/**
 * Money. Integer cents only. No floats anywhere near a payment amount.
 *
 * Every amount that crosses the Hyperswitch API boundary is an integer in the
 * smallest currency unit (USD cents), matching the `amount` field semantics.
 */

export type Cents = number & { readonly __brand: unique symbol };

export function cents(n: number): Cents {
  if (!Number.isInteger(n)) throw new Error(`Money must be integer cents, got ${n}`);
  if (n < 0) throw new Error(`Money must be non-negative, got ${n}`);
  return n as Cents;
}

export function addCents(...xs: Cents[]): Cents {
  return cents(xs.reduce((a, b) => a + b, 0));
}

export function mulCents(a: Cents, qty: number): Cents {
  if (!Number.isInteger(qty) || qty < 0) throw new Error(`qty must be a non-negative integer, got ${qty}`);
  return cents(a * qty);
}

/** Percentage fee, rounded half-up to the nearest cent. Deterministic. */
export function pctOf(a: Cents, percent: number): Cents {
  return cents(Math.round((a * percent) / 100));
}

export function formatUSD(a: Cents): string {
  return (a / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/**
 * US ticketing fee model.
 *
 * The FTC's rule on unfair or deceptive fees (effective 2025) targets live-event
 * ticketing and short-term lodging specifically: the total price a consumer will
 * actually pay must be disclosed up front and displayed at least as prominently
 * as any other price. Fees cannot be revealed only at the final step.
 *
 * Consequence for architecture, not just for UI copy: the *total* is computed at
 * seat-hold time and is the number we authorise. Face value alone is never
 * authorised, and no fee is added after the buyer has seen the total.
 */
export interface Fees {
  faceValue: Cents;      // to the artist/promoter
  serviceFee: Cents;     // platform
  facilityFee: Cents;    // venue
  total: Cents;          // what the buyer is charged, disclosed up front
}

export const SERVICE_FEE_PCT = 12;
export const FACILITY_FEE_PER_TICKET = cents(350); // $3.50/ticket, venue

export function computeFees(unitFaceValue: Cents, qty: number): Fees {
  const faceValue = mulCents(unitFaceValue, qty);
  const serviceFee = pctOf(faceValue, SERVICE_FEE_PCT);
  const facilityFee = mulCents(FACILITY_FEE_PER_TICKET, qty);
  return {
    faceValue,
    serviceFee,
    facilityFee,
    total: addCents(faceValue, serviceFee, facilityFee),
  };
}
