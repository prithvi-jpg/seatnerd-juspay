import { NextRequest, NextResponse } from "next/server";
import { holdSeats, sweepExpiredHolds } from "@/lib/checkout";
import { formatUSD, cents } from "@/lib/money";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    // Lazy hold expiry: clean stale holds before taking new inventory.
    await sweepExpiredHolds().catch(() => {});
    const body = await req.json();
    const { eventId, tierId, qty, buyerEmail } = body ?? {};

    const result = await holdSeats({
      eventId,
      tierId,
      qty: Number(qty),
      buyerEmail,
      returnUrl: process.env.NEXT_PUBLIC_APP_URL,
    });

    return NextResponse.json({
      orderId: result.orderId,
      paymentId: result.paymentId,
      clientSecret: result.clientSecret,
      total: result.total,
      totalLabel: formatUSD(cents(result.total)),
      breakdown: {
        faceValue: result.breakdown.faceValue,
        serviceFee: result.breakdown.serviceFee,
        facilityFee: result.breakdown.facilityFee,
      },
      holdExpiresAt: result.holdExpiresAt,
    });
  } catch (e) {
    const msg = (e as Error).message;
    return NextResponse.json(
      { error: msg, soldOut: msg.startsWith("SOLD_OUT") },
      { status: msg.startsWith("SOLD_OUT") ? 409 : 400 },
    );
  }
}
