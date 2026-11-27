import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  REPUTATION_FORBIDDEN_WORDS,
  latestDeliveredRecordId,
  newestDeliveredPurchase,
  reputationBodyLowercase,
  reputationDetailEligible,
  reputationForbiddenInBody,
  reputationPageEligible,
  selectReputationHosts,
} from "@/lib/sellers/reputation";
import { ReputationSellerArticle } from "@/app/x402/sellers/[host]/page";
import { GET as getSitemapSellers } from "@/app/sitemap-sellers.xml/route";
import NotFound from "@/app/not-found";
import { buildSellerDetail, type SellerSummary } from "@/lib/sellers/board";
import type { SellerRowFacts } from "@/lib/sellers/fix-modes";

const ROOT = process.cwd();

function summary(p: Partial<SellerSummary> & { host: string }): SellerSummary {
  return {
    host: p.host,
    listings: p.listings ?? 2,
    delivered: p.delivered ?? 2,
    pending: p.pending ?? 0,
    seller: p.seller ?? 0,
    vet402: p.vet402 ?? 0,
    unsorted: p.unsorted ?? 0,
    notPaid: p.notPaid ?? 0,
    notTried: p.notTried ?? 0,
    lastAttemptAt: p.lastAttemptAt ?? "2026-11-16T00:00:00Z",
    rebuyEligible: false,
    rebuyEndpointId: null,
  };
}

const delivered: SellerRowFacts = {
  endpointId: "e1",
  status: "settled",
  httpStatusPaid: 200,
  txHash: "0x" + "aa".repeat(32),
  attemptedAt: "2026-11-16T12:00:00Z",
  network: "eip155:8453",
  method: "GET",
  meta: null,
  schema: null,
  unpaidStatus: null,
  selection: null,
  verifyReason: null,
};

function eligibleDetail(host = "shop.example") {
  return buildSellerDetail(
    host,
    [
      { endpointId: "e1", resourceKey: "shop.example/api", resourceUrl: "https://shop.example/api", method: "GET", priceAmount: "1" },
      { endpointId: "e2", resourceKey: "shop.example/v1", resourceUrl: "https://shop.example/v1", method: "GET", priceAmount: "1" },
    ],
    [delivered, { ...delivered, endpointId: "e2", attemptedAt: "2026-11-16T11:00:00Z" }],
    "2026-11-16T12:00:00Z",
  );
}

function htmlForbiddenCount(html: string): string[] {
  const lower = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").toLowerCase();
  const hits: string[] = [];
  for (const w of REPUTATION_FORBIDDEN_WORDS) {
    if (lower.includes(w)) hits.push(w);
  }
  return hits;
}

test("selectReputationHosts: delivered 1 と任意の非ゼロカウントで外れる", () => {
  const sellers = [
    summary({ host: "ok.example", delivered: 2 }),
    summary({ host: "one.example", delivered: 1 }),
    summary({ host: "seller-fail.example", delivered: 2, seller: 1 }),
    summary({ host: "vet402-fail.example", delivered: 2, vet402: 1 }),
    summary({ host: "unsorted.example", delivered: 2, unsorted: 1 }),
    summary({ host: "not-paid.example", delivered: 2, notPaid: 1 }),
    summary({ host: "pending.example", delivered: 2, pending: 1 }),
    summary({ host: "bad-host..", delivered: 2 }),
  ];
  assert.deepEqual(selectReputationHosts(sellers, 50), ["ok.example"]);
});

test("selectReputationHosts: delivered 降順、同数は host 昇順、limit", () => {
  const sellers = [
    summary({ host: "b.example", delivered: 3 }),
    summary({ host: "a.example", delivered: 3 }),
    summary({ host: "c.example", delivered: 5 }),
    summary({ host: "d.example", delivered: 4 }),
    summary({ host: "e.example", delivered: 4 }),
  ];
  assert.deepEqual(selectReputationHosts(sellers, 3), ["c.example", "d.example", "e.example"]);
  assert.deepEqual(selectReputationHosts(sellers, 10).slice(0, 2), ["c.example", "d.example"]);
});

