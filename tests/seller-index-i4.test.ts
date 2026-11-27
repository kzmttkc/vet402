// I4 (2026-11-27): index only delivered-in-window or payee-claimed seller pages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sitemap from "@/app/sitemap";
import { SITE_URL } from "@/lib/site-url";
import { GET as getSitemapSellers } from "@/app/sitemap-sellers.xml/route";
import {
  selectIndexableSellerHosts,
  sellerIndexCounts,
  sellerIndexGateOf,
  sellerPageIndexable,
  SELLER_INDEX_DELIVERY_WINDOW_DAYS,
} from "@/lib/sellers/seller-index";

const ROOT = join(import.meta.dirname, "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

test("sellerPageIndexable: delivered in window or payee claim", () => {
  const delivered = sellerIndexGateOf("ok.example", new Set(["ok.example"]), new Set());
  assert.equal(sellerPageIndexable(delivered), true);
  const claimed = sellerIndexGateOf("claim.example", new Set(), new Set(["claim.example"]));
  assert.equal(sellerPageIndexable(claimed), true);
  const none = sellerIndexGateOf("quiet.example", new Set(), new Set());
  assert.equal(sellerPageIndexable(none), false);
  assert.equal(sellerPageIndexable(sellerIndexGateOf("../bad", new Set(), new Set())), false);
});

test("selectIndexableSellerHosts keeps only board hosts in the delivered or claimed sets", () => {
  assert.equal(SELLER_INDEX_DELIVERY_WINDOW_DAYS, 30);
  const board = ["quiet.example", "ok.example", "claim.example", "ok.example", "../bad"];
  const out = selectIndexableSellerHosts(board, new Set(["ok.example", "not-on-board.example", "../bad"]), new Set(["claim.example"]));
  assert.deepEqual(out, ["claim.example", "ok.example"]);
  assert.deepEqual(selectIndexableSellerHosts(board, new Set(), new Set()), []);
});

test("sitemap-sellers.xml headers count the same list as the body", () => {
  const route = read("src/app/sitemap-sellers.xml/route.ts");
  assert.match(route, /sellerIndexCounts\(hosts\)/);
  assert.doesNotMatch(route, /readSellerIndexCounts/);
});

test("reputation sitemap entries are filtered by the I4 gate", () => {
  const src = read("src/app/sitemap.ts");
  const i = src.indexOf("async function reputationSitemapEntries");
  const seg = src.slice(i, src.indexOf("async function sellerIndexSitemapEntries"));
  assert.match(seg, /getIndexableSellerHostsCached/);
  assert.match(seg, /indexableSet\.has/);
});

test("seller index counts: sitemap URL count matches indexable page count", () => {
  const hosts = ["a.example", "b.example"];
  assert.deepEqual(sellerIndexCounts(hosts), { indexablePages: 2, sitemapUrls: 2 });
});

test("undelivered-only host stays noindex and out of structured data (page wiring)", () => {
  const page = read("src/app/sellers/[host]/page.tsx");
  assert.match(page, /noindex:\s*!indexable/);
  assert.match(page, /\{indexable \? \(/);
  assert.match(page, /@type":\s*"WebPage"/);
});

test("sitemap-sellers.xml lists /sellers/ hosts from the index gate", async () => {
  const route = read("src/app/sitemap-sellers.xml/route.ts");
  assert.match(route, /getIndexableSellerHostsCached/);
  assert.match(route, /\/sellers\//);
  assert.match(route, /x-vet402-indexable-pages/);
  const res = await getSitemapSellers();
  assert.ok(res.status === 200 || res.status === 503);
  if (res.status === 200) {
    const body = await res.text();
    assert.doesNotMatch(body, /\/x402\/sellers\//);
    assert.match(res.headers.get("x-vet402-sitemap-urls") ?? "0", /^\d+$/);
  }
});

test("static sitemap includes only /sellers/{host} index URLs, not /sellers index", async () => {
  const src = read("src/app/sitemap.ts");
  assert.match(src, /sellerIndexSitemapEntries/);
  assert.match(src, /getIndexableSellerHostsCached/);
  const urls = (await sitemap()).map((e) => e.url);
  assert.equal(urls.some((u) => u === `${SITE_URL}/sellers`), false);
  for (const u of urls.filter((x) => x.includes("/sellers/") && !x.includes("/x402/"))) {
    assert.match(u, /\/sellers\/[^/]+$/);
  }
});

test("internal links: home and /sellers use indexable host list", () => {
  assert.match(read("src/app/page.tsx"), /HomeIndexedSellers/);
  assert.match(read("src/app/sellers/page.tsx"), /indexableHosts=/);
  const views = read("src/components/site/sellers/SellersViews.tsx");
  assert.match(views, /delivery in the last 30 days or a signed payee claim/);
  // Hosts outside the gate stay clickable for the seller but pass no link signal.
  assert.match(views, /rel=\{sellerLinkRel\(/);
  assert.match(views, /"nofollow"/);
});

test("reader exposes delivered-window and payee-claim host sets", () => {
  const reader = read("src/lib/sellers/reader.ts");
  assert.match(reader, /readHostsWithDeliveredInWindow/);
  assert.match(reader, /readHostsWithPayeeClaim/);
  assert.match(reader, /deliveredPredicate/);
  assert.match(reader, /verified_payees/);
});
test("sitemap.xml is regenerated at runtime so hosts that leave the gate leave the sitemap", () => {
  assert.match(read("src/app/sitemap.ts"), /^export const revalidate = 3600;$/m);
});
