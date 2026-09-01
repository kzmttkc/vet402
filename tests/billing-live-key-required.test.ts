import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { isStripeConfigured } from "../src/lib/billing/plans";

// 2026-09-01: production was measured serving customers a TEST-mode Stripe
// Checkout page. A signed-up account POSTed /api/billing/checkout and got back
// `https://checkout.stripe.com/c/pay/cs_test_...` — the customer would land on
// a page banner-stamped TEST MODE where no real card can pay.
//
// The cause was not a bug in the checkout code. The code was correct and the
// environment was wrong, and nothing in the system could tell the difference:
// `isStripeConfigured()` asked only whether a key existed, so a test key looked
// exactly as configured as a live one.
//
// Selling is therefore gated on the key's mode, not its presence. A test key in
// production reads as "not configured", which 503s the checkout API and hides
// the paid CTA (dashboard/billing keys both off `stripeConfigured`). When live
// keys land, selling switches on by itself — no follow-up deploy to remember.
const ENV_KEYS = ["STRIPE_SECRET_KEY", "VERCEL_ENV"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function setEnv(vercelEnv: string | undefined, key: string | undefined) {
  if (vercelEnv === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = vercelEnv;
  if (key === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = key;
}

describe("isStripeConfigured — production refuses test-mode keys", () => {
  it("is false in production when the key is a test key", () => {
    setEnv("production", "sk_test_51abcDEF");
    assert.equal(isStripeConfigured(), false);
  });

  it("is false in production for a restricted test key too", () => {
    setEnv("production", "rk_test_51abcDEF");
    assert.equal(isStripeConfigured(), false);
  });

  it("is true in production when the key is a live key", () => {
    setEnv("production", "sk_live_51abcDEF");
    assert.equal(isStripeConfigured(), true);
  });

  it("accepts a live restricted key in production", () => {
    setEnv("production", "rk_live_51abcDEF");
    assert.equal(isStripeConfigured(), true);
  });

  it("is false when no key is set at all", () => {
    setEnv("production", undefined);
    assert.equal(isStripeConfigured(), false);
  });

  // Preview and local development must keep working with test keys, otherwise
  // the billing flow becomes untestable anywhere and the next mode mix-up gets
  // found in production again.
  it("allows a test key outside production", () => {
    setEnv("preview", "sk_test_51abcDEF");
    assert.equal(isStripeConfigured(), true);
    setEnv(undefined, "sk_test_51abcDEF");
    assert.equal(isStripeConfigured(), true);
  });

  // An unrecognised prefix is treated as live rather than blocked: refusing to
  // sell on a key we merely failed to classify would be a self-inflicted
  // outage, and the mode mix-up this guards against has a known shape.
  it("does not block a key whose prefix it cannot classify", () => {
    setEnv("production", "sk_51abcDEF");
    assert.equal(isStripeConfigured(), true);
  });
});
