// ============================================================
// Front page, 2026-10-21 owner decision (option A, "推奨で").
//
// The first screen stays exactly as it was. Directly under it: "The public ledger" (two counts from
// the L1 ledger and the L0 verdicts) and "Where purchases settled" (one row per chain with a
// settled purchase). Both come from the one cached reader the page already uses,
// getObservatoryStatsCached(), never from an HTTP fetch and never from a number in the source.
// When the read is not usable, neither section is drawn.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
  LedgerSection,
  NO_ASSET,
  SettledChainsSection,
  homeLedgerOf,
  settlementAssetOf,
  type HomeLedgerStats,
} from "@/components/site/HomeLedger";
import { SUPPORTED_CHAINS } from "@/components/site/supported-chains-data";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const HOME = read("src/app/page.tsx");
const LEDGER_SRC = read("src/components/site/HomeLedger.tsx");

function fixture(over: Partial<HomeLedgerStats> = {}): HomeLedgerStats {
  const l1Base = {
    attempts: 5321,
    settled: 4210,
    delivered: 3987,
    byChain: [
      { chain: "Base", attempts: 4000, settled: 3500, delivered: 3300, inconclusive: 0, settledNonceBound: 0, settledAmountPayeeOnly: 0 },
      { chain: "stellar:pubnet", attempts: 300, settled: 250, delivered: 240, inconclusive: 0, settledNonceBound: 0, settledAmountPayeeOnly: 0 },
      { chain: "BSC", attempts: 200, settled: 150, delivered: 140, inconclusive: 0, settledNonceBound: 0, settledAmountPayeeOnly: 0 },
      { chain: "eip155:999999", attempts: 20, settled: 7, delivered: 5, inconclusive: 0, settledNonceBound: 0, settledAmountPayeeOnly: 0 },
      { chain: "Base Sepolia", attempts: 40, settled: 0, delivered: 0, inconclusive: 0, settledNonceBound: 0, settledAmountPayeeOnly: 0 },
    ],
  };
  return {
    totalEndpoints: 30000,
    activeEndpoints: 20086,
    publishedPassActive: 12345,
    readAt: "2026-10-21T09:25:02.700Z",
    ...over,
    l1: { ...l1Base, ...(over.l1 ?? {}) },
  } as unknown as HomeLedgerStats;
}

// ---------- the reader and the gate ----------

