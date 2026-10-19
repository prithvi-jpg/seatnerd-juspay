/**
 * Checkout orchestration.
 *
 * This is the module the whole prototype exists to demonstrate: the point where
 * the *inventory* state machine and the *payment* state machine are coupled.
 *
 * Sequence:
 *   1. hold seats            (inventory: held++)
 *   2. create payment intent (capture_method: manual)
 *   3. authorise             (routed; auto-failover on retryable failures)
 *   4. fulfil                (issue barcodes)
 *   5. capture               (take the money) -- only after barcodes exist
 *   6. on abandon/expiry     (void auth, inventory: held--)
 *
 * The ordering of 4 and 5 is the whole argument. Capture strictly after issue
 * means we can never hold money for a ticket that does not exist.
 */

import { sql, logOrderEvent } from "./db";
import { computeFees, formatUSD, cents } from "./money";
import {
  assertTransition,
  interpretIntentStatus,
  classifyFailure,
  type OrderState,
} from "./order-state";
import {
  createPayment,
  confirmPaymentWithCard,
  retrievePayment,
  capturePayment,
  cancelPayment,
  CONNECTORS,
  ROUTING_PRIORITY,
  type ConnectorKey,
  type HsPayment,
  type TraceEntry,
} from "./hyperswitch";

export const HOLD_TTL_MINUTES = 10;

function orderId(): string {
  return "SN-" + Math.random().toString(36).slice(2, 8).toUpperCase();
}

function barcode(): string {
  return (
    "SN" +
    Math.random().toString(36).slice(2, 8).toUpperCase() +
    Math.random().toString(36).slice(2, 6).toUpperCase()
  );
}

export interface HoldResult {
  orderId: string;
  paymentId: string;
  clientSecret: string;
  total: number;
  breakdown: ReturnType<typeof computeFees>;
  holdExpiresAt: string;
}

/**
 * Step 1+2: take an inventory hold and create the payment intent.
 *
 * The inventory decrement is guarded in SQL: the UPDATE only succeeds if enough
 * unsold, unheld capacity exists. That single statement is the oversell guard —
 * concurrent buyers during an onsale cannot both take the last seat, because the
 * WHERE clause re-checks availability atomically at write time.
 */
export async function holdSeats(args: {
  eventId: string;
  tierId: string;
  qty: number;
  buyerEmail?: string;
  returnUrl?: string;
  trace?: TraceEntry[];
}): Promise<HoldResult> {
  const { eventId, tierId, qty } = args;
  if (!Number.isInteger(qty) || qty < 1 || qty > 8) {
    throw new Error("qty must be an integer between 1 and 8");
  }

  const rows = (await sql`
    UPDATE tiers
       SET held = held + ${qty}
     WHERE id = ${tierId}
       AND capacity - sold - held >= ${qty}
    RETURNING id, name, face_value, capacity, sold, held
  `) as Array<{ id: string; name: string; face_value: number }>;

  if (rows.length === 0) {
    throw new Error("SOLD_OUT: not enough seats available for this tier");
  }
  const tier = rows[0];

  const breakdown = computeFees(cents(tier.face_value), qty);
  const oid = orderId();
  const expires = new Date(Date.now() + HOLD_TTL_MINUTES * 60_000);

  await sql`
    INSERT INTO orders (id, event_id, tier_id, qty, face_value, service_fee,
                        facility_fee, total, state, buyer_email, hold_expires_at)
    VALUES (${oid}, ${eventId}, ${tierId}, ${qty}, ${breakdown.faceValue},
            ${breakdown.serviceFee}, ${breakdown.facilityFee}, ${breakdown.total},
            'holding', ${args.buyerEmail ?? null}, ${expires.toISOString()})
  `;

  await logOrderEvent({
    orderId: oid,
    kind: "hold_created",
    fromState: "draft",
    toState: "holding",
    amount: breakdown.total,
    detail: { tier: tier.name, qty, expiresAt: expires.toISOString() },
  });

  const payment = await createPayment(
    {
      amount: breakdown.total,
      orderId: oid,
      description: `SeatNerd ${tier.name} x${qty}`,
      captureMethod: "manual",
      returnUrl: args.returnUrl,
      metadata: { tier: tier.name, qty, event_id: eventId },
    },
    args.trace,
  );

  if (!payment.payment_id) {
    throw new Error(`Hyperswitch create failed: ${JSON.stringify(payment).slice(0, 300)}`);
  }

  await sql`
    UPDATE orders
       SET payment_id = ${payment.payment_id},
           client_secret = ${payment.client_secret ?? null},
           updated_at = now()
     WHERE id = ${oid}
  `;

  await logOrderEvent({
    orderId: oid,
    kind: "intent_created",
    paymentId: payment.payment_id,
    amount: breakdown.total,
    detail: { capture_method: payment.capture_method, status: payment.status },
  });

  return {
    orderId: oid,
    paymentId: payment.payment_id,
    clientSecret: payment.client_secret ?? "",
    total: breakdown.total,
    breakdown,
    holdExpiresAt: expires.toISOString(),
  };
}

