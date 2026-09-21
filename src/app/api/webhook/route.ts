import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { after } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { fetchInstagramProfile } from "@/lib/instagram";
import { sendAndStore } from "@/lib/outbound";
import { getAIResponse, isHoldingMessage } from "@/lib/ai";
import { resolveAccountByIgId, type ResolvedAccount } from "@/lib/tenant";
import { checkMessageQuota } from "@/lib/usage";
import { withSlot } from "@/lib/queue";
import { debounce, DEBOUNCE_MS } from "@/lib/debounce";
import {
  isPureEmoji,
  isNoIntentOpener,
  isTrivialAck,
  cannedWelcome,
  pastTimeReply,
  mergeConsecutiveTurns,
} from "@/lib/message-triage";
import {
  detectHandoff,
  detectReview,
  stripHandoff,
  dedupeKey,
  refersToPastOrder,
  isPastBooking,
} from "@/lib/order-detect";
import { isClosedOn } from "@/lib/closed-days";
import { isOutletUnavailable } from "@/lib/availability";
import { parseIncomingMedia, hasMedia, describeMedia, type Media } from "@/lib/attachments";
import { isBlocked } from "@/lib/blocklist";
import { maybeSweepFeedback } from "@/lib/feedback-run";

// The reply is generated in after() (see below), and on Vercel that background
// work is bounded by THIS function's maxDuration — exceed it and the reply is
// killed mid-generation while Meta already got its 200, i.e. a silent no-reply.
// Pin it rather than depend on the platform default staying generous. An LLM
// reply is ~10-30s; 60s covers a small batch. Raise for slower models.
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  // Platform-level: one Meta app = one callback URL = one verify token.
  if (mode === "subscribe" && token === process.env.INSTAGRAM_VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }

  return new Response("Forbidden", { status: 403 });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Messaging = any;

/**
 * Meta signs every webhook with the app secret. Without this check anyone who
 * learns the URL can forge an event — and now that entry[0].id selects a tenant,
 * a forged event is a cross-tenant write.
 */
