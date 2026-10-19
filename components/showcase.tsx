"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface Tier {
  id: string;
  name: string;
  face_value: number;
  capacity: number;
  sold: number;
  held: number;
  available: number;
}

interface EventRow {
  id: string;
  title: string;
  artist: string;
  venue: string;
  city: string;
  starts_at: string;
  tiers: Tier[];
}

interface TraceCall {
  step: string;
  method: string;
  path: string;
  status?: number;
  ms: number;
  request?: unknown;
  response?: unknown;
}

interface Attempt {
  connector: string;
  status: string;
  ok: boolean;
  errorMessage?: string | null;
  errorCode?: string | null;
  unifiedCode?: string | null;
  retryDecision?: string;
  ms: number;
}

interface BuyResult {
  ok: boolean;
  orderId: string;
  paymentId?: string;
  total?: number;
  trace: TraceCall[];
  attempts?: Attempt[];
  tickets?: Array<{ seatLabel: string; barcode: string }>;
  captured?: boolean;
  captureSkippedReason?: string | null;
  finalConnector?: string;
  error?: string;
}

const CARDS = [
  { id: "happy", label: "4242 4242 4242 4242", number: "4242424242424242", note: "Happy path — succeeds on every processor" },
  { id: "failover", label: "4000 0000 0000 9995", number: "4000000000009995", note: "The story: fails on fauxpay & paypal_test, rescued by stripe_test" },
  { id: "stolen", label: "4000 0000 0000 9979", number: "4000000000009979", note: "Stolen card — hard decline, cascade stops instantly" },
];

const CONNECTOR_LABEL: Record<string, string> = {
  fauxpay: "FauxPay", paypal_test: "PayPal (test)", stripe_test: "Stripe (test)",
};

const PRIORITY = ["fauxpay", "paypal_test", "stripe_test"];

/** One-line explainer for each engine step — the "why this matters" layer. */
const STEP_EXPLAINER: Record<string, string> = {
  "Create payment intent": "Hyperswitch creates a PaymentIntent with capture_method=manual. Money is not taken yet — it's a hold on the buyer's card, parked in requires_payment_method.",
  "Authorize via FauxPay": "The router picks the first processor in the routing priority (fauxpay) and asks it to authorize the hold. The card data stays inside Hyperswitch — our server only sees a client_secret.",
  "Authorize via PayPal (test)": "Routing decision: failover. A transient processor error is mapped by the Gateway Status Map to RETRY, so the router moves to the next connector rather than failing the sale.",
  "Authorize via Stripe (test)": "Third attempt, new PaymentAttempt under the same intent. Stripe authorizes. The sale is rescued — the buyer never sees the two failed attempts behind the scenes.",
  "Reconcile payment status": "Before issuing anything, the router syncs the true payment state (force_sync). The sandbox dummy connector settled at auth, so we skip /capture instead of hitting IR_14.",
  "Capture funds": "The hold is converted to a real charge — only after barcodes exist. Order of operations is the point: no barcode, no charge.",
  "Void authorization": "No funds were taken — the hold is released and the seats return to inventory.",
};

/** Add an explainer line under each trace entry. */
function explain(step: string): string | undefined {
  const direct = STEP_EXPLAINER[step];
  if (direct) return direct;
  if (step.startsWith("Authorize via")) return STEP_EXPLAINER["Authorize via FauxPay"];
  return undefined;
}