export interface AuthorizeAttempt {
  connector: ConnectorKey;
  status: string;
  ok: boolean;
  errorCode?: string | null;
  errorMessage?: string | null;
  unifiedCode?: string | null;
  retryDecision?: string;
  ms: number;
}

export interface AuthorizeResult {
  orderId: string;
  paymentId: string;
  success: boolean;
  attempts: AuthorizeAttempt[];
  finalConnector?: ConnectorKey;
  alreadyCaptured: boolean;
  needsCustomerAction: boolean;
}

/**
 * Step 3: authorise with application-level failover across the routing priority.
 *
 * IMPORTANT — what this is and is not:
 *
 * Hyperswitch performs connector failover internally via its Gateway Status Map
 * (`do_gsm_actions` / `get_gsm_decision` / `do_retry` in
 * crates/router/src/core/payments/retry.rs), creating a fresh PaymentAttempt under
 * the same PaymentIntent. That is the production mechanism and it is configured in
 * the dashboard, not in merchant code.
 *
 * Here we drive the failover explicitly from the application so the behaviour is
 * *observable* in the demo: each leg is pinned to one connector with `routing.type:
 * "single"`, and we record the decision we would expect GSM to make. This makes the
 * retry visible in the UI and in the audit log rather than hidden inside the router.
 *
 * We also honour the retryable/non-retryable distinction: a stolen card stops the
 * cascade immediately instead of burning attempts across every connector.
 */
