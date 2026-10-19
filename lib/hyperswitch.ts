/**
 * Hyperswitch server-side client.
 *
 * SERVER ONLY. This module reads HYPERSWITCH_API_KEY and must never be imported
 * into a client component. All state-changing payment calls live here so the
 * secret key never crosses the network boundary to the browser.
 *
 * Endpoints and field names verified against the live sandbox — see VERIFICATION.md.
 */

const BASE = process.env.HYPERSWITCH_BASE_URL ?? "https://sandbox.hyperswitch.io";
const API_KEY = process.env.HYPERSWITCH_API_KEY ?? "";
const PROFILE_ID = process.env.HYPERSWITCH_PROFILE_ID ?? "";

export const CONNECTORS = {
  fauxpay: {
    name: "fauxpay",
    mca: process.env.HS_MCA_FAUXPAY ?? "",
    label: "FauxPay",
  },
  paypal_test: {
    name: "paypal_test",
    mca: process.env.HS_MCA_PAYPAL_TEST ?? "",
    label: "PayPal (test)",
  },
  stripe_test: {
    name: "stripe_test",
    mca: process.env.HS_MCA_STRIPE_TEST ?? "",
    label: "Stripe (test)",
  },
} as const;

export type ConnectorKey = keyof typeof CONNECTORS;

/**
 * Priority routing order for the onsale.
 *
 * Mirrors StaticRoutingAlgorithm::Priority in crates/api_models/src/routing.rs.
 * Deterministic on purpose so failover is demonstrable on stage. In production
 * this is where you'd switch to DynamicRoutingAlgorithm::SuccessBasedAlgorithm
 * and let observed authorisation rates pick the connector.
 */
export const ROUTING_PRIORITY: ConnectorKey[] = ["fauxpay", "paypal_test", "stripe_test"];

export interface HsError {
  type?: string;
  message?: string;
  code?: string;
}

/** One captured Hyperswitch call — request and response, for the live trace rail. */
export interface TraceEntry {
  step: string;          // human label, e.g. "Create payment intent"
  method: "POST" | "GET";
  path: string;
  request?: unknown;
  response?: unknown;
  status?: number;       // HTTP status
  ms: number;
  connector?: string;
}

export interface HsPayment {
  payment_id: string;
  status: string;
  amount: number;
  net_amount?: number;
  amount_capturable?: number;
  amount_received?: number | null;
  currency: string;
  connector?: string | null;
  client_secret?: string | null;
  capture_method?: string | null;
  merchant_connector_id?: string | null;
  attempt_count?: number;
  error_code?: string | null;
  error_message?: string | null;
  unified_code?: string | null;
  unified_message?: string | null;
  next_action?: unknown;
  metadata?: Record<string, unknown> | null;
  error?: HsError;
}

async function hsFetch<T>(
  path: string,
  init: RequestInit & { body?: string },
  trace?: TraceEntry[],
  step?: string,
): Promise<T> {
  if (!API_KEY) throw new Error("HYPERSWITCH_API_KEY is not set");
  const t0 = Date.now();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "api-key": API_KEY,
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });
  const ms = Date.now() - t0;
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Hyperswitch ${path} returned non-JSON (${res.status}): ${text.slice(0, 300)}`);
  }
  if (trace && step) {
    trace.push({
      step,
      method: (init.method as "POST" | "GET") ?? "GET",
      path,
      request: init.body ? safeParse(init.body) : undefined,
      response: json,
      status: res.status,
      ms,
    });
  }
  return json as T;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s.slice(0, 200);
  }
}

function routingFor(connector: ConnectorKey) {
  const c = CONNECTORS[connector];
  return { type: "single", data: { connector: c.name, merchant_connector_id: c.mca } };
}

export interface CreatePaymentArgs {
  amount: number;            // integer cents
  orderId: string;
  description: string;
  metadata?: Record<string, unknown>;
  returnUrl?: string;
  /** manual = authorise now, capture at fulfilment. Correct model for ticketing. */
  captureMethod?: "manual" | "automatic";
}

export async function createPayment(
  args: CreatePaymentArgs,
  trace?: TraceEntry[],
): Promise<HsPayment> {
  return hsFetch<HsPayment>(
    "/payments",
    {
      method: "POST",
      body: JSON.stringify({
        amount: args.amount,
        currency: "USD",
        confirm: false,
        capture_method: args.captureMethod ?? "manual",
        profile_id: PROFILE_ID,
        description: args.description,
        return_url: args.returnUrl,
        metadata: { order_id: args.orderId, ...(args.metadata ?? {}) },
      }),
    },
    trace,
    "Create payment intent",
  );
}

/** Server-side confirm with explicit card data — used by the failover demo harness. */
export async function confirmPaymentWithCard(
  paymentId: string,
  card: { number: string; expMonth: string; expYear: string; holder: string; cvc: string },
  connector: ConnectorKey,
  trace?: TraceEntry[],
): Promise<HsPayment> {
  return hsFetch<HsPayment>(
    `/payments/${paymentId}/confirm`,
    {
      method: "POST",
      body: JSON.stringify({
        payment_method: "card",
        payment_method_type: "credit",
        payment_method_data: {
          card: {
            card_number: card.number,
            card_exp_month: card.expMonth,
            card_exp_year: card.expYear,
            card_holder_name: card.holder,
            card_cvc: card.cvc,
          },
        },
        routing: routingFor(connector),
      }),
    },
    trace,
    `Authorize via ${CONNECTORS[connector].label}`,
  );
}

export async function retrievePayment(
  paymentId: string,
  forceSync = true,
  trace?: TraceEntry[],
): Promise<HsPayment> {
  return hsFetch<HsPayment>(
    `/payments/${paymentId}?force_sync=${forceSync}`,
    { method: "GET" },
    trace,
    "Reconcile payment status",
  );
}

/**
 * Capture. Valid only from requires_capture / partially_captured_and_capturable /
 * processing — per the IR_14 error text returned by the router itself.
 * Callers must check `alreadyCaptured` first (see order-state.interpretIntentStatus).
 */
export async function capturePayment(
  paymentId: string,
  amountToCapture: number,
  trace?: TraceEntry[],
): Promise<HsPayment> {
  return hsFetch<HsPayment>(
    `/payments/${paymentId}/capture`,
    {
      method: "POST",
      body: JSON.stringify({ amount_to_capture: amountToCapture }),
    },
    trace,
    "Capture funds",
  );
}

/** Void an authorisation — releases the hold without taking funds. */
export async function cancelPayment(
  paymentId: string,
  reason: string,
  trace?: TraceEntry[],
): Promise<HsPayment> {
  return hsFetch<HsPayment>(
    `/payments/${paymentId}/cancel`,
    {
      method: "POST",
      body: JSON.stringify({ cancellation_reason: reason }),
    },
    trace,
    "Void authorization",
  );
}

export async function refundPayment(paymentId: string, amount: number, reason: string) {
  return hsFetch<Record<string, unknown>>(`/refunds`, {
    method: "POST",
    body: JSON.stringify({ payment_id: paymentId, amount, reason }),
  });
}
