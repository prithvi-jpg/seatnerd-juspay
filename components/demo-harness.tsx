"use client";

import { useState } from "react";
import { CONNECTORS, type ConnectorKey } from "@/lib/hyperswitch";

interface Attempt {
  connector: ConnectorKey;
  status: string;
  ok: boolean;
  errorCode?: string | null;
  errorMessage?: string | null;
  unifiedCode?: string | null;
  retryDecision?: string;
  ms: number;
}

interface DemoResult {
  orderId: string;
  paymentId: string;
  success: boolean;
  attempts: Attempt[];
  finalConnector?: ConnectorKey;
  alreadyCaptured: boolean;
  needsCustomerAction: boolean;
  error?: string;
}

const CARDS: Array<{ id: string; label: string; number: string; hint: string }> = [
  { id: "happy",   label: "4242 4242 4242 4242", number: "4242424242424242", hint: "succeeds everywhere — happy path" },
  { id: "failover",label: "4000 0000 0000 9995", number: "4000000000009995", hint: "transient failure on fauxpay/paypal_test → succeeds on stripe_test" },
  { id: "stolen",  label: "4000 0000 0000 9979", number: "4000000000009979", hint: "hard decline (stolen) — must NOT cascade" },
  { id: "declined",label: "4000 0000 0000 0002", number: "4000000000000002", hint: "hard decline everywhere" },
];

const ORDER = ["fauxpay", "paypal_test", "stripe_test"] as ConnectorKey[];

