import { supabaseAdmin } from "@/lib/supabase";
import { isSoleOutlet, sameOutlet } from "@/lib/availability";
import { istWeekday, istDateKey, istDayStart, istDayLabel, WEEKDAY_NAMES } from "@/lib/ist";

// Days an outlet simply isn't open — a standing weekly closure ("every Tuesday") or one specific
// date. Two consumers live here together on purpose:
//
//   closedDaysBlock()  -> the text the AI is given
//   findClosedDay()    -> the gate the webhook enforces
//
// Keeping them in one module is the point. The takeaway rule learned this the hard way (0027: "the
// prompt states the rule, the code is what makes it true") — if the prompt and the enforcement read
// the rules through separate code paths, they drift, and the failure is a guest told one thing while
// the system does another.

export type ClosedDay = {
  id: string;
  outlet: string | null; // NULL = every outlet of this business
  weekday: number | null; // 0=Sun … 2=Tue, IST
  on_date: string | null; // "YYYY-MM-DD", an IST calendar date
  note: string | null;
};

const SELECT = "id, outlet, weekday, on_date, note";

/** Every closure rule for a business. Returns [] on any error — never throws into a reply path. */
export async function listClosedDays(businessId: string): Promise<ClosedDay[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from("closed_days")
      .select(SELECT)
      .eq("business_id", businessId)
      .order("created_at", { ascending: true });
    return error ? [] : ((data ?? []) as ClosedDay[]);
  } catch {
    return [];
  }
}

// Does a rule cover this outlet? A NULL outlet on the rule means "all of them".
//
// Matched the way closed OUTLETS are (availability.ts), not by exact name. It used to require the
// exact text, and the two sides never agree for Beshak: the Unavailable dropdown stores its one
// outlet as "Dumas road Surat" while the agent writes "Beshak Surat" on every order. A closed day
// saved for that outlet was therefore invisible to this check, and a booking the agent wrongly
// recapped for that day would have been saved. So: a business with one outlet is covered whatever
// the agent called it, and otherwise names are compared with sameOutlet ("Uni" matches
// "University Road", Piplod never matches Vesu).
function coversOutlet(rule: ClosedDay, outlet: string | null, soleOutlet: boolean): boolean {
  if (!rule.outlet) return true;
  if (soleOutlet) return true;
  if (!outlet) return false;
  return sameOutlet(rule.outlet, outlet);
}

function hits(rule: ClosedDay, ms: number): boolean {
  if (rule.weekday != null) return istWeekday(ms) === rule.weekday;
  if (rule.on_date) return istDateKey(ms) === rule.on_date;
  return false;
}

/**
 * The closed-day rule covering the IST day this instant falls in, or null. Returned (not just a
 * yes/no) so the webhook can tell the guest which day is closed.
 *
 * `scheduledAtIso` is orders.scheduled_at — already a UTC instant derived from the guest's IST
 * wall-clock. A null date means the AI never pinned one down (parseAbsDate deliberately refuses
 * "today"/"Saturday"), and there is nothing to block against, so this answers null rather than
 * guessing: blocking a booking whose date we don't actually know would be worse than missing one.
 */
export async function findClosedDay(
  businessId: string,
  scheduledAtIso: string | null,
  outlet: string | null
): Promise<ClosedDay | null> {
  if (!scheduledAtIso) return null;
  const ms = new Date(scheduledAtIso).getTime();
  if (isNaN(ms)) return null;

  const rules = await listClosedDays(businessId);
  if (!rules.length) return null;
  const soleOutlet = await isSoleOutlet(businessId);
  return rules.find((r) => coversOutlet(r, outlet, soleOutlet) && hits(r, ms)) ?? null;
}

// How far ahead to enumerate concrete dates for the AI. Eight weeks covers every realistic booking
// horizon for a restaurant without bloating the prompt — a weekly rule contributes 8 lines.
const HORIZON_DAYS = 56;

/**
 * The prompt block. Deliberately states the rule AND lists real upcoming dates.
 *
 * Listing dates is not redundancy for its own sake: the model is handed exactly one date ("Current
 * date & time (IST)") and would otherwise have to do calendar arithmetic to decide whether the 23rd
 * is a Tuesday — and REPLY_GUARD already carries a rule added because that arithmetic went wrong
 * before. Resolving the dates server-side turns a reasoning step into a lookup.
 *
 * Returns "" on empty or any error, exactly like getUnavailableBlock, so a missing table or a bad
 * row degrades to "no restrictions" rather than silencing an account.
 */
export async function closedDaysBlock(businessId: string): Promise<string> {
  try {
    const rules = await listClosedDays(businessId);
    if (rules.length === 0) return "";

    const where = (r: ClosedDay) => r.outlet?.trim() || "All outlets";
    const note = (r: ClosedDay) => (r.note?.trim() ? ` — ${r.note.trim()}` : "");

    const weekly = rules
      .filter((r) => r.weekday != null)
      .map((r) => `- ${where(r)}: closed every ${WEEKDAY_NAMES[r.weekday as number]}${note(r)}`);

    // Upcoming concrete dates, from every rule combined, in order.
    const today = istDayStart(Date.now());
    const upcoming: string[] = [];
    for (let i = 0; i < HORIZON_DAYS; i++) {
      const ms = today + i * 86_400_000;
      const matched = rules.filter((r) => hits(r, ms));
      if (matched.length === 0) continue;
      const outlets = matched.map(where);
      const scope = outlets.includes("All outlets") ? "" : ` (${[...new Set(outlets)].join(", ")})`;
      upcoming.push(`${istDayLabel(ms)}${scope}`);
    }

    // One-off dates already past the horizon still deserve a mention, or a closure set for a date
    // three months out would be invisible to the AI until it was nearly here.
    const beyond = rules
      .filter((r) => r.on_date && r.on_date > istDateKey(today + HORIZON_DAYS * 86_400_000))
      .map((r) => `- ${where(r)}: closed on ${r.on_date}${note(r)}`);

    return [
      "## Closed Days (overrides everything)",
      // Phrased to sit alongside REPLY_GUARD's "checks you run against hours, availability or " +
      // "internal rules are silent" — the AI should act on this when a guest's request hits it, not
      // announce the closure list unprompted.
      "The outlet is CLOSED on these days. Never accept, recap or confirm a reservation or pickup for one. If a guest asks for a closed day, tell them the outlet is closed that day and offer the nearest day it is open. Do not bring this up unless their request actually falls on one.",
      ...weekly,
      ...beyond,
      upcoming.length ? `Closed dates coming up: ${upcoming.join(" · ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  } catch {
    return "";
  }
}
