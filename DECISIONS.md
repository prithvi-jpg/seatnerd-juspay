# Decision Log — Hyperswitch Ticketing Prototype

Every entry: the decision, the alternatives considered, why this one, and what it costs.
This file is the raw material for the 3-page architecture doc.

---

## D1 — Vertical: US live event ticketing

**Alternatives:** travel/OTA, subscriptions, food delivery, marketplaces, donations.

**Chosen:** live event ticketing (small-to-mid venue onsale).

**Why:**
- Auth-then-capture is *structurally required*, not decorative. A ticket is not fulfilled
  until a barcode is issued. Money must be held, not taken, while inventory is held.
- Onsale surge is the canonical failover scenario. A PSP browning out for 90 seconds
  during a drop costs the entire event's revenue. This is the reason orchestration exists.
- US ticketing traffic is mobile- and wallet-dominant → Apple Pay / Google Pay are the
  primary conversion lever, not a nice-to-have.
- Naturally marketplace-shaped (venue / promoter / platform) → credible deferred scope
  for split payments and payouts.
- High-fraud vertical → justifies selective 3DS rather than blanket 3DS.

**Cost:** inventory-hold logic must be real, which is where most of the non-payment
engineering budget goes.

---

## D2 — Build lean, do NOT fork Medusa/Saleor/Pretix

**Alternatives:**
- Fork Medusa v2, implement `AbstractPaymentProvider` (initiatePayment / authorizePayment /
  capturePayment / refundPayment / getPaymentStatus / getWebhookActionAndData).
- Fork Vendure, implement `PaymentMethodHandler` (createPayment / settlePayment / cancelPayment).
- Fork Pretix (Django, ticketing-native), implement `BasePaymentProvider`.

**Chosen:** purpose-built Next.js app on Vercel + Neon Postgres.

**Why:**
- 24-hour budget. Medusa/Saleor/Pretix each require a non-Vercel backend host, Postgres,
  usually Redis, plus their own module/plugin learning curve. Estimated 8+ hours before
  the first line of *payment* code — over a third of total budget spent on someone else's
  docker-compose.
- Juspay has already published "Add multiple payment providers to Medusa v2 with
  medusa-custom-payments plugin" (blog, Jun 2026). Reproducing it reads as following a
  tutorial rather than making an architectural argument.
- The interesting engineering in ticketing is NOT the cart. It is (a) coupling the payment
  state machine to the inventory-hold state machine and (b) routing/retry behaviour under
  surge. A generic commerce fork actively hides both behind its own abstractions.

**Cost:** the order state machine is hand-rolled, so it must be small, explicit and correct.
Mitigation: keep it a single well-tested module with an explicit state enum.

**Honest note for the walkthrough:** the fork approach is the right call on a 2-week budget,
and the Medusa `AbstractPaymentProvider` seam is genuinely clean. This is a
time-boxed trade, not a claim that bespoke beats reuse.

---

## D3 — Integration mode: Hyperswitch Web SDK (UnifiedCheckout) + server-side mutations

**Alternatives:**
- (a) Server-to-server API with a fully custom card form.
- (b) Hosted payment link / hosted checkout page.
- (c) Web SDK UnifiedCheckout driven by `client_secret`.  ← chosen

**Why (c):**
- Raw PAN never touches our origin or our server → PCI SAQ-A posture instead of SAQ-D.
  For a prototype this is a *stated architectural position*, which is the point.
- Wallets (Google Pay), BNPL (Klarna / Affirm / Afterpay) and cards render from one
  component driven by Hyperswitch's payment-methods response. Adding a method becomes a
  dashboard config change, not a frontend release.
- Retains full control of the purchase journey and post-payment fulfilment, unlike (b).
- All state-changing calls (create / capture / void / refund) stay server-side with the
  secret key; the browser only ever holds `client_secret` + publishable key.

**Cost:** less pixel control than a bespoke form. Acceptable — appearance API covers theming.

---

## D4 — Capture model: `capture_method = manual`

Authorize when the seat hold is taken. Capture only when the barcode is issued.
Void when the hold expires unfulfilled.

Verified against Hyperswitch source (`crates/common_enums/src/enums.rs`):
- `CaptureMethod::{Automatic, Manual, ManualMultiple, Scheduled, SequentialAutomatic}`
- `IntentStatus::RequiresCapture` is the state we park in between hold and fulfilment.
- `IntentStatus::PartiallyCapturedAndCapturable` and
  `IntentStatus::PartiallyAuthorizedAndRequiresCapture` exist → partial capture is a
  first-class concept, relevant for partially-fulfilled multi-ticket orders.

