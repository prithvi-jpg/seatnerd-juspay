"use client";

import { useState } from "react";
import { HyperElements, UnifiedCheckout } from "@juspay-tech/react-hyper-js";
import { formatUSD, cents } from "@/lib/money";

interface Props {
  orderId: string;
  clientSecret: string;
  total: number;
  breakdown: { faceValue: number; serviceFee: number; facilityFee: number };
  holdExpiresAt: string;
}

/**
 * Checkout host: renders Hyperswitch UnifiedCheckout inside HyperElements.
 * The browser only ever holds client_secret + publishable key; all mutations
 * (fulfil + capture) go through server routes.
 */
export default function CheckoutHost({ orderId, clientSecret, total, breakdown, holdExpiresAt }: Props) {
  const [state, setState] = useState<"paying" | "done" | "error">("paying");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const pk = process.env.NEXT_PUBLIC_HYPERSWITCH_PUBLISHABLE_KEY ?? "";

  async function onPaymentComplete() {
    setBusy(true);
    try {
      const r = await fetch(`/api/orders/${orderId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "fulfill" }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "fulfilment failed");
      window.location.href = `/order/${orderId}`;
    } catch (e) {
      setMsg((e as Error).message);
      setState("error");
      setBusy(false);
    }
  }

  return (
    <div style={{ border: "1px solid #262c3b", borderRadius: 14, padding: 20, background: "#10131c" }}>
      {state === "paying" && (
        <>
          <div style={{ fontSize: 13, color: "#7c8698", marginBottom: 12 }}>
            Hold expires {new Date(holdExpiresAt).toLocaleTimeString()} — you are never charged
            until your tickets are issued.
          </div>
          <HyperElements options={{ clientSecret }}>
            <UnifiedCheckout
              options={{
                appearance: {
                  theme: "night",
                  variables: { colorPrimary: "#8ab4ff", fontFamily: "system-ui" },
                },
              }}
              onPaymentComplete={onPaymentComplete}
            />
          </HyperElements>
          {busy && <div style={{ marginTop: 12, fontSize: 13, color: "#8ab4ff" }}>Issuing your tickets…</div>}
        </>
      )}

      {state === "error" && (
        <div style={{ color: "#f87171", fontSize: 14 }}>Payment issue: {msg}</div>
      )}
    </div>
  );
}