export async function authorizeWithFailover(args: {
  orderId: string;
  card: { number: string; expMonth: string; expYear: string; holder: string; cvc: string };
  priority?: ConnectorKey[];
  trace?: TraceEntry[];
}): Promise<AuthorizeResult> {
  const order = (
    (await sql`SELECT * FROM orders WHERE id = ${args.orderId}`) as Array<Record<string, unknown>>
  )[0];
  if (!order) throw new Error("order not found");

  const paymentId = order.payment_id as string;
  const priority = args.priority ?? ROUTING_PRIORITY;
  const attempts: AuthorizeAttempt[] = [];

  let success = false;
  let finalConnector: ConnectorKey | undefined;
  let alreadyCaptured = false;
  let needsCustomerAction = false;

  for (let i = 0; i < priority.length; i++) {
    const connector = priority[i];
    const t0 = Date.now();

    // A payment intent that already failed cannot be re-confirmed; mint a fresh
    // intent for each subsequent leg. (Hyperswitch's internal GSM retry does this
    // for us as a new PaymentAttempt; driving it from outside, we create a new
    // intent so each leg is independently auditable.)
    let pid = paymentId;
    if (i > 0) {
      const fresh = await createPayment(
        {
          amount: order.total as number,
          orderId: args.orderId,
          description: `SeatNerd retry leg ${i + 1}`,
          captureMethod: "manual",
          metadata: { retry_leg: i + 1, original_payment_id: paymentId },
        },
        args.trace,
      );
      pid = fresh.payment_id;
      await sql`UPDATE orders SET payment_id = ${pid}, client_secret = ${fresh.client_secret ?? null}, updated_at = now() WHERE id = ${args.orderId}`;
    }

    let res: HsPayment;
    try {
      res = await confirmPaymentWithCard(pid, args.card, connector, args.trace);
    } catch (e) {
      const ms = Date.now() - t0;
      attempts.push({
        connector,
        status: "transport_error",
        ok: false,
        errorMessage: (e as Error).message,
        retryDecision: "retry",
        ms,
      });
      await logOrderEvent({
        orderId: args.orderId,
        kind: "auth_attempt_error",
        connector,
        paymentId: pid,
        attemptNo: i + 1,
        errorMessage: (e as Error).message,
        retryDecision: "retry",
      });
      continue;
    }

    const ms = Date.now() - t0;
    const outcome = interpretIntentStatus(res.status);

    if (outcome.authorized || outcome.needsCustomerAction) {
      success = outcome.authorized;
      needsCustomerAction = outcome.needsCustomerAction;
      alreadyCaptured = outcome.alreadyCaptured;
      finalConnector = connector;

      attempts.push({ connector, status: res.status, ok: true, ms });
      await sql`UPDATE orders SET connector = ${connector}, updated_at = now() WHERE id = ${args.orderId}`;
      await logOrderEvent({
        orderId: args.orderId,
        kind: outcome.authorized ? "auth_succeeded" : "auth_requires_action",
        fromState: "holding",
        toState: outcome.authorized ? "authorized" : "holding",
        connector,
        paymentId: pid,
        attemptNo: i + 1,
        amount: order.total as number,
        detail: { status: res.status, alreadyCaptured: outcome.alreadyCaptured, ms },
      });
      break;
    }

    // Failed leg — decide whether the cascade continues.
    const decision = classifyFailure(res.error_message);
    attempts.push({
      connector,
      status: res.status,
      ok: false,
      errorCode: res.error_code,
      errorMessage: res.error_message,
      unifiedCode: res.unified_code,
      retryDecision: decision,
      ms,
    });
    await logOrderEvent({
      orderId: args.orderId,
      kind: "auth_failed",
      connector,
      paymentId: pid,
      attemptNo: i + 1,
      errorCode: res.error_code,
      errorMessage: res.error_message,
      unifiedCode: res.unified_code,
      retryDecision: decision,
      detail: { status: res.status, ms },
    });

    if (decision === "do_not_retry") break;
  }

  if (success) {
    await sql`UPDATE orders SET state = 'authorized', updated_at = now() WHERE id = ${args.orderId}`;
  } else if (!needsCustomerAction) {
    await releaseHold(args.orderId, "authorization_failed");
  }

  return {
    orderId: args.orderId,
    paymentId: (
      (await sql`SELECT payment_id FROM orders WHERE id = ${args.orderId}`) as Array<{ payment_id: string }>
    )[0].payment_id,
    success,
    attempts,
    finalConnector,
    alreadyCaptured,
    needsCustomerAction,
  };
}

export interface FulfillResult {
  orderId: string;
  tickets: Array<{ id: string; seatLabel: string; barcode: string }>;
  captured: boolean;
  captureSkippedReason?: string;
}

/**
 * Steps 4+5: issue barcodes, THEN capture.
 *
 * If barcode generation throws, we void the authorisation instead of capturing —
 * the buyer is never charged for tickets that were not issued.
 */
