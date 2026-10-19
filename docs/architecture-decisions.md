# SeatNerd — Architecture & Decisions
### A US live-event ticketing payments prototype on Juspay Hyperswitch

*Prithvi Rey — Juspay Hyperswitch Round 1*

---

## 1. The industry and why

**Live event ticketing (US).** Tickets are sold under surge conditions for a finite
inventory of time-sensitive seats, mostly to mobile buyers. That combination makes it the
vertical where payment orchestration is *structurally* necessary, not optional:

- **Onsale surge is the canonical failover scenario.** A payment processor browning out
  for 90 seconds during a ticket drop costs the entire event's revenue. A merchant with
  one PSP has no answer to this; an orchestrator routes around it in milliseconds.
- **Auth-then-capture is genuinely required.** A ticket is not fulfilled until a barcode
  is issued. Money must be *held*, not taken, while inventory is held — and the two
  lifecycles must be welded together.
- **Mobile/wallet-first.** US ticketing conversion is dominated by Apple Pay and Google
  Pay; these are the primary checkout lever, not a feature.
- **Marketplace-shaped.** Proceeds split venue / promoter / platform; fraud is high, so
  selective 3DS and careful retry policy matter; the FTC's all-in-pricing rule (effective
  2025, live-event ticketing named explicitly) makes the *total shown up front* a
  regulatory requirement, not a UX preference.

## 2. Flows it needs

| Flow | Status |
|---|---|
| Seat hold → auth (manual capture) → barcode issue → capture | **Built** |
| Connector failover under transient failure | **Built (live demo)** |
| Hard-decline handling (no wasted retries) | **Built** |
| Hold expiry → void → inventory release | **Built (cron)** |
| Webhook reconciliation + idempotency | **Built** |
| Ops visibility (auth rate, decline taxonomy, retries) | **Built** |
| Split payments to venue/promoter | Deferred — see §5 |
| Disputes, network tokens, 3DS decision rules, Apple Pay certs | Deferred — see §5 |

## 3. Integration choices and reasoning

**Capture model — `capture_method: manual`.** Authorize at hold time; capture strictly
*after* barcode issuance; void on expiry/abandonment. This makes "charged for a ticket
that was never issued" structurally impossible — the worst failure mode in ticketing.
Verified against `IntentStatus::RequiresCapture` and `CaptureMethod::Manual` in
`crates/common_enums/src/enums.rs`.

**Integration mode — Hyperswitch Web SDK (`@juspay-tech/react-hyper-js`), driven by
`client_secret`.** The browser holds only the publishable key and a client secret; the
secret API key never leaves the server (PCI SAQ-A posture). Wallets and BNPL render from
the SDK, so adding a payment method becomes a dashboard change, not a release.

**Routing — deterministic Priority across three connectors** (fauxpay → paypal_test →
stripe_test), so failover is demonstrable on stage. Production answer noted in the doc:
`SuccessBasedAlgorithm` dynamic routing on observed authorization rate.

**Retry policy — Gateway-Status-Map-style classification.** Verified live that a
transient connector error and a stolen card return the *same* `error_code (DC_08)` and
`unified_code (UE_9000)`; only the message differs. Retry decisions therefore key on
(connector, code, message): transient → cascade to next connector; hard decline → stop
immediately. A stolen card is never retried — repeated declines damage the merchant's
auth-rate reputation with issuers.

**Engine — purpose-built Next.js + Neon Postgres, not a forked commerce platform.**
Forking Medusa/Saleor/Pretix was evaluated; each costs a non-Vercel backend, Postgres,
usually Redis, plus its own plugin system — over a third of a 24-hour budget before
payment code. Juspay has also already published the Medusa plugin walkthrough, making it
a tutorial reproduction rather than an architectural argument. The interesting
engineering here is the coupling of the payment state machine to inventory holds, and
routing behavior under surge — both purpose-built, both fully owned.

## 4. End-to-end

1. Buyer picks tier/qty → **atomic SQL hold** (`capacity - sold - held >= qty` in the
   WHERE clause — the oversell guard).
2. Server creates the payment intent (manual capture) and returns a `client_secret`.
3. UnifiedCheckout authorizes; on transient failure the app cascades to the next
   connector (live demo: fauxpay ✗ → paypal_test ✗ → stripe_test ✓).
4. Barcodes are issued; **only then** is the payment captured (dummy connectors in
   sandbox settle at auth; handler detects this and skips `/capture` instead of hitting
   the `IR_14` error — documented limitation, handled defensively).
5. Every transition writes an append-only `order_events` row — the ops console's data
   source. Webhooks (HMAC-SHA512 verified) reconcile state; a cron releases expired
   holds.

Live: https://seatnerd.vercel.app — demo harness: /demo — ops: /ops

## 5. Deferred, with approach

- **Split payments** (`SplitPaymentsRequest` — stripe/adyen variants exist in the API):
  single auth, split at capture to venue + promoter + platform; payout via Payouts API.
- **3DS decision manager** (`ThreeDsDecisionRule` routing kind): selective SCA by
  amount/risk for ticketing's fraud profile instead of blanket 3DS.
- **Network tokenization**: dedicated token incoming-webhook path exists; on issuer
  availability, tokenize at save-time to lift auth rates.
- **Apple Pay**: requires merchant identity cert + domain verification — real-account
  blocker in sandbox, called out rather than faked.
- **Disputes**: webhook-driven intake + evidence workflow per card scheme.
- **Virtual waiting room** (Queue-It style) in front of the onsale to flatten surge.
