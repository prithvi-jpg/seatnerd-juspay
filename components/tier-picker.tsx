"use client";

import { useMemo, useState } from "react";
import { computeFees, formatUSD, cents } from "@/lib/money";
import CheckoutHost from "./checkout-host";

interface Tier {
  id: string;
  name: string;
  face_value: number;
  capacity: number;
  sold: number;
  held: number;
}

interface Props {
  eventId: string;
  tiers: Tier[];
}

export default function TierPicker({ eventId, tiers }: Props) {
  const [tierId, setTierId] = useState(tiers[0]?.id ?? "");
  const [qty, setQty] = useState(2);
  const [phase, setPhase] = useState<"pick" | "checkout" | "error">("pick");
  const [error, setError] = useState("");
  const [checkout, setCheckout] = useState<{
    orderId: string; clientSecret: string; total: number;
    breakdown: { faceValue: number; serviceFee: number; facilityFee: number };
    holdExpiresAt: string;
  } | null>(null);

  const tier = tiers.find((t) => t.id === tierId) ?? tiers[0];
  const fees = useMemo(() => computeFees(cents(tier?.face_value ?? 0), qty), [tier, qty]);
  const avail = Math.max((tier?.capacity ?? 0) - (tier?.sold ?? 0) - (tier?.held ?? 0), 0);

  async function hold() {
    setError("");
    try {
      const r = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, tierId, qty }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "could not hold seats");
      setCheckout(data);
      setPhase("checkout");
    } catch (e) {
      setError((e as Error).message);
      setPhase("error");
    }
  }

  if (phase === "checkout" && checkout) {
    return (
      <div>
        <div style={{
          border: "1px solid #262c3b", borderRadius: 14, padding: 20, background: "#10131c", marginBottom: 14,
        }}>
          <div style={{ fontSize: 13, color: "#7c8698" }}>Your order</div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, fontSize: 14 }}>
            <span>{tier?.name} × {qty}</span>
            <span>{formatUSD(cents(checkout.breakdown.faceValue))}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 14 }}>
            <span>Service fee (12%)</span><span>{formatUSD(cents(checkout.breakdown.serviceFee))}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 14 }}>
            <span>Facility fee</span><span>{formatUSD(cents(checkout.breakdown.facilityFee))}</span>
          </div>
          <div style={{
            display: "flex", justifyContent: "space-between", marginTop: 10, paddingTop: 10,
            borderTop: "1px solid #262c3b", fontWeight: 700, fontSize: 18,
          }}>
            <span>Total</span><span>{formatUSD(cents(checkout.total))}</span>
          </div>
          <div style={{ fontSize: 12, color: "#7c8698", marginTop: 6 }}>
            All-in price — no fees added later.
          </div>
        </div>
        <CheckoutHost {...checkout} />
        <button onClick={() => setPhase("pick")} style={{
          marginTop: 12, background: "none", border: "none", color: "#7c8698", cursor: "pointer", fontSize: 13,
        }}>← Change selection</button>
      </div>
    );
  }

  return (
    <div style={{ border: "1px solid #262c3b", borderRadius: 14, padding: 20, background: "#10131c" }}>
      <div style={{ fontWeight: 600, marginBottom: 12 }}>Get tickets</div>

      <label style={{ fontSize: 13, color: "#7c8698" }}>Tier</label>
      <select value={tierId} onChange={(e) => setTierId(e.target.value)} style={{
        width: "100%", margin: "6px 0 14px", padding: "10px 12px", borderRadius: 8,
        background: "#171b26", color: "#e6e9f0", border: "1px solid #262c3b", fontSize: 15,
      }}>
        {tiers.map((t) => {
          const a = Math.max(t.capacity - t.sold - t.held, 0);
          return <option key={t.id} value={t.id} disabled={a === 0}>{t.name} — {formatUSD(cents(t.face_value))} ({a} left)</option>;
        })}
      </select>

      <label style={{ fontSize: 13, color: "#7c8698" }}>Quantity</label>
      <select value={qty} onChange={(e) => setQty(Number(e.target.value))} style={{
        width: "100%", margin: "6px 0 14px", padding: "10px 12px", borderRadius: 8,
        background: "#171b26", color: "#e6e9f0", border: "1px solid #262c3b", fontSize: 15,
      }}>
        {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => <option key={n} value={n}>{n}</option>)}
      </select>

      <div style={{ borderTop: "1px solid #262c3b", paddingTop: 12, marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}>
          <span style={{ color: "#aab2c4" }}>Face value</span>
          <span>{formatUSD(cents(fees.faceValue))}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, marginTop: 4 }}>
          <span style={{ color: "#aab2c4" }}>Service fee (12%)</span>
          <span>{formatUSD(cents(fees.serviceFee))}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, marginTop: 4 }}>
          <span style={{ color: "#aab2c4" }}>Facility fee</span>
          <span>{formatUSD(cents(fees.facilityFee))}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700, fontSize: 18, marginTop: 10 }}>
          <span>Total</span><span>{formatUSD(cents(fees.total))}</span>
        </div>
      </div>

      <button onClick={hold} disabled={avail === 0} style={{
        width: "100%", padding: "14px", borderRadius: 10, border: "none", cursor: "pointer",
        background: avail === 0 ? "#333a4a" : "#8ab4ff", color: "#0b0d12", fontWeight: 700, fontSize: 16,
      }}>
        {avail === 0 ? "Sold out" : "Continue to checkout"}
      </button>
      <div style={{ fontSize: 12, color: "#7c8698", marginTop: 10, lineHeight: 1.6 }}>
        Seats are held for 10 minutes. You're only charged after your tickets are issued.
        Payments run on Juspay Hyperswitch (sandbox).
      </div>

      {phase === "error" && <div style={{ color: "#f87171", marginTop: 10, fontSize: 14 }}>{error}</div>}
    </div>
  );
}
