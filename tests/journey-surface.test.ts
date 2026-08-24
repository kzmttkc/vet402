// ============================================================
// vet402 — understand → use → pay journey lock (2026-08-15).
//
// Three layers share one site:
//   1. Reader: public measurements (observatory) need no account
//   2. Lookup: score a wallet in the browser (/payee) need no account
//   3. Integrator: a key is for the score API; paid upgrade is Billing
// The memo must not describe live observatory work as unbuilt, the header
// must name the live product, and signup must not leak snake_case errors.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

test("desktop header names the observatory as a primary path", () => {
  const header = read("src/components/site/SiteHeader.tsx");
  const itemsBlock = header.slice(
    header.indexOf("const NAV_ITEMS"),
    header.indexOf("const NAV_SECONDARY"),
  );
  assert.ok(itemsBlock.includes('href: "/observatory"'), "Observatory belongs in the 5-item header");
  assert.ok(!itemsBlock.includes('href: "/accuracy"'), "Accuracy stays secondary so Observatory fits");
});

test("memo §4 lists the observatory as live and §5 does not call it unbuilt", () => {
  const home = read("src/app/page.tsx");
  assert.ok(home.includes('position: "s4_observatory"'));
  assert.ok(home.includes('href: "/observatory"'));
  assert.ok(!home.includes("These are not measurements yet"));
  assert.ok(!home.includes('title="The observatory"'));
});

test("signup does not print raw snake_case errors and uses a real sample wallet", () => {
  const signup = read("src/app/signup/page.tsx");
  assert.ok(signup.includes("dashboardErrorMessage"));
  assert.ok(!signup.includes('replaceAll("_", " ")'));
  assert.ok(signup.includes("0xd8da6bf26964af9d7eed9e03e53415d37aa96045"));
  assert.ok(signup.includes("/dashboard/billing"));
});

test("dashboard nav has no dead Logs link and names Lists in words", () => {
  const shell = read("src/components/dashboard/shell.tsx");
  assert.ok(!shell.includes("/dashboard/logs"));
  assert.ok(shell.includes('label: "Lists"'));
  assert.ok(!shell.includes("WL / BL"));
});

test("FAQ says the observatory and payee lookup need no account", () => {
  const faq = read("src/components/site/faq-data.ts");
  assert.ok(/Do I need an account\?/.test(faq));
  assert.match(faq, /observatory/i);
  assert.match(faq, /no account|public/i);
});

test("billing empty-state does not leak operator env var names", () => {
  const billing = read("src/app/dashboard/billing/page.tsx");
  assert.ok(!billing.includes("STRIPE_SECRET_KEY"));
});

test("dashboard wallet lookup uses the payee engine, not the payer engine", () => {
  const route = read("src/app/api/dashboard/lookup/route.ts");
  assert.ok(route.includes("scorePayeeWallet"));
  assert.ok(route.includes("persistPayeeScoreResult"));
});

test("billing names a cancelled checkout and a failed payment", () => {
  const billing = read("src/app/dashboard/billing/page.tsx");
  assert.ok(billing.includes("checkout=cancelled") || billing.includes('=== "cancelled"'));
  assert.ok(/past_due|Payment failed|update (your )?card/i.test(billing));
});

test("lost-key path is named on login and in the FAQ", () => {
  const login = read("src/app/dashboard/login/page.tsx");
  const faq = read("src/components/site/faq-data.ts");
  assert.ok(login.includes("SUPPORT_EMAIL") || login.includes("support@vet402.com"));
  assert.ok(/lost (my |the )?key|cannot retrieve/i.test(faq + login));
});

test("first dashboard curl hits the payee score path", () => {
  const overview = read("src/app/dashboard/page.tsx");
  assert.ok(overview.includes("/payees/"));
  assert.ok(!overview.includes("/wallets/0xd8da6bf"));
});

test("FAQ distinguishes observatory measurements from scores", () => {
  const faq = read("src/components/site/faq-data.ts");
  assert.ok(faq.includes("What is the difference between the observatory and a score?"));
  assert.match(faq, /never reported as an L0–L2 result|never an L0-L2 result/i);
});

test("observatory index is filterable and names L1 without mixing it into L0 cells", () => {
  const page = read("src/app/observatory/page.tsx");
  assert.ok(page.includes('method="get"'));
  assert.ok(page.includes('name="q"'));
  assert.ok(page.includes('name="verdict"'));
  assert.ok(page.includes('name="network"'));
  assert.ok(page.includes('event="observatory_view"'));
  assert.match(page, /L1 settle-through/);
});

