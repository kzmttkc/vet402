// Wave 1 §3.9: lock home pricing copy and the PricingSection table to BILLING_PLANS.
// Includes is a quote of text already public on the home page, not an enforced limit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { BILLING_PLANS } from "@/lib/billing/plans";
import { getPlanLimit } from "@/lib/api/auth";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const FORBIDDEN_PUBLIC_ENGLISH = /\b(we|our|us)\b|—|–|;/;

const EXPECTED_PLANS = [
  { key: "free" as const, name: "Free", priceLabel: "$0", monthlyUsd: 0, monthlyLimit: 1_000 },
  { key: "pro" as const, name: "Pro", priceLabel: "$49/mo", monthlyUsd: 49, monthlyLimit: 50_000 },
  { key: "scale" as const, name: "Scale", priceLabel: "$199/mo", monthlyUsd: 199, monthlyLimit: 500_000 },
];

const EXPECTED_INCLUDES: Record<(typeof EXPECTED_PLANS)[number]["key"], string> = {
  free: "REST, MCP and x402 middleware, TypeScript SDK",
  pro: "Everything in Free, higher monthly lookup quota",
  scale: "Everything in Pro, highest monthly lookup quota",
};

const FORBIDDEN_INCLUDES_MARKETING =
  /priority support|SLA|score history|highest rate limit|dedicated/i;

function assertHomePricingTable(html: string): void {
  const thead = html.match(/<thead>([\s\S]*?)<\/thead>/)?.[1] ?? "";
  for (const label of ["Tier", "Price", "Lookups / month", "Includes"]) {
    assert.match(thead, new RegExp(`>${label}<`));
  }

  const tbody = html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
  const rows = [...tbody.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
  if (rows.length !== 3) {
    throw new Error(`expected 3 pricing rows, got ${rows.length}`);
  }

  const parsed = rows.map((row) => {
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) =>
      m[1].replace(/<[^>]+>/g, "").trim(),
    );
    return cells;
  });

  const names = parsed.map((r) => r[0]);
  const prices = parsed.map((r) => r[1]);
  const limits = parsed.map((r) => r[2]);
  const includes = parsed.map((r) => r[3]);
  if (names.join(",") !== "Free,Pro,Scale") {
    throw new Error(`unexpected tier names: ${names.join(", ")}`);
  }
  if (prices.join(",") !== "$0,$49/mo,$199/mo") {
    throw new Error(`unexpected price labels: ${prices.join(", ")}`);
  }

  const planKeys = ["free", "pro", "scale"] as const;
  const expectedLimits = planKeys.map((id) => getPlanLimit(id).toLocaleString("en-US"));
  if (limits.join(",") !== expectedLimits.join(",")) {
    throw new Error(`unexpected lookup limits: ${limits.join(", ")}`);
  }
  for (const id of planKeys) {
    assert.equal(BILLING_PLANS[id].monthlyLimit, getPlanLimit(id), `${id} limit must match getPlanLimit`);
  }

  for (const cell of includes) {
    if (FORBIDDEN_INCLUDES_MARKETING.test(cell)) {
      throw new Error("forbidden marketing copy in Includes column");
    }
  }
  const expectedIncludeLines = planKeys.map((id) => EXPECTED_INCLUDES[id]);
  if (includes.join("\x1e") !== expectedIncludeLines.join("\x1e")) {
    throw new Error(`unexpected Includes column: ${includes.join(" | ")}`);
  }

  const tableEnglish = [...parsed.flat(), "Tier", "Price", "Lookups / month", "Includes"].join(" ");
  if (FORBIDDEN_PUBLIC_ENGLISH.test(tableEnglish)) {
    throw new Error("forbidden public English in pricing table");
  }
}

function assertHomeHeroPricingCopy(pageSource: string): void {
  assert.match(
    pageSource,
    /Start free with \{BILLING_PLANS\.free\.monthlyLimit\.toLocaleString\("en-US"\)\} seller checks a month\./,
  );
  assert.match(
    pageSource,
    /Pro is \$\{BILLING_PLANS\.pro\.monthlyUsd\} a month\. Scale is \$\{BILLING_PLANS\.scale\.monthlyUsd\} a month\./,
  );
  const freeLine = `Start free with ${BILLING_PLANS.free.monthlyLimit.toLocaleString("en-US")} seller checks a month.`;
  const paidLine = `Pro is $${BILLING_PLANS.pro.monthlyUsd} a month. Scale is $${BILLING_PLANS.scale.monthlyUsd} a month.`;
  if (freeLine !== "Start free with 1,000 seller checks a month.") {
    throw new Error(`unexpected hero free line: ${freeLine}`);
  }
  if (paidLine !== "Pro is $49 a month. Scale is $199 a month.") {
    throw new Error(`unexpected hero paid line: ${paidLine}`);
  }
}