export default function DemoHarness() {
  const [cardId, setCardId] = useState("failover");
  const [priority, setPriority] = useState<ConnectorKey[]>(ORDER);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DemoResult | null>(null);
  const [note, setNote] = useState("");

  const card = CARDS.find((c) => c.id === cardId)!;

  async function run() {
    setBusy(true);
    setResult(null);
    setNote("");
    try {
      // Fresh hold per run so the demo is repeatable.
      const hold = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId: "evt_presidio", tierId: "tier_ga_sf", qty: 1 }),
      }).then((r) => r.json());
      if (!hold.orderId) throw new Error(hold.error ?? "hold failed");

      const r = await fetch("/api/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: hold.orderId,
          card: { number: card.number, expMonth: "12", expYear: "2030", holder: "Demo Buyer", cvc: "123" },
          priority,
        }),
      });
      const data = await r.json();
      if (data.error) throw new Error(data.error);
      setResult(data);
    } catch (e) {
      setResult({
        orderId: "", paymentId: "", success: false, attempts: [],
        alreadyCaptured: false, needsCustomerAction: false,
        error: (e as Error).message,
      });
    } finally {
      setBusy(false);
    }
  }

  async function issueTickets() {
    if (!result?.orderId) return;
    await fetch(`/api/orders/${result.orderId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "fulfill" }),
    });
    window.location.href = `/order/${result.orderId}`;
  }

  function toggleConnector(c: ConnectorKey) {
    setPriority((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]));
  }

  return (
    <div>
      {/* Card selector */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 13, color: "#7c8698", marginBottom: 8 }}>1 · Choose a test card</div>
        <div style={{ display: "grid", gap: 8 }}>
          {CARDS.map((c) => (
            <label key={c.id} style={{
              display: "flex", gap: 10, alignItems: "flex-start", padding: 12, borderRadius: 10,
              border: `1px solid ${cardId === c.id ? "#8ab4ff" : "#262c3b"}`,
              background: cardId === c.id ? "#141a2b" : "#10131c", cursor: "pointer",
            }}>
              <input type="radio" name="card" checked={cardId === c.id} onChange={() => setCardId(c.id)} />
              <div>
                <div style={{ fontFamily: "monospace", fontSize: 15 }}>{c.label}</div>
                <div style={{ fontSize: 12, color: "#7c8698" }}>{c.hint}</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* Routing order */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 13, color: "#7c8698", marginBottom: 8 }}>2 · Routing priority (Hyperswitch &quot;Priority&quot; algorithm)</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {ORDER.map((c) => (
            <button key={c} onClick={() => toggleConnector(c)} style={{
              padding: "8px 14px", borderRadius: 999, cursor: "pointer",
              border: priority.includes(c) ? "1px solid #8ab4ff" : "1px solid #333a4a",
              background: priority.includes(c) ? "#141a2b" : "transparent",
              color: priority.includes(c) ? "#8ab4ff" : "#5a6374", fontSize: 13,
            }}>
              {CONNECTORS[c].label}{!priority.includes(c) ? " (off)" : ""}
            </button>
          ))}
        </div>
      </div>

      <button onClick={run} disabled={busy || priority.length === 0} style={{
        width: "100%", padding: "14px", borderRadius: 10, border: "none", cursor: "pointer",
        background: busy ? "#333a4a" : "#8ab4ff", color: "#0b0d12", fontWeight: 700, fontSize: 16,
      }}>
        {busy ? "Running payment attempts…" : "Run payment with failover"}
      </button>

      {result?.error && <div style={{ color: "#f87171", marginTop: 12, fontSize: 14 }}>{result.error}</div>}

      {/* Attempt timeline */}
      {result && !result.error && (
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 13, color: "#7c8698", marginBottom: 10 }}>Attempt timeline</div>
          {result.attempts.map((a, i) => (
            <div key={i} style={{
              border: "1px solid #262c3b", borderRadius: 10, padding: 12, marginBottom: 8,
              background: a.ok ? "rgba(74,222,128,0.05)" : "rgba(248,113,113,0.05)",
              borderLeft: `4px solid ${a.ok ? "#4ade80" : "#f87171"}`,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontWeight: 700 }}>
                  Attempt {i + 1} · {CONNECTORS[a.connector].label}
                </div>
                <div style={{ fontSize: 12, color: "#5a6374" }}>{a.ms}ms</div>
              </div>
              <div style={{ marginTop: 6, fontSize: 13, color: a.ok ? "#4ade80" : "#f87171" }}>
                {a.ok ? "✓ authorized" : `✗ ${a.status}`}
              </div>
              {a.errorMessage && (
                <div style={{ marginTop: 4, fontFamily: "monospace", fontSize: 12, color: "#aab2c4" }}>
                  {a.errorMessage}
                  {a.errorCode ? `  [${a.errorCode}${a.unifiedCode ? ` / ${a.unifiedCode}` : ""}]` : ""}
                </div>
              )}
              {a.retryDecision && (
                <div style={{ marginTop: 6, fontSize: 12 }}>
                  <span style={{
                    background: a.retryDecision === "retry" ? "rgba(250,204,21,0.15)" : "rgba(248,113,113,0.15)",
                    color: a.retryDecision === "retry" ? "#facc15" : "#f87171",
                    padding: "2px 8px", borderRadius: 999,
                  }}>
                    GSM decision: {a.retryDecision === "retry" ? "RETRY → next connector" : "DO NOT RETRY"}
                  </span>
                </div>
              )}
            </div>
          ))}

          <div style={{ marginTop: 14, padding: 14, borderRadius: 10, background: "#10131c", border: "1px solid #262c3b" }}>
            {result.success ? (
              <>
                <div style={{ color: "#4ade80", fontWeight: 700 }}>
                  ✓ Sale rescued — order {result.orderId} authorized via {CONNECTORS[result.finalConnector!].label}
                </div>
                <button onClick={issueTickets} style={{
                  marginTop: 12, padding: "12px 18px", borderRadius: 8, border: "none", cursor: "pointer",
                  background: "#4ade80", color: "#0b0d12", fontWeight: 700,
                }}>
                  Issue tickets & capture →
                </button>
              </>
            ) : (
              <div style={{ color: "#f87171", fontWeight: 700 }}>
                ✗ Payment failed after {result.attempts.length} attempt(s) — no funds taken, hold released
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
