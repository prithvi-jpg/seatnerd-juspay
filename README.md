# SeatNerd — US live-event ticketing on Juspay Hyperswitch

**Round 1 take-home prototype.** Takes a buyer from seat selection to a **real, completed
payment in the Hyperswitch sandbox**, and demonstrates why payment orchestration exists.

**Live app:** https://seatnerd.vercel.app · **Showcase:** https://prithvi-jpg.github.io/seatnerd-juspay/ · **Failover demo:** https://seatnerd.vercel.app/demo ·
**Ops console:** https://seatnerd.vercel.app/ops

## The thesis

Live-event ticketing is the vertical where orchestration is structurally necessary:

- **Onsale surge** = the canonical failover scenario (a PSP browning out for 90 seconds
  costs the whole event's revenue).
- **Auth-then-capture is required** — a ticket isn't fulfilled until a barcode is issued.
  Money is held, not taken, while inventory is held.
- **Wallet-first, mobile-dominant** US market; **FTC all-in pricing** names ticketing
  explicitly.

## The demo (the centrepiece)

Card `4000 0000 0000 9995` **fails** on fauxpay and paypal_test with a transient connector
error, and **succeeds** on stripe_test — a connector-dependent outcome baked into
Hyperswitch's own dummy connector (`crates/router/src/routes/dummy_connector/utils.rs`).
The app cascades across the routing priority (GSM-style retry decision), rescues the sale,
and issues the ticket. A stolen card (`4000 0000 0000 9979`) stops the cascade after one
attempt — retries are never wasted on hard declines.

Both return the same `error_code DC_08 / unified_code UE_9000`; only the message
distinguishes them, so retry decisions key on (connector, code, message).

## Architecture

```
Buyer → Next.js storefront (Vercel) → Web SDK (client_secret only)
      → API routes (server, snd_ key) → Neon Postgres
      → Hyperswitch sandbox (fauxpay · paypal_test · stripe_test)
      → order_events (append-only audit trail) → ops console
```

Key choices (full rationale in `docs/architecture-decisions.md`):

1. **Manual capture** — authorize at hold, capture after barcode issue, void on expiry.
   Charged-for-a-ticket-that-never-existed is structurally impossible.
2. **Web SDK + server-side mutations** — publishable key only in the browser; PCI SAQ-A
   posture; wallets/BNPL render from the SDK.
3. **Purpose-built engine, not a forked commerce platform** — a fork costs a non-Vercel
   backend + Postgres + Redis + a plugin system to learn; the interesting engineering here
   is the payment↔inventory coupling, which we own entirely.
4. **Atomic oversell guard** — `UPDATE ... WHERE capacity - sold - held >= qty` is the
   whole concurrency story for an onsale.
5. **Append-only `order_events`** — every transition is traceable; the ops console reads
   it (auth rate by connector, decline taxonomy, retry decisions, inventory).

## Verified against the real sandbox

`docs/VERIFICATION.md` (in-repo copy) contains every curl call and response — the
manual-capture connector limitation (`IR_14`), the failover both ways, the hard-decline
matrix — all captured live.

## Run locally

```bash
bun install
cp .env.local.example .env.local   # fill from your Hyperswitch sandbox dashboard
bun run db:seed                    # schema + events
bun run dev                        # http://localhost:3000
```

Requires: Hyperswitch sandbox account (Developers → API Keys), Neon Postgres.

## Repo map

| Path | What |
|---|---|
| `lib/money.ts` | Integer cents; FTC all-in pricing (fees shown up front) |
| `lib/order-state.ts` | Explicit 8-state machine + IntentStatus mapping + retry classification |
| `lib/hyperswitch.ts` | Server-only HS client (create/confirm/retrieve/capture/cancel/refund) |
| `lib/checkout.ts` | hold → authorize(failover) → issue → capture orchestration |
| `lib/db.ts` | Neon schema + append-only event log |
| `app/api/*` | Route handlers (events, checkout, authorize, orders, webhooks, ops, sweep) |
| `app/demo` | Failover harness (card + routing priority → attempt timeline) |
| `app/ops` | Payments ops console |
| `docs/` | Architecture & decisions, interactive deck, verification log |
| `AGENTS.md` | Operating rules + verified facts for AI-assisted builds |
| `DECISIONS.md` | Every decision with alternatives and costs |

## Deferred (with approach)

Split payments & payouts · 3DS decision rules · network tokenization · Apple Pay
(real-account blocker in sandbox) · disputes · virtual waiting room.