function verifySignature(rawBody: string, header: string | null): boolean {
  const secret = process.env.META_APP_SECRET;
  if (!secret) {
    // Fail open only when unconfigured, and say so loudly — otherwise a missing
    // env var would silently drop every real message.
    console.warn("META_APP_SECRET not set — webhook signature NOT verified.");
    return true;
  }
  if (!header?.startsWith("sha256=")) return false;

  const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const got = header.slice("sha256=".length);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(got, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  // Read the raw body: the signature is over exact bytes, so re-serialising breaks it.
  const raw = await request.text();

  if (!verifySignature(raw, request.headers.get("x-hub-signature-256"))) {
    console.warn("Rejected webhook with an invalid X-Hub-Signature-256.");
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  let body: { object?: string; entry?: { id?: string; messaging?: Messaging[] }[] };
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.object !== "instagram") {
    return Response.json({ status: "ignored" });
  }

  // Acknowledge Meta immediately (must respond within ~5s or it retries the event,
  // causing duplicate processing). Heavy work runs after the response.
  for (const entry of body.entry ?? []) {
    // entry.id IS the destination Instagram business account — i.e. which tenant
    // this DM belongs to. Everything downstream is scoped by it.
    const igAccountId = entry.id;
    if (!igAccountId) continue;

    for (const messaging of entry.messaging ?? []) {
      // Text OR media. This used to require text, so a guest who shared a post or
      // reel with no caption was dropped here — never stored, never shown to staff,
      // never replied to. Only genuinely empty events are skipped now.
      const m = messaging?.message;
      if (!m?.text && !hasMedia(m)) continue;
      // Echoes fire for EVERY outbound message on the account — ours (AI/dashboard,
      // already stored when sent) and anything sent manually from the connected
      // account's own Instagram app. processEcho tells the two apart by mid.
      if (messaging?.message?.is_echo) {
        after(() => withSlot(() => processEcho(igAccountId, messaging)));
        continue;
      }
      // Bounded: a burst of DMs queues instead of firing unlimited concurrent AI calls.
      after(() => withSlot(() => processMessage(igAccountId, messaging)));
    }
  }

  // Post-dining thank-yous ride on real traffic rather than waiting for a scheduler. The
  // Render cron that used to be their only trigger fired on 5 of 12 days, and a feedback DM
  // is perishable — Instagram refuses anything more than 24h after the guest's last message —
  // so a missed day doesn't delay the message, it loses it. One guest's was due Saturday
  // afternoon and was still unsent when staff clicked it on Sunday evening, 39h later.
  //
  // Self-throttling to once every few minutes and capped per run, so it's a no-op on almost
  // every webhook. In after() and never throwing, so it cannot touch the guest's own reply.
  after(() => maybeSweepFeedback());

  return Response.json({ status: "received" });
}

async function processMessage(igAccountId: string, messaging: Messaging) {
  const igsid = messaging.sender.id;
  // May be absent entirely on a media-only message (a shared post with no caption).
  const text: string = messaging.message.text ?? "";
  const instagramMsgId = messaging.message.mid;
  const media = parseIncomingMedia(messaging.message);

  try {
    // Which tenant owns this account? Unknown / unapproved => ignore. Never fall
    // back to another tenant.
    const account = await resolveAccountByIgId(igAccountId);
    if (!account) return;

    const conversation = await findOrCreateConversation(account, igsid);
    if (!conversation) {
      console.error("Failed to create conversation for", igsid, "on", igAccountId);
      return;
    }

    // Store user message. Duplicate mid (Meta retry) is now scoped per-conversation.
    // `content` stays exactly what the guest typed — possibly "" — because the Inbox
    // renders the media itself; synthesising text here would corrupt the transcript.
    const { error: insertError } = await supabaseAdmin.from("instagram_messages").insert({
      conversation_id: conversation.id,
      role: "user",
      content: text,
      instagram_msg_id: instagramMsgId,
      attachments: media.length ? media : null,
    });
    if (insertError?.code === "23505") return;

    // Surfaces any attachment type the parser didn't recognise, with its raw type,
    // so an unanticipated payload shape is visible in logs instead of silently
    // becoming a generic card.
    for (const m of media) {
      if (m.kind === "other") {
        console.warn(`Unrecognised Instagram attachment type "${m.rawType}" on ${instagramMsgId}`);
      }
    }

    await touch(conversation.id);

    // Do-not-reply list. Global: one entry silences this handle on EVERY connected
    // account (see src/lib/blocklist.ts). Everything above has already run, so the
    // message is stored and the Inbox shows it exactly as normal — we simply never
    // answer. Sits above the mode check, and therefore above the canned-welcome path
    // below, because a blocked guest's first "hi" must not get the welcome DM either.
    if (await isBlocked(conversation.username)) return;

    if (conversation.mode === "human") return;

    // ANY attachment ends the turn. Not a word back — no story reply, no story mention,
    // no shared post or reel, no photo, and nothing from the `template` /
    // `unsupported_type` shapes Meta sends for media it won't hand over at all.
    //
    // This started narrower (stories only) and kept leaking, because each rule was a bet
    // on knowing Meta's type names: `ig_story` wasn't in the table, so a guest got "thank
    // you for sharing! 🤍" for a story we'd promised never to answer. The blanket rule
    // can't leak — it asks whether there is media, not what kind.
    //
    // The cost is close to zero, measured rather than assumed: of 238 inbound media
    // messages, 208 carried no text whatsoever, and 29 of the 30 that did were story
    // replies (already silent). Exactly ONE non-story attachment in the whole history
    // ever carried a real question. Against that, the agent was answering ~83 of these —
    // mostly "I'm not able to view attachments", twice in a row to the same guest.
    //
    // The message is still stored and still shows in the Inbox, so staff can answer by
    // hand; and a LATER text-only message still gets a reply, with describeMedia putting
    // "[sent a photo]" in the history so the model knows what was referred to.
    if (media.length) return;

    // A bare emoji is not a question, wherever it lands in the thread. It used to
    // count as a "no intent opener", so a guest who opened with just 👋 got the whole
    // welcome message back — starting a conversation they never asked for. The message
    // is still stored above (history and the Inbox stay accurate); only the reply is
    // suppressed. "hi" / "hello" / "info?" still get the welcome. Placed before the
    // count query below so it costs no round trip either.
    // A bare emoji carrying a shared post or reel still reaches the AI, which is why
    // this stays conditional on `media` rather than testing the text alone.
    if (isPureEmoji(text) && !media.length) return;

    // Cost pre-filter — runs before anything that touches the paid AI. A bare
    // "thanks" used to trigger a full Claude call with the ~19K-char script every
    // single time; that case doesn't need the model at all.
    const { count: messageCount } = await supabaseAdmin
      .from("instagram_messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", conversation.id);
    const isFirstMessage = messageCount === 1;

    if (isFirstMessage && isNoIntentOpener(text)) {
      // Faithful stand-in for the AI's own scripted welcome line — no AI call.
      await sendCannedReply(account, conversation.id, igsid, cannedWelcome(account.businessName, account.takeawayEnabled));
      return;
    }
    if (!isFirstMessage && isTrivialAck(text)) {
      // A bare emoji or "thanks" needs no reply at all — nothing sent, nothing generated.
      return;
    }

    // Real content: debounce so a burst of several quick messages ("hi", "table
    // for 2", "tonight 8pm" as three bubbles) becomes ONE AI call, not three.
    // Already running inside the caller's after() background task — no need to
    // nest another after() here, and the setTimeout it schedules relies on this
    // being a single long-lived process (Render), same constraint queue.ts
    // already documents for its own in-process concurrency gate.
    debounce(conversation.id, DEBOUNCE_MS, () => {
      withSlot(() => generateAndSendReply(igAccountId, conversation.id)).catch((error) =>
        console.error("Debounced reply error:", error)
      );
    });
  } catch (error) {
    console.error("Webhook processing error:", error);
  }
}

// Sends a fixed, non-AI reply (the canned first-message welcome). Mirrors the
// storage side of generateAndSendReply's real send, minus everything AI-only.
async function sendCannedReply(
  account: ResolvedAccount,
  conversationId: string,
  igsid: string,
  text: string
) {
  const sent = await sendAndStore({
    conversationId,
    igsid,
    text,
    accessToken: account.accessToken,
  });
  if (!sent.ok) {
    console.error(`Welcome reply not delivered to ${igsid}: ${sent.error?.message}`);
  }
}

// The AI-calling path, run after the debounce window settles. Re-resolves the
// account and re-fetches the conversation fresh rather than trusting a closure
// captured several seconds ago — mode may have changed in the meantime (e.g. a
// manual phone reply arrived and handed the conversation to a human).
async function generateAndSendReply(igAccountId: string, conversationId: string) {
  try {
    const account = await resolveAccountByIgId(igAccountId);
    if (!account) return;

    const { data: conversation } = await supabaseAdmin
      .from("instagram_conversations")
      .select("*")
      .eq("id", conversationId)
      .maybeSingle();
    if (!conversation) return;
    if (conversation.mode === "human") return;
    // Re-checked for the same reason mode is: the debounce window is 6 seconds wide,
    // so staff can block this handle after the message landed but before we reply.
    // Normally a cache hit, so it costs nothing.
    if (await isBlocked(conversation.username)) return;

    const igsid = conversation.igsid;

    // Plan quota. Checked BEFORE the AI call, because the AI call is the thing
    // that costs money. The inbound message(s) are already stored, so nothing is
    // lost — the tenant just stops getting auto-replies until the period rolls
    // over or they upgrade.
    const quota = await checkMessageQuota(account.clientId);
    if (!quota.allowed) {
      console.warn(
        `Quota blocked reply for client ${account.clientId} on @${account.username}: ${quota.reason}`
      );
      return;
    }

    // Fresh start after an order: once a reservation/takeaway is captured we stamp
    // `context_reset_at` (below), and from then on the AI is fed mainly the messages from that
    // point on — the finished order's lead-up is hidden so the AI can't resume or re-confirm it.
    // The one exception is when the guest clearly asks about a past order: then we lift the
    // filter for this single turn so the AI has the full transcript to answer from. See the
    // `>=` and MIN_CONTEXT notes below — the boundary must never starve the model of context.
    const resetAt = (conversation as { context_reset_at?: string | null }).context_reset_at ?? null;

    // Newest-first + reverse, so a long conversation feeds the AI its RECENT 20 turns.
    // Ascending + limit(20) returned the OLDEST 20 instead — past 20 messages the AI was
    // reasoning from the top of the thread and never saw what was just said.
    const { data: rawHistory } = await supabaseAdmin
      .from("instagram_messages")
      .select("role, content, created_at, attachments")
      .eq("conversation_id", conversation.id)
      .order("created_at", { ascending: false })
      .limit(20);
    const rows = (rawHistory || []).slice().reverse();

    // Nothing new from the guest since our last message — an earlier run already answered.
    // Two bubbles more than DEBOUNCE_MS apart get a run each, and when the first run's reply
    // lands before the second run reads history, the second finds the conversation ending on
    // OUR turn. Sent to Claude like that, the reply is always empty (4/4 in replay), which we
    // then treated as an outage: on 21 Sep a guest who had just been asked for her number got
    // the holding message and her chat was pulled from the agent. A staff reply at the end
    // means the same thing — someone has already answered.
    if (rows.length && rows[rows.length - 1].role !== "user") return;

    // Debounce may have batched several guest bubbles since the last assistant
    // turn — check intent across all of them, not just the very last one.
    const trailingUserText = [];
    for (let i = rows.length - 1; i >= 0 && rows[i].role === "user"; i--) {
      trailingUserText.unshift(rows[i].content);
    }
    const wantsPast = refersToPastOrder(trailingUserText.join("\n"));

    // The guest is revising a "finished" order — it's not really finished
    // anymore. Clear the reset boundary (not just lift it for this one turn)
    // so a bare follow-up answer ("4:30 PM", answering the AI's own "what
    // time?") keeps seeing full history too, instead of losing the order the
    // moment the guest's reply no longer contains a trigger keyword itself.
    // A new handoff line (see below) re-stamps a fresh boundary once the
    // revised order is actually finalized.
    if (resetAt && wantsPast) {
      await supabaseAdmin
        .from("instagram_conversations")
        .update({ context_reset_at: null })
        .eq("id", conversation.id);
    }

    // `>=` keeps the recap/confirmation turn the boundary was stamped AT inside the window.
    // With a strict `>` it was excluded, so the guest's next "Okay" reached the model as the
    // only message in the conversation — and the script's own "if history is empty, this is a
    // fresh conversation" rule then correctly produced a brand-new welcome. Keeping that turn
    // visible is also what makes REPLY_GUARD's "you already finalized an order" rule
    // enforceable: the model can now SEE the finalization it's being told about.
    const afterReset =
      resetAt && !wantsPast ? rows.filter((m) => m.created_at >= resetAt) : rows;

    // Floor: never hand the model a context-less window. The reset exists to stop it RESUMING
    // a finished order, not to erase the conversation — so if the boundary trimmed history down
    // to almost nothing, fall back to the recent turns instead of leaving it with no grounding.
    // 6 proved too small in practice: a guest's name and number given 7 turns back fell outside
    // the window and the AI asked for them again.
    const MIN_CONTEXT = 12;
    const filtered =
      afterReset.length < MIN_CONTEXT ? rows.slice(-MIN_CONTEXT) : afterReset;

    // What we have ALREADY captured from this guest, injected as a system instruction rather
    // than left to survive the history window. Two reasons it belongs here and not in the
    // transcript: stripHandoff() deletes the handoff line that carried the name and contact, so
    // the transcript may no longer hold them anywhere; and a system line cannot be echoed back
    // to the guest as a chat turn the way a fake assistant message could. Carrying `status` also
    // stops the AI following a staff "your order is confirmed" DM with "the team will confirm
    // shortly" — it can finally see that the order is already done.
    const captured = await capturedOrderNote(conversation.id);

    // This tenant's script — not a module-level constant.
    const ai = await getAIResponse(
      mergeConsecutiveTurns(
        filtered
          .map((m) => {
            // Never feed a raw handoff line back to the model — a previously-leaked one in the history
            // makes it echo the same order every turn (a loop). Strip it from assistant turns; a turn
            // that was ONLY a handoff line becomes empty and is dropped below.
            if (m.role === "assistant") {
              return { role: "assistant" as const, content: stripHandoff(m.content).trim() };
            }
            // Tell the model WHAT the guest was reacting to. Without this a story reply reads as a
            // context-free remark, and a media-only message is an empty turn that the filter below
            // drops — leaving a history that can end up empty, which makes getAIResponse serve the
            // outage message. The descriptor exists only here; the stored transcript keeps the
            // guest's real words.
            const note = describeMedia((m.attachments as Media[] | null) ?? []);
            const body = (m.content ?? "").trim();
            return {
              role: "user" as const,
              content: note ? (body ? `${note} ${body}` : note) : body,
            };
          })
          .filter((m) => m.content.length > 0)
      ),
      { systemPrompt: captured ? `${account.systemPrompt}\n\n${captured}` : account.systemPrompt }
    );

    // If the AI appended a reservation/takeaway handoff line — or a REVIEW line for a matter that
    // needs a human — strip it so the guest sees only the clean reply; the row is captured below.
    const detected = detectHandoff(ai.text);
    const detectedReview = detectReview(ai.text);

    // Collaboration / paid-promo pitches are never answered by the AI. The brand's
    // position on partnerships isn't the model's to improvise, so the request goes
    // to Review silently and a human sends the standing reply from there (the
    // "Send collab decline" button on the Review page).
    //
    // Returning early skips the send entirely — the AI's drafted reply is discarded,
    // not stored, so the Inbox shows the guest's message with no response. The three
    // steps below must still run: the model was called and billed either way, the
    // Review row IS the point of this branch, and without the human flip the guest's
    // next message would just get an AI reply anyway.
    // The brand does not do takeaway, but the model tried to take one anyway. The script
    // says dine-in only and tenant.ts repeats it as a hard block, yet neither is a guarantee
    // — so this is the part that actually holds. Beshak's first ever guest was offered a
    // takeaway by the canned welcome; the model itself declining correctly afterwards is not
    // something to rely on twice.
    //
    // Same shape as the collaboration branch below: the reply is DISCARDED rather than sent,
    // because telling a guest their pickup is noted when no such service exists is worse
    // than silence. Usage is still recorded (the model was billed), no order is captured,
    // and a human takes the thread.
    if (detected?.kind === "takeaway" && !account.takeawayEnabled) {
      console.warn(
        `Model emitted a TAKEAWAY line for @${account.username}, which is dine-in only — discarding.`
      );
      await recordUsage(account, ai);
      await supabaseAdmin
        .from("instagram_conversations")
        .update({ mode: "human", human_handoff_reason: "review" })
        .eq("id", conversation.id);
      return;
    }

    // The outlet is shut that day, but the model booked it anyway. Same two-sided treatment as
    // takeaway above: closedDaysBlock states the rule in the prompt, and this is what makes it
    // true. It has to sit HERE, before the send at the bottom of this function — captureOrder runs
    // after the DM has already gone out, so a check down there would reject an order the guest has
    // just been told is in hand.
    //
    // detected.scheduledAt is null when the AI never pinned an absolute date (parseAbsDate refuses
    // "today"/"Saturday" on purpose); isClosedOn answers false for that rather than guessing, so a
    // dateless handoff passes through as it does today.
    if (detected) {
      // A booking for a time that has already passed. First, because a time that doesn't exist
      // yet is the most basic invalidity. On 18 Sep a guest typed "17th sep" meaning the 18th;
      // the agent — which is handed today's date on every turn — called the 17th "tomorrow
      // morning", the order was captured, and staff confirmed it 35 hours in the past.
      //
      // Deliberately NOT the human handoff the closure guards below use. Those are policy the
      // guest can't change; this is a typo they fix in one message. So: discard the recap (it
      // was built on the wrong date), capture nothing, send a plain "that's passed — when?",
      // and stay in AI mode so their correction is answered and captured normally.
      if (isPastBooking(detected.scheduledAt, Date.now())) {
        console.warn(
          `Model captured a ${detected.kind} in the past for @${account.username} (${detected.scheduledAt}) — asking for a new time.`
        );
        await recordUsage(account, ai);
        await sendCannedReply(account, conversation.id, igsid, pastTimeReply(detected.kind));
        return;
      }

      // TWO closure systems, and until now only one of them was enforced. `closed_days` is the
      // standing "every Tuesday / this date" rule that isClosedOn covers. The Unavailable tab
      // writes somewhere else entirely — `unavailable_outlets`, a "shut right now until X"
      // window — and that had nothing behind it but the prompt. Hence Piplod being offered,
      // confirmed, and only stopped by a colleague typing "Piplod is closed today".
      if (await isOutletUnavailable(account.businessId, detected.outlet, detected.scheduledAt)) {
        console.warn(
          `Model booked a ${detected.kind} at a closed outlet for @${account.username} (${detected.outlet}) — discarding.`
        );
        await recordUsage(account, ai);
        await supabaseAdmin
          .from("instagram_conversations")
          .update({ mode: "human", human_handoff_reason: "closed_day" })
          .eq("id", conversation.id);
        return;
      }

      if (await isClosedOn(account.businessId, detected.scheduledAt, detected.outlet)) {
        console.warn(
          `Model booked a ${detected.kind} on a closed day for @${account.username} (${detected.scheduledAt}) — discarding.`
        );
        await recordUsage(account, ai);
        await supabaseAdmin
          .from("instagram_conversations")
          .update({ mode: "human", human_handoff_reason: "closed_day" })
          .eq("id", conversation.id);
        return;
      }
    }

    // The agent is down and this guest has ALREADY been told "our team will get back to you".
    // Saying it again every time they write is worse than silence — on 20 Sep the API refused
    // every call for over an hour, and each new message earned another copy. Hand the chat to a
    // human (again, harmlessly) and say nothing.
    const lastAssistant = [...rows].reverse().find((m) => m.role === "assistant")?.content;
    if (ai.unavailable && isHoldingMessage(lastAssistant)) {
      await supabaseAdmin
        .from("instagram_conversations")
        .update({ mode: "human", human_handoff_reason: "outage" })
        .eq("id", conversation.id);
      return;
    }

    if (detectedReview?.category === "collaboration") {
      await recordUsage(account, ai);
      await captureReview(account, conversation, detectedReview);
      await supabaseAdmin
        .from("instagram_conversations")
        .update({ mode: "human", human_handoff_reason: "review" })
        .eq("id", conversation.id);
      return;
    }

    const stripped = (detected || detectedReview ? stripHandoff(ai.text) : ai.text).trim();
    // NEVER leak the raw internal handoff line to the guest. If stripping leaves nothing (the model
    // replied with only the note), send a safe line instead of the raw grammar — and this clean text
    // is what gets stored below, so the history stays uncontaminated.
    const customerText =
      stripped || "Thanks! I've noted that — our team will confirm and follow up shortly. 🙌";

    // Reply FROM this tenant's account: the token is the sender identity.
    // Stores one row per delivered part (a long reply is split), each with its own
    // mid so the later echo of it is deduped by processEcho rather than mistaken for
    // a manual phone reply. Stores nothing at all if Instagram rejected the send.
    const sent = await sendAndStore({
      conversationId: conversation.id,
      igsid,
      text: customerText,
      accessToken: account.accessToken,
    });

    // The guest received nothing. Capturing an order or stamping a fresh-start
    // boundary off a reply they never saw would compound the failure, so bail and
    // hand the thread to a human — that puts the failure in front of staff in the
    // Inbox instead of leaving it silent, which is how an undelivered cake menu
    // sat there looking sent.
    if (!sent.ok) {
      console.error(
        `Reply not delivered to ${igsid} on @${account.username}: ${sent.error?.message}`
      );
      await supabaseAdmin
        .from("instagram_conversations")
        .update({ mode: "human", human_handoff_reason: "undelivered" })
        .eq("id", conversation.id);
      return;
    }

    await recordUsage(account, ai);

    if (detected) {
      await captureOrder(account, conversation, detected);
      // Fresh-start boundary: hide everything up to and including this confirmation from future AI
      // turns. Using the confirmation message's own DB timestamp (with the strict `>` filter above)
      // keeps the cut exact regardless of app-vs-DB clock skew. Covers reservations AND takeaways.
      //
      // The recap is also the AI's LAST word. Nothing exists yet — no human has approved this
      // booking — so anything the model says next can only be filler or, worse, a promise it has
      // no standing to make. It once answered a guest's "Perfect" with "We'll see you tomorrow
      // evening", 99 seconds before staff actually confirmed. The script already forbade exactly
      // that phrasing and the model said it anyway, which is why the stop lives here and not in
      // the prompt. Everything after the recap — "ok", a question, a change of mind — is a
      // person's to answer. Reversed by the Confirm and Cancel routes, which flip this same pair
      // back (guarded on the reason, so they only ever un-silence what this line silenced).
      await supabaseAdmin
        .from("instagram_conversations")
        .update({
          context_reset_at: sent.lastCreatedAt ?? new Date().toISOString(),
          mode: "human",
          human_handoff_reason: "awaiting_confirmation",
        })
        .eq("id", conversation.id);
    }
    if (detectedReview) await captureReview(account, conversation, detectedReview);

    // Hand the conversation to a human — future inbound messages aren't auto-answered (the guard
    // near the top of processMessage early-returns on mode === "human"), so staff pick it up. Two
    // reasons: (a) Claude couldn't answer (paused key, outage, or refusal) — the safe holding
    // message was already sent above and we never serve weak-model output; or (b) the AI flagged a
    // REVIEW matter (collab/complaint/…) that a person must take over. Recorded as
    // human_handoff_reason so the Inbox can nudge staff to use "Log order" for the "outage" case
    // specifically — a manual reply typed from here never runs captureOrder, so a reservation/order
    // a human finishes by hand after an outage would otherwise never reach the Orders page.
    if (ai.unavailable || detectedReview) {
      await supabaseAdmin
        .from("instagram_conversations")
        .update({ mode: "human", human_handoff_reason: ai.unavailable ? "outage" : "review" })
        .eq("id", conversation.id);
    }
  } catch (error) {
    console.error("Webhook processing error:", error);
  }
}

/**
 * An echo of an outbound message on the account. Sender/recipient are flipped
 * versus a normal inbound event: the business account is the sender, the guest
 * is the recipient.
 *
 * We never know in advance whether an echo is one of ours (AI reply or a
 * dashboard-sent reply, both already stored with this same mid when sent) or a
 * reply typed directly in the Instagram app on someone's phone (never stored
 * anywhere). Rather than guess, we just try to insert it: the partial unique
 * index on (conversation_id, instagram_msg_id) makes a duplicate a no-op via
 * the same 23505 swallow used for inbound retries, while a genuinely new mid
 * inserts cleanly — which is exactly the phone-app case this exists to catch.
 */
async function processEcho(igAccountId: string, messaging: Messaging) {
  const igsid = messaging.recipient.id;
  const text = messaging.message.text;
  const instagramMsgId = messaging.message.mid;

  try {
    const account = await resolveAccountByIgId(igAccountId);
    if (!account) return;

    const conversation = await findOrCreateConversation(account, igsid);
    if (!conversation) return;

    const { error: insertError } = await supabaseAdmin.from("instagram_messages").insert({
      conversation_id: conversation.id,
      role: "assistant",
      content: text,
      instagram_msg_id: instagramMsgId,
    });
    if (insertError?.code === "23505") return; // ours — already recorded when sent

    // Genuinely new: sent from outside Instasuite (the phone app). A human is
    // clearly already handling this guest, so stop the AI from also replying.
    await touch(conversation.id);
    await supabaseAdmin
      .from("instagram_conversations")
      .update({ mode: "human" })
      .eq("id", conversation.id);
  } catch (error) {
    console.error("Webhook echo processing error:", error);
  }
}

/**
 * A system-prompt note describing what has already been captured from this guest, so the AI
 * never re-asks for a name, number or pickup time it has on file. Returns "" when there is no
 * order yet, or on any error — this only ever ADDS grounding, so a failure here must not break
 * the reply. See the call site in generateAndSendReply for why this is a system line rather
 * than part of the message history.
 */
async function capturedOrderNote(conversationId: string): Promise<string> {
  try {
    const { data: order } = await supabaseAdmin
      .from("orders")
      .select("kind, customer_name, details, status")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ kind: string; customer_name: string | null; details: string | null; status: string }>();
    if (!order) return "";

    const state =
      order.status === "completed"
        ? "This has ALREADY HAPPENED and is closed (the guest dined / collected). Never re-confirm it or ask about its details — if they now want something else, take it as a brand-new request."
        : order.status === "confirmed"
          ? "Our team has ALREADY CONFIRMED this with the guest — refer to it as confirmed and never say the team will confirm it."
          : order.status === "cancelled"
            ? "This was CANCELLED. Do not treat it as active."
            : "Our team has not confirmed this yet.";

    return [
      "ALREADY CAPTURED IN THIS CONVERSATION — never ask the guest for any of these details again; you already have them:",
      `· Type: ${order.kind}`,
      order.customer_name ? `· Name: ${order.customer_name}` : null,
      order.details ? `· ${order.details}` : null,
      `· ${state}`,
    ]
      .filter(Boolean)
      .join("\n");
  } catch {
    return "";
  }
}

