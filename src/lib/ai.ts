import Anthropic from "@anthropic-ai/sdk";

type ChatMessage = { role: "user" | "assistant"; content: string };

export type AIOptions = {
  /** The tenant's script, resolved by the caller from account -> business. */
  systemPrompt: string;
  model?: string;
};

export type AIResult = {
  text: string;
  /** Which provider answered — callers meter usage off this. "none" == Claude couldn't. */
  provider: "claude" | "none";
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /**
   * True when Claude could not produce a usable reply (paused key, outage, or refusal)
   * and `text` is a safe holding message. The caller should hand the conversation to a
   * human rather than keep auto-replying. We deliberately do NOT fall back to weaker
   * models — a wrong or garbled reply to a real customer is worse than a brief holding
   * message plus a human stepping in.
   */
  unavailable: boolean;
};

// The Anthropic key is a PLATFORM credential (we pay, then bill the tenant), not
// per-tenant — so this client holds no tenant state and is safe to share. What must
// never be module-scope is the system prompt: that is per-tenant, always passed in.
const anthropic = new Anthropic();
const DEFAULT_CLAUDE_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";

// Shown to the guest whenever Claude can't answer. Paired with a human handoff by the
// caller (see webhook), so "our team will get back to you" is truthful.
const OUTAGE_MESSAGE = "Thanks for your message! Our team will get back to you shortly.";

/** True if this text IS the holding message — lets the webhook avoid sending it to the same
 *  guest twice during one outage. Compared here so the wording lives in exactly one place. */
export function isHoldingMessage(text: string | null | undefined): boolean {
  return (text ?? "").trim() === OUTAGE_MESSAGE;
}

// ---------------------------------------------------------------------------
// Failure visibility + circuit breaker.
//
// On 20 Sep every reply stopped for over an hour and nobody could say why: the API was
// answering "You have reached your specified API usage limits. You will regain access on
// 2026-10-01", and the only trace of it was a console.warn on the server. Staff answered 62
// messages by hand while each new guest got the same holding line. Two problems, both here:
// the reason was invisible, and a hard stop was retried forever.
//
// In-process state, the same assumption debounce.ts and queue.ts already document (one
// long-lived Render process). Worst case on a restart is one extra failed call.
// ---------------------------------------------------------------------------

/** How long to stop calling out after a HARD failure — long enough to stop hammering a
 *  refusing API, short enough that recovery is picked up on its own. */
const BREAKER_MS = 5 * 60 * 1000;

let lastError: { message: string; at: number } | null = null;
let breakerUntil = 0;

export type AiStatus = {
  ok: boolean;
  /** The API's own words, e.g. the usage-limit message — what was missing before. */
  error: string | null;
  at: string | null;
  /** When calls will be attempted again, while the breaker is open. */
  retryAt: string | null;
};

export function getAiStatus(): AiStatus {
  // Only report a failure that is still current: a blip an hour ago is not an outage.
  const fresh = lastError && Date.now() - lastError.at < 15 * 60 * 1000;
  return {
    ok: !fresh,
    error: fresh ? lastError!.message : null,
    at: fresh ? new Date(lastError!.at).toISOString() : null,
    retryAt: Date.now() < breakerUntil ? new Date(breakerUntil).toISOString() : null,
  };
}

/**
 * A failure that retrying cannot help: the usage cap, a revoked key, a model this account
 * can't reach. 429 and 5xx are the opposite — transient, and the SDK already retries those,
 * so they must NOT trip the breaker or a busy minute would mute the agent for five.
 */
function isHardFailure(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return status === 400 || status === 401 || status === 403 || status === 404;
}

function describeError(err: unknown): string {
  const e = err as { status?: number; error?: { error?: { message?: string } }; message?: string };
  const detail = e?.error?.error?.message || e?.message || "Unknown error";
  return e?.status ? `HTTP ${e.status}: ${detail}` : detail;
}