**Why it matters for this vertical:** taking money for a seat that was never issued is the
single worst failure mode in ticketing — it creates a refund, a support ticket, and a
chargeback risk for a customer who never received anything. Manual capture makes that
structurally impossible: no barcode, no capture.

---

## D5 — The failover demo (the centrepiece)

Verified in Hyperswitch source, `crates/router/src/routes/dummy_connector/utils.rs`:

| Card                | Behaviour                                                      |
|---------------------|----------------------------------------------------------------|
| 4242424242424242    | succeeds on all dummy connectors                                |
| 4000000000000002    | "Card declined" — hard decline, everywhere                      |
| 4000000000009987    | "Lost card" — hard decline                                      |
| 4000000000009979    | "Stolen card" — hard decline                                    |
| **4000000000009995**| **fails on fauxpay/paypal_test with "Internal Server Error from Connector, Please try again later"; SUCCEEDS on stripe_test** |
| 4000003800000446    | 3DS challenge flow                                              |

The 9995 failure is a *transient processor error*, not a card-level decline — precisely the
class that Hyperswitch's Gateway Status Map (GSM) marks retryable.

Retry machinery verified in `crates/router/src/core/payments/retry.rs`:
`do_gsm_actions`, `get_gsm_decision`, `do_retry`, `make_new_auto_retry_payment_attempt`,
with `GsmDecision::{Retry, DoDefault, DoNotRetry}`.

**Demo:** route non-Stripe first → transient failure → GSM returns `Retry` → auto-retry on
stripe_test → succeeds. One PaymentIntent, two PaymentAttempts, ticket issued.
Contrast with 4000000000009979 (stolen): hard decline, no retry, attempt not wasted.

That contrast — retry the retryable, don't retry the unretryable — is the actual thesis.

---

## D6 — Routing configuration

Verified `RoutingAlgorithmKind` in `crates/api_models/src/routing.rs`:
`Single | Priority | VolumeSplit | Advanced | Dynamic | ThreeDsDecisionRule`

and `StaticRoutingAlgorithm::{Single, Priority, VolumeSplit, Advanced(Program<..>)}`,
`DynamicRoutingAlgorithm::{EliminationBasedAlgorithm, SuccessBasedAlgorithm, ContractBasedAlgorithm}`.

**Chosen for the prototype:** `Priority` routing across the three configured connectors,
so failover order is deterministic and demonstrable on stage.

**Discussed as the production answer:** `SuccessBasedAlgorithm` (dynamic) — route by
observed real-time authorisation rate per connector. Under an onsale surge this is what you
actually want: the router notices a degrading processor and shifts volume away from it
before a human could.

---

## D7 — Connectors configured (sandbox)

```
merchant_id : merchant_1785913207
profile_id  : pro_qtI93gNwM6ETwnAikcTk
fauxpay     : mca_r42pm00SVseBsxsh773D   Card
paypal_test : mca_oLwVVfh6SrYh5VPa8WFn   Card
stripe_test : mca_7oS3SFPvyl4cgZlqzMlV   Card, Google Pay, Klarna/Affirm/Afterpay
```

Dummy connectors chosen over real test processors deliberately: deterministic outcomes,
no processor onboarding, and — critically — card 4000000000009995 gives a
*connector-dependent* result, which is what makes a real failover demonstrable at all.

---

## D8 — Deferred, with a plan

Not built. Each has a stated approach — see the architecture doc.

- Split payments to venue / promoter / platform (`SplitPaymentsRequest` exists in the API:
  `stripe_split_payment`, `adyen_split_payment` variants).
- Payouts API for promoter settlement.
- Disputes / chargeback handling (high-value in ticketing fraud).
- Network tokenization (verified: dedicated `network_tokenization_incoming` webhook path).
- 3DS decision manager rules (`ThreeDsDecisionRule` routing kind) — selective SCA by
  amount/risk rather than blanket 3DS.
- Apple Pay (requires domain verification + merchant identity certificate — a real-account
  blocker in sandbox, worth calling out explicitly).
- ACH / bank debit via Plaid for high-value season tickets.
- Incremental authorization (upgrades / seat changes after initial auth).
- Queue-It style virtual waiting room in front of the onsale.
