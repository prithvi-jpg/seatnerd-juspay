import Link from "next/link";
import DemoHarness from "@/components/demo-harness";

export const dynamic = "force-dynamic";

export default function DemoPage() {
  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "32px 20px 64px" }}>
      <Link href="/" style={{ color: "#7c8698", fontSize: 14, textDecoration: "none" }}>← All events</Link>

      <h1 style={{ fontSize: 30, margin: "16px 0 6px" }}>Payment orchestration, live</h1>
      <p style={{ color: "#aab2c4", lineHeight: 1.7, marginTop: 0 }}>
        This harness routes a real payment through the Juspay Hyperswitch sandbox.
        Pick a test card, set the routing priority, and watch the Gateway-Status-Map-style
        failover decide — attempt by attempt — whether to retry or stop.
        Same card number, different connectors, opposite outcomes.
      </p>

      <DemoHarness />

      <footer style={{ marginTop: 40, fontSize: 12, color: "#5a6374", lineHeight: 1.8 }}>
        <b>How to read the demo:</b> card 4000 0000 0000 9995 fails on fauxpay and paypal_test
        with a transient connector error (&quot;Internal Server Error from Connector&quot; — retryable),
        and succeeds on stripe_test. Card 4000 0000 0000 9979 is stolen (hard decline — the
        cascade stops after one attempt instead of burning authorisation attempts).
        Both return error code <span style={{ fontFamily: "monospace" }}>DC_08 / UE_9000</span>;
        only the message distinguishes them — which is why GSM-style retry decisions are
        configured on (connector, code, message), never on the code alone.
      </footer>
    </main>
  );
}
