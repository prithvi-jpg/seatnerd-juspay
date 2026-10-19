/**
 * End-to-end orchestration test against the REAL Hyperswitch sandbox.
 * Run: bun run scripts/e2e-test.mjs
 *
 * Uses tsx-free dynamic import of the TS modules via bun's native TS support.
 */
import { holdSeats, authorizeWithFailover, fulfillAndCapture, releaseHold } from "../lib/checkout.ts";
import { sql } from "../lib/db.ts";
import { formatUSD } from "../lib/money.ts";

const line = (s = "") => console.log(s);
const hr = () => line("─".repeat(78));

const CARDS = {
  success:   { number: "4242424242424242", expMonth: "12", expYear: "2030", holder: "Prithvi Rey", cvc: "123" },
  failover:  { number: "4000000000009995", expMonth: "12", expYear: "2030", holder: "Prithvi Rey", cvc: "123" },
  stolen:    { number: "4000000000009979", expMonth: "12", expYear: "2030", holder: "Prithvi Rey", cvc: "123" },
};

async function scenario(name, card, priority) {
  hr();
  line(`SCENARIO: ${name}`);
  line(`card=${card.number}  priority=[${priority.join(" -> ")}]`);
  hr();

  const hold = await holdSeats({
    eventId: "evt_presidio",
    tierId: "tier_pit_sf",
    qty: 2,
    buyerEmail: "prithvi@example.com",
  });
  line(`  hold        order=${hold.orderId} payment=${hold.paymentId}`);
  line(`  breakdown   face=${formatUSD(hold.breakdown.faceValue)} svc=${formatUSD(hold.breakdown.serviceFee)} fac=${formatUSD(hold.breakdown.facilityFee)} TOTAL=${formatUSD(hold.breakdown.total)}`);

  const auth = await authorizeWithFailover({ orderId: hold.orderId, card, priority });
  line(`  attempts:`);
  for (const a of auth.attempts) {
    const tag = a.ok ? "OK  " : "FAIL";
    line(`    [${tag}] ${a.connector.padEnd(12)} status=${String(a.status).padEnd(22)} ${a.ms}ms  ${a.errorMessage ?? ""}${a.retryDecision ? "  -> " + a.retryDecision : ""}`);
  }
  line(`  authorized  = ${auth.success}  finalConnector=${auth.finalConnector ?? "-"}  alreadyCaptured=${auth.alreadyCaptured}`);

  if (!auth.success) {
    line(`  RESULT: no funds secured; hold released.`);
    return;
  }

  const f = await fulfillAndCapture(hold.orderId);
  line(`  tickets     ${f.tickets.map(t => t.barcode).join(", ")}`);
  line(`  captured    = ${f.captured}${f.captureSkippedReason ? "  (" + f.captureSkippedReason + ")" : ""}`);

  const [o] = await sql`SELECT state, total, connector FROM orders WHERE id = ${hold.orderId}`;
  line(`  FINAL       state=${o.state} total=${formatUSD(o.total)} connector=${o.connector}`);
}

line("\n╔══════════════════════════════════════════════════════════════════════════╗");
line("║  SeatNerd  ·  end-to-end orchestration against Hyperswitch sandbox       ║");
line("╚══════════════════════════════════════════════════════════════════════════╝");

// 1. Happy path, straight to stripe_test.
await scenario("Happy path", CARDS.success, ["stripe_test"]);

// 2. THE FAILOVER: fauxpay fails transiently, stripe_test saves the sale.
await scenario("Transient failure -> failover", CARDS.failover, ["fauxpay", "paypal_test", "stripe_test"]);

// 3. Hard decline: must NOT cascade.
await scenario("Hard decline (stolen) -> no retry", CARDS.stolen, ["fauxpay", "paypal_test", "stripe_test"]);

hr();
line("AUDIT TRAIL (last 25 events)");
hr();
const evts = await sql`
  SELECT order_id, kind, connector, attempt_no, error_message, retry_decision
    FROM order_events ORDER BY id DESC LIMIT 25`;
for (const e of evts.reverse()) {
  line(`  ${e.order_id}  ${String(e.kind).padEnd(22)} ${String(e.connector ?? "-").padEnd(12)} ${e.attempt_no ?? ""} ${e.retry_decision ?? ""} ${e.error_message ?? ""}`);
}

hr();
const [stats] = await sql`
  SELECT
    COUNT(*) FILTER (WHERE kind='auth_succeeded') AS ok,
    COUNT(*) FILTER (WHERE kind='auth_failed')    AS failed
  FROM order_events`;
line(`auth_succeeded=${stats.ok}  auth_failed=${stats.failed}`);
line("");