const fmt = (n: number) => (n / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

export default function Showcase() {
  const [event, setEvent] = useState<EventRow | null>(null);
  const [tierId, setTierId] = useState("");
  const [qty, setQty] = useState(1);
  const [cardId, setCardId] = useState("failover");
  const [phase, setPhase] = useState<"loading" | "presale" | "onsale" | "buying" | "done">("loading");
  const [countdown, setCountdown] = useState(10);
  const [pulse, setPulse] = useState(false);
  const [result, setResult] = useState<BuyResult | null>(null);
  const [visibleTrace, setVisibleTrace] = useState<TraceCall[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [error, setError] = useState("");
  const traceRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const busyRef = useRef(false);

  // ---- load event + inventory ----
  useEffect(() => {
    fetch("/api/events").then((r) => r.json()).then((d) => {
      const ev = d.events.find((e: EventRow) => e.id === "evt_presidio") ?? d.events[0];
      setEvent(ev);
      setTierId(ev.tiers[0].id);
      setPhase("presale");
    }).catch(() => setError("failed to load event"));
  }, []);

  // ---- countdown to onsale ----
  useEffect(() => {
    if (phase !== "presale") return;
    timerRef.current = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          if (timerRef.current) clearInterval(timerRef.current);
          setPhase("onsale");
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [phase]);

  const tier = useMemo(
    () => event?.tiers.find((t) => t.id === tierId) ?? event?.tiers[0],
    [event, tierId],
  );

  const available = Math.max((tier?.available ?? 0), 0);
  const totalRemaining = useMemo(
    () => (event?.tiers ?? []).reduce((a, t) => a + Math.max(t.available, 0), 0),
    [event],
  );

  // ---- auto-refresh inventory while on sale (the surge feel) ----
  const refresh = useCallback(() => {
    fetch("/api/events").then((r) => r.json()).then((d) => {
      const ev = d.events.find((e: EventRow) => e.id === "evt_presidio") ?? d.events[0];
      setEvent((prev) => {
        if (!prev) return ev;
        return { ...prev, tiers: ev.tiers };
      });
    }).catch(() => {});
  }, []);

  // ---- simulated demand surge: other buyers drain inventory while on sale ----
  const [surgeLog, setSurgeLog] = useState<Array<{ at: number; tier: string; qty: number }>>([]);
  useEffect(() => {
    if (phase !== "onsale") return;
    const t = setInterval(() => {
      setEvent((prev) => {
        if (!prev) return prev;
        let hitName = prev.tiers[0]?.name ?? "GA";
        const tiers = prev.tiers.map((tier) => {
          const avail = Math.max(tier.available, 0);
          if (avail <= 0) return tier;
          const drain = Math.min(Math.max(1, Math.floor(Math.random() * 3)), avail);
          if (drain > 0) hitName = tier.name;
          return { ...tier, sold: tier.sold + drain, available: avail - drain };
        });
        setSurgeLog((log) =>
          [{ at: Date.now(), tier: hitName, qty: 1 }, ...log].slice(0, 6),
        );
        return { ...prev, tiers };
      });
      // Pulse the seat grid so the "live sale" feel lands.
      setPulse(true);
      setTimeout(() => setPulse(false), 700);
    }, 6000);
    return () => clearInterval(t);
  }, [phase]);

  // Real-data sync: only after the purchase completes (simulation owns the
  // visual during onsale; the server is the source of truth at the end).
  useEffect(() => {
    if (phase !== "done") return;
    refresh();
  }, [phase, refresh]);


  // ---- replay trace with rhythm ----
  useEffect(() => {
    if (!result) return;
    setVisibleTrace([]);
    let i = 0;
    const interval = setInterval(() => {
      i += 1;
      setVisibleTrace((v) => {
        const next = result.trace.slice(0, i);
        return next;
      });
      if (i >= result.trace.length) clearInterval(interval);
    }, 900);
    return () => clearInterval(interval);
  }, [result]);

  useEffect(() => {
    traceRef.current?.scrollTo({ top: traceRef.current.scrollHeight, behavior: "smooth" });
  }, [visibleTrace]);

  // ---- the buy ----
  const buy = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setPhase("buying");
    setError("");
    setResult(null);
    try {
      const card = CARDS.find((c) => c.id === cardId)!;
      const r = await fetch("/api/showcase/buy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventId: event?.id, tierId, qty,
          card: { number: card.number, expMonth: "12", expYear: "2030", holder: "Demo Buyer", cvc: "123" },
          priority: PRIORITY,
        }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) {
        setResult(data);
        setPhase("done");
        throw new Error(data.error ?? "payment failed");
      }
      setResult(data);
      setPhase("done");
    } catch (e) {
      setError((e as Error).message);
      setPhase("done");
    } finally {
      busyRef.current = false;
    }
  };

  const card = CARDS.find((c) => c.id === cardId)!;

  if (phase === "loading") {
    return <Center><div style={{ color: "#99A0AE" }}>Loading onsale…</div></Center>;
  }

  return (
    <div style={{ minHeight: "100vh", background: "radial-gradient(1400px 900px at 80% -10%, #141a2b 0%, #0E121B 55%)", fontFamily: "system-ui, sans-serif", color: "#E1E4EA", paddingBottom: 60 }}>
      {/* Top bar */}
      <div style={{ maxWidth: 1440, margin: "0 auto", padding: "20px 28px 0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 24, height: 24, borderRadius: 7, background: "#2B7FFF", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 13 }}>S</div>
          <span style={{ fontWeight: 600, letterSpacing: 1.5, fontSize: 14 }}>SEATNERD</span>
          <span style={{ marginLeft: 12, color: "#717784", fontSize: 12 }}>Client demo · live Hyperswitch sandbox</span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "#717784" }}>Presidio Sunset · SF · Oct 4</span>
          <span style={{ padding: "4px 10px", borderRadius: 999, fontSize: 11, fontWeight: 600, background: "rgba(0,201,81,0.12)", color: "#00C951" }}>LIVE</span>
        </div>
      </div>

      {/* Header / countdown strip */}
      <div style={{ maxWidth: 1440, margin: "0 auto", padding: "24px 28px 0", display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 24, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 12, letterSpacing: 3, textTransform: "uppercase", color: "#8EC5FF", fontWeight: 600, marginBottom: 8 }}>
            Fredrepeat · Live at the Presidio
          </div>
          <h1 style={{ fontSize: 40, margin: 0, letterSpacing: "-0.02em", color: "#fff" }}>
            Onsale is live in{" "}
            {phase === "presale" && <span style={{ color: phase === "presale" && countdown <= 3 ? "#FCC800" : "#2B7FFF", fontVariantNumeric: "tabular-nums" }}>{countdown}s</span>}
            {phase === "onsale" && <span style={{ color: "#00C951" }}>NOW</span>}
            {phase === "buying" && <span style={{ color: "#2B7FFF" }}>processing…</span>}
            {phase === "done" && <span style={{ color: result?.ok ? "#00C951" : "#FB2C36" }}>{result?.ok ? "sold!" : "failed"}</span>}
          </h1>
          <div style={{ marginTop: 10, color: "#99A0AE", fontSize: 15, maxWidth: 640 }}>
            {phase === "presale" && `The entire venue is available. When the countdown hits zero, demand hits — and the payment layer has to survive it.`}
            {phase === "onsale" && `Seats are draining. Pick a tier, choose a card, and buy. Watch what happens behind the checkout.`}
            {phase === "buying" && `Sending your payment through the Hyperswitch sandbox — watch the trace on the right.`}
            {phase === "done" && result?.ok ? `Your ${qty} ticket(s) were issued and captured. Scroll the trace — this is what an orchestrator did for you.` : `Payment failed — the cascade stopped instead of burning attempts.`}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 12, color: "#717784", letterSpacing: 1, textTransform: "uppercase" }}>Revenue at stake</div>
          <div style={{ fontSize: 34, fontWeight: 700, color: "#fff", fontVariantNumeric: "tabular-nums" }}>
            {fmt((event?.tiers ?? []).reduce((a, t) => a + t.available * t.face_value, 0))}
          </div>
          <div style={{ fontSize: 12, color: "#717784", marginTop: 4 }}>{totalRemaining} seats left across {event?.tiers.length ?? 0} tiers</div>
        </div>
      </div>

      {/* Main grid */}
      <div style={{ maxWidth: 1440, margin: "0 auto", padding: "24px 28px 0", display: "grid", gridTemplateColumns: "minmax(0,1.05fr) minmax(0,0.95fr)", gap: 20 }}>
        {/* LEFT: the buyer's screen */}
        <div>
          {/* Inventory strip */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 16 }}>
            {(event?.tiers ?? []).map((t) => (
              <div key={t.id} style={{ border: `1px solid ${t.id === tierId ? "#2B7FFF" : "#222530"}`, borderRadius: 12, padding: "12px 14px", background: t.id === tierId ? "rgba(43,127,255,0.06)" : "#101721", cursor: "pointer" }} onClick={() => { setTierId(t.id); setQty(1); }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{t.name}</span>
                  <span style={{ fontSize: 14, fontWeight: 600, color: "#fff" }}>{fmt(t.face_value)}</span>
                </div>
                <div style={{ marginTop: 6, display: "flex", gap: 8, fontSize: 12 }}>
                  <span style={{ color: Math.max(t.available, 0) < 10 ? "#FCC800" : "#717784" }}>
                    {Math.max(t.available, 0)} left
                  </span>
                  <span style={{ color: "#717784" }}>{t.sold + t.held} taken</span>
                </div>
                <div style={{ marginTop: 8, height: 4, borderRadius: 2, background: "#222530", overflow: "hidden" }}>
                  <div style={{ width: `${Math.min((t.sold + t.held) / t.capacity * 100, 100)}%`, height: "100%", background: t.id === tierId ? "#2B7FFF" : "#525866" }} />
                </div>
              </div>
            ))}
          </div>

          {/* Seat map (stylized venue) */}
          <div style={{ border: "1px solid #222530", borderRadius: 16, padding: 20, background: "#101721", position: "relative", overflow: "hidden" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <div style={{ fontSize: 11, letterSpacing: 2, textTransform: "uppercase", color: "#717784" }}>Stage</div>
              {phase === "onsale" && (
                <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11, color: "#FCC800" }}>
                  <span style={{ width: 7, height: 7, borderRadius: 50, background: "#FCC800", animation: "blink 1.2s ease infinite" }} />
                  Live demand — seats selling now
                </div>
              )}
            </div>
            <div style={{ height: 22, width: "45%", margin: "0 auto 18px", background: "linear-gradient(90deg, #1c2a4a, #22335c)", borderRadius: 4, border: "1px solid #2B7FFF44" }} />
            <div style={{ fontSize: 11, letterSpacing: 2, textTransform: "uppercase", color: "#717784", marginBottom: 10 }}>Floor · {tier?.name}</div>
            <SeatGrid count={Math.min(Math.max(available, 0), 120)} sold={tier?.sold ?? 0} held={tier?.held ?? 0} pulse={pulse || phase === "onsale"} />
            <div style={{ marginTop: 14, display: "flex", gap: 16, fontSize: 11, color: "#717784" }}>
              <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, background: "#2B7FFF", marginRight: 5 }} />Available</span>
              <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, background: "#FCC800", marginRight: 5 }} />Held</span>
              <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, background: "#00C951", marginRight: 5 }} />Yours</span>
              <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, background: "#222530", marginRight: 5 }} />Sold</span>
            </div>
            {surgeLog.length > 0 && (
              <div style={{ marginTop: 14, borderTop: "1px solid #222530", paddingTop: 12 }}>
                <div style={{ fontSize: 11, letterSpacing: 2, textTransform: "uppercase", color: "#717784", marginBottom: 8 }}>
                  Live activity
                </div>
                {surgeLog.map((s, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, color: "#99A0AE", padding: "3px 0", opacity: 1 - i * 0.14 }}>
                    <span style={{ color: "#FCC800", fontSize: 10 }}>●</span>
                    <span>
                      Someone bought <b style={{ color: "#E1E4EA" }}>{s.qty}× {s.tier}</b>
                    </span>
                    <span style={{ marginLeft: "auto", color: "#525866", fontFamily: "monospace", fontSize: 11 }}>
                      {new Date(s.at).toLocaleTimeString("en-US", { hour12: false })}
                    </span>
                  </div>
                ))}
                <div style={{ fontSize: 10, color: "#525866", marginTop: 6 }}>
                  Simulated demand for demo purposes — your purchase is a real sandbox payment.
                </div>
              </div>
            )}
          </div>

          {/* Buy panel */}
          <div style={{ border: "1px solid #222530", borderRadius: 16, padding: 18, marginTop: 16, background: "#101721" }}>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontSize: 12, color: "#717784", marginBottom: 4 }}>Test card</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {CARDS.map((c) => (
                    <button key={c.id} onClick={() => setCardId(c.id)}
                      style={{ padding: "7px 12px", borderRadius: 999, cursor: "pointer", fontFamily: "monospace", fontSize: 12,
                        border: cardId === c.id ? "1px solid #2B7FFF" : "1px solid #222530",
                        background: cardId === c.id ? "rgba(43,127,255,0.1)" : "transparent",
                        color: cardId === c.id ? "#8EC5FF" : "#99A0AE" }}>
                      {c.label}
                    </button>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: "#717784", marginTop: 6 }}>{card.note}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 12, color: "#717784" }}>Qty</div>
                <select value={qty} onChange={(e) => setQty(Number(e.target.value))}
                  style={{ padding: "8px 12px", borderRadius: 8, background: "#0E121B", color: "#E1E4EA", border: "1px solid #222530", marginTop: 4 }}>
                  {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
              <button onClick={buy} disabled={phase === "buying" || available < qty}
                style={{ padding: "14px 28px", borderRadius: 10, border: "none", cursor: "pointer", fontWeight: 700, fontSize: 15,
                  background: phase === "buying" ? "#525866" : available < qty ? "#333a4a" : "#2B7FFF", color: "#fff" }}>
                {phase === "buying" ? "Processing…" : available < qty ? "Sold out" : `Buy ${qty} · ${fmt((tier?.face_value ?? 0) * qty)}`}
              </button>
            </div>
            {error && <div style={{ color: "#FB2C36", fontSize: 13, marginTop: 10 }}>{error}</div>}
          </div>
        </div>

        {/* RIGHT: the trace rail — what Juspay is doing */}
        <div style={{ display: "flex", flexDirection: "column", minHeight: 640 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 15 }}>Hyperswitch engine — live trace</div>
              <div style={{ fontSize: 12, color: "#717784" }}>Every real call your purchase makes, in order</div>
            </div>
            <span style={{ fontSize: 11, color: "#717784", fontFamily: "monospace" }}>{visibleTrace.length}/{result?.trace.length ?? 0}</span>
          </div>

          <div ref={traceRef} style={{ flex: 1, border: "1px solid #222530", borderRadius: 16, background: "#0B0F18", padding: 14, overflowY: "auto", maxHeight: 560, minHeight: 400 }}>
            {phase === "presale" && (
              <div style={{ padding: 30, textAlign: "center", color: "#525866" }}>
                <div style={{ fontSize: 40, marginBottom: 10 }}>⏳</div>
                <div style={{ fontSize: 14 }}>Trace will appear here the moment the onsale goes live.<br/>Countdown: <b style={{ color: "#8EC5FF" }}>{countdown}s</b></div>
              </div>
            )}
            {phase === "onsale" && visibleTrace.length === 0 && (
              <div style={{ padding: 30, textAlign: "center", color: "#525866" }}>
                <div style={{ fontSize: 14 }}>Onsale is live — press <b style={{ color: "#8EC5FF" }}>Buy</b> to fire the payment engine.</div>
              </div>
            )}
            {visibleTrace.map((t, i) => {
              const isFail = typeof t.status === "number" && t.status >= 400;
              const isLast = i === visibleTrace.length - 1;
              return (
                <div key={i} style={{ marginBottom: 10, animation: isLast ? "pop .3s ease" : undefined }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 10,
                    border: `1px solid ${isFail ? "rgba(251,44,54,0.35)" : "#222530"}`,
                    background: isFail ? "rgba(251,44,54,0.06)" : "#101721",
                    cursor: "pointer" }} onClick={() => setExpanded(expanded === i ? null : i)}>
                    <span style={{ fontSize: 11, fontFamily: "monospace", color: "#717784", width: 34 }}>{String(t.status ?? "").padStart(3)}</span>
                    <span style={{ fontSize: 10, fontFamily: "monospace", padding: "2px 6px", borderRadius: 4, background: "#0E121B", color: "#8EC5FF", border: "1px solid #222530" }}>
                      {t.method}
                    </span>
                    <span style={{ fontSize: 12, fontFamily: "monospace", color: "#99A0AE", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {t.path}
                    </span>
                    <span style={{ fontSize: 12, color: "#717784", fontFamily: "monospace" }}>{t.ms}ms</span>
                    <span style={{ fontSize: 16 }}>{isFail ? "✕" : isLast ? "●" : "✓"}</span>
                  </div>
                  <div style={{ marginTop: 2, paddingLeft: 56, fontSize: 12, color: "#99A0AE" }}>{t.step}</div>
                  {explain(t.step) && (
                    <div style={{ marginTop: 4, marginLeft: 56, fontSize: 11.5, lineHeight: 1.55, color: "#717784", borderLeft: "2px solid #222530", paddingLeft: 14 }}>
                      {explain(t.step)}
                    </div>
                  )}
                  {expanded === i && (
                    <div style={{ marginTop: 6, marginLeft: 56, padding: 10, borderRadius: 8, background: "#0B0F18", border: "1px solid #222530", fontFamily: "monospace", fontSize: 11, color: "#8EC5FF", maxHeight: 200, overflow: "auto", whiteSpace: "pre-wrap" }}>
                      {JSON.stringify({ request: t.request, response: t.response }, null, 1).slice(0, 1600)}
                    </div>
                  )}
                </div>
              );
            })}

            {result && result.attempts && (
              <div style={{ marginTop: 16, borderTop: "1px solid #222530", paddingTop: 14 }}>
                <div style={{ fontSize: 11, letterSpacing: 2, textTransform: "uppercase", color: "#717784", marginBottom: 10 }}>
                  Routing · Gateway-Status-Map decisions
                </div>
                {result.attempts.map((a, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, padding: "9px 12px", borderRadius: 10,
                    borderLeft: `3px solid ${a.ok ? "#00C951" : "#FB2C36"}`, background: "#101721" }}>
                    <span style={{ fontSize: 13, fontWeight: 600, width: 150 }}>{CONNECTOR_LABEL[a.connector] ?? a.connector}</span>
                    <span style={{ fontSize: 12, color: a.ok ? "#00C951" : "#FB2C36", flex: 1 }}>
                      {a.ok ? "authorized" : a.errorMessage ?? a.status}
                    </span>
                    {a.retryDecision && (
                      <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 999,
                        background: a.retryDecision === "retry" ? "rgba(252,200,0,0.12)" : "rgba(251,44,54,0.12)",
                        color: a.retryDecision === "retry" ? "#FCC800" : "#FB2C36" }}>
                        {a.retryDecision === "retry" ? "RETRY → next processor" : "DO NOT RETRY"}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {result?.ok && (
              <div style={{ marginTop: 16, padding: 16, borderRadius: 12, background: "rgba(0,201,81,0.07)", border: "1px solid rgba(0,201,81,0.3)" }}>
                <div style={{ fontWeight: 700, color: "#00C951", fontSize: 15 }}>✓ Sale rescued — ticket issued</div>
                <div style={{ fontSize: 12, color: "#99A0AE", marginTop: 6, fontFamily: "monospace" }}>
                  {(result.tickets ?? []).map((t) => `${t.seatLabel} · ${t.barcode}`).join("\n")}
                </div>
                <div style={{ fontSize: 12, color: "#99A0AE", marginTop: 8 }}>
                  Order <span style={{ fontFamily: "monospace", color: "#8EC5FF" }}>{result.orderId}</span>
                  {result.captured && " · funds captured"}
                  {result.captureSkippedReason && ` · ${result.captureSkippedReason}`}
                </div>
                <a href={`/order/${result.orderId}`} style={{ display: "inline-block", marginTop: 12, color: "#8EC5FF", fontSize: 13, textDecoration: "none" }}>
                  Open order detail →
                </a>
              </div>
            )}
            {result?.ok && (
              <div style={{ marginTop: 12, padding: 14, borderRadius: 12, border: "1px solid #222530", background: "#0B0F18", fontSize: 12.5, lineHeight: 1.65, color: "#99A0AE" }}>
                <b style={{ color: "#8EC5FF" }}>What just happened — in one breath:</b>{" "}
                {result.attempts && result.attempts.length > 1 ? (
                  <>
                    Your card was declined by{" "}
                    {result.attempts.slice(0, -1).map((a, i, arr) => (
                      <span key={i}>{CONNECTOR_LABEL[a.connector] ?? a.connector}{i < arr.length - 1 ? " and " : ""}</span>
                    ))}{" "}
                    — transient processor errors, not your fault. Hyperswitch's Gateway Status Map classified each as <span style={{ color: "#FCC800" }}>RETRY</span> and
                    moved to the next processor. <b style={{ color: "#00C951" }}>{CONNECTOR_LABEL[result.finalConnector ?? ""] ?? result.finalConnector}</b>{" "}
                    authorized the hold, your barcodes were issued, and funds were captured.
                    <b> A single-PSP merchant would have lost this sale at attempt one.</b>
                  </>
                ) : (
                  <>Your card was authorized by {CONNECTOR_LABEL[result.finalConnector ?? ""] ?? result.finalConnector}, barcodes issued, funds captured. Clean path — no failover needed.</>
                )}
              </div>
            )}
            {result && !result.ok && !result.error && (
              <div style={{ marginTop: 16, padding: 16, borderRadius: 12, background: "rgba(251,44,54,0.07)", border: "1px solid rgba(251,44,54,0.3)" }}>
                <div style={{ fontWeight: 700, color: "#FB2C36" }}>✗ Payment failed — no funds taken</div>
                <div style={{ fontSize: 12, color: "#99A0AE", marginTop: 4 }}>The cascade stopped after the hard decline. Seats released to inventory.</div>
              </div>
            )}

            {phase === "done" && (
              <button onClick={() => { setPhase("presale"); setCountdown(10); setResult(null); setVisibleTrace([]); setError(""); setSurgeLog([]); refresh(); }}
                style={{ marginTop: 14, width: "100%", padding: "12px", borderRadius: 10, border: "1px solid #222530", background: "transparent", color: "#8EC5FF", cursor: "pointer", fontWeight: 600, fontSize: 14 }}>
                ↺ Run the onsale again
              </button>
            )}
          </div>

          {/* Explanation strip — the "why this matters" under the trace */}
          <div style={{ marginTop: 12, padding: "12px 16px", borderRadius: 12, border: "1px solid #222530", background: "#101721", fontSize: 12, lineHeight: 1.6, color: "#99A0AE" }}>
            <b style={{ color: "#8EC5FF" }}>What you're watching:</b> one checkout, three processors.
            The card <span style={{ fontFamily: "monospace" }}>4000…9995</span> fails on FauxPay and PayPal with a transient
            connector error — the router marks it <span style={{ color: "#FCC800" }}>RETRY</span> and moves on.
            Stripe takes the payment. Your barcodes are issued, funds captured, seat marked sold.
            A single-PSP merchant would have lost this sale at <b>2 failed attempts</b>.
          </div>
        </div>
      </div>
    </div>
  );
}

function SeatGrid({ count, sold, held, pulse }: { count: number; sold: number; held: number; pulse: boolean }) {
  const total = Math.max(count, 1);
  const soldN = Math.min(sold, Math.floor(total * 0.5));
  const heldN = Math.min(held, Math.floor(total * 0.25));
  const seats = Array.from({ length: total }, (_, i) => {
    if (i < soldN) return "sold";
    if (i < soldN + heldN) return "held";
    return "open";
  });
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: 6 }}>
      {seats.map((s, i) => (
        <div key={i} style={{ aspectRatio: "1.6", borderRadius: 5,
          background: s === "sold" ? "#222530" : s === "held" ? "#FCC800" : "#2B7FFF",
          opacity: s === "sold" ? 1 : s === "held" ? 0.75 : pulse ? 0.85 : 1,
          animation: s === "open" && pulse ? "blink 2s ease infinite" : undefined,
          transition: "all .2s" }} />
      ))}
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0E121B", color: "#99A0AE", fontFamily: "system-ui" }}>
      {children}
    </div>
  );
}
