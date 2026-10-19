import { neon } from "@neondatabase/serverless";

export const sql = neon(process.env.DATABASE_URL!);

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  artist        TEXT NOT NULL,
  venue         TEXT NOT NULL,
  city          TEXT NOT NULL,
  starts_at     TIMESTAMPTZ NOT NULL,
  hero          TEXT
);

CREATE TABLE IF NOT EXISTS tiers (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES events(id),
  name          TEXT NOT NULL,
  face_value    INTEGER NOT NULL,      -- integer cents
  capacity      INTEGER NOT NULL,
  sold          INTEGER NOT NULL DEFAULT 0,
  held          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id                TEXT PRIMARY KEY,
  event_id          TEXT NOT NULL REFERENCES events(id),
  tier_id           TEXT NOT NULL REFERENCES tiers(id),
  qty               INTEGER NOT NULL,
  face_value        INTEGER NOT NULL,  -- cents
  service_fee       INTEGER NOT NULL,
  facility_fee      INTEGER NOT NULL,
  total             INTEGER NOT NULL,
  state             TEXT NOT NULL,
  buyer_email       TEXT,
  payment_id        TEXT,
  client_secret     TEXT,
  connector         TEXT,
  hold_expires_at   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only audit trail. Every payment/order state change writes here.
-- This is what the ops console reads, and what makes any state change traceable.
CREATE TABLE IF NOT EXISTS order_events (
  id            BIGSERIAL PRIMARY KEY,
  order_id      TEXT NOT NULL,
  at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind          TEXT NOT NULL,       -- e.g. hold_created, auth_attempt, auth_failed, captured
  from_state    TEXT,
  to_state      TEXT,
  connector     TEXT,
  payment_id    TEXT,
  attempt_no    INTEGER,
  error_code    TEXT,
  error_message TEXT,
  unified_code  TEXT,
  retry_decision TEXT,               -- retry | do_not_retry
  amount        INTEGER,
  detail        JSONB
);

CREATE TABLE IF NOT EXISTS tickets (
  id          TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL REFERENCES orders(id),
  seat_label  TEXT NOT NULL,
  barcode     TEXT NOT NULL,
  issued_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Webhook idempotency: webhooks may duplicate and arrive out of order.
CREATE TABLE IF NOT EXISTS webhook_log (
  id          BIGSERIAL PRIMARY KEY,
  event_type  TEXT,
  payment_id  TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  signature_valid BOOLEAN,
  body        JSONB
);

CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(order_id);
CREATE INDEX IF NOT EXISTS idx_orders_payment ON orders(payment_id);
`;

export interface OrderEventInput {
  orderId: string;
  kind: string;
  fromState?: string | null;
  toState?: string | null;
  connector?: string | null;
  paymentId?: string | null;
  attemptNo?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  unifiedCode?: string | null;
  retryDecision?: string | null;
  amount?: number | null;
  detail?: unknown;
}

export async function logOrderEvent(e: OrderEventInput) {
  await sql`
    INSERT INTO order_events
      (order_id, kind, from_state, to_state, connector, payment_id, attempt_no,
       error_code, error_message, unified_code, retry_decision, amount, detail)
    VALUES
      (${e.orderId}, ${e.kind}, ${e.fromState ?? null}, ${e.toState ?? null},
       ${e.connector ?? null}, ${e.paymentId ?? null}, ${e.attemptNo ?? null},
       ${e.errorCode ?? null}, ${e.errorMessage ?? null}, ${e.unifiedCode ?? null},
       ${e.retryDecision ?? null}, ${e.amount ?? null},
       ${e.detail ? JSON.stringify(e.detail) : null})
  `;
}