test("the page reads the numbers from the cached reader, not over HTTP", () => {
  assert.ok(HOME.includes('from "@/lib/observatory/cached-reads"'));
  assert.ok(HOME.includes("getObservatoryStatsCached().catch(() => null)"));
  assert.ok(HOME.includes("getHomeExampleCached().catch(() => null)"));
  assert.ok(HOME.includes("const ledger = homeLedgerOf(stats);"));
  const example = read("src/lib/observatory/home-example.ts");
  for (const src of [HOME, LEDGER_SRC, example]) {
    assert.ok(!/\bfetch\(/.test(src), "no fetch() on the front page or in its ledger sections");
    assert.ok(!src.includes("https://vet402.com/api"), "no absolute API URL is read");
  }
  assert.ok(!HOME.includes("force-dynamic"), "the page keeps the existing cache policy");
});

test("the cached reader stamps the time it read the database", () => {
  const cached = read("src/lib/observatory/cached-reads.ts");
  assert.match(
    cached,
    /getObservatoryStatsCached[\s\S]*?unstable_cache\(\s*async \(\) => \(\{ \.\.\.\(await getObservatoryStats\(\)\), readAt: new Date\(\)\.toISOString\(\) \}\)/,
    "readAt is set inside the cache fill, so it is the read time and not the render time",
  );
});

test("an unusable read draws neither section", () => {
  assert.equal(homeLedgerOf(null), null);
  assert.equal(homeLedgerOf(undefined), null);
  assert.equal(homeLedgerOf(fixture({ totalEndpoints: 0 })), null, "the reader's empty shape");
  assert.equal(homeLedgerOf(fixture({ l1: { byChain: [] } } as unknown as Partial<HomeLedgerStats>)), null, "L1 not read");
  assert.equal(homeLedgerOf(fixture({ readAt: undefined })), null, "a cache entry with no read time");
  assert.ok(homeLedgerOf(fixture()));
});

test("the chain table sits under the new first screen and above the memo, behind the same gate", () => {
  const introAt = HOME.indexOf("<HomeIntro");
  const dlEnd = HOME.indexOf("</dl>");
  const chainsAt = HOME.indexOf("{ledger ? <SettledChainsSection ledger={ledger} /> : null}");
  const rfcHead = HOME.indexOf('<div className="doc-head');
  assert.ok(!HOME.includes("<LedgerSection"), "the two-count block is replaced by the sentence in HomeIntro");
  assert.ok(introAt > 0 && dlEnd > introAt && chainsAt > dlEnd && rfcHead > chainsAt, "order: intro, definitions, chains, memo");
});

// ---------- what the sections print ----------

test("The public ledger prints the two counts from the read, and the date is the one cyan text", () => {
  const ledger = homeLedgerOf(fixture());
  assert.ok(ledger);
  const html = renderToStaticMarkup(createElement(LedgerSection, { ledger }));
  assert.ok(html.includes("The public ledger"));
  assert.ok(html.includes("Paid attempts that settled"));
  assert.ok(html.includes(">4,210<") && html.includes(" of 5,321"));
  assert.ok(html.includes("3,987 of the settled purchases also returned a 2xx answer."));
  assert.ok(html.includes("Latest L0 verdict on listed endpoints"));
  assert.ok(html.includes(">12,345<") && html.includes(" pass of 20,086 listed"));
  assert.ok(html.includes("7,741 listed endpoints do not have pass as their latest probe. That includes a published fail, unverified, and endpoints not yet probed."));
  assert.ok(html.includes("Customer count and revenue: not published."));
  assert.ok(html.includes('href="/api/v1/observatory/state"') && html.includes("(CC BY 4.0)."));
  assert.ok(html.includes('href="/observatory"') && html.includes("Open the observatory"));
  assert.ok(html.includes('href="/observatory/state"') && html.includes("See both counts"));
  const cyan = [...html.matchAll(/class="text-signal">([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(cyan, ["2026-10-21"], "the read date and nothing else is cyan");
  assert.ok(html.includes("at 09:25 UTC"));
});

test("Where purchases settled: one row per chain with a settled purchase, names and assets from existing sources", () => {
  const ledger = homeLedgerOf(fixture());
  assert.ok(ledger);
  const html = renderToStaticMarkup(createElement(SettledChainsSection, { ledger }));
  assert.ok(html.includes("Where purchases settled"));
  for (const h of ["Chain", "Asset", "Settled purchases", "Answered 2xx", "Paid, no 2xx"]) assert.ok(html.includes(`>${h}<`), h);
  const rows = [...html.matchAll(/<tr><td title="([^"]*)">([^<]*)<\/td><td>([^<]*)<\/td><td class="num">([^<]*)<\/td><td class="num">([^<]*)<\/td><td class="num">([^<]*)<\/td><\/tr>/g)].map(
    (m) => m.slice(1),
  );
  // The new column is settled − delivered for that chain. The fixture's counts are unchanged.
  assert.deepEqual(rows, [
    ["Base", "Base", "USDC", "3,500", "3,300", "200"],
    ["stellar:pubnet", "Stellar", "USDC", "250", "240", "10"],
    ["BSC", "BSC", "USD1", "150", "140", "10"],
    ["eip155:999999", "eip155:999999", NO_ASSET, "7", "5", "2"],
  ]);
  assert.ok(!html.includes("Base Sepolia"), "a chain with no settled purchase has no row");
});

test("the chain table keeps the #chains anchor and the Robinhood Chain row's agreed sentence and link", () => {
  const ledger = homeLedgerOf(fixture());
  assert.ok(ledger);
  const html = renderToStaticMarkup(createElement(SettledChainsSection, { ledger }));
  assert.ok(html.includes('<h2 id="chains"'));
  const row = SUPPORTED_CHAINS.find((c) => c.kind === "product");
  assert.ok(row && row.kind === "product");
  assert.ok(html.includes(`${row.chain}: `));
  assert.ok(html.includes('href="/rwa"') && html.includes("vet402 /rwa"));
  assert.ok(html.includes("The purchase lane and the settlement index are not supported."));
});

test("asset words are taken from supported-chains-data.ts and the methodology sentence, not invented", () => {
  for (const row of SUPPORTED_CHAINS) {
    if (row.kind === "lane") assert.equal(settlementAssetOf(row.chain), row.asset, row.chain);
  }
  const vocab = read("src/lib/observatory/vocabulary.ts");
  assert.ok(vocab.includes("USDC on Base, Arc, Celo, Solana and Stellar"), "Stellar's asset is USDC in the methodology");
  assert.ok(vocab.includes("USD1 on BNB Chain"), "BNB Chain's asset is USD1 in the methodology");
  assert.equal(settlementAssetOf("Stellar"), "USDC");
  assert.equal(settlementAssetOf("BSC"), "USD1");
  assert.equal(settlementAssetOf("Polygon"), NO_ASSET);
});

test("no count is written into the ledger sections' source", () => {
  const body = LEDGER_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const jsxText = [...body.matchAll(/>([^<>{}]+)</g)].map((m) => m[1]).join(" ");
  assert.ok(!/\d{2,}/.test(jsxText.replace(/2xx|402|CC BY 4\.0|L[0-3]/g, "")), `no number in the copy: ${jsxText}`);
});

// ---------- direction C keeps the search, the two entries, and the three definitions ----------

test("direction C keeps the seller search, the two entries, and the three definitions", () => {
  const panel = read("src/components/site/home/CheckPanel.tsx");
  const squash = (s: string) => s.replace(/\s+/g, " ");
  const intro = squash(read("src/components/site/home/HomeIntro.tsx"));
  assert.ok(intro.includes("Paid is on chain."));
  assert.ok(intro.includes("Delivered is not."));
  for (const piece of [
    '<form method="get" action="/sellers" role="search"',
    'id="home-seller-q"',
    'name="q"',
    'aria-describedby="home-seller-q-help"',
    "Seller domain",
    'placeholder="api.example.com"',
    "Check a seller",
    'props={{ position: "hero_signup" }}',
    "Get a free API key",
    'props={{ position: "hero_playground" }}',
    "Try one check, no account",
  ]) {
    assert.ok(squash(panel).includes(squash(piece)), `check panel still says: ${piece}`);
  }
  const defs = HOME.slice(HOME.indexOf("<dl "), HOME.indexOf("</dl>") + 5);
  for (const piece of [
    '<dt className="font-semibold">What this is</dt>',
    "<dd>x402 is how an agent pays an API. vet402 buys from those APIs itself and publishes whether what was paid for arrived.</dd>",
    '<dt className="font-semibold">What you give us</dt>',
    "<dd>Nothing to look: no wallet, no account, no card. A free key only for API calls.</dd>",
    '<dt className="font-semibold">What we do not do</dt>',
    "<dd>Guarantee a seller, refund, handle chargebacks, check identity (KYC), approve payments, or cap your spending.</dd>",
  ]) {
    assert.ok(squash(defs).includes(squash(piece)), `definitions still say: ${piece}`);
  }
  assert.equal((defs.match(/<dt /g) ?? []).length, 3, "the table has three rows");
});

test("the search names what it searches (audit A-05)", () => {
  const panel = read("src/components/site/home/CheckPanel.tsx");
  assert.ok(panel.includes('aria-describedby="home-seller-q-help"'));
  assert.match(
    panel,
    /<p id="home-seller-q-help" className="mt-2 text-\[0\.75rem\] text-white\/70">\s*Results are Base purchases\. A host with purchases on another chain, or one missing here, can still be listed in the observatory\.\s*<\/p>/,
  );
});
