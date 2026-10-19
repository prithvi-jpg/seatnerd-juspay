import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { fulfillAndCapture, voidAuthorization, releaseHold } from "@/lib/checkout";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const order = (
    await sql`SELECT * FROM orders WHERE id = ${id}`
  ) as unknown as Array<Record<string, unknown>> | [];

  if (order.length === 0) return NextResponse.json({ error: "not found" }, { status: 404 });
  const o = order[0];

  const events = (await sql`
    SELECT kind, at, from_state, to_state, connector, attempt_no, error_message,
           retry_decision, amount, detail
      FROM order_events WHERE order_id = ${id} ORDER BY id ASC
  `) as unknown as Array<Record<string, unknown>>;

  const tickets = (await sql`
    SELECT seat_label, barcode, issued_at FROM tickets WHERE order_id = ${id} ORDER BY issued_at
  `) as unknown as Array<Record<string, unknown>>;

  return NextResponse.json({ order: o, events, tickets });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const action = body.action ?? "fulfill";

  try {
    if (action === "fulfill") {
      const result = await fulfillAndCapture(id);
      return NextResponse.json(result);
    }
    if (action === "void") {
      await voidAuthorization(id, body.reason ?? "buyer_abandoned");
      return NextResponse.json({ ok: true, action: "voided" });
    }
    if (action === "release") {
      await releaseHold(id, body.reason ?? "manual_release");
      return NextResponse.json({ ok: true, action: "released" });
    }
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
