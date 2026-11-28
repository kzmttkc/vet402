// 2026-11-28 依頼 AA: Grok 10語実測に基づく AEO 頁（seller-reputation-api, trust-score, chains, refunds, mcp, llms）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sitemap from "@/app/sitemap";
import { SITE_URL } from "@/lib/site-url";
import {
  readIndexableHostsOnNetwork,
  selectIndexableSellerHosts,
  sellerIndexGateOf,
  sellerPageIndexable,
} from "@/lib/sellers/seller-index";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

function publicProse(src: string): string {
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\{\/\*[\s\S]*?\*\/\}/g, " ");
  const literals = [...noComments.matchAll(/`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"/g)].map((m) => m[0]);
  const jsx = [...noComments.matchAll(/<(?:[A-Za-z][\w.]*)(?:\s[^<>]*?)?>([^<>{}]*)</g)].map((m) => m[1]);
  return [...literals, ...jsx].join("\n");
}

test("new AEO pages carry the expected title and H1", () => {
  const rep = read("src/app/x402/seller-reputation-api/page.tsx");
  assert.match(rep, /SELLER_REPUTATION_API/);
  assert.match(read("src/lib/x402/seller-reputation-sections.ts"), /x402 seller reputation API/);
  const trust = read("src/app/x402/trust-score/page.tsx");
  assert.match(trust, /x402 trust score/);
  const mcp = read("src/app/docs/mcp/page.tsx");
  assert.match(mcp, /x402 MCP server: check a seller before paying/);
  const chains = read("src/components/site/x402-answers.ts");
  assert.match(chains, /x402 settlements by chain/);
});

test("refunds page does not hardcode 2026-11-09 snapshot counts", () => {
  const src = read("src/app/x402/refunds/page.tsx");
  assert.doesNotMatch(src, /REFUNDS_SNAPSHOT/);
  assert.doesNotMatch(src, /2026-11-09.*14427/);
  assert.match(src, /getObservatoryStatsCached/);
});

test("chain guide uses I4 gate for seller host tables", () => {
  const slug = read("src/app/x402/chains/[slug]/page.tsx");
  assert.match(slug, /getIndexableHostsOnChainCached/);
  assert.match(slug, /\/x402\/sellers\//);
  assert.doesNotMatch(slug, /2026-11-16/);
});

test("chain pages: C1 index gate excludes non-indexable hosts", () => {
  const delivered = new Set(["good.example", "bad.example"]);
  const deliveredHosts = new Set(["good.example"]);
  const claimedHosts = new Set<string>();
  const out = selectIndexableSellerHosts(
    ["good.example", "bad.example"],
    deliveredHosts,
    claimedHosts,
  );
  assert.deepEqual(out, ["good.example"]);
  assert.equal(sellerPageIndexable(sellerIndexGateOf("bad.example", deliveredHosts, claimedHosts)), false);
});

test("new public pages: no revenue fields (C2)", () => {
  for (const file of [
    "src/app/x402/seller-reputation-api/page.tsx",
    "src/lib/x402/seller-reputation-sections.ts",
    "src/app/x402/trust-score/page.tsx",
    "src/lib/x402/trust-score-sections.ts",
    "src/app/x402/chains/page.tsx",
    "src/app/x402/chains/[slug]/page.tsx",
  ]) {
    const prose = publicProse(read(file));
    assert.doesNotMatch(prose, /\bMRR\b/i, file);
    assert.doesNotMatch(prose, /\brevenue\b/i, file);
    assert.doesNotMatch(prose, /price_usd/, file);
  }
});

test("sitemap lists seller-reputation-api and trust-score", async () => {
  const urls = (await sitemap()).map((e) => e.url);
  assert.ok(urls.includes(`${SITE_URL}/x402/seller-reputation-api`));
  assert.ok(urls.includes(`${SITE_URL}/x402/trust-score`));
});

test("llms.txt lists new pages", () => {
  const llms = read("public/llms.txt");
  assert.ok(llms.includes("https://vet402.com/x402/seller-reputation-api"));
  assert.ok(llms.includes("https://vet402.com/x402/trust-score"));
  assert.ok(llms.includes("seller-reputation-api.md"));
  assert.ok(llms.includes("trust-score.md"));
  assert.ok(llms.includes("x402 settlements by chain"));
});

test("readIndexableHostsOnNetwork is exported and uses existing gate", () => {
  assert.equal(typeof readIndexableHostsOnNetwork, "function");
  const index = read("src/lib/sellers/seller-index.ts");
  assert.match(index, /selectIndexableSellerHosts/);
  assert.match(index, /readHostsWithDeliveredOnNetwork/);
});