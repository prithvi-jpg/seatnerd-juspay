# AGENTS.md — operating rules for AI agents on this repo

Read this before touching anything. It is short on purpose.

## What this project is

A prototype of a **US live-event ticketing** purchase journey that takes a buyer from seat
selection to a **real completed payment in the Juspay Hyperswitch sandbox**.

Built for a Juspay Round-1 take-home. The graded qualities are, in order:
1. Sound architecture and *defensible* integration choices driven by the vertical.
2. A real, working, hosted end-to-end payment.
3. Clear articulation of what was deferred and how it would be approached.
4. Evidence of disciplined AI-assisted engineering (this session is a deliverable).

Time budget is 24 hours. **Scope discipline beats completeness.** Gold-plating is a
negative signal — the brief says "time and quality matter".

## Non-negotiable rules

1. **Never invent an API.** Every Hyperswitch endpoint, field name, enum variant or status
   must be verified against either
   `/home/prithvi/juspay-prototype/research/repos/hyperswitch` (cloned source) or the
   official API reference. If you cannot verify it, write `UNVERIFIED:` next to it and stop.
   Fabricated payment APIs are the single fastest way to fail this exercise.

2. **Secrets never leave the server.** The Hyperswitch API key (`snd_...`) is server-only.
   Only the publishable key (`pk_snd_...`) and `client_secret` may reach the browser.
   Never log a full card number, CVV, or the API key. `.env.local` is gitignored and stays
   gitignored.

3. **All payment mutations are server-side.** Create / confirm / capture / void / refund
   happen in route handlers, never from client code. The client gets a `client_secret`
   and nothing else.

4. **Amounts are integers in the smallest currency unit.** USD cents. Never floats.
   Never do float arithmetic on money anywhere in this codebase.

5. **Webhooks are the source of truth for payment state**, not the browser redirect.
   The browser can be closed, the network can drop. Reconcile from webhook + explicit
   status retrieve. Treat every webhook as potentially duplicated and out-of-order —
   handlers must be idempotent.

6. **Every state transition must be traceable.** Persist an event row for each transition
   (who, what, when, connector, attempt id, decline code). The ops console reads these.
   This is a payments project: an untraceable state change is a bug.

7. **Keep the order state machine explicit and small.** One module, one enum, one
   transition function. No implicit state scattered across handlers.

## Verified facts (do not re-derive, do not contradict)

Verified by reading the cloned Hyperswitch source:

- `IntentStatus`: `Succeeded, Failed, Cancelled, CancelledPostCapture, Processing,
  RequiresCustomerAction, RequiresMerchantAction, RequiresPaymentMethod,
  RequiresConfirmation, RequiresCapture, PartiallyCaptured,
  PartiallyCapturedAndCapturable, PartiallyAuthorizedAndRequiresCapture`
  — `crates/common_enums/src/enums.rs`
- `CaptureMethod`: `Automatic, Manual, ManualMultiple, Scheduled, SequentialAutomatic`
- `AttemptStatus` includes `Authorized, Charged, Voided, VoidedPostCharge, CaptureInitiated,
  PartialCharged, AuthenticationPending, RouterDeclined, Failure, Expired`
- `RoutingAlgorithmKind`: `Single, Priority, VolumeSplit, Advanced, Dynamic,
  ThreeDsDecisionRule` — `crates/api_models/src/routing.rs`
- `GsmDecision`: `Retry, DoDefault, DoNotRetry`; retry machinery in
  `crates/router/src/core/payments/retry.rs` (`do_gsm_actions`, `get_gsm_decision`,
  `do_retry`, `make_new_auto_retry_payment_attempt`)
- Dummy-connector test cards — `crates/router/src/routes/dummy_connector/utils.rs`:

  | Card | Behaviour |
  |------|-----------|
  | 4242424242424242 / 4111111111111111 / 5555555555554444 | succeed |
  | 4000000000000002 / 5105105105105100 | "Card declined" (hard) |
  | 4000000000009987 | "Lost card" (hard) |
  | 4000000000009979 | "Stolen card" (hard) |
  | **4000000000009995** | **transient failure on non-Stripe dummy connectors; SUCCEEDS on stripe_test** |
  | 4000003800000446 | 3DS challenge |

## Sandbox environment

```
base url    : https://sandbox.hyperswitch.io
merchant_id : merchant_1785913207
profile_id  : pro_qtI93gNwM6ETwnAikcTk
connectors  : fauxpay     mca_r42pm00SVseBsxsh773D  (Card)
              paypal_test mca_oLwVVfh6SrYh5VPa8WFn  (Card)
              stripe_test mca_7oS3SFPvyl4cgZlqzMlV  (Card, Google Pay, Klarna/Affirm/Afterpay)
```

Auth header for server calls: `api-key: <HYPERSWITCH_API_KEY>`.

## Stack

- Next.js App Router + TypeScript, deployed on Vercel.
- Neon serverless Postgres (works from Vercel edge/serverless without connection pooling pain).
- `@juspay-tech/hyper-js` + `@juspay-tech/react-hyper-js` for UnifiedCheckout.
- Package manager: **bun** (user preference). `bun install`, `bun run dev`.
- No Docker. No separate backend service. It must deploy with `git push`.

## Definition of done for any task

- It runs. You executed it and pasted real output — not a description of expected output.
- Money math is integer cents.
- The failure path is handled, not just the happy path.
- If it touches payment state, it writes an event row.
- If you learned something that contradicts this file, update this file.

## Anti-goals

- Do not build an admin CMS, user auth, email delivery, or a seat-map editor.
- Do not add a state-management library. React state + server components are enough.
- Do not abstract prematurely. Two connectors is not a plugin ecosystem.
- Do not write tests for framework glue. Do test the order state machine and money math.
