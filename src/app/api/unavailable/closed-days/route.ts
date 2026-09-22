import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getContext } from "@/lib/ownership";
import { can, isStaff } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { WEEKDAY_NAMES, istToday } from "@/lib/ist";

// Closed days — the third closure list, beside 86'd dishes (/api/unavailable) and closed outlets
// (/api/unavailable/outlets). Same ownership and gating; the difference is that a row here is a
// CALENDAR rule (every Tuesday, or one date) rather than a start/end window, so there is no
// scope/until handling at all.

// Verify the caller owns the business (or is staff) — same helper as its two siblings.
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

type JoinedRow = {
  id: string;
  business_id: string;
  outlet: string | null;
  weekday: number | null;
  on_date: string | null;
  note: string | null;
  created_at: string;
  businesses: { name: string; client_id: string } | null;
};

export async function GET() {
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "unavailable")) return Response.json({ error: "Not found" }, { status: 404 });

  let query = supabaseAdmin
    .from("closed_days")
    .select("id, business_id, outlet, weekday, on_date, note, created_at, businesses!inner(name, client_id)")
    .order("created_at", { ascending: false });

  // Staff see every business's entries; a client only their own.
  if (!isStaff(ctx.user.role)) query = query.eq("businesses.client_id", ctx.user.id);

  const { data, error } = await query;
  if (error) return Response.json({ error: error.message }, { status: 500 });

  // Unlike the window-based lists, a weekly rule never expires, so nothing is filtered out by time.
  // A one-off date that has passed IS dropped — it's spent, and leaving it would grow the list
  // forever with rows nobody can act on.
  const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const rows = ((data ?? []) as unknown as JoinedRow[])
    .filter((r) => r.weekday != null || (r.on_date != null && r.on_date >= today))
    .map((r) => ({
      id: r.id,
      business_id: r.business_id,
      business_name: r.businesses?.name ?? null,
      outlet: r.outlet,
      weekday: r.weekday,
      on_date: r.on_date,
      note: r.note,
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
  // An empty outlet means "every outlet of this business" — same convention as unavailable_dishes.
  const outlet = String(body?.outlet ?? "").trim() || null;
  const note = String(body?.note ?? "").trim() || null;

  const hasWeekday = body?.weekday !== undefined && body?.weekday !== null && body?.weekday !== "";
  const onDate = String(body?.on_date ?? "").trim() || null;

  if (!businessId) return Response.json({ error: "business_id is required" }, { status: 400 });

  // Mirrors the table's CHECK constraint, so the caller gets a sentence instead of a 23514.
  if (hasWeekday === !!onDate) {
    return Response.json(
      { error: "Choose either a repeating weekday or a single date — not both." },
      { status: 400 }
    );
  }

  let weekday: number | null = null;
  if (hasWeekday) {
    weekday = Number(body.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      return Response.json({ error: "Invalid weekday" }, { status: 400 });
    }
  }
  if (onDate && !/^\d{4}-\d{2}-\d{2}$/.test(onDate)) {
    return Response.json({ error: "Invalid date" }, { status: 400 });
  }
  // A past date would save and then vanish at once (the GET drops spent dates), which looks
  // exactly like a failed save.
  if (onDate && onDate < istToday()) {
    return Response.json({ error: "That date has already passed — pick today or later." }, { status: 400 });
  }

  if (!(await ownsBusiness(businessId, ctx))) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const { data, error } = await supabaseAdmin
    .from("closed_days")
    .insert({ business_id: businessId, outlet, weekday, on_date: onDate, note })
    .select("id, business_id, outlet, weekday, on_date, note, created_at")
    .single();
  if (error) return Response.json({ error: error.message }, { status: 500 });

  await logAudit(ctx.user, {
    action: "unavailable.closed_day_add",
    targetType: "closed_day",
    targetId: data.id,
    targetLabel:
      weekday != null ? `${outlet ?? "All outlets"} · every ${WEEKDAY_NAMES[weekday]}` : `${outlet ?? "All outlets"} · ${onDate}`,
  });

  return Response.json(data, { status: 201 });
}
