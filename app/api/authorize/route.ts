import { NextRequest, NextResponse } from "next/server";
import { authorizeWithFailover } from "@/lib/checkout";
import { CONNECTORS, type ConnectorKey } from "@/lib/hyperswitch";

export const dynamic = "force-dynamic";

/** Server-side authorization with explicit routing — powers the failover demo. */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { orderId, card, priority } = body ?? {};

    if (!orderId || !card?.number) {
      return NextResponse.json({ error: "orderId and card are required" }, { status: 400 });
    }

    const valid = priority?.filter((c: string) => c in CONNECTORS) as ConnectorKey[] | undefined;
    const result = await authorizeWithFailover({
      orderId,
      card: {
        number: String(card.number).replace(/\s+/g, ""),
        expMonth: String(card.expMonth),
        expYear: String(card.expYear),
        holder: String(card.holder ?? "SeatNerd Buyer"),
        cvc: String(card.cvc),
      },
      priority: valid && valid.length > 0 ? valid : undefined,
    });

    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