test("reputationDetailEligible: 買った出品はすべて delivered、未購入は数に入れない", () => {
  const ok = eligibleDetail();
  assert.equal(reputationDetailEligible(ok), true);
  const partial = buildSellerDetail(
    "shop.example",
    [
      { endpointId: "e1", resourceKey: "shop.example/api", resourceUrl: "https://shop.example/api", method: "GET", priceAmount: "1" },
      { endpointId: "e2", resourceKey: "shop.example/v1", resourceUrl: "https://shop.example/v1", method: "GET", priceAmount: "1" },
    ],
    [delivered],
    "2026-11-16T12:00:00Z",
  );
  assert.equal(reputationDetailEligible(partial), false);

  const withNotTried = buildSellerDetail(
    "shop.example",
    [
      { endpointId: "e1", resourceKey: "shop.example/api", resourceUrl: "https://shop.example/api", method: "GET", priceAmount: "1" },
      { endpointId: "e2", resourceKey: "shop.example/v1", resourceUrl: "https://shop.example/v1", method: "GET", priceAmount: "1" },
      { endpointId: "e3", resourceKey: "shop.example/new", resourceUrl: "https://shop.example/new", method: "GET", priceAmount: "1" },
    ],
    [delivered, { ...delivered, endpointId: "e2", attemptedAt: "2026-11-16T11:00:00Z" }],
    "2026-11-16T12:00:00Z",
  );
  assert.equal(reputationDetailEligible(withNotTried), true);
  const html = renderToStaticMarkup(createElement(ReputationSellerArticle, { detail: withNotTried }));
  assert.match(html, /At each of the 2 listings.*latest purchase delivered a response/);
  assert.equal((html.match(/<tbody>[\s\S]*?<\/tbody>/g)?.[0]?.match(/<tr>/g) ?? []).length, 2);
});

test("reputationDetailEligible: otherChain が新しく delivered に分類できない", () => {
  const d = buildSellerDetail(
    "shop.example",
    [
      { endpointId: "e1", resourceKey: "shop.example/api", resourceUrl: "https://shop.example/api", method: "GET", priceAmount: "1" },
      { endpointId: "e2", resourceKey: "shop.example/v1", resourceUrl: "https://shop.example/v1", method: "GET", priceAmount: "1" },
    ],
    [delivered, { ...delivered, endpointId: "e2", attemptedAt: "2026-11-16T11:00:00Z" }],
    "2026-11-16T12:00:00Z",
    undefined,
    [{ endpointId: "e1", network: "eip155:56", status: "settle_failed", attemptedAt: "2026-11-17T00:00:00Z", httpStatusPaid: 500 }],
  );
  assert.equal(reputationDetailEligible(d), false);
});

test("reputationDetailEligible: withdrawnRoutes があると不適格", () => {
  const d = eligibleDetail();
  assert.equal(reputationDetailEligible({ ...d, withdrawnRoutes: [{ endpointId: "e1", resourceKey: "shop.example/x" }] }), false);
});

test("reputationDetailEligible: 対象外 host", () => {
  const d = eligibleDetail("Bad-Host");
  assert.equal(reputationDetailEligible(d), false);
});

test("reputationPageEligible: path に error があれば禁止語", () => {
  const d = buildSellerDetail(
    "shop.example",
    [
      { endpointId: "e1", resourceKey: "shop.example/api/error", resourceUrl: "https://shop.example/api/error", method: "GET", priceAmount: "1" },
      { endpointId: "e2", resourceKey: "shop.example/v1", resourceUrl: "https://shop.example/v1", method: "GET", priceAmount: "1" },
    ],
    [delivered, { ...delivered, endpointId: "e2", attemptedAt: "2026-11-16T11:00:00Z" }],
    "2026-11-16T12:00:00Z",
  );
  assert.equal(reputationDetailEligible(d), true);
  assert.equal(reputationForbiddenInBody(d), true);
  assert.equal(reputationPageEligible(d), false);
});

test("reputationBodyLowercase は reputationDetailEligible から呼べる", () => {
  const d = eligibleDetail();
  assert.ok(reputationBodyLowercase(d).includes("shop.example"));
});

test("評判ページ描画 HTML に禁止語が 0 件", () => {
  const detail = eligibleDetail();
  const html = renderToStaticMarkup(createElement(ReputationSellerArticle, { detail }));
  assert.deepEqual(htmlForbiddenCount(html), []);
  assert.match(html, /At each of the 2 listings.*latest purchase delivered a response/);
  assert.match(html, /Get an email when this record changes:/);
  assert.match(html, /href="\/observatory\/e\/e1"/);
  assert.match(html, />open the latest record and use the alert form</);
  assert.match(html, /not built yet/);
  assert.match(html, />I would use this</);
});

