# Sandbox Verification Log — real calls, real responses

Every call below was executed against `https://sandbox.hyperswitch.io` with the SeatNerd
sandbox merchant. Nothing here is illustrative; these are captured responses.

Merchant `merchant_1785913207`, profile `pro_qtI93gNwM6ETwnAikcTk`.

---

## V1 — Create payment, manual capture

`POST /payments` with `confirm:false`, `capture_method:"manual"`, amount `12800` USD cents.

```
payment_id        = pay_urzkd6CBurzQdIEcOu0d
status            = requires_payment_method
capture_method    = manual
amount            = 12800
amount_capturable = 0
client_secret     = pay_urzkd6CBurzQdIEcOu0d_secret_4GTAWsdUTTx8K5OFeyHo
```

Note the response also returns `sdk_authorization`, a base64 blob packing
`profile_id`, `publishable_key`, `client_secret`, `client_session_id`, `payment_id` —
this is what the Web SDK consumes.

---

## V2 — Failover leg 1: card 4000000000009995 on **fauxpay** → DECLINED

`POST /payments/pay_urzkd6CBurzQdIEcOu0d/confirm`
with `routing: {type:"single", data:{connector:"fauxpay", merchant_connector_id:"mca_r42pm00SVseBsxsh773D"}}`

```
status                = failed
connector             = fauxpay
error_code            = DC_08
error_message         = Payment declined: Internal Server Error from Connector, Please try again later
unified_code          = UE_9000
unified_message       = Something went wrong
attempt_count         = 1
merchant_connector_id = mca_r42pm00SVseBsxsh773D
```

This is a **transient** processor failure — the retryable class.

---

## V3 — Failover leg 2: the SAME card on **stripe_test** → SUCCEEDED

```
payment_id        = pay_yR7GsmZOSc7VGou74o5t
status            = succeeded
connector         = stripe_test
error_code        = None
amount_received   = 12800
```

**Identical card number, opposite outcome, purely because of connector choice.**
This is the empirical basis for the whole routing/failover argument. Sourced from
`crates/router/src/routes/dummy_connector/utils.rs`, lines ~316-330, where card
`4000000000009995` branches on `if connector == DummyConnectors::StripeTest`.

---

## V4 — Hard decline is distinguishable from transient failure

Card `4000000000009979` on stripe_test:

```
status        = failed
connector     = stripe_test
error_code    = DC_08
error_message = Payment declined: Stolen card
unified_code  = UE_9000
```

Same `error_code`/`unified_code` as the transient case, but a different
`error_message`. **Important consequence:** on these dummy connectors you cannot
distinguish retryable from non-retryable on `error_code` alone. A production GSM
config keys on (connector, code, message) → decision. Our app classifies on the
message string for the demo and says so out loud rather than pretending the code
is sufficient.

Retrying a stolen card is not just wasteful — repeated declines damage the
merchant's authorisation-rate reputation with issuers. "Don't retry" is a feature.

---

## V5 — CONNECTOR LIMITATION: dummy connectors ignore manual capture

`POST /payments` with `confirm:true`, `capture_method:"manual"`, card 4242…4242,
routed to stripe_test:

```
payment_id        = pay_xDZ8juL1EZjai54w51FQ
status            = succeeded        <-- expected: requires_capture
amount_capturable = 9900
amount_received   = 9900             <-- funds already taken
capture_method    = manual           <-- intent recorded correctly
```

Then `POST /payments/pay_xDZ8juL1EZjai54w51FQ/capture`:

```json
{"error":{"type":"invalid_request",
 "message":"This Payment could not be captured because it has a payment.status of succeeded. The expected state is requires_capture, partially_captured_and_capturable, processing",
 "code":"IR_14"}}
```

**Diagnosis:** Hyperswitch records and forwards `capture_method: manual` correctly; the
*dummy connector* does not implement the separate-auth step and settles immediately.
This is a sandbox connector limitation, **not** an API or integration error.

**Consequences for the build:**
1. The auth→capture→void design stays — it is the correct architecture for ticketing and
   the API supports it fully (`IntentStatus::RequiresCapture` etc. verified in source).
2. The application must not assume `requires_capture` will be reached. It reads the actual
   returned status and branches. Code that only handles the ideal path would break here.
3. For the demo we surface both: the intended lifecycle, and what this connector actually
   did — with the `IR_14` error as evidence. That error message conveniently enumerates
   the valid capture states straight from the router.
4. Real processors in test mode (Stripe test via real credentials, Adyen test) do honour
   manual capture. Called out as an environment constraint, not hand-waved.

---

## Verified error taxonomy

Hyperswitch normalises connector errors into a unified layer:

| field | meaning | example |
|---|---|---|
| `error_code` | connector's code, passed through | `DC_08` |
| `error_message` | connector's message | `Payment declined: Stolen card` |
| `unified_code` | Hyperswitch-normalised code | `UE_9000` |
| `unified_message` | normalised, user-safe message | `Something went wrong` |

The unified layer is what lets one piece of merchant code handle N processors —
the reason an orchestrator exists. Worth noting the dummy connectors collapse
several distinct conditions into `UE_9000`; richer connectors map more precisely.

---

## Confirmed API state machine (runtime + source agreement)

Capture is valid only from: `requires_capture`, `partially_captured_and_capturable`,
`processing` — per the `IR_14` error text, matching `IntentStatus` in
`crates/common_enums/src/enums.rs`.

## Test card matrix (verified in source, spot-checked live)

| Card | Result |
|---|---|
| 4242424242424242 | success |
| 4111111111111111 | success |
| 5555555555554444 | success |
| 4000000000000002 | "Card declined" (hard) |
| 5105105105105100 | "Card declined" (hard) |
| 4000000000009987 | "Lost card" (hard) |
| 4000000000009979 | "Stolen card" (hard) — verified live |
| **4000000000009995** | **transient fail on fauxpay/paypal_test; success on stripe_test — verified live both ways** |
| 4000003800000446 | 3DS challenge |