function assertHomeJsonLdOfferPrices(pageSource: string): void {
  assert.match(pageSource, new RegExp(`price: "${BILLING_PLANS.pro.monthlyUsd}"`));
  assert.match(pageSource, new RegExp(`price: "${BILLING_PLANS.scale.monthlyUsd}"`));
  if (String(BILLING_PLANS.pro.monthlyUsd) !== "49") {
    throw new Error("pro monthlyUsd must be 49");
  }
  if (String(BILLING_PLANS.scale.monthlyUsd) !== "199") {
    throw new Error("scale monthlyUsd must be 199");
  }
}

function assertPricingSectionUnconditionalOnHome(pageSource: string): void {
  const needle = '<PricingSection className={s.section} titleId="home-pricing" />';
  const lines = pageSource.split("\n");
  const idx = lines.findIndex((line) => line.includes(needle));
  assert.ok(idx >= 0, "home page must render PricingSection");
  const line = lines[idx].trim();
  assert.doesNotMatch(line, /isStripeConfigured|\?|&&/);
  const window = lines.slice(Math.max(0, idx - 20), idx + 1).join("\n");
  assert.doesNotMatch(
    window,
    /isStripeConfigured\s*\(\s*\)\s*\?[\s\S]*$/,
    "PricingSection must not sit inside isStripeConfigured conditional JSX",
  );
  assert.doesNotMatch(window, /&&\s*<PricingSection/, "PricingSection must not follow && guard");
}

test("[guard] BILLING_PLANS names, labels, and limits", () => {
  for (const row of EXPECTED_PLANS) {
    const plan = BILLING_PLANS[row.key];
    assert.equal(plan.name, row.name);
    assert.equal(plan.priceLabel, row.priceLabel);
    assert.equal(plan.monthlyUsd, row.monthlyUsd);
    assert.equal(plan.monthlyLimit, row.monthlyLimit);
  }
});

test("[guard] home hero pricing strings in page.tsx and composed English", () => {
  assertHomeHeroPricingCopy(read("src/app/page.tsx"));
});

test("[guard] JSON-LD offer prices match monthlyUsd", () => {
  assertHomeJsonLdOfferPrices(read("src/app/page.tsx"));
});

test("[guard] PricingSection on home is outside Stripe conditionals", () => {
  assertPricingSectionUnconditionalOnHome(read("src/app/page.tsx"));
});

test("[guard] PricingSection table rows and headers on the home id", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { PricingSection } = await import("@/components/site/PricingSection");
  const html = renderToStaticMarkup(PricingSection({ titleId: "home-pricing" }));
  assertHomePricingTable(html);
});

test("[guard] home PricingSection render shows prices and quotas with Stripe off", async () => {
  const priorStripe = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  try {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { PricingSection } = await import("@/components/site/PricingSection");
    const html = renderToStaticMarkup(PricingSection({ titleId: "home-pricing" }));
    for (const token of ["$49/mo", "$199/mo", "1,000"]) {
      assert.ok(html.includes(token), `expected ${token} in pricing render`);
    }
    assertHomePricingTable(html);
  } finally {
    if (priorStripe !== undefined) {
      process.env.STRIPE_SECRET_KEY = priorStripe;
    } else {
      delete process.env.STRIPE_SECRET_KEY;
    }
  }
});

test("[guard] mutated pricing table html fails assertHomePricingTable", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { PricingSection } = await import("@/components/site/PricingSection");
  const html = renderToStaticMarkup(PricingSection({ titleId: "home-pricing" }));

  assert.throws(() => assertHomePricingTable(html.replace("$49/mo", "$59/mo")), /unexpected price labels/);
  assert.throws(() => assertHomePricingTable(html.replace("50,000", "60,000")), /unexpected lookup limits/);
  const tbody = html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
  const oneRowRemoved = html.replace(tbody, tbody.replace(/<tr>[\s\S]*?<\/tr>/, ""));
  assert.throws(() => assertHomePricingTable(oneRowRemoved), /expected 3 pricing rows/);

  const poisonedIncludes = html.replace(
    EXPECTED_INCLUDES.pro,
    "Everything in Free, priority support and SLA",
  );
  assert.throws(() => assertHomePricingTable(poisonedIncludes), /forbidden marketing copy in Includes column/);
  assert.throws(
    () => assertHomePricingTable(html.replace(EXPECTED_INCLUDES.scale, `${EXPECTED_INCLUDES.scale}, score history`)),
    /forbidden marketing copy in Includes column/,
  );
});

test("[guard] mutated page.tsx fails hero and JSON-LD guards", () => {
  const page = read("src/app/page.tsx");
  const brokeHero = page.replace(
    "Pro is ${BILLING_PLANS.pro.monthlyUsd} a month",
    "Pro is $59 a month",
  );
  assert.throws(() => assertHomeHeroPricingCopy(brokeHero));
  assert.throws(() => assertHomeJsonLdOfferPrices(page.replace('price: "49"', 'price: "59"')));
});
