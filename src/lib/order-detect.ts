import crypto from "node:crypto";

// Detects the structured "handoff line" the AI appends when it finalizes a reservation or
// takeaway, so the webhook can (a) strip it from what the guest sees and (b) capture a real
// order row. Pure and synchronous — it runs in the reply path and must never throw.
//
// Reservation line (pipe-delimited; the script instructs the AI to emit exactly this):
//   RESERVATION | Outlet: <outlet> | Name: <name> | Date: <date> | Time: <time> | Guests: <n> | Contact: <number or ->
// Takeaway line (existing "Team Handoff Note Format" in the script):
//   TAKEAWAY [Outlet]–[City] / [Items] / Name:<name> | Contact:<number> | Pickup:<time>

const RESERVATION_RE = /^[ \t]*RESERVATION\s*\|.*$/im;
const TAKEAWAY_RE = /^[ \t]*TAKEAWAY\b.*$/im;
// Non-order handoff: anything that needs a human (collab/complaint/billing/event/other).
//   REVIEW | Type: <collaboration|complaint|billing|event|other> | Name: <name or -> | Contact: <number or -> | Summary: <one line>
const REVIEW_RE = /^[ \t]*REVIEW\s*\|.*$/im;

export type OrderKind = "reservation" | "takeaway";
export type DetectedOrder = {
  kind: OrderKind;
  /** The exact handoff line (used for the dedupe key). */
  line: string;
  /** Guest name parsed from the line, if present. */
  customer: string | null;
  /** The outlet named on the line, if present — matched against closure rules before capture. */
  outlet: string | null;
  /** A clean, human-readable summary for the dashboard + confirmation message. */
  summary: string;
  /** The reservation/pickup time as a UTC ISO string (from the `At:` field), or null. */
  scheduledAt: string | null;
};

/** The known review buckets. Free-text `Type:` is normalised to one of these; anything else → "other". */
export type ReviewCategory = "collaboration" | "complaint" | "billing" | "event" | "cancellation" | "other";
export type DetectedReview = {
  /** The exact handoff line (used for the dedupe key). */
  line: string;
  /** Normalised bucket parsed from the line's `Type:` field. */
  category: ReviewCategory;
  /** Guest name parsed from the line, if present. */
  customer: string | null;
  /** A clean, human-readable summary for the dashboard. */
  summary: string;
};

// Map the AI's free-text `Type:` onto a known bucket. Substring match so "paid collab" → collaboration,
// "payment issue" → billing, etc.; unrecognised (or missing) falls back to "other".
//
// The collaboration list is deliberately wide: that bucket is the one the webhook
// suppresses the AI's reply for, so a partnership pitch filed as "other" would get
// answered automatically — the exact thing the suppression exists to prevent. Widening
// it is safe in one direction only, because this runs on matters the AI has ALREADY
// flagged for review; it can never silence an ordinary guest.
//
// It stays tight in the other direction, though: collaboration is tested BEFORE
// complaint, so an over-broad term here (a bare "media", say, matching "social media
// complaint") would silence someone with a real problem. Every term below reads as
// partnership-shaped on its own.
function normalizeCategory(type: string | undefined): ReviewCategory {
  const t = (type || "").toLowerCase();
  if (/cancel/.test(t)) return "cancellation";
  if (
    /collab|partner|promo|sponsor|barter|influencer|ambassador|ugc|shout ?out|brand deal|advertis|marketing/.test(t)
  ) {
    return "collaboration";
  }
  if (/complain|issue|problem|refund|angry/.test(t)) return "complaint";
  if (/bill|payment|invoice|charge/.test(t)) return "billing";
  if (/event|party|large group|group booking|catering/.test(t)) return "event";
  return "other";
}

// Parse `Key: value | Key: value` pairs out of a line. The reservation line is fully
// pipe-delimited so this yields every field; the takeaway line only partially matches
// (brackets/slashes break the key), which is fine — its customer falls back to the profile.
function parseFields(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of line.split("|")) {
    const m = part.match(/^\s*([A-Za-z ]+?)\s*:\s*(.+?)\s*$/);
    if (m) out[m[1].trim().toLowerCase()] = m[2].trim();
  }
  return out;
}