// Persist a captured reservation/takeaway as a pending order row. Guarded so it can never
// break the reply (already sent above), and swallows the 23505 dedupe collision the same way
// the message insert does. Staff confirm it later from the Orders page.
async function captureOrder(
  account: ResolvedAccount,
  conversation: { id: string; igsid: string; name?: string | null; username?: string | null },
  detected: NonNullable<ReturnType<typeof detectHandoff>>
) {
  try {
    const customer =
      detected.customer || conversation.name || conversation.username || "Guest";

    // One live order per conversation per kind. The AI often re-emits the SAME order with
    // slightly different wording ("half and half (X and Y)" then "HnH X + Y"); dedupe_key is a
    // hash of the exact line, so each rewording used to slip through and create another row —
    // one real order became three, each with its own Confirm button and its own DM to the guest.
    // The later emission is normally the more complete one (it has picked up the name/contact),
    // so refresh the open row instead of inserting beside it. The `status` guard makes the update
    // lose safely to a staff confirm that landed a moment earlier, rather than silently rewriting
    // an order the guest has already been told is going ahead.
    const { data: open } = await supabaseAdmin
      .from("orders")
      .select("id")
      .eq("conversation_id", conversation.id)
      .eq("kind", detected.kind)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ id: string }>();

    if (open) {
      await supabaseAdmin
        .from("orders")
        .update({
          customer_name: customer,
          details: detected.summary,
          scheduled_at: detected.scheduledAt,
          dedupe_key: dedupeKey(detected.kind, conversation.id, detected.line),
        })
        .eq("id", open.id)
        .eq("status", "pending");
      return;
    }

    const { error } = await supabaseAdmin.from("orders").insert({
      business_id: account.businessId,
      conversation_id: conversation.id,
      igsid: conversation.igsid,
      instagram_account_id: account.accountId,
      kind: detected.kind,
      customer_name: customer,
      details: detected.summary,
      scheduled_at: detected.scheduledAt,
      dedupe_key: dedupeKey(detected.kind, conversation.id, detected.line),
    });
    if (error && error.code !== "23505") {
      console.warn("orders insert failed:", error.message);
    }
  } catch (err) {
    console.warn("captureOrder error:", (err as Error).message);
  }
}

