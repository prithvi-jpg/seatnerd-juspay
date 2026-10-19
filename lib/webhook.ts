/**
 * Hyperswitch outgoing webhook verification.
 *
 * Scheme verified in juspay/hyperswitch source — crates/router/src/core/webhooks/types.rs:
 *   HMAC-SHA512(raw JSON body, payment_response_hash_key), hex-encoded,
 *   delivered in header X-WEBHOOK-SIGNATURE.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const HASH_KEY = process.env.HYPERSWITCH_PAYMENT_RESPONSE_HASH_KEY ?? "";

export function verifyWebhookSignature(rawBody: string, signatureHeader: string | null): boolean {
  if (!HASH_KEY || !signatureHeader) return false;
  const expected = createHmac("sha512", HASH_KEY).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signatureHeader.trim(), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Webhook event envelope as emitted by Hyperswitch (webhook_events.rs shape). */
export interface HsWebhookEvent {
  type?: string;
  event_type?: string;
  data?: {
    object?: {
      payment_id?: string;
      status?: string;
      amount?: number;
      currency?: string;
      metadata?: Record<string, unknown> | null;
      attempt_count?: number;
    } | null;
  } | null;
  payment_id?: string;
  status?: string;
  metadata?: Record<string, unknown> | null;
}

export function extractEvent(e: HsWebhookEvent): {
  type: string;
  paymentId: string;
  status?: string;
  metadata?: Record<string, unknown> | null;
} {
  const type = e.type ?? e.event_type ?? "unknown";
  const obj = e.data?.object;
  return {
    type,
    paymentId: obj?.payment_id ?? e.payment_id ?? "",
    status: obj?.status ?? e.status,
    metadata: obj?.metadata ?? e.metadata,
  };
}
