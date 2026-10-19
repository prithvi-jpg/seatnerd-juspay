import Link from "next/link";
import { sql } from "@/lib/db";
import { formatUSD, cents } from "@/lib/money";

export const dynamic = "force-dynamic";

export default async function OpsPage() {
  const [overview] = (await sql`
    SELECT
      COUNT(*) AS orders_total,
      COUNT(*) FILTER (WHERE state = 'issued') AS orders_issued,
      COUNT(*) FILTER (WHERE state = 'released') AS orders_released,
      COUNT(*) FILTER (WHERE state = 'failed') AS orders_failed,
      COALESCE(SUM(total) FILTER (WHERE state = 'issued'), 0) AS gmv_cents
    FROM orders
  `) as unknown as Array<Record<string, number>>;

  const authByConnector = (await sql`
    SELECT connector, kind, COUNT(*) AS n
      FROM order_events
     WHERE kind IN ('auth_succeeded','auth_failed')
       AND connector IS NOT NULL
     GROUP BY connector, kind ORDER BY connector
  `) as unknown as Array<Record<string, string | number>>;

  const declines = (await sql`
    SELECT error_message, unified_code, COUNT(*) AS n
      FROM order_events
     WHERE kind = 'auth_failed' AND error_message IS NOT NULL
     GROUP BY error_message, unified_code ORDER BY n DESC LIMIT 8
  `) as unknown as Array<Record<string, string | number>>;

  const retries = (await sql`
    SELECT retry_decision, COUNT(*) AS n
      FROM order_events WHERE retry_decision IS NOT NULL GROUP BY retry_decision
  `) as unknown as Array<Record<string, string | number>>;

  const recent = (await sql`
    SELECT order_id, kind, at, connector, attempt_no, error_message, retry_decision
      FROM order_events ORDER BY id DESC LIMIT 24
  `) as unknown as Array<{ order_id: string; kind: string; at: string; connector: string | null; attempt_no: number | null; error_message: string | null; retry_decision: string | null }>;

  const inventory = (await sql`
    SELECT e.title, t.name, t.capacity, t.sold, t.held,
           GREATEST(t.capacity - t.sold - t.held, 0) AS available
      FROM tiers t JOIN events e ON e.id = t.event_id
     ORDER BY e.starts_at, t.face_value DESC
  `) as unknown as Array<{ title: string; name: string; capacity: number; sold: number; held: number; available: number }>;

  const card = (s: string | number | null | undefined) => String(s ?? "—");

  return (
    <main style={{ maxWidth: 1000, margin: "0 auto", padding: "32px 20px 64px" }}>
      <Link href="/" style={{ color: "#7c8698", fontSize: 14, textDecoration: "none" }}>← Storefront</Link>
      <h1 style={{ fontSize: 30, margin: "16px 0 4px" }}>Payments ops console</h1>
      <p style={{ color: "#aab2c4", marginTop: 0, fontSize: 14 }}>
        What your PSP dashboard isn&apos;t showing you — authorisation results, decline taxonomy,
        retry decisions, and inventory, all from the append-only event log.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 12, marginTop: 20 }}>
        {[
          ["Orders", card(overview.orders_total)],
          ["Issued", card(overview.orders_issued)],
          ["Released", card(overview.orders_released)],
          ["Failed", card(overview.orders_failed)],
          ["GMV (issued)", formatUSD(cents(Number(overview.gmv_cents ?? 0)))],
        ].map(([label, value]) => (
          <div key={label} style={{ border: "1px solid #262c3b", borderRadius: 12, padding: 16, background: "#10131c" }}>
            <div style={{ fontSize: 12, color: "#7c8698" }}>{label}</div>
            <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>{value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", marginTop: 16 }}>
        <section style={{ border: "1px solid #262c3b", borderRadius: 12, padding: 16, background: "#10131c" }}>
          <div style={{ fontWeight: 600, marginBottom: 10 }}>Auth results by connector</div>
          {authByConnector.length === 0 && <div style={{ color: "#5a6374", fontSize: 13 }}>No attempts yet.</div>}
          {authByConnector.map((row, i) => {
            const ok = card(row.kind) === "auth_succeeded";
            return (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 14 }}>
                <span style={{ fontFamily: "monospace" }}>{card(row.connector)}</span>
                <span style={{ color: ok ? "#4ade80" : "#f87171" }}>
                  {card(row.kind).replace("auth_", "")} · {card(row.n)}
                </span>
              </div>
            );
          })}
        </section>

        <section style={{ border: "1px solid #262c3b", borderRadius: 12, padding: 16, background: "#10131c" }}>
          <div style={{ fontWeight: 600, marginBottom: 10 }}>Retry decisions (GSM)</div>
          {retries.length === 0 && <div style={{ color: "#5a6374", fontSize: 13 }}>No failed attempts yet.</div>}
          {retries.map((row, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 14 }}>
              <span style={{ color: card(row.retry_decision) === "retry" ? "#facc15" : "#f87171" }}>
                {card(row.retry_decision)}
              </span>
              <span>{card(row.n)}</span>
            </div>
          ))}
        </section>
      </div>

      <section style={{ border: "1px solid #262c3b", borderRadius: 12, padding: 16, background: "#10131c", marginTop: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 10 }}>Decline taxonomy</div>
        {declines.length === 0 && <div style={{ color: "#5a6374", fontSize: 13 }}>No declines yet.</div>}
        {declines.map((row, i) => (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "5px 0", fontSize: 13 }}>
            <span style={{ color: "#aab2c4", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {card(row.error_message)}
            </span>
            <span style={{ flexShrink: 0, fontFamily: "monospace", color: "#7c8698" }}>
              {card(row.unified_code)} × {card(row.n)}
            </span>
          </div>
        ))}
      </section>

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", marginTop: 16 }}>
        <section style={{ border: "1px solid #262c3b", borderRadius: 12, padding: 16, background: "#10131c" }}>
          <div style={{ fontWeight: 600, marginBottom: 10 }}>Inventory (held vs sold)</div>
          {inventory.map((row, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", fontSize: 13 }}>
              <span>{card(row.title)} — {card(row.name)}</span>
              <span style={{ color: "#7c8698" }}>
                {card(row.sold)} sold · {card(row.held)} held · {card(row.available)} left
              </span>
            </div>
          ))}
        </section>

        <section style={{ border: "1px solid #262c3b", borderRadius: 12, padding: 16, background: "#10131c" }}>
          <div style={{ fontWeight: 600, marginBottom: 10 }}>Recent events</div>
          {recent.map((row, i) => (
            <div key={i} style={{ display: "flex", gap: 8, padding: "3px 0", fontSize: 12, fontFamily: "monospace" }}>
              <span style={{ color: "#5a6374", flexShrink: 0 }}>
                {new Date(row.at as string).toLocaleTimeString("en-US", { hour12: false })}
              </span>
              <span style={{ color: "#aab2c4", flexShrink: 0 }}>{card(row.kind)}</span>
              <span style={{ color: "#5a6374", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {card(row.connector)} {card(row.attempt_no)} {card(row.retry_decision)}
              </span>
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}