// Conversation-hygiene rules appended to EVERY tenant's system prompt. Without them a
// model can treat each turn fresh — re-asking for details the guest already gave — or
// narrate its reasoning; these pull it back toward tracking state and staying coherent.
const REPLY_GUARD = [
  "Reply with only the message to send to the guest — no preamble, no quotes, no explanation of your reasoning.",
  "Track what the guest has already told you. Never ask again for a detail they have already given (name, date, time, party size, contact, outlet, or order items). Acknowledge what you have and ask only for what is still missing.",
  "Greet only ONCE, at the very start. If the guest states any intent — 'reservation', 'takeaway', a dish, a date or time — act on it immediately: confirm what you understood and ask for the specific details still missing. NEVER answer a stated intent with another 'How can I help you?' greeting, and never send back-to-back greetings.",
  "Once you have everything needed to place a reservation or takeaway order, confirm it back to the guest and proceed to the hand-off — do not repeat the request for details.",
  "Write only in clear, natural English (or the language the guest is writing in). Never insert stray words or characters from an unrelated language mid-message.",
  "Don't pre-empt with conditional rules, timing caveats, hours, or disclaimers (e.g. prep delays or cutoff times) — raise a condition only when the guest's actual request triggers it, and answer only what they asked.",
  // The script tells the agent to CHECK a requested time against the outlet's hours, but only
  // spells out what to say when that check FAILS. Told to run a check and given no rule about
  // the passing case, the model narrated it: "Unfortunately, our dinner service at Pal closes at
  // 10:00 PM, so 8:45 PM works perfectly" — it opened in the frame of reporting a constraint,
  // then found the constraint didn't bind, and couldn't retract the word it had already emitted.
  // The guest is only ever owed the outcome of a check that actually blocks them.
  "Checks you run against hours, availability or internal rules are silent. When a request passes, say NOTHING about the check — never mention opening or closing times, kitchen timings, how far away the booking is, or that you verified anything. Speak about timing ONLY when the guest's request actually fails a rule, and then only about what they must change.",
  // "5/9/26" is 5 September, not 9 May. No script says so, so the model resolved it correctly and
  // then lost its nerve and asked the guest to confirm a date they had just written — which meant
  // it never finished the recap, never emitted the hand-off line, and no order was ever captured.
  "Dates written in numbers are DAY first: 5/9/26 is 5 September 2026, not 9 May. Read a date the guest has given, apply it, and never ask them to re-confirm or re-state a date, time, name, contact or party size they have already written — even if their format was ambiguous or the booking is soon.",
  // A guest typed "17th sep" on the 18th and the agent called it "tomorrow morning", and turned a bare
  // "8:30" into 8:30 AM for what was a dinner booking. The webhook now refuses to capture a past booking
  // (isPastBooking), but the model should never recap one in the first place.
  "Before recapping a reservation or pickup, compare its date and time with the current date and time above. If it has already passed, don't recap it — say so and ask for a future date and time. A date earlier than today is almost always a typo: ask, never assume. If a time has no am/pm and both are possible that day, ask which.",
  // A guest wrote "24 September 2026, Thursday" and the agent recapped "Thursday, 26 September" — the
  // 26th is a Saturday. It was only ever told today's date and had to count forward to find a weekday,
  // and it counted wrong in 5 of 8 replays of that chat. calendarBlock() below now hands it the answer.
  "Every weekday and date you write must come from the Calendar above — look it up, never work one out yourself. Keep the date the guest gave; never move it to fit a weekday. If the guest's weekday and date disagree with the Calendar, ask which one they meant before recapping.",
  "Keep every reply under 900 characters — Instagram rejects anything longer and the guest receives NOTHING. Never paste a long list of items: send the menu link, or name a few options and offer to say more.",
  "Once you have FINALIZED a reservation or takeaway earlier in this conversation (you confirmed it back to the guest and/or emitted its hand-off line), treat any LATER message as a fresh request and respond to what it actually asks — if they want another reservation or order, start collecting its details; otherwise just answer their question. Do NOT resume, re-confirm, or re-emit the hand-off for the finished order, and do NOT restart with a generic greeting (you have already greeted them). Only revisit a past order if the guest explicitly asks about it (to check or change it). You may reuse their name, contact and preferences, and emit a new hand-off line only when they actually place a new order.",
].join("\n");

/** How far ahead the calendar reaches. Bookings are rarely further out than this, and the table
 *  costs ~900 input tokens a reply — small beside a 17K-token script. */
const CALENDAR_WEEKS = 16;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * A day-by-day calendar, one week per line, starting today in IST.
 *
 * Built from the server clock on every call rather than stored anywhere, so it can never go
 * stale or run out at the end of a year. The model is poor at weekday arithmetic ("Thursday"
 * after Monday 21 September came out as the 26th more often than the 24th) and perfect at
 * looking something up: with this table in the prompt, the same chat got the right date 24/24.
 */
export function calendarBlock(now: Date = new Date()): string {
  // Today's date as IST sees it, then walk forward in whole UTC days. India has no DST, so
  // every day is exactly 24h and formatting each one in UTC can't slip across midnight.
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(now)
    .split("-")
    .map(Number);
  const lines: string[] = [];
  for (let w = 0; w < CALENDAR_WEEKS; w++) {
    const days: string[] = [];
    for (let i = 0; i < 7; i++) {
      const n = w * 7 + i;
      const day = new Date(Date.UTC(y, m - 1, d + n));
      // Spelled out by hand rather than via Intl: the server's locale data decides whether
      // September is "Sep" or "Sept", and the guest writes the full name anyway.
      const label = `${WEEKDAYS[day.getUTCDay()]} ${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]} ${day.getUTCFullYear()}`;
      days.push(n === 0 ? `${label} (today)` : label);
    }
    lines.push(days.join(" | "));
  }
  return `Calendar (IST), starting today:\n${lines.join("\n")}`;
}

// A safe holding-message result. Every non-answer path returns this shape so the caller
// can uniformly detect an outage via `unavailable` and hand off to a human.
const outageResult = (): AIResult => ({
  text: OUTAGE_MESSAGE,
  provider: "none",
  model: null,
  inputTokens: null,
  outputTokens: null,
  unavailable: true,
});

