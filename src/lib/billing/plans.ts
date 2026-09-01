export const BILLING_PLANS = {
  free: {
    name: "Free",
    monthlyLimit: 1_000,
    priceLabel: "$0",
    stripePriceId: null,
  },
  pro: {
    name: "Pro",
    monthlyLimit: 50_000,
    priceLabel: "$49/mo",
    stripePriceId: () => process.env.STRIPE_PRICE_PRO ?? null,
  },
  scale: {
    name: "Scale",
    monthlyLimit: 500_000,
    priceLabel: "$199/mo",
    stripePriceId: () => process.env.STRIPE_PRICE_SCALE ?? null,
  },
} as const;

export type PaidPlan = "pro" | "scale";

export function planFromStripePriceId(priceId: string): PaidPlan | null {
  if (priceId === process.env.STRIPE_PRICE_PRO) return "pro";
  if (priceId === process.env.STRIPE_PRICE_SCALE) return "scale";
  return null;
}

// A Stripe key carries its own mode in its prefix. Production selling is gated
// on that mode rather than on the key merely existing, because on 2026-09-01
// production was measured handing customers a `cs_test_...` Checkout URL: a
// page stamped TEST MODE that no real card can pay. Nothing failed — the code
// was right and the environment was wrong, and `Boolean(STRIPE_SECRET_KEY)`
// could not tell the two apart.
//
// Reading a production test key as "not configured" closes the checkout API
// (503) and hides the paid CTA, since both key off this one function. Live keys
// switch selling back on by themselves.
function isProductionRuntime(): boolean {
  return (process.env.VERCEL_ENV ?? process.env.NODE_ENV) === "production";
}

export function isStripeConfigured(): boolean {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return false;
  // Only a recognised test prefix blocks. An unclassifiable key is allowed
  // through: refusing to sell on a key we merely failed to parse would be a
  // self-inflicted outage, and this guards a mix-up with a known shape.
  if (isProductionRuntime() && /^(sk|rk)_test_/.test(key)) return false;
  return true;
}
