import { NextRequest, NextResponse } from "next/server";
import { holdSeats, authorizeWithFailover, fulfillAndCapture } from "@/lib/checkout";
import { CONNECTORS, type ConnectorKey, type TraceEntry } from "@/lib/hyperswitch";

export const dynamic = "force-dynamic";

/**
 * The demo-theater "buy" endpoint.
 * Runs the entire journey — hold, authorize (with failover), fulfil+capture —
 * in one request and returns the full trace of real Hyperswitch calls so the
 * showcase page can replay them in real time.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { eventId, tierId, qty, card, priority, buyerEmail } = body ?? {};

  if (!eventId || !tierId || !card?.number) {
    return NextResponse.json({ error: "eventId, tierId and card are required" }, { status: 400 });
  }

  const trace: TraceEntry[] = [];
  const valid = priority?.filter((c: string) => c in CONNECTORS) as ConnectorKey[] | undefined;

  try {
    // 1. Hold seats + create payment intent (manual capture)
    const hold = await holdSeats({
      eventId,
      tierId,
      qty: Number(qty ?? 1),
      buyerEmail,
      returnUrl: process.env.NEXT_PUBLIC_APP_URL,
      trace,
    });

    // 2. Authorize with failover across the routing priority
    const auth = await authorizeWithFailover({
      orderId: hold.orderId,
      card: {
        number: String(card.number).replace(/\s+/g, ""),
        expMonth: String(card.expMonth ?? "12"),
        expYear: String(card.expYear ?? "2030"),
        holder: String(card.holder ?? "SeatNerd Buyer"),
        cvc: String(card.cvc ?? "123"),
      },
      priority: valid && valid.length > 0 ? valid : undefined,
      trace,
    });

    if (!auth.success) {
      return NextResponse.json({
        ok: false,
        orderId: hold.orderId,
        trace,
        attempts: auth.attempts,
      });
    }

    // 3. Issue barcodes, then capture
    const fulfil = await fulfillAndCapture(hold.orderId, trace);

    return NextResponse.json({
      ok: true,
      orderId: hold.orderId,
      paymentId: auth.paymentId,
      total: hold.total,
      trace,
      attempts: auth.attempts,
      tickets: fulfil.tickets,
      captured: fulfil.captured,
      captureSkippedReason: fulfil.captureSkippedReason ?? null,
      finalConnector: auth.finalConnector,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message, trace }, { status: 400 });
  }
}
