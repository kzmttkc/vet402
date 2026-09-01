import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 2026-09-01: the homepage emitted schema.org Offer entries for Pro ($49) and
// Scale ($199) unconditionally, while production could not sell either plan —
// the checkout API was handing customers a TEST-mode Stripe page, and is now
// deliberately closed until live keys land.
//
// A visible plan-comparison table is a description of the tiers and stays put.
// An `Offer` is not a description: it is a machine-readable assertion that the
// thing is purchasable at that price, addressed to search engines and to the
// buying agents this product exists to serve. Publishing one for a plan nobody
// can buy is exactly the unverifiable claim vet402 sells against.
//
// So paid offers are derived from the same `isStripeConfigured()` that gates
// the checkout API and the paid CTA. One switch, three surfaces, no drift.
const SOURCE = readFileSync(join(process.cwd(), "src/app/page.tsx"), "utf8");

test("paid offers are gated on selling actually being on", () => {
  assert.match(
    SOURCE,
    /isStripeConfigured/,
    "page.tsx must consult isStripeConfigured() rather than always listing paid offers",
  );
});

test("the Free offer is not gated — signup works regardless of Stripe", () => {
  const offersStart = SOURCE.indexOf("offers:");
  assert.notEqual(offersStart, -1, "the JSON-LD offers array must still exist");
  const offersBlock = SOURCE.slice(offersStart, offersStart + 1200);
  const freeAt = offersBlock.indexOf("BILLING_PLANS.free.name");
  const gateAt = offersBlock.indexOf("isStripeConfigured");
  assert.notEqual(freeAt, -1, "the Free offer must still be published");
  assert.ok(
    gateAt === -1 || freeAt < gateAt,
    "Free must be listed before the paid gate, so it is never withheld",
  );
});

test("both paid plans sit behind the gate, not just one", () => {
  const gateAt = SOURCE.indexOf("isStripeConfigured");
  assert.notEqual(gateAt, -1);
  const gated = SOURCE.slice(gateAt);
  assert.match(gated, /BILLING_PLANS\.pro\.name/, "Pro must be behind the gate");
  assert.match(gated, /BILLING_PLANS\.scale\.name/, "Scale must be behind the gate");
});