test("latestDeliveredRecordId: 全出品のうちいちばん新しい届いた購入の endpoint id", () => {
  const d = eligibleDetail();
  assert.equal(latestDeliveredRecordId(d), "e1");
  const newer = buildSellerDetail(
    "shop.example",
    [
      { endpointId: "e1", resourceKey: "shop.example/api", resourceUrl: "https://shop.example/api", method: "GET", priceAmount: "1" },
      { endpointId: "e2", resourceKey: "shop.example/v1", resourceUrl: "https://shop.example/v1", method: "GET", priceAmount: "1" },
    ],
    [delivered, { ...delivered, endpointId: "e2", attemptedAt: "2026-11-20T00:00:00Z" }],
    "2026-11-20T00:00:00Z",
  );
  assert.equal(latestDeliveredRecordId(newer), "e2");
});

test("詳細が不適格なとき page は Base の売り手頁へ転送する", () => {
  const src = readFileSync(join(ROOT, "src/app/x402/sellers/[host]/page.tsx"), "utf8");
  assert.match(src, /!detail \|\| !reputationPageEligible\(detail\)/);
  assert.match(src, /redirect\(sellerPath\(host\)\)/);
  assert.doesNotMatch(src, /\bfailed\b/i);
});

function notFoundError(err: unknown): boolean {
  const e = err as { digest?: string; message?: string };
  return String(e.digest ?? e.message ?? err).includes("404");
}

function redirectError(err: unknown): boolean {
  const e = err as { digest?: string; message?: string };
  const s = String(e.digest ?? e.message ?? err);
  return s.includes("NEXT_REDIRECT") || s.includes("redirect");
}

test("条件外 host は reputation page を呼ぶと notFound", async () => {
  const { default: ReputationSellerPage } = await import("@/app/x402/sellers/[host]/page");
  await assert.rejects(
    () => ReputationSellerPage({ params: Promise.resolve({ host: "bad..host" }) }),
    notFoundError,
  );
});

test("索引に無い host は Base の売り手頁へ転送する", async () => {
  const { default: ReputationSellerPage } = await import("@/app/x402/sellers/[host]/page");
  const { getReputationHostsCached } = await import("@/lib/sellers/reputation");
  const allowed = await getReputationHostsCached().catch(() => null);
  const host = "not-indexed.example";
  if (allowed?.includes(host)) return;
  await assert.rejects(() => ReputationSellerPage({ params: Promise.resolve({ host }) }), redirectError);
});

test("seller index sitemap GET は I4 対象の /sellers/ URL を出す", async () => {
  const res = await getSitemapSellers();
  if (res.status === 503) return;
  assert.equal(res.status, 200);
  const rows = Number(res.headers.get("x-vet402-rows"));
  assert.ok(Number.isFinite(rows));
  const indexable = Number(res.headers.get("x-vet402-indexable-pages"));
  assert.equal(indexable, rows);
  const locs = [...(await res.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.equal(locs.length, rows);
  assert.ok(locs.every((u) => u.includes("/sellers/") && !u.includes("/x402/sellers/")));
});

test("newestDeliveredPurchase: 他チェーンの届いた購入が Base より新しければそちらを出す", () => {
  const d = buildSellerDetail(
    "shop.example",
    [
      { endpointId: "e1", resourceKey: "shop.example/api", resourceUrl: "https://shop.example/api", method: "GET", priceAmount: "1" },
      { endpointId: "e2", resourceKey: "shop.example/v1", resourceUrl: "https://shop.example/v1", method: "GET", priceAmount: "1" },
    ],
    [delivered, { ...delivered, endpointId: "e2", attemptedAt: "2026-11-16T11:00:00Z" }],
    "2026-11-16T12:00:00Z",
    undefined,
    [
      {
        endpointId: "e1",
        network: "eip155:56",
        status: "settled",
        attemptedAt: "2026-11-18T00:00:00Z",
        httpStatusPaid: 200,
      },
    ],
  );
  const listing = d.listings.find((l) => l.endpointId === "e1")!;
  const newest = newestDeliveredPurchase(listing);
  assert.equal(newest?.attemptedAt, "2026-11-18T00:00:00Z");
  assert.equal(newest?.network, "eip155:56");
  const html = renderToStaticMarkup(createElement(ReputationSellerArticle, { detail: d }));
  assert.match(html, /2026-11-18 00:00/);
  assert.match(html, />BNB Chain</);
  assert.match(html, /href="\/observatory\/e\/e1"/);
  assert.equal(latestDeliveredRecordId(d), "e1");
});

test("404 本文に評判禁止語は無い", () => {
  const html = renderToStaticMarkup(createElement(NotFound));
  assert.deepEqual(htmlForbiddenCount(html), []);
});