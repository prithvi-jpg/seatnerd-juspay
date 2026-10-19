/**
 * Order state machine for ticketing.
 *
 * Deliberately explicit: one enum, one transition table, one function.
 * The whole point of this module is that an order's lifecycle is auditable and
 * that illegal transitions are impossible rather than merely unlikely.
 *
 * The ticketing-specific invariant this encodes:
 *
 *   inventory is HELD at authorisation, and only CONSUMED at capture.
 *
 * Money is never captured for a seat that was not issued. If fulfilment fails
 * or the hold expires, we VOID the authorisation and return the seat to
 * inventory. This is why capture_method = manual is not decoration.
 */

export type OrderState =
  | "draft"          // cart exists, no seats held
  | "holding"        // seats held, payment intent created, not yet authorised
  | "authorized"     // funds authorised (or settled by a connector that ignores manual capture)
  | "issuing"        // authorised + fulfilment in progress (barcode generation)
  | "issued"         // barcodes issued AND funds captured -> terminal success
  | "released"       // hold expired/abandoned, auth voided, seats returned -> terminal
  | "failed"         // payment failed after all routing attempts -> terminal
  | "refunded";      // post-issue refund -> terminal

export const TERMINAL_STATES: ReadonlySet<OrderState> = new Set<OrderState>([
  "issued",
  "released",
  "failed",
  "refunded",
]);

/** Allowed transitions. Anything not listed here is a bug, not an edge case. */
const TRANSITIONS: Record<OrderState, readonly OrderState[]> = {
  draft:      ["holding", "failed"],
  holding:    ["authorized", "failed", "released"],
  authorized: ["issuing", "released", "failed"],
  issuing:    ["issued", "released", "failed"],
  issued:     ["refunded"],
  released:   [],
  failed:     [],
  refunded:   [],
};

export class IllegalTransition extends Error {
  constructor(from: OrderState, to: OrderState) {
    super(`Illegal order transition: ${from} -> ${to}`);
    this.name = "IllegalTransition";
  }
}

export function canTransition(from: OrderState, to: OrderState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OrderState, to: OrderState): void {
  if (!canTransition(from, to)) throw new IllegalTransition(from, to);
}

/**
 * Map a Hyperswitch IntentStatus to our order state.
 *
 * Status strings verified against `IntentStatus` in
 * crates/common_enums/src/enums.rs of juspay/hyperswitch (serialised snake_case).
 *
 * NOTE the `succeeded` case. On a manual-capture intent we expect
 * `requires_capture`, but the sandbox dummy connectors settle immediately and
 * return `succeeded`. We handle both rather than assuming the ideal path —
 * see VERIFICATION.md V5. `alreadyCaptured` tells the caller whether a
 * separate /capture call is still required.
 */
export type HyperswitchIntentStatus =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "cancelled_post_capture"
  | "processing"
  | "requires_customer_action"
  | "requires_merchant_action"
  | "requires_payment_method"
  | "requires_confirmation"
  | "requires_capture"
  | "partially_captured"
  | "partially_captured_and_capturable"
  | "partially_authorized_and_requires_capture";

export interface PaymentOutcome {
  /** Funds are secured (authorised or already settled). Safe to fulfil. */
  authorized: boolean;
  /** Connector already took the money; do NOT call /capture (would return IR_14). */
  alreadyCaptured: boolean;
  /** Buyer must complete an action (3DS/redirect). */
  needsCustomerAction: boolean;
  /** Terminal failure for this attempt. */
  failed: boolean;
  /** Still in flight; reconcile via webhook or force_sync retrieve. */
  pending: boolean;
}

export function interpretIntentStatus(s: HyperswitchIntentStatus | string): PaymentOutcome {
  const base: PaymentOutcome = {
    authorized: false,
    alreadyCaptured: false,
    needsCustomerAction: false,
    failed: false,
    pending: false,
  };
  switch (s) {
    case "requires_capture":
    case "partially_authorized_and_requires_capture":
      return { ...base, authorized: true };

    case "succeeded":
    case "partially_captured":
    case "partially_captured_and_capturable":
      // Authorised AND settled. Fulfil, but skip the capture call.
      return { ...base, authorized: true, alreadyCaptured: true };

    case "requires_customer_action":
      return { ...base, needsCustomerAction: true };

    case "processing":
    case "requires_confirmation":
    case "requires_payment_method":
    case "requires_merchant_action":
      return { ...base, pending: true };

    case "failed":
    case "cancelled":
    case "cancelled_post_capture":
      return { ...base, failed: true };

    default:
      // Unknown status: treat as pending and reconcile. Never assume success.
      return { ...base, pending: true };
  }
}

/**
 * Retryability classification.
 *
 * Verified live (see VERIFICATION.md V2/V4): on the sandbox dummy connectors a
 * transient connector error and a stolen card BOTH return error_code `DC_08`
 * and unified_code `UE_9000`. Only the message differs. So a naive retry keyed
 * on the code alone would happily retry a stolen card — which wastes an attempt
 * and, in production, damages the merchant's auth-rate reputation with issuers.
 *
 * Hyperswitch's own answer is the Gateway Status Map (GSM): a configured table
 * of (connector, flow, code, message) -> GsmDecision::{Retry, DoDefault, DoNotRetry},
 * consumed by `do_gsm_actions` / `get_gsm_decision` in
 * crates/router/src/core/payments/retry.rs.
 *
 * This function is a local stand-in for that table, scoped to what the sandbox
 * actually returns. It is intentionally conservative: unknown -> do not retry.
 */
export type RetryDecision = "retry" | "do_not_retry";

const HARD_DECLINE_MARKERS = [
  "stolen card",
  "lost card",
  "card declined",
  "insufficient funds",
  "expired card",
  "invalid card",
  "card not supported",
];

const TRANSIENT_MARKERS = [
  "internal server error",
  "try again later",
  "timeout",
  "temporarily unavailable",
  "processing error",
];

export function classifyFailure(errorMessage?: string | null): RetryDecision {
  const m = (errorMessage ?? "").toLowerCase();
  if (HARD_DECLINE_MARKERS.some((k) => m.includes(k))) return "do_not_retry";
  if (TRANSIENT_MARKERS.some((k) => m.includes(k))) return "retry";
  return "do_not_retry";
}
