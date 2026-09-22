// Zero-cost heuristics that run BEFORE any AI call, so trivial messages never
// reach the paid Claude API. Every inbound message used to trigger a full call
// regardless of content — a bare emoji or a "thanks" cost the same as a real
// booking request. This is deliberately conservative: when in doubt, a message
// falls through to the real AI rather than risk silently swallowing something
// that actually needed an answer (e.g. "yes"/"ok" confirming a booking).

// \u{200D} = zero-width joiner (multi-part emoji like a family emoji built
// from several base emoji), \u{FE0F} = variation selector-16 (forces emoji
// presentation), \p{Emoji_Modifier} = skin-tone modifiers (e.g. the 🏽 in
// 👍🏽) — none of these are matched by \p{Extended_Pictographic} on their own.
// Written as escapes, not literal invisible characters, so the source stays
// unambiguous.
const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{200D}\u{FE0F}\s]+$/u;

export function isPureEmoji(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && EMOJI_ONLY.test(trimmed);
}

// Used ONLY for a conversation's first message — these are content-free
// greetings where the script's own instruction is just "send the generic
// welcome and ask reservation or takeaway", so a canned reply is a faithful
// stand-in, not a guess.
const NO_INTENT_OPENERS = new Set([
  "hi",
  "hello",
  "hey",
  "hii",
  "heyy",
  "yo",
  "info",
  "info?",
]);

// Emoji are deliberately NOT handled here. processMessage drops an emoji-only
// message before this runs, so a bare 👋 now gets no reply at all rather than the
// welcome — answering it started a conversation the guest never asked for. Keeping
// the emoji rule in exactly one place stops the two paths from disagreeing.
export function isNoIntentOpener(text: string): boolean {
  return NO_INTENT_OPENERS.has(text.trim().toLowerCase());
}

// Used for any NON-first message. Deliberately narrow — "ok", "okay", "yes",
// "no", "sure", "alright" are excluded on purpose, because those are plausible
// real answers to a pending AI question (e.g. "Shall I confirm that?" -> "ok"
// means yes) and must never be silently dropped.
const TRIVIAL_ACKS = new Set([
  "thanks",
  "thank you",
  "thanks!",
  "thank you!",
  "thx",
  "ty",
  "thnx",
  "cheers",
]);

// Emoji handled by processMessage's isPureEmoji guard, not here — see isNoIntentOpener.
export function isTrivialAck(text: string): boolean {
  return TRIVIAL_ACKS.has(text.trim().toLowerCase());
}

// The group's affirmation word, from the VOICE SIGNATURE block in the Capiche and Aiko
// scripts. It doubles as the name of the sister restaurant, which is why it has to be
// suppressed on that brand's own account — see below.
const SIGNATURE_WORD = "Beshak";

export function cannedWelcome(businessName: string, takeawayEnabled: boolean): string {
  // Opens with the brand's affirmation word, per the VOICE SIGNATURE block in the
  // scripts. This reply never reaches the model — it is the no-AI answer to a bare
  // "hi", which is the most common opener there is (a quarter of all conversations).
  // Left as a plain greeting, the single most frequent "first reply of the
  // conversation" would be the one place the signature never appeared.
  //
  // ...except where the brand's own name IS the signature word. "Beshak! Welcome to
  // Beshak" reads as a stutter, and the point of the signature is that the word carries
  // the brand — which the name is already doing. Compared rather than hardcoded to one
  // tenant, because the collision is the actual rule: whenever these two are the same
  // string, the prefix adds nothing.
  const isOwnBrand = businessName.trim().toLowerCase() === SIGNATURE_WORD.toLowerCase();
  const opener = isOwnBrand ? "" : `${SIGNATURE_WORD}! `;

  // The offer has to match what the brand actually does. This line used to promise
  // takeaway for EVERY tenant, so Beshak — dine-in only — advertised a service it does
  // not run, one second in and without ever consulting its script, then had to
  // contradict itself when the guest took it up.
  const offer = takeawayEnabled
    ? "How may I help you today — a table reservation, or a takeaway order?"
    : "Would you like to book a table?";

  return `${opener}Welcome to ${businessName} 👋 ${offer}`;
}

// Sent INSTEAD of the agent's recap when the booking it captured is already in the past (see
// isPastBooking and its gate in the webhook). A past date is almost always a typo the guest fixes in
// one message, so this asks rather than handing the chat to a human — unlike a closed outlet, which
// is policy the guest can't change. Deterministic on purpose: the model's own recap was built on the
// wrong date, and it once called yesterday "tomorrow".
export function pastTimeReply(kind: "reservation" | "takeaway"): string {
  return kind === "takeaway"
    ? "Just to check — that pickup time has already passed. What time would you like to pick up?"
    : "Just to check — that date and time has already passed. Which date and time would you like to book for?";
}

/**
 * What a guest is told when their booking lands on a closed day or a closed outlet.
 *
 * Until now they were told nothing: the recap was discarded and the chat went quietly to staff, so
 * the guest waited on a reply that depended on someone noticing. Like pastTimeReply, this names the
 * problem and asks for another choice, and the agent stays on to take it.
 *
 * `when` arrives ready to read ("on Sunday 27 September 2026", "until Wednesday 23 September 2026,
 * 3:00 pm"). The closure's note is deliberately never passed in: notes are written for staff
 * ("staff shortage", "fully reserved till closing time"), not for guests.
 */
export function closedReply(kind: "reservation" | "takeaway", place: string, when: string): string {
  return kind === "takeaway"
    ? `Sorry, ${place} is closed ${when}, so we can't take a pickup then. Would another day or time work for you?`
    : `Sorry, ${place} is closed ${when}. Would another date work for you?`;
}

type Turn = { role: "user" | "assistant"; content: string };

/**
 * Collapses consecutive same-role turns into one (joined with a newline), in
 * order. Anthropic's Messages API requires strictly alternating user/assistant
 * roles — once bursts are debounced, several stored "user" rows can sit
 * back-to-back with no assistant row between them, which the API would
 * otherwise reject outright.
 */
export function mergeConsecutiveTurns<T extends Turn>(history: T[]): Turn[] {
  const merged: Turn[] = [];
  for (const turn of history) {
    const last = merged[merged.length - 1];
    if (last && last.role === turn.role) {
      last.content = `${last.content}\n${turn.content}`;
    } else {
      merged.push({ role: turn.role, content: turn.content });
    }
  }
  return merged;
}
