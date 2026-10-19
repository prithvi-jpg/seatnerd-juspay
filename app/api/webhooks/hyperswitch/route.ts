import { NextRequest, NextResponse } from "next/server";
import { sql, logOrderEvent } from "@/lib/db";
import { verifyWebhookSignature, extractEvent, type HsWebhookEvent } from "@/lib/webhook";
import { fulfillAndCapture, voidAuthorization } from "@/lib/checkout";
import { interpretIntentStatus } from "@/lib/order-state";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Incoming Hyperswitch webhook.
 *
 * Design (per AGENTS.md rule 5): webhooks are the source of truth for payment
 * state, not the browser redirect. Handler is idempotent — duplicates and
 * out-of-order deliveries are expected and handled.
 */
export async function POST(req: NextRequest) {
  const raw = await req.text();
  const signature = req.headers.get("x-webhook-signature") ?? req.headers.get("X-WEBHOOK-SIGNATURE");
  const valid = verifyWebhookSignature(raw, signature);

  let ev: HsWebhookEvent;
  try {
    ev = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const { type, paymentId, status, metadata } = extractEvent(ev);

  // Persist the raw event for audit + idempotency.
  await sql`
    INSERT INTO webhook_log (event_type, payment_id, signature_valid, body)
    VALUES (${type}, ${paymentId}, ${valid}, ${raw})
  `;

  if (!valid) {
    // Log but don't fail loudly — we still record it; the ops console flags it.
    return NextResponse.json({ received: true, signatureValid: false });
  }

  // Find the order by payment id OR by the order_id in metadata (retry legs
  // mint fresh payment intents, so the original order_id metadata is the key).
  const orderIdFromMeta =
    (metadata?.order_id as string) ?? (ev.data?.object?.metadata?.order_id as string) ?? null;

  const order = (
    await sql`
      SELECT * FROM orders
       WHERE payment_id = ${paymentId}
          OR id = ${orderIdFromMeta}
       LIMIT 1
    `
  ) as unknown as Array<Record<string, unknown>> | [];

  if (order.length === 0) {
    return NextResponse.json({ received: true, order: "not_found" });
  }

  const o = order[0];
  const orderId = o.id as string;
  const currentState = o.state as string;

  // Idempotency: terminal states do not move again.
  if (["issued", "released", "refunded", "failed"].includes(currentState)) {
    return NextResponse.json({ received: true, idempotent: true, state: currentState });
  }

  const outcome = interpretIntentStatus(status ?? "");

  if (outcome.authorized) {
    await logOrderEvent({
      orderId,
      kind: "webhook_authorized",
      fromState: currentState,
      toState: "authorized",
      paymentId,
      detail: { status, signatureValid: true },
    });
    await sql`UPDATE orders SET state = 'authorized', updated_at = now() WHERE id = ${orderId}`;

    // Auto-fulfil on confirmed auth (sandbox settles immediately anyway).
    // In production this would be driven by a fulfilment job.
    try {
      await fulfillAndCapture(orderId);
    } catch (e) {
      await logOrderEvent({
        orderId,
        kind: "webhook_fulfil_failed",
        paymentId,
        errorMessage: (e as Error).message,
      });
    }
  } else if (outcome.failed) {
    await logOrderEvent({
      orderId,
      kind: "webhook_failed",
      fromState: currentState,
      toState: "failed",
      paymentId,
      detail: { status },
    });
    if (currentState !== "holding" && currentState !== "authorized") {
      await voidAuthorization(orderId, "webhook_failure");
    }
  } else if (outcome.pending) {
    await logOrderEvent({
      orderId,
      kind: "webhook_pending",
      paymentId,
      detail: { status },
    });
  }

  return NextResponse.json({ received: true, orderId, status });
}