test("methodology opens with a 60-second skim", () => {
  const page = read("src/app/observatory/methodology/page.tsx");
  assert.ok(page.includes("In 60 seconds"));
  assert.ok(page.includes('event="methodology_view"'));
});

test("integrations point at npm packages, not repository paths", () => {
  const page = read("src/app/dashboard/integrations/page.tsx");
  assert.ok(page.includes("npmjs.com/package/@vet402/sdk"));
  assert.ok(page.includes("npmjs.com/package/@vet402/mcp-server"));
  assert.ok(page.includes("npmjs.com/package/@vet402/middleware"));
  assert.ok(!page.includes("packages/sdk"));
  assert.ok(!page.includes("docs/mcp-setup.md"));
});

test("billing names terms, cancel, and support on the upgrade screen", () => {
  const billing = read("src/app/dashboard/billing/page.tsx");
  assert.ok(billing.includes("/legal/terms"));
  assert.match(billing, /cancel|Cancel/);
  assert.ok(billing.includes("SUPPORT_EMAIL") || billing.includes("support@vet402.com"));
  assert.ok(billing.includes("billing_view") || billing.includes('event="billing_view"'));
});

test("payee claim is API-only and links to the docs", () => {
  const page = read("src/app/payee/[address]/page.tsx");
  assert.match(page, /API-only|no in-browser form/i);
  assert.ok(page.includes("/docs/api"));
  assert.ok(page.includes("/api/v1/payees/verify"));
});

test("blog index uses the RFC sheet, not a zinc kicker", () => {
  const index = read("src/app/blog/page.tsx");
  const post = read("src/app/blog/[slug]/page.tsx");
  assert.ok(index.includes("className=\"sheet\"") || index.includes("className='sheet'"));
  assert.ok(!index.includes("uppercase tracking-wide text-zinc-500"));
  assert.ok(post.includes("className=\"sheet\"") || post.includes("className='sheet'"));
  assert.ok(!post.includes("uppercase tracking-wide text-zinc-500"));
});

test("payee and agent not-found pages use the RFC sheet", () => {
  const payee = read("src/app/payee/[address]/not-found.tsx");
  const agent = read("src/app/agent/[agentId]/not-found.tsx");
  assert.ok(payee.includes("sheet"));
  assert.ok(agent.includes("sheet"));
  assert.ok(!payee.includes("uppercase tracking-wide text-zinc-500"));
  assert.ok(!agent.includes("uppercase tracking-wide text-zinc-500"));
});

test("dashboard nav collapses on small screens", () => {
  const shell = read("src/components/dashboard/shell.tsx");
  assert.ok(shell.includes("<details") || shell.includes("lg:hidden"));
});

test("terms include a paid-subscription section without renumbering 0–15", () => {
  const terms = read("src/app/legal/terms/page.tsx");
  assert.ok(terms.includes('sec-no">15.'));
  assert.ok(terms.includes('sec-no">16.'));
  assert.match(terms, /Paid subscriptions|subscription/i);
});

test("product glossary locks Verify / Score / Observatory / Lookup", () => {
  const product = read("PRODUCT.md");
  assert.match(product, /Verify/);
  assert.match(product, /Observatory/);
  assert.match(product, /Lookup/);
  assert.match(product, /0–100|ALLOW/);
});

test("faq, lookup, and methodology fire view events", () => {
  const faq = read("src/app/faq/page.tsx");
  const lookup = read("src/app/dashboard/lookup/page.tsx");
  assert.ok(faq.includes('event="faq_view"'));
  assert.ok(lookup.includes("lookup_view") || lookup.includes('event="lookup_view"'));
});

test("State of x402 is reachable from the observatory index and the footer", () => {
  const footer = read("src/components/site/SiteFooter.tsx");
  const page = read("src/app/observatory/page.tsx");
  assert.ok(footer.includes('href: "/observatory/state"'));
  assert.ok(page.includes('href="/observatory/state"'));
});

test("payee score surfaces declare a 30s wall-clock budget", () => {
  const api = read("src/app/api/v1/payees/[address]/score/route.ts");
  const page = read("src/app/payee/[address]/page.tsx");
  assert.match(api, /export const maxDuration = 30/);
  assert.match(page, /export const maxDuration = 30/);
});
