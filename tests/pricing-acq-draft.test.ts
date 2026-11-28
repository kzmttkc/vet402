// ACQ §10 draft: plan limits, tax wording, and public surfaces stay aligned with BILLING_PLANS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { BILLING_PLANS } from "@/lib/billing/plans";
import { getPlanLimit } from "@/lib/api/auth";
import {
  MAX_OBSERVATORY_WATCH_CLAIMS_PER_KEY,
  MAX_WATCHLIST_PER_KEY,
  MAX_WEBHOOKS_PER_KEY,
} from "@/lib/billing/key-feature-limits";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const squash = (s: string) => s.replace(/\s+/g, " ");

test("P1: free monthly limit is 3,000 in BILLING_PLANS, auth, and openapi", () => {
  assert.equal(BILLING_PLANS.free.monthlyLimit, 3_000);
  assert.equal(getPlanLimit("free"), 3_000);
  const openapi = read("docs/openapi.yaml");
  assert.match(openapi, new RegExp(`Free ${BILLING_PLANS.free.monthlyLimit.toLocaleString("en-US")}`));
});

test("pricing page details render per-key limits from shared constants", async () => {
  const { PricingPageDetails } = await import("@/components/site/PricingPageDetails");
  const html = renderToStaticMarkup(PricingPageDetails());
  assert.match(html, new RegExp(`Webhook endpoints: ${MAX_WEBHOOKS_PER_KEY} per key`));
  assert.match(html, new RegExp(`Watchlist targets: ${MAX_WATCHLIST_PER_KEY} per key`));
  assert.match(
    html,
    new RegExp(`Observatory payee-wallet claims \\(delist alerts\\): ${MAX_OBSERVATORY_WATCH_CLAIMS_PER_KEY} wallets per key`),
  );
  assert.doesNotMatch(html, /Seller Watch/i);
  assert.doesNotMatch(html, /\$490|\$1,990|annual plan/i);
});

test("terms §16 and legal notice describe consumption-tax exemption and no qualified invoice", () => {
  const terms = squash(read("src/app/legal/terms/page.tsx"));
  const notice = squash(read("src/app/legal/notice/page.tsx"));
  for (const src of [terms, notice]) {
    assert.match(src, /consumption-tax-exempt|consumption tax is not added/i);
    assert.match(src, /qualified invoice/i);
    assert.match(src, /not registered as a qualified invoice issuer|cannot be issued/i);
  }
  assert.match(terms, /Existing subscribers/);
  assert.match(terms, /twelve months/);
  assert.match(terms, /thirty days/);
});

test("pricing page does not list unshipped P9 or Seller Watch", () => {
  const page = read("src/app/pricing/page.tsx");
  const details = read("src/components/site/PricingPageDetails.tsx");
  const combined = page + details;
  assert.doesNotMatch(combined, /Seller Watch|9 USDC|30-day pass/i);
});