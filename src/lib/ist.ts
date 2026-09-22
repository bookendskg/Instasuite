// IST (Asia/Kolkata, UTC+5:30) — the outlets' clock.
//
// The rest of the codebase stores and reasons in UTC, but every human-facing date in this app is a
// wall-clock date in India: "closed Tuesday" means Tuesday in Surat, and a booking on the 15th is the
// 15th there regardless of where the operator's laptop is. Until now the offset was copy-pasted into
// four files with no shared home, which is fine for display but not for logic — this module exists
// because closed-days needs to DERIVE a weekday, not just format one.
//
// A fixed offset is correct here and not a shortcut: India has never observed DST, so there is no
// transition for a zone database to know about.

export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * The IST weekday of an instant: 0 = Sunday … 2 = Tuesday.
 *
 * The naive version — `new Date(ms).getUTCDay()` — is wrong by a whole day for the exact bookings
 * that matter. A Tuesday 9:30 PM IST reservation is stored as Tuesday 16:00 UTC, which happens to
 * agree; but a Tuesday 4:00 AM IST instant is MONDAY 22:30 UTC and would read as Monday. Shifting
 * into IST first is what makes the answer the restaurant's answer.
 */
export function istWeekday(ms: number): number {
  return new Date(ms + IST_OFFSET_MS).getUTCDay();
}

/** The IST calendar date of an instant as "YYYY-MM-DD", for comparing against a `date` column. */
export function istDateKey(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Midnight starting `ms`'s IST calendar day, as a UTC epoch. */
export function istDayStart(ms: number): number {
  return Math.floor((ms + IST_OFFSET_MS) / 86_400_000) * 86_400_000 - IST_OFFSET_MS;
}

/**
 * An `<input type="date">` value ("2026-09-15") → the UTC instant of that IST day's midnight.
 *
 * `new Date("2026-09-15")` parses as UTC midnight and `new Date(v + "T00:00")` parses in the
 * BROWSER's zone — neither is the outlet's midnight. Appending the Z and subtracting the offset
 * pins it to IST whatever the operator's machine is set to.
 */
export function fromIstDateStart(v: string): string | null {
  if (!v) return null;
  const t = new Date(`${v}T00:00:00Z`).getTime();
  return isNaN(t) ? null : new Date(t - IST_OFFSET_MS).toISOString();
}

/** Same, but the END of that IST day — i.e. the following midnight, so the whole day is covered. */
export function fromIstDateEnd(v: string): string | null {
  if (!v) return null;
  const t = new Date(`${v}T00:00:00Z`).getTime();
  return isNaN(t) ? null : new Date(t + 86_400_000 - IST_OFFSET_MS).toISOString();
}

/**
 * An `<input type="datetime-local">` value ("2026-09-15T18:30") read as IST → the UTC instant.
 *
 * The Unavailable page previously did `new Date(v).toISOString()` on this, which interprets the
 * value in whatever zone the operator's machine is set to — so a closure entered from outside India
 * ended at the wrong moment. Appending the Z makes the parse explicit, and subtracting the offset
 * puts it on the outlet's clock.
 */
export function fromIstDateTime(v: string): string | null {
  if (!v) return null;
  const t = new Date(`${v.length === 16 ? v : v.slice(0, 16)}:00Z`).getTime();
  return isNaN(t) ? null : new Date(t - IST_OFFSET_MS).toISOString();
}

/** A UTC ISO instant → the `<input type="date">` value for its IST day. */
export function toIstDateInput(iso: string | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  return isNaN(t) ? "" : istDateKey(t);
}

/** "Tue 15 Sep" — the compact IST label used in the AI prompt and the Unavailable list. */
export function istDayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/** Today's IST date as "YYYY-MM-DD" — the `min` for a date picker, so the past can't be chosen. */
export function istToday(nowMs: number = Date.now()): string {
  return istDateKey(nowMs);
}

const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const LONG_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// "Sun 27 Sep", or with `long` "Sunday 27 September 2026". Built by hand rather than with Intl,
// whose en-IN data writes "Sept" and adds a comma.
function dayLabel(ms: number, long = false): string {
  const d = new Date(ms + IST_OFFSET_MS);
  return long
    ? `${WEEKDAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()} ${LONG_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
    : `${SHORT_DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${SHORT_MONTHS[d.getUTCMonth()]}`;
}

function clockLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * The days a closure covers, in words — shared by the Unavailable list and the AI prompt so the
 * two can never describe the same row differently.
 *
 * A whole-day closure ends at the FOLLOWING midnight, which is how a 27 → 27 range is stored. It
 * used to be shown as that raw instant, "until Mon, 28 Sept, 12:00 am", which reads as closed on
 * Monday; and a 25 → 26 range read as "until Sun, 27 Sept", i.e. closed Sunday, when Sunday was
 * open. Here a midnight end is named by the last day it actually covers, and a start that hasn't
 * happened yet is always stated.
 *
 *   Sun 27 → Sun 27          "Sun 27 Sep (all day)"
 *   Fri 25 → Sat 26          "Fri 25 Sep – Sat 26 Sep"
 *   Today                    "today (Tue 22 Sep)"
 *   started, ends Sat night  "through Sat 26 Sep"
 *   ends at a set time       "until Wed 23 Sep, 3:00 pm"
 *   no end                   "until further notice"
 *
 * `long` spells dates out in full ("Sunday 27 September 2026") for the AI prompt. With the short
 * form the agent turned down a Saturday 26 booking because of a Sunday 27 closure in 2 of 5
 * replays; with the full form, 0 of 8.
 */
export function describeWindow(
  startsAt: string | null,
  endsAt: string | null,
  nowMs: number = Date.now(),
  { long = false }: { long?: boolean } = {}
): string {
  const dayLabel_ = (ms: number) => dayLabel(ms, long);
  const start = startsAt ? new Date(startsAt).getTime() : NaN;
  const end = endsAt ? new Date(endsAt).getTime() : NaN;
  const future = !isNaN(start) && start > nowMs;
  const startIsMidnight = future && istDayStart(start) === start;
  const from = future ? (startIsMidnight ? dayLabel_(start) : `${dayLabel_(start)}, ${clockLabel(start)}`) : "";

  if (isNaN(end)) return future ? `from ${from}, until further notice` : "until further notice";

  if (istDayStart(end) === end) {
    const lastDay = end - 86_400_000; // midnight starting the last day covered
    if (!future) {
      return lastDay === istDayStart(nowMs) ? `today (${dayLabel_(lastDay)})` : `through ${dayLabel_(lastDay)}`;
    }
    if (startIsMidnight && start === lastDay) return `${dayLabel_(lastDay)} (all day)`;
    return `${from} – ${dayLabel_(lastDay)}`;
  }

  const until = `until ${dayLabel_(end)}, ${clockLabel(end)}`;
  return future ? `from ${from} ${until}` : until;
}

export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