export async function getAIResponse(
  messages: ChatMessage[],
  options: AIOptions
): Promise<AIResult> {
  // Give the agent date awareness (it otherwise has none) so it can resolve relative dates
  // the guest mentions and tell when an earlier order's date/time has already passed. IST —
  // the business's timezone.
  const nowIst = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "full",
    timeStyle: "short",
  });
  const system = `${options.systemPrompt}\n\nCurrent date & time (IST): ${nowIst}.\n\n${calendarBlock()}\n\n${REPLY_GUARD}`;
  const claudeModel = options.model || DEFAULT_CLAUDE_MODEL;

  // The API rejects a history that opens with an assistant turn, which is reachable
  // when a human starts the thread from the dashboard's send route.
  const history = [...messages];
  while (history.length && history[0].role !== "user") history.shift();
  if (!history.length) return outageResult();

  // The API told us it would refuse until a fixed date; calling it again every time a guest
  // writes achieves nothing. Recovery needs no intervention — the breaker simply lapses.
  if (Date.now() < breakerUntil) return outageResult();

  try {
    const res = await anthropic.messages.create({
      model: claudeModel,
      max_tokens: 1024,
      system,
      messages: history,
    });

    if (res.stop_reason === "refusal") {
      // Claude declined — hand to a human rather than push a canned answer.
      return {
        text: "Our team will be happy to help! Let me connect you.",
        provider: "claude",
        model: claudeModel,
        inputTokens: res.usage?.input_tokens ?? null,
        outputTokens: res.usage?.output_tokens ?? null,
        unavailable: true,
      };
    }

    const text = res.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    if (text) {
      // A reply just went through, so whatever was wrong no longer is. Without this,
      // getAiStatus keeps reporting the old failure for its full 15-minute window and the
      // Inbox banner tells staff to take over conversations the agent is already handling
      // — which is exactly what happened once the usage cap was lifted on 20 Sep.
      //
      // Reaching here means the breaker was already closed (the guard above returns early
      // otherwise), so zeroing it changes nothing today; it is here so the two can never
      // drift apart if that guard is ever relaxed. Recovery still costs one breaker
      // interval: no call is attempted while it is open, so nothing can clear this sooner.
      lastError = null;
      breakerUntil = 0;
      return {
        text,
        provider: "claude",
        model: claudeModel,
        inputTokens: res.usage?.input_tokens ?? null,
        outputTokens: res.usage?.output_tokens ?? null,
        unavailable: false,
      };
    }
    // Counts as a failure for reporting: from the guest's side it is identical to an outage.
    // Not a hard one, though — no breaker, since the next call may well succeed.
    lastError = { message: "Claude returned no text", at: Date.now() };
    console.warn("Claude returned no text — serving a holding message.");
  } catch (err) {
    // Paused/invalid key, rate limit, outage, etc. No weak-model fallback: send a safe
    // holding message and let the caller hand the conversation to a human.
    const detail = describeError(err);
    lastError = { message: detail, at: Date.now() };
    if (isHardFailure(err)) breakerUntil = Date.now() + BREAKER_MS;
    console.warn("Claude call failed — serving a holding message:", detail);
  }

  return outageResult();
}

// Reshape arbitrary business notes (uploaded doc) into the app's DM-agent script
// format. NOT via getAIResponse: that path caps output at 1024 tokens (a full script
// is larger) and returns a guest-facing holding message on failure rather than throwing.
// Fills the editor for human review — never auto-saved.
const REFORMAT_SYSTEM = (businessName: string) => `You convert a business's raw notes into a system-prompt "script" that governs an AI assistant answering that business's Instagram DMs. The business is "${businessName}".

Reshape the user's content into a clear Markdown script with these sections:
- **Persona** — who the assistant is (the voice of ${businessName}) and its goal.
- **What it can help with** — the topics it should handle.
- **Facts it may state** — menu, prices, hours, locations, booking/links, policies. Use ONLY facts present in the source. Never invent a price, item, hour, address, or link. If the source lacks something, omit it (or note the assistant should offer to connect a human).
- **Rules** — always include: never volunteer prices unless the customer explicitly asks (then answer); never make up facts; hand off to a human when unsure or asked something out of scope; stay in character.
- **Tone** — concise, warm, on-brand.

Preserve every real detail from the source; reorganize, don't discard. Output ONLY the script in Markdown — no preamble, no commentary, no code fences around the whole thing.`;

export async function reformatToScript(sourceText: string, businessName: string): Promise<string> {
  const res = await anthropic.messages.create({
    model: DEFAULT_CLAUDE_MODEL,
    max_tokens: 8192,
    system: REFORMAT_SYSTEM(businessName),
    messages: [{ role: "user", content: sourceText }],
  });

  if (res.stop_reason === "refusal") {
    throw new Error("The model declined to reformat this file.");
  }
  const text = res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) throw new Error("The model returned an empty script.");
  return text;
}