// Persist a captured REVIEW matter (collab/complaint/billing/event/other) as a pending review row.
// Same guards as captureOrder: never breaks the reply (already sent), swallows the 23505 dedupe
// collision. Staff work these from the Review page; the conversation is flipped to human above.
async function captureReview(
  account: ResolvedAccount,
  conversation: { id: string; igsid: string; name?: string | null; username?: string | null },
  detected: NonNullable<ReturnType<typeof detectReview>>
) {
  try {
    const customer =
      detected.customer || conversation.name || conversation.username || "Guest";
    const { error } = await supabaseAdmin.from("review_items").insert({
      business_id: account.businessId,
      conversation_id: conversation.id,
      igsid: conversation.igsid,
      instagram_account_id: account.accountId,
      category: detected.category,
      customer_name: customer,
      details: detected.summary,
      dedupe_key: dedupeKey("review", conversation.id, detected.line),
    });
    if (error && error.code !== "23505") {
      console.warn("review_items insert failed:", error.message);
    }
  } catch (err) {
    console.warn("captureReview error:", (err as Error).message);
  }
}

async function findOrCreateConversation(account: ResolvedAccount, igsid: string) {
  // Scoped by account: the same customer may talk to several tenants, and each
  // gets its own conversation (this is what UNIQUE(instagram_account_id, igsid) allows).
  const { data: existing } = await supabaseAdmin
    .from("instagram_conversations")
    .select("*")
    .eq("instagram_account_id", account.accountId)
    .eq("igsid", igsid)
    .maybeSingle();

  const profile = await fetchInstagramProfile(igsid, account.accessToken);

  if (existing) {
    // Only write back the fields Instagram actually returned.
    //
    // fetchInstagramProfile swallows every failure and answers all-nulls by design, so it
    // can never block a reply. Spreading that straight into an UPDATE meant one bad lookup
    // ERASED a name we already had, and the chat silently reverted to the bare 16-digit
    // igsid the list falls back to. Transient timeouts did it, and so did the permanent
    // "User consent is required to access user profile" (code 230) refusal, which recurs
    // on every single message from that guest.
    //
    // Strict `== null` rather than a falsy check: follower_count 0 and a false
    // is_user_follow_business are real values worth storing.
    const fresh = Object.fromEntries(
      Object.entries(profile).filter(([, v]) => v != null)
    );
    if (Object.keys(fresh).length) {
      await supabaseAdmin.from("instagram_conversations").update(fresh).eq("id", existing.id);
    }
    return { ...existing, ...fresh };
  }

  const { data: created, error } = await supabaseAdmin
    .from("instagram_conversations")
    .insert({ instagram_account_id: account.accountId, igsid, ...profile })
    .select()
    .single();

  if (error) console.error("Conversation insert failed:", error.message);
  return created;
}

async function touch(conversationId: string) {
  await supabaseAdmin
    .from("instagram_conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", conversationId);
}

// Per-reply COGS. Phase 3 bills off this table.
async function recordUsage(
  account: ResolvedAccount,
  ai: Awaited<ReturnType<typeof getAIResponse>>
) {
  if (ai.provider === "none") return;
  // Haiku 4.5: $1/1M in, $5/1M out -> cents per token.
  const costCents =
    ai.provider === "claude" && ai.inputTokens != null && ai.outputTokens != null
      ? (ai.inputTokens / 1_000_000) * 100 + (ai.outputTokens / 1_000_000) * 500
      : 0;

  await supabaseAdmin.from("usage_events").insert({
    client_id: account.clientId,
    business_id: account.businessId,
    instagram_account_id: account.accountId,
    kind: "ai_reply",
    model: ai.model,
    input_tokens: ai.inputTokens,
    output_tokens: ai.outputTokens,
    cost_cents: costCents,
  });
}
