import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getContext } from "@/lib/ownership";
import { can, isStaff } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { fromIstDateStart, fromIstDateEnd, fromIstDateTime } from "@/lib/ist";

// Closed-outlet closures — sibling of /api/unavailable (which handles 86'd dishes). Same ownership,
// scoping, and IST-window logic; the difference is `outlet` is required and there's no `dish`.

// Verify the caller owns the business (or is staff) — mirrors ownsBusiness in /api/unavailable.
async function ownsBusiness(
  businessId: string,
  ctx: NonNullable<Awaited<ReturnType<typeof getContext>>>
) {
  const { data } = await supabaseAdmin
    .from("businesses")
    .select("id, client_id")
    .eq("id", businessId)
    .maybeSingle<{ id: string; client_id: string }>();
  if (!data) return false;
  return isStaff(ctx.user.role) || data.client_id === ctx.user.id;
}

// End of the current IST day as a UTC instant (an outlet "closed today" clears at IST midnight).
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function endOfIstDay(now = new Date()): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const nextMidnightIst =
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) + 24 * 60 * 60 * 1000;
  return new Date(nextMidnightIst - IST_OFFSET_MS);
}

type JoinedRow = {
  id: string;
  business_id: string;
  outlet: string;
  note: string | null;
  starts_at: string;
  ends_at: string | null;
  created_at: string;
  businesses: { name: string; client_id: string } | null;
};

export async function GET() {
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "unavailable")) return Response.json({ error: "Not found" }, { status: 404 });

  let query = supabaseAdmin
    .from("unavailable_outlets")
    .select("id, business_id, outlet, note, starts_at, ends_at, created_at, businesses!inner(name, client_id)")
    .order("created_at", { ascending: false });

  // Staff see every business's entries; a client only their own.
  if (!isStaff(ctx.user.role)) query = query.eq("businesses.client_id", ctx.user.id);

  const { data, error } = await query;
  if (error) return Response.json({ error: error.message }, { status: 500 });

  // Hide already-ended rows: the page shows only what's live or upcoming. The AI block in
  // availability.ts uses the same rule for outlets, so an upcoming closure listed here is one the
  // agent already knows about.
  const now = Date.now();
  const rows = ((data ?? []) as unknown as JoinedRow[])
    .filter((r) => r.ends_at == null || new Date(r.ends_at).getTime() > now)
    .map((r) => ({
      id: r.id,
      business_id: r.business_id,
      business_name: r.businesses?.name ?? null,
      outlet: r.outlet,
      note: r.note,
      starts_at: r.starts_at,
      ends_at: r.ends_at,
      created_at: r.created_at,
    }));

  return Response.json(rows);
}

export async function POST(request: NextRequest) {
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "unavailable")) return Response.json({ error: "Not found" }, { status: 404 });

  const body = await request.json().catch(() => null);
  const businessId = String(body?.business_id ?? "");
  const outlet = String(body?.outlet ?? "").trim();
  const note = String(body?.note ?? "").trim() || null;
  const scope = String(body?.scope ?? "today"); // "today" | "custom" | "dates" | "open"
  const until = body?.until ? String(body.until) : null;
  // "dates" scope only: an IST calendar range from <input type="date">.
  const fromDate = body?.from_date ? String(body.from_date) : null;
  const toDate = body?.to_date ? String(body.to_date) : null;

  if (!businessId) return Response.json({ error: "business_id is required" }, { status: 400 });
  if (!outlet) return Response.json({ error: "An outlet name is required" }, { status: 400 });
  if (!(await ownsBusiness(businessId, ctx))) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  let startsAt: string | null = null; // null => the DB default now()
  let endsAt: string | null;
  if (scope === "open") {
    endsAt = null;
  } else if (scope === "dates") {
    // A date range on the OUTLET's calendar. `from` may be in the future — this is the only scope
    // that sets starts_at, which is what makes a closure schedulable ahead of time rather than
    // always beginning the moment it is saved.
    if (!fromDate) return Response.json({ error: "A start date is required" }, { status: 400 });
    startsAt = fromIstDateStart(fromDate);
    endsAt = fromIstDateEnd(toDate || fromDate); // one date given => that single day
    if (!startsAt || !endsAt) return Response.json({ error: "Invalid date" }, { status: 400 });
    if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
      return Response.json({ error: "The end date must not be before the start date." }, { status: 400 });
    }
  } else if (scope === "custom") {
    if (!until) return Response.json({ error: "A custom end time is required" }, { status: 400 });
    // `until` is an IST wall-clock from a datetime-local input. It used to go through
    // `new Date(until)`, which reads it in the BROWSER's zone — so an operator working from
    // anywhere but India silently set the wrong end time.
    endsAt = fromIstDateTime(until);
    if (!endsAt) return Response.json({ error: "Invalid end time" }, { status: 400 });
  } else {
    endsAt = endOfIstDay().toISOString(); // "today"
  }
  // A window that has already ended would save and then vanish at once (the GET hides ended rows),
  // which looks exactly like a failed save. The pickers stop this too; a stale tab can't.
  if (endsAt && new Date(endsAt).getTime() <= Date.now()) {
    return Response.json({ error: "That date has already passed — pick today or later." }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("unavailable_outlets")
    .insert({ business_id: businessId, outlet, note, ends_at: endsAt, ...(startsAt ? { starts_at: startsAt } : {}) })
    .select("id, business_id, outlet, note, starts_at, ends_at, created_at")
    .single();
  if (error) return Response.json({ error: error.message }, { status: 500 });

  await logAudit(ctx.user, {
    action: "unavailable.outlet_close",
    targetType: "unavailable_outlet",
    targetId: data.id,
    targetLabel: data.outlet,
  });

  return Response.json(data, { status: 201 });
}