export async function fulfillAndCapture(
  orderIdArg: string,
  trace?: TraceEntry[],
): Promise<FulfillResult> {
  const order = (
    (await sql`SELECT * FROM orders WHERE id = ${orderIdArg}`) as Array<Record<string, unknown>>
  )[0];
  if (!order) throw new Error("order not found");

  const state = order.state as OrderState;
  assertTransition(state, "issuing");
  await sql`UPDATE orders SET state = 'issuing', updated_at = now() WHERE id = ${orderIdArg}`;
  await logOrderEvent({
    orderId: orderIdArg,
    kind: "fulfilment_started",
    fromState: state,
    toState: "issuing",
  });

  const qty = order.qty as number;
  const tickets: Array<{ id: string; seatLabel: string; barcode: string }> = [];

  try {
    for (let i = 0; i < qty; i++) {
      const id = "tkt_" + Math.random().toString(36).slice(2, 10);
      const seatLabel = `GA-${String(i + 1).padStart(3, "0")}`;
      const bc = barcode();
      await sql`
        INSERT INTO tickets (id, order_id, seat_label, barcode)
        VALUES (${id}, ${orderIdArg}, ${seatLabel}, ${bc})
      `;
      tickets.push({ id, seatLabel, barcode: bc });
    }
  } catch (e) {
    // Fulfilment failed after authorisation: void, never capture.
    await voidAuthorization(orderIdArg, "fulfilment_failed");
    throw e;
  }

  // Capture only now that barcodes exist.
  const paymentId = order.payment_id as string;
  const current = await retrievePayment(paymentId, true, trace);
  const outcome = interpretIntentStatus(current.status);

  let captured = false;
  let captureSkippedReason: string | undefined;

  if (outcome.alreadyCaptured) {
    // Sandbox dummy connectors settle on authorisation and ignore manual capture.
    // Calling /capture here would return IR_14. See VERIFICATION.md V5.
    captured = true;
    captureSkippedReason =
      "connector settled at authorisation (manual capture not honoured by sandbox dummy connector)";
    await logOrderEvent({
      orderId: orderIdArg,
      kind: "capture_skipped",
      paymentId,
      connector: order.connector as string,
      amount: order.total as number,
      detail: { reason: captureSkippedReason, status: current.status },
    });
  } else if (outcome.authorized) {
    const cap = await capturePayment(paymentId, order.total as number, trace);
    captured = !cap.error;
    await logOrderEvent({
      orderId: orderIdArg,
      kind: captured ? "captured" : "capture_failed",
      paymentId,
      connector: order.connector as string,
      amount: order.total as number,
      detail: { status: cap.status, error: cap.error ?? null },
    });
    if (!captured) {
      throw new Error(`Capture failed: ${JSON.stringify(cap.error)}`);
    }
  } else {
    throw new Error(`Cannot capture: payment status is ${current.status}`);
  }

  // Inventory: convert hold -> sold.
  await sql`
    UPDATE tiers
       SET held = GREATEST(held - ${qty}, 0),
           sold = sold + ${qty}
     WHERE id = ${order.tier_id as string}
  `;

  await sql`UPDATE orders SET state = 'issued', updated_at = now() WHERE id = ${orderIdArg}`;
  await logOrderEvent({
    orderId: orderIdArg,
    kind: "issued",
    fromState: "issuing",
    toState: "issued",
    paymentId,
    connector: order.connector as string,
    amount: order.total as number,
    detail: { tickets: tickets.length },
  });

  return { orderId: orderIdArg, tickets, captured, captureSkippedReason };
}

/** Void an authorisation and return inventory. */
export async function voidAuthorization(orderIdArg: string, reason: string) {
  const order = (
    (await sql`SELECT * FROM orders WHERE id = ${orderIdArg}`) as Array<Record<string, unknown>>
  )[0];
  if (!order) throw new Error("order not found");
  const paymentId = order.payment_id as string | null;

  if (paymentId) {
    try {
      const res = await cancelPayment(paymentId, reason);
      await logOrderEvent({
        orderId: orderIdArg,
        kind: "auth_voided",
        paymentId,
        detail: { reason, status: res.status, error: res.error ?? null },
      });
    } catch (e) {
      await logOrderEvent({
        orderId: orderIdArg,
        kind: "auth_void_failed",
        paymentId,
        errorMessage: (e as Error).message,
        detail: { reason },
      });
    }
  }
  await releaseHold(orderIdArg, reason);
}

/** Return held inventory and mark the order released. */
export async function releaseHold(orderIdArg: string, reason: string) {
  const order = (
    (await sql`SELECT * FROM orders WHERE id = ${orderIdArg}`) as Array<Record<string, unknown>>
  )[0];
  if (!order) return;
  const state = order.state as OrderState;
  if (state === "issued" || state === "released" || state === "refunded") return;

  await sql`
    UPDATE tiers SET held = GREATEST(held - ${order.qty as number}, 0)
     WHERE id = ${order.tier_id as string}
  `;
  const to: OrderState = state === "holding" || state === "authorized" || state === "issuing" ? "released" : "failed";
  await sql`UPDATE orders SET state = ${to}, updated_at = now() WHERE id = ${orderIdArg}`;
  await logOrderEvent({
    orderId: orderIdArg,
    kind: "hold_released",
    fromState: state,
    toState: to,
    detail: { reason },
  });
}

/** Sweep expired holds. Invoked by a cron route; in production this is a scheduled job. */
export async function sweepExpiredHolds(): Promise<string[]> {
  const rows = (await sql`
    SELECT id FROM orders
     WHERE state IN ('holding','authorized')
       AND hold_expires_at IS NOT NULL
       AND hold_expires_at < now()
  `) as Array<{ id: string }>;
  const swept: string[] = [];
  for (const r of rows) {
    await voidAuthorization(r.id, "hold_expired");
    swept.push(r.id);
  }
  return swept;
}

export { formatUSD };