// Parse the `At:` field ("YYYY-MM-DD HH:MM", an IST wall-clock the AI computed) into a UTC
// ISO string, so the Inbox can tell when the reservation/pickup time has passed. Returns null
// if absent or unparseable — such an order never counts as "completed".
function parseIstToUtc(at: string | undefined): string | null {
  if (!at) return null;
  const m = at.match(/^\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  return istToUtcIso(+y, +mo, +d, +h, +mi);
}

// An IST wall-clock (Y/M/D H:M) → the UTC ISO instant. IST = UTC+5:30, so subtract 5.5h.
function istToUtcIso(y: number, mo: number, d: number, h: number, mi: number): string | null {
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi) - 5.5 * 3600 * 1000);
  return isNaN(dt.getTime()) ? null : dt.toISOString();
}

// Today's date in IST (used as the base date for a takeaway pickup, which is same-day).
function istToday(): { y: number; mo: number; d: number } {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return { y: ist.getUTCFullYear(), mo: ist.getUTCMonth() + 1, d: ist.getUTCDate() };
}

// Parse a wall-clock time ("1:35 PM", "1:35pm", "13:35", "7 PM") into 24h. Null if unparseable.
function parseClock(str: string | undefined): { h: number; m: number } | null {
  if (!str) return null;
  const m = str.match(/(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ap = m[3]?.toLowerCase().replace(/\./g, "");
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  return h > 23 || min > 59 ? null : { h, m: min };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Parse an ABSOLUTE date ("2026-07-30", "30 Jul", "30 Jul 2026", "Jul 30"). Null for anything vague
// ("today", "Saturday", blank) — a reservation with no real date must not be guessed onto today.
function parseAbsDate(str: string | undefined): { y: number; mo: number; d: number } | null {
  if (!str) return null;
  const s = str.trim();
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return { y: +m[1], mo: +m[2], d: +m[3] };
  m = s.match(/(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*(\d{4})?/i);
  if (m) return { y: m[3] ? +m[3] : istToday().y, mo: MONTHS.indexOf(m[2].toLowerCase()) + 1, d: +m[1] };
  m = s.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*(\d{1,2})(?:\s*,?\s*(\d{4}))?/i);
  if (m) return { y: m[3] ? +m[3] : istToday().y, mo: MONTHS.indexOf(m[1].toLowerCase()) + 1, d: +m[2] };
  return null;
}

// Fallback when the AI omits the structured `At:` field: derive scheduled_at from the fields the script
// already emits. Takeaway = Pickup time on today's IST date (same-day). Reservation = Time + an ABSOLUTE
// Date only (never assume today for a booking, or an upcoming reservation would wrongly "complete").
function deriveScheduledAt(kind: OrderKind, f: Record<string, string>): string | null {
  if (kind === "takeaway") {
    const t = parseClock(f["pickup"]);
    if (!t) return null;
    const { y, mo, d } = istToday();
    return istToUtcIso(y, mo, d, t.h, t.m);
  }
  const t = parseClock(f["time"]);
  const date = parseAbsDate(f["date"]);
  if (!t || !date) return null;
  return istToUtcIso(date.y, date.mo, date.d, t.h, t.m);
}

export function detectHandoff(reply: string): DetectedOrder | null {
  const r = reply.match(RESERVATION_RE);
  if (r) {
    const line = r[0].trim();
    const f = parseFields(line);
    const summary =
      [
        f["outlet"] && `Outlet: ${f["outlet"]}`,
        f["date"] && `Date: ${f["date"]}`,
        f["time"] && `Time: ${f["time"]}`,
        f["guests"] && `Guests: ${f["guests"]}`,
        f["contact"] && f["contact"] !== "-" && `Contact: ${f["contact"]}`,
      ]
        .filter(Boolean)
        .join(" · ") || line.replace(/^RESERVATION\s*\|?\s*/i, "").trim();
    return { kind: "reservation", line, customer: f["name"] || null, outlet: f["outlet"] || null, summary, scheduledAt: parseIstToUtc(f["at"]) ?? deriveScheduledAt("reservation", f) };
  }

  const t = reply.match(TAKEAWAY_RE);
  if (t) {
    const line = t[0].trim();
    const f = parseFields(line);
    const summary =
      [
        f["outlet"] && `Outlet: ${f["outlet"]}`,
        f["items"] && `Items: ${f["items"]}`,
        f["pickup"] && `Pickup: ${f["pickup"]}`,
        f["contact"] && f["contact"] !== "-" && `Contact: ${f["contact"]}`,
      ]
        .filter(Boolean)
        .join(" · ") || line.replace(/^TAKEAWAY\s*\|?\s*/i, "").trim();
    return { kind: "takeaway", line, customer: f["name"] || null, outlet: f["outlet"] || null, summary, scheduledAt: parseIstToUtc(f["at"]) ?? deriveScheduledAt("takeaway", f) };
  }

  return null;
}

// Detect the REVIEW handoff line (a non-order matter needing a human). Independent of detectHandoff —
// a single reply could in principle carry both, and they go to different tables.
export function detectReview(reply: string): DetectedReview | null {
  const m = reply.match(REVIEW_RE);
  if (!m) return null;
  const line = m[0].trim();
  const f = parseFields(line);
  const summary =
    f["summary"] || line.replace(/^REVIEW\s*\|?\s*/i, "").trim();
  return {
    line,
    category: normalizeCategory(f["type"]),
    customer: f["name"] && f["name"] !== "-" ? f["name"] : null,
    summary,
  };
}

// Remove the handoff line(s) from the reply so the guest sees only the clean confirmation.
export function stripHandoff(reply: string): string {
  return reply
    .replace(RESERVATION_RE, "")
    .replace(TAKEAWAY_RE, "")
    .replace(REVIEW_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Backs the orders.dedupe_key unique constraint — a verbatim re-emission collapses to one
// order; an edited one (different line) captures anew.
export function dedupeKey(kind: string, conversationId: string, line: string): string {
  const hash = crypto.createHash("sha1").update(line).digest("hex");
  return `${kind}:${conversationId}:${hash}`;
}

// After an order is placed we hide the pre-order transcript from the AI (see the webhook's history
// fetch). This decides the ONE exception: does the guest's message clearly refer back to an existing
// order? If so, the webhook shows the full history for that turn so the AI can answer. Kept
// conservative — only unambiguous "about a past order" phrasings, not any mention of the words.
const PAST_ORDER_RES = [
  /\b(my|the|that|this) (order|reservation|booking|table|pickup|takeaway)\b/i,
  /\b(cancel|change|modify|update|reschedule|move|edit|amend)\b[^.?!]*\b(order|reservation|booking|table|pickup)\b/i,
  /\bwhat (did|have) i (order|book|reserve)/i,
  /\b(already|previously|earlier|before) (ordered|booked|reserved|placed)\b/i,
  /\border (status|number|no\.?|id|details|confirmation)\b/i,
  /\bthe (order|reservation|booking) i (placed|made|had|did)\b/i,
  /\b(previous|earlier|last|prior) (order|reservation|booking)\b/i,
];

export function refersToPastOrder(text: string): boolean {
  if (!text || !text.trim()) return false;
  return PAST_ORDER_RES.some((re) => re.test(text));
}

// A booking whose time has already passed. On 18 Sep a guest typed "17th sep" (meaning the 18th),
// the agent recapped it as "a breakfast reservation for tomorrow morning" — about yesterday — and
// the order was captured, confirmed and completed 35 hours in the past. The model is given the
// current date on every turn and still did this, so the webhook checks it in code.
//
// The 15-minute grace is for "a table right now" / an ASAP pickup, which the agent writes as the
// current minute; the capture lands seconds later and would otherwise refuse the keenest guests.
// Null → false: a handoff with no pinned date can't be judged (same stance as findClosedDay).
const PAST_GRACE_MS = 15 * 60 * 1000;

export function isPastBooking(scheduledAtIso: string | null, nowMs: number): boolean {
  if (!scheduledAtIso) return false;
  const at = new Date(scheduledAtIso).getTime();
  if (Number.isNaN(at)) return false;
  return at < nowMs - PAST_GRACE_MS;
}
