import { sql } from "@/lib/db";
import { notFound } from "next/navigation";
import Link from "next/link";
import { formatUSD, cents } from "@/lib/money";

export const dynamic = "force-dynamic";

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const order = (
    await sql`SELECT * FROM orders WHERE id = ${id}`
  ) as unknown as Array<Record<string, unknown>> | [];

  if (order.length === 0) notFound();
  const o = order[0];

  const tickets = (await sql`
    SELECT seat_label, barcode FROM tickets WHERE order_id = ${id} ORDER BY issued_at
  `) as unknown as Array<{ seat_label: string; barcode: string }>;

  const events = (await sql`
    SELECT kind, at, connector, attempt_no, error_message, retry_decision, detail
      FROM order_events WHERE order_id = ${id} ORDER BY id ASC
  `) as unknown as Array<Record<string, unknown>>;

  const STATE_COLOR: Record<string, string> = {
    issued: "#4ade80", released: "#7c8698", failed: "#f87171",
    authorized: "#8ab4ff", holding: "#facc15", issuing: "#facc15", refunded: "#e879f9",
  };

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "40px 20px" }}>
      <Link href="/" style={{ color: "#7c8698", fontSize: 14, textDecoration: "none" }}>← All events</Link>

      <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ fontSize: 20 }}>Order {id}</div>
        <span style={{
          background: STATE_COLOR[o.state as string] ?? "#333a4a", color: "#0b0d12",
          borderRadius: 999, padding: "3px 12px", fontSize: 12, fontWeight: 700, textTransform: "uppercase",
        }}>{o.state as string}</span>
      </div>
      <div style={{ color: "#7c8698", fontSize: 14, marginTop: 6 }}>
        {formatUSD(cents(o.total as number))} · {o.connector ? `routed via ${o.connector}` : "no connector yet"}
      </div>

      {tickets.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <div style={{ fontSize: 13, color: "#7c8698", letterSpacing: 1, textTransform: "uppercase", marginBottom: 10 }}>
            Your tickets
          </div>
          {tickets.map((t) => (
            <div key={t.barcode} style={{
              border: "1px solid #262c3b", borderRadius: 12, padding: 14, marginBottom: 10,
              background: "linear-gradient(135deg,#10131c,#141a2b)", display: "flex",
              justifyContent: "space-between", alignItems: "center",
            }}>
              <div>
                <div style={{ fontWeight: 700 }}>{t.seat_label}</div>
                <div style={{ fontFamily: "monospace", fontSize: 13, color: "#8ab4ff" }}>{t.barcode}</div>
              </div>
              <div style={{ fontSize: 12, color: "#4ade80" }}>VALID</div>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 28 }}>
        <div style={{ fontSize: 13, color: "#7c8698", letterSpacing: 1, textTransform: "uppercase", marginBottom: 10 }}>
          Payment & fulfilment trail
        </div>
        {events.map((ev, i) => (
          <div key={i} style={{
            display: "flex", gap: 12, fontSize: 13, padding: "7px 0",
            borderBottom: "1px solid #1b202d", color: "#aab2c4",
          }}>
            <div style={{ width: 110, flexShrink: 0, color: "#5a6374" }}>
              {new Date(ev.at as string).toLocaleTimeString("en-US", { hour12: false })}
            </div>
            <div style={{ flexShrink: 0, fontWeight: 600, color: "#e6e9f0", width: 150 }}>
              {ev.kind as string}
            </div>
            <div style={{ flexShrink: 0, width: 90 }}>
              {ev.connector ? (ev.connector as string) : "—"}
            </div>
            <div style={{ color: "#7c8698", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {ev.retry_decision ? `retry=${ev.retry_decision}` : ""}
              {ev.error_message ? String(ev.error_message).slice(0, 60) : ""}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
