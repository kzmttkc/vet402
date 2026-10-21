// ============================================================
// /sellers の描画（src/components/site/sellers/SellersViews.tsx）。頁はデータを引いて渡すだけなので、
// ここで描画の約束を固定する:
//   - 取得時刻（DB を読んだ時刻）を出す。数字は props から出る（文言に件数を焼かない）
//   - vet402 の側の失敗は "vet402's side" と書き、売り手に直させない。買い直しの説明を添える
//   - 決済 tx は Basescan へ、export.csv の該当行へのたどり方を出す
//   - 「直った（fixed）」と書かない。届いた後の行は事実だけ
//   - 方法論へリンクする
// ============================================================
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FixFirstView, SellerDetailView, SellersIndexView, sellerDescription, sellerPageTitle, TITLE_MAX } from "@/components/site/sellers/SellersViews";
import { buildSellerBoard, buildSellerDetail, markRebuyEligible, searchSellers, sellerHeadline, type LatestRow } from "@/lib/sellers/board";
import type { SellerRowFacts } from "@/lib/sellers/fix-modes";

const TX = `0x${"cd".repeat(32)}`;
const FETCHED = "2026-09-28T13:04:05.000Z";

/** 先頭の 4 数（delivered / seller / none / with no Base purchase）。和は出品数と一致する。 */
function leadCountSum(html: string): number {
  const head = html.split("By the latest attempt")[0] ?? "";
  const m = head.match(
    /<strong>([\d,]+)<\/strong> delivered[\s\S]*?<strong>([\d,]+)<\/strong> failed on the seller(?:&#x27;|')s side[\s\S]*?<strong>([\d,]+)<\/strong> with no such result[\s\S]*?<strong>([\d,]+)<\/strong> with no Base purchase/,
  );
  assert.ok(m, "lead counts");
  return m.slice(1, 5).reduce((sum, raw) => sum + Number(raw.replaceAll(",", "")), 0);
}

/** テストの書きやすさのための旗 → 共有の判定が読む meta / schema。declaresQuery は「必須のクエリがある」。 */
type Flags = { declaresBody?: boolean; bodyRecorded?: boolean; declaresQuery?: boolean; optionalQueryOnly?: boolean; queryRecorded?: boolean };
function withFlags(p: Partial<SellerRowFacts> & Flags): Partial<SellerRowFacts> {
  const { declaresBody, bodyRecorded, declaresQuery, optionalQueryOnly, queryRecorded, ...rest } = p;
  const props: Record<string, unknown> = {};
  if (declaresBody) props.body = {};
  if (declaresQuery) props.queryParams = { required: ["q"] };
  else if (optionalQueryOnly) props.queryParams = {};
  const meta: Record<string, unknown> = {};
  if (bodyRecorded) meta.requestBody = true;
  if (queryRecorded) meta.requestQuery = "declared";
  return {
    schema: Object.keys(props).length ? { properties: { input: { properties: props } } } : null,
    meta: Object.keys(meta).length ? meta : null,
    ...rest,
  };
}
function r(p: Partial<SellerRowFacts> & Flags): SellerRowFacts {
  return {
    endpointId: "e1",
    status: "settle_failed",
    httpStatusPaid: null,
    txHash: null,
    attemptedAt: "2026-09-20T12:00:00Z",
    network: "eip155:8453",
    method: "GET",
    meta: null,
    schema: null,
    unpaidStatus: null,
    selection: null,
    verifyReason: null,
    ...withFlags(p),
  };
}

/** 2026-09-29 第2巡: seller の側に置く根拠（(b)〜(e)）をそろえた行。 */
function proven(p: Partial<SellerRowFacts> & Flags): SellerRowFacts {
  const x = r(p);
  return {
    amountUnits: "10000",
    payTo: `0x${"11".repeat(20)}`,
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payer: "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670",
    declaresHeaders: false,
    pathTemplate: false,
    listingMaxTimeoutSeconds: 20,
    ...x,
    meta: x.meta ?? { requestBody: "none", requestQuery: "empty" },
  };
}

const eps = [
  { endpointId: "e1", resourceKey: "shop.example/a", resourceUrl: "https://shop.example/a", method: "POST", priceAmount: "1000" },
  { endpointId: "e2", resourceKey: "shop.example/b", resourceUrl: "https://shop.example/b", method: "GET", priceAmount: "1000" },
  { endpointId: "e3", resourceKey: "shop.example/c", resourceUrl: "https://shop.example/c", method: "POST", priceAmount: "1000" },
  { endpointId: "e4", resourceKey: "shop.example/d", resourceUrl: "https://shop.example/d", method: "GET", priceAmount: "1000" },
];
const rows = [
  // e1: 残高切れ（vet402 の側）が最新
  r({ endpointId: "e1", status: "settle_failed", httpStatusPaid: 402, attemptedAt: "2026-09-14T01:02:03Z" }),
  // e2: 失敗の後に届いた
  r({ endpointId: "e2", status: "settle_failed", httpStatusPaid: 500, attemptedAt: "2026-09-10T00:00:00Z" }),
  r({ endpointId: "e2", status: "settled", httpStatusPaid: 200, txHash: TX, attemptedAt: "2026-09-12T00:00:00Z", selection: "census" }),
  // e3: 本文を送らなかった期間の 422（vet402 の側）
  r({ endpointId: "e3", status: "settle_failed", httpStatusPaid: 422, method: "POST", declaresBody: true, attemptedAt: "2026-09-11T00:00:00Z" }),
];

test("SellerDetailView: 取得時刻・vet402 の側・買い直し・tx・export の行", () => {
  const d = buildSellerDetail("shop.example", eps, rows, FETCHED);
  const html = renderToStaticMarkup(createElement(SellerDetailView, { detail: d, page: 1, now: Date.parse("2026-09-28T13:00:00Z"), revalidateSec: 300 }));
  assert.equal(leadCountSum(html), d.summary.listings);
  assert.match(html, /Read from the database 2026-09-28 13:04 UTC/);
  assert.match(html, /reused for up to 5 min/);
  // 2026-09-29: 表題は最新の購入日つきの事実の言い方（現在形の「Is … working?」をやめた）
  assert.match(html, /<h1[^>]*>shop\.example: x402 purchase results on Base, latest attempt 2026-09-14<\/h1>/);
  assert.doesNotMatch(html, /working\?/);
  // 行に層（L1）を書く。記録頁の Published state（L0）と読み違えない
  assert.match(html, /Recorded \(L1 paid purchase\):/);
  assert.match(html, /Latest attempt/);
  assert.match(html, /<strong>L0<\/strong> state/);
  assert.match(html, /vet402&#x27;s side/);
  assert.match(html, /vet402&#x27;s wallet was out of USDC/);
  assert.match(html, /vet402 did not send the declared request body/);
  assert.match(html, /Nothing for the seller to fix\./);
  // 旗 off（board に retest の結果なし）: 買い直しを約束しない。こちらの側の失敗だとだけ言う
  assert.doesNotMatch(html, /Re-buy:|queued|eligible for a re-buy|buys from that seller again|will appear/);
  assert.match(html, /Your most recent purchase failed on vet402&#x27;s side\.<\/strong> Nothing for you to fix there\./);
  assert.match(html, /This failure was on vet402&#x27;s side, not the seller&#x27;s\./);
  assert.match(html, new RegExp(`href="https://basescan.org/tx/${TX}"`));
  assert.match(html, /href="\/api\/v1\/observatory\/export\.csv\?days=\d+"/);
  assert.match(html, /<code>attempted_at<\/code> 2026-09-12T00:00:00Z/);
  assert.match(html, /The latest purchase delivered\. An earlier attempt listed below did not\./);
  assert.doesNotMatch(html, /\bfixed\b/i, "never claim a fix");
  assert.match(html, /href="\/observatory\/methodology"/);
  assert.match(html, /href="\/observatory\/e\/e1"/);
  assert.match(html, /No Base purchase is on this listing/);
  assert.match(html, /with no Base purchase/);
  assert.doesNotMatch(html, /not tried yet/);
  assert.doesNotMatch(html, /has not tried/);
  // 2026-09-29 第2巡: 署名した行には払った条件を出す
  assert.match(html, /The 402 terms vet402 paid:<\/strong> exact\./);
  assert.match(html, /bought by the <code>census<\/code>|\[census\]/);
});

test("SellerDetailView: Base の購入が無い出品は、他チェーンの署名済み購入を書く", () => {
  const d = buildSellerDetail(
    "mailpulse.theaslangroupllc.com",
    [{
      endpointId: "e-bnb",
      resourceKey: "mailpulse.theaslangroupllc.com/api/letters/ltr_6efe036558965c36",
      resourceUrl: "https://mailpulse.theaslangroupllc.com/api/letters/ltr_6efe036558965c36",
      method: "GET",
      priceAmount: "1000",
    }],
    [],
    FETCHED,
    undefined,
    [{ endpointId: "e-bnb", network: "eip155:56", status: "settled", attemptedAt: "2026-10-19T03:31:00Z", httpStatusPaid: 200 }],
  );
  const html = renderToStaticMarkup(createElement(SellerDetailView, { detail: d, page: 1, now: 0, revalidateSec: 300 }));
  assert.equal(d.sellerView.delivered, 0);
  assert.equal(d.sellerView.seller, 0);
  assert.equal(d.sellerView.none, 0);
  assert.equal(d.summary.notTried, 1);
  assert.match(html, /Result<\/dt>\s*<dd class="m-0[^"]*">\s*not tried on Base yet\s*<\/dd>/);
  assert.match(html, /Whose side<\/dt>\s*<dd class="m-0">\s*not tried on Base yet\s*<\/dd>/);
  assert.match(html, /Other chains<\/dt>\s*<dd class="m-0">\s*BSC, 2026-10-19 03:31 UTC, settled, HTTP 200\s*<\/dd>/);
  assert.match(html, /Also bought on other chains: 1 listing \(BSC 1\)\. Each card lists them under Other chains\./);
  assert.match(html, /<h1[^>]*>[^<]*latest attempt 2026-10-19 on BSC<\/h1>/);
  assert.match(html, /No Base purchase is on this listing\./);
  assert.match(html, /record page shows that purchase in the Payment chain column/);
  assert.match(html, /opens the settlement on Basescan when the purchase is on Base/);
  assert.doesNotMatch(html, /opens the settlement on Basescan\./);
  assert.doesNotMatch(html, /not tried yet/);
  assert.doesNotMatch(html, /has not tried/);
  assert.doesNotMatch(html, /no failure \(delivered\)/);
  assert.equal(leadCountSum(html), d.summary.listings);
  const lead = html.split("By the latest attempt")[0] ?? "";
  assert.match(lead, /<strong>0<\/strong> delivered/);
  assert.match(lead, /<strong>1<\/strong> with no Base purchase/);
  assert.match(html, /By the latest attempt at each listing, whatever it was:[\s\S]*<strong>1<\/strong> with no Base purchase/);
});

test("SellerDetailView: Base の購入が無い settle_failed は Result に status と HTTP を出し、delivered に数えない", () => {
  const d = buildSellerDetail(
    "carbon-cashmere.example",
    [{
      endpointId: "e-star",
      resourceKey: "carbon-cashmere.example/transfer-flow",
      resourceUrl: "https://carbon-cashmere.example/transfer-flow",
      method: "GET",
      priceAmount: "1000",
    }],
    [],
    FETCHED,
    undefined,
    [{ endpointId: "e-star", network: "stellar:pubnet", status: "settle_failed", attemptedAt: "2026-10-18T21:30:42Z", httpStatusPaid: 402 }],
  );
  const html = renderToStaticMarkup(createElement(SellerDetailView, { detail: d, page: 1, now: 0, revalidateSec: 300 }));
  assert.equal(d.sellerView.delivered, 0);
  assert.equal(d.sellerView.seller, 0);
  assert.equal(d.sellerView.none, 0);
  assert.equal(d.summary.notTried, 1);
  assert.match(html, /Result<\/dt>\s*<dd class="m-0[^"]*">\s*not tried on Base yet\s*<\/dd>/);
  assert.match(html, /Whose side<\/dt>\s*<dd class="m-0">\s*not tried on Base yet\s*<\/dd>/);
  assert.match(html, /Other chains<\/dt>\s*<dd class="m-0">\s*Stellar, 2026-10-18 21:30 UTC, settle_failed, HTTP 402\s*<\/dd>/);
  assert.match(html, /No Base purchase is on this listing\./);
  assert.match(html, /<h1[^>]*>[^<]*latest attempt 2026-10-18 on Stellar<\/h1>/);
  assert.doesNotMatch(html, /no failure \(delivered\)/);
  assert.equal(leadCountSum(html), d.summary.listings);
  const lead = html.split("By the latest attempt")[0] ?? "";
  assert.match(lead, /<strong>0<\/strong> delivered/);
  assert.match(lead, /<strong>0<\/strong> with no such result/);
  assert.match(lead, /<strong>1<\/strong> with no Base purchase/);
});

const STAR_TX = "ab".repeat(32);

test("先頭の件数とカードの Result・Whose side は Base の行だけで決まる", () => {
  const listing = {
    endpointId: "e-img",
    resourceKey: "agent402.tools/api/image-ocr",
    resourceUrl: "https://agent402.tools/api/image-ocr",
    method: "GET",
    priceAmount: "1000",
  };
  const overCap = buildSellerDetail("agent402.tools", [listing], [
    r({ endpointId: "e-img", status: "over_cap", attemptedAt: "2026-10-06T09:32:00Z" }),
  ], FETCHED, undefined, [
    { endpointId: "e-img", network: "stellar:pubnet", status: "settled", attemptedAt: "2026-10-18T21:30:44Z", httpStatusPaid: 200, txHash: STAR_TX },
  ]);
  assert.equal(overCap.listings[0]?.latest?.bucket, "vet402");
  assert.equal(overCap.sellerView.delivered, 0);
  assert.equal(overCap.sellerView.seller, 0);
  assert.equal(overCap.sellerView.none, 1);
  assert.equal(overCap.summary.notTried, 0);
  const overHtml = renderToStaticMarkup(createElement(SellerDetailView, { detail: overCap, page: 1, now: 0, revalidateSec: 300 }));
  assert.equal(leadCountSum(overHtml), overCap.summary.listings);
  const overLead = overHtml.split("By the latest attempt")[0] ?? "";
  assert.match(overLead, /<strong>0<\/strong> delivered/);
  assert.match(overLead, /<strong>0<\/strong> failed on the seller/);
  assert.match(overLead, /<strong>1<\/strong> with no such result/);
  assert.match(overLead, /<strong>0<\/strong> with no Base purchase/);
  assert.match(overLead, /Also bought on other chains: 1 listing \(Stellar 1\)\. Each card lists them under Other chains\./);
  assert.match(overHtml, /Latest Base attempt<\/dt>\s*<dd class="m-0">2026-10-06 09:32 UTC<\/dd>/);
  assert.doesNotMatch(overHtml, /Latest attempt<\/dt>/);
  assert.match(overHtml, /Result<\/dt>\s*<dd class="m-0[^"]*">\s*vet402&#x27;s own limits\s*<\/dd>/);
  assert.match(overHtml, /Whose side<\/dt>\s*<dd class="m-0">\s*vet402&#x27;s side\s*<\/dd>/);
  assert.doesNotMatch(overHtml, /Result<\/dt>\s*<dd class="m-0[^"]*">\s*settled/);
  assert.match(overHtml, /Other chains<\/dt>\s*<dd class="m-0">\s*Stellar, 2026-10-18 21:30 UTC, settled, HTTP 200\s*<a href="https:\/\/stellar\.expert\/explorer\/public\/tx\/ab(?:ab){31}" class="underline">transaction<\/a>\s*<\/dd>/);
  assert.match(overHtml, /The latest Base attempt failed on vet402&#x27;s side\./);
  assert.doesNotMatch(overHtml, /The latest attempt failed on vet402/);
  assert.doesNotMatch(overHtml, /[Tt]here has been no attempt since/);
  assert.doesNotMatch(overHtml, /Your most recent purchase failed on vet402/);
  assert.match(overHtml, /<h1[^>]*>[^<]*latest attempt 2026-10-18 on Stellar<\/h1>/);
  assert.match(overHtml, /The time filled in for the dispute is the latest Base attempt\./);
  assert.match(overHtml, /The time filled in is the latest Base attempt when that listing has a Base purchase\./);
  assert.match(overHtml, /purchase=2026-10-06T09%3A32%3A00Z/);
  assert.doesNotMatch(overHtml, /purchase=2026-10-18T21%3A30%3A44Z/);

  const settledBase = buildSellerDetail("agent402.tools", [listing], [
    r({ endpointId: "e-img", status: "settled", httpStatusPaid: 200, txHash: TX, attemptedAt: "2026-10-06T09:32:00Z" }),
  ], FETCHED, undefined, [
    { endpointId: "e-img", network: "stellar:pubnet", status: "settle_failed", attemptedAt: "2026-10-18T21:30:44Z", httpStatusPaid: 402 },
  ]);
  assert.equal(settledBase.sellerView.delivered, 1);
  assert.equal(settledBase.sellerView.seller, 0);
  assert.equal(settledBase.sellerView.none, 0);
  assert.equal(settledBase.summary.notTried, 0);
  const failHtml = renderToStaticMarkup(createElement(SellerDetailView, { detail: settledBase, page: 1, now: 0, revalidateSec: 300 }));
  assert.equal(leadCountSum(failHtml), settledBase.summary.listings);
  const failLead = failHtml.split("By the latest attempt")[0] ?? "";
  assert.match(failLead, /<strong>1<\/strong> delivered/);
  assert.match(failLead, /<strong>0<\/strong> failed on the seller/);
  assert.match(failLead, /<strong>0<\/strong> with no such result/);
  assert.match(failLead, /<strong>0<\/strong> with no Base purchase/);
  assert.match(failHtml, /Result<\/dt>\s*<dd class="m-0[^"]*">\s*delivered\s*<\/dd>/);
  assert.match(failHtml, /Whose side<\/dt>\s*<dd class="m-0">\s*no failure \(delivered\)\s*<\/dd>/);
  assert.doesNotMatch(failHtml, /Result<\/dt>\s*<dd class="m-0[^"]*">\s*settle_failed/);
  assert.match(failHtml, /Other chains<\/dt>\s*<dd class="m-0">\s*Stellar, 2026-10-18 21:30 UTC, settle_failed, HTTP 402\s*<\/dd>/);
});

test("他チェーンの行は先頭の下の 1 文で、件数の多い鎖から書く", () => {
  const endpoints = [
    { endpointId: "e-b1", resourceKey: "mix.example/a", resourceUrl: "https://mix.example/a", method: "GET", priceAmount: "1000" },
    { endpointId: "e-b2", resourceKey: "mix.example/b", resourceUrl: "https://mix.example/b", method: "GET", priceAmount: "1000" },
    { endpointId: "e-s1", resourceKey: "mix.example/c", resourceUrl: "https://mix.example/c", method: "GET", priceAmount: "1000" },
  ];
  const d = buildSellerDetail("mix.example", endpoints, [], FETCHED, undefined, [
    { endpointId: "e-b1", network: "eip155:56", status: "settled", attemptedAt: "2026-10-19T03:31:00Z", httpStatusPaid: 200 },
    { endpointId: "e-b2", network: "eip155:56", status: "settled", attemptedAt: "2026-10-18T03:31:00Z", httpStatusPaid: 200 },
    { endpointId: "e-s1", network: "stellar:pubnet", status: "settled", attemptedAt: "2026-10-17T03:31:00Z", httpStatusPaid: 200 },
  ]);
  assert.equal(d.sellerView.delivered + d.sellerView.seller + d.sellerView.none + d.summary.notTried, d.summary.listings);
  const html = renderToStaticMarkup(createElement(SellerDetailView, { detail: d, page: 1, now: 0, revalidateSec: 300 }));
  assert.equal(leadCountSum(html), d.summary.listings);
  assert.match(html, /Also bought on other chains: 3 listings \(BSC 2, Stellar 1\)\. Each card lists them under Other chains\./);
  assert.match(html, /Other chains<\/dt>\s*<dd class="m-0">\s*BSC, 2026-10-19 03:31 UTC, settled, HTTP 200\s*<\/dd>/);
  assert.match(html, /Other chains<\/dt>\s*<dd class="m-0">\s*Stellar, 2026-10-17 03:31 UTC, settled, HTTP 200\s*<\/dd>/);
});

test("SellerDetailView: otherChain の空の本文は delivered に数えない", () => {
  const d = buildSellerDetail(
    "empty.example",
    [{
      endpointId: "e-empty",
      resourceKey: "empty.example/pay",
      resourceUrl: "https://empty.example/pay",
      method: "GET",
      priceAmount: "1000",
    }],
    [],
    FETCHED,
    undefined,
    [{ endpointId: "e-empty", network: "eip155:56", status: "settled", attemptedAt: "2026-10-19T03:31:00Z", httpStatusPaid: 200, payloadNonEmpty: false }],
  );
  assert.equal(d.sellerView.delivered, 0);
  assert.equal(d.sellerView.none, 0);
  assert.equal(d.summary.notTried, 1);
  const html = renderToStaticMarkup(createElement(SellerDetailView, { detail: d, page: 1, now: 0, revalidateSec: 300 }));
  assert.doesNotMatch(html, /no failure \(delivered\)/);
  assert.match(html, /Result<\/dt>\s*<dd class="m-0[^"]*">\s*not tried on Base yet\s*<\/dd>/);
  assert.match(html, /Whose side<\/dt>\s*<dd class="m-0">\s*not tried on Base yet\s*<\/dd>/);
  assert.match(html, /Other chains<\/dt>\s*<dd class="m-0">\s*BSC, 2026-10-19 03:31 UTC, settled, HTTP 200, body empty\s*<\/dd>/);
  assert.equal(leadCountSum(html), d.summary.listings);
  const reader = readFileSync("src/lib/sellers/reader.ts", "utf8");
  const otherQuery = reader.slice(reader.indexOf("const otherRaw"), reader.indexOf("return buildSellerDetail"));
  assert.match(otherQuery, /pu\.payload_non_empty/);
  assert.match(otherQuery, /pu\.tx_hash/);
  assert.match(otherQuery, /payloadNonEmpty/);
  assert.match(otherQuery, /txHash/);
});

test("SellerDetailView: Base より新しい他チェーンの購入は、Base の行の横に書く", () => {
  const listing = {
    endpointId: "e-img",
    resourceKey: "agent402.tools/api/image-ocr",
    resourceUrl: "https://agent402.tools/api/image-ocr",
    method: "GET",
    priceAmount: "1000",
  };
  const base = r({ endpointId: "e-img", status: "settled", httpStatusPaid: 200, txHash: TX, attemptedAt: "2026-10-06T09:32:00Z" });
  const newer = buildSellerDetail("agent402.tools", [listing], [base], FETCHED, undefined, [
    { endpointId: "e-img", network: "stellar:pubnet", status: "settled", attemptedAt: "2026-10-18T21:30:44Z", httpStatusPaid: 200 },
  ]);
  const newerHtml = renderToStaticMarkup(createElement(SellerDetailView, { detail: newer, page: 1, now: 0, revalidateSec: 300 }));
  assert.match(newerHtml, /Latest Base attempt<\/dt>\s*<dd class="m-0">2026-10-06 09:32 UTC<\/dd>/);
  assert.doesNotMatch(newerHtml, /Latest attempt<\/dt>/);
  assert.match(newerHtml, /Result<\/dt>\s*<dd class="m-0[^"]*">\s*delivered\s*<\/dd>/);
  assert.match(newerHtml, /Other chains<\/dt>\s*<dd class="m-0">\s*Stellar, 2026-10-18 21:30 UTC, settled, HTTP 200\s*<\/dd>/);
  assert.match(newerHtml, /<h1[^>]*>[^<]*latest attempt 2026-10-18 on Stellar<\/h1>/);
  assert.deepEqual(sellerHeadline(newer), { at: "2026-10-18T21:30:44Z", chain: "Stellar" });
  assert.doesNotMatch(newerHtml, /No Base purchase is on this listing/);
  assert.equal(leadCountSum(newerHtml), newer.summary.listings);

  const older = buildSellerDetail("agent402.tools", [listing], [base], FETCHED, undefined, [
    { endpointId: "e-img", network: "stellar:pubnet", status: "settled", attemptedAt: "2026-10-01T00:00:00Z", httpStatusPaid: 200 },
  ]);
  const olderHtml = renderToStaticMarkup(createElement(SellerDetailView, { detail: older, page: 1, now: 0, revalidateSec: 300 }));
  assert.match(olderHtml, /Latest attempt<\/dt>\s*<dd class="m-0">2026-10-06 09:32 UTC<\/dd>/);
  assert.doesNotMatch(olderHtml, /Latest Base attempt<\/dt>/);
  assert.match(olderHtml, /Result<\/dt>\s*<dd class="m-0[^"]*">\s*delivered\s*<\/dd>/);
  assert.match(olderHtml, /Other chains<\/dt>\s*<dd class="m-0">\s*Stellar, 2026-10-01 00:00 UTC, settled, HTTP 200\s*<\/dd>/);
  assert.equal(older.listings[0]?.otherChain?.network, "stellar:pubnet");
  assert.equal(sellerHeadline(older).chain, null);
  assert.equal(older.sellerView.delivered, 1);
  assert.equal(leadCountSum(olderHtml), older.summary.listings);
});

test("並びと題: otherChain の方が新しい出品が先、Base の方が新しければ鎖の名は題に出ない", () => {
  const endpoints = [
    { endpointId: "old", resourceKey: "shop.example/old", resourceUrl: "https://shop.example/old", method: "GET", priceAmount: "1000" },
    { endpointId: "star", resourceKey: "shop.example/star", resourceUrl: "https://shop.example/star", method: "GET", priceAmount: "1000" },
  ];
  const stellar = { endpointId: "star", network: "stellar:pubnet", status: "settled", attemptedAt: "2026-10-18T21:30:44Z", httpStatusPaid: 200 };
  const newerOther = buildSellerDetail(
    "shop.example",
    endpoints,
    [r({ endpointId: "old", status: "settled", httpStatusPaid: 200, txHash: TX, attemptedAt: "2026-10-01T00:00:00Z" })],
    FETCHED,
    undefined,
    [stellar],
  );
  assert.equal(newerOther.listings[0]?.endpointId, "star");
  assert.deepEqual(sellerHeadline(newerOther), { at: "2026-10-18T21:30:44Z", chain: "Stellar" });

  const newerBase = buildSellerDetail(
    "shop.example",
    endpoints,
    [r({ endpointId: "old", status: "settled", httpStatusPaid: 200, txHash: TX, attemptedAt: "2026-10-20T00:00:00Z" })],
    FETCHED,
    undefined,
    [stellar],
  );
  assert.equal(newerBase.listings[0]?.endpointId, "old");
  assert.equal(sellerHeadline(newerBase).chain, null);
  assert.equal(sellerHeadline(newerBase).at, "2026-10-20T00:00:00Z");
});

test("SellerDetailView: 数字は props から（件数を変えると表示が変わる）", () => {
  const d1 = buildSellerDetail("shop.example", eps, rows, FETCHED);
  const d2 = buildSellerDetail("shop.example", eps.slice(0, 2), rows, FETCHED);
  const h1 = renderToStaticMarkup(createElement(SellerDetailView, { detail: d1, page: 1, now: 0, revalidateSec: 300 }));
  const h2 = renderToStaticMarkup(createElement(SellerDetailView, { detail: d2, page: 1, now: 0, revalidateSec: 300 }));
  assert.match(h1, /4 Base listings/);
  assert.match(h2, /2 Base listings/);
});

test("SellersIndexView: 検索欄・一覧・内訳・方法論・取得時刻", () => {
  const latest: LatestRow[] = rows.map((x) => ({ ...x, host: "shop.example" }));
  const board = buildSellerBoard(
    [
      { host: "shop.example", listings: 4 },
      { host: "quiet.example", listings: 2 },
    ],
    latest.filter((x) => x.endpointId !== "e2" || x.status === "settled"),
    FETCHED,
  );
  const html = renderToStaticMarkup(createElement(SellersIndexView, { board, page: 1, q: "", search: null, revalidateSec: 300 }));
  assert.match(html, /<form[^>]*action="\/sellers"[^>]*method="get"/);
  assert.match(html, /name="q"/);
  assert.match(html, /href="\/sellers\/shop\.example"/);
  assert.match(html, /href="\/sellers\/quiet\.example"/);
  assert.match(html, /2 sellers with 6 Base listings; vet402 has tried to buy from 1 of\s+the sellers/);
  assert.match(html, /<h1[^>]*>Find your purchase results \(Base, as of 2026-09-14\)<\/h1>/, "the heading says when");
  assert.match(html, /Read from the database 2026-09-28 13:04 UTC/);
  assert.match(html, /href="\/observatory\/methodology"/);
  assert.match(html, /href="\/sellers\/fix-first"/);
  assert.match(html, /By the latest attempt at each listing:[\s\S]*?with no Base purchase/);
  // 一覧の順: 買った売り手が先
  assert.ok(html.indexOf("/sellers/shop.example") < html.indexOf("/sellers/quiet.example"));
});

test("SellersIndexView: 購入ホストの読み取り失敗は一致なしと書かない", () => {
  const board = buildSellerBoard([{ host: "shop.example", listings: 1 }], [], FETCHED);
  const html = renderToStaticMarkup(
    createElement(SellersIndexView, {
      board,
      page: 1,
      q: "api.solenrich.com",
      search: searchSellers(board.sellers, "api.solenrich.com"),
      revalidateSec: 300,
      purchasedLookupFailed: true,
    }),
  );
  assert.match(html, /Reading the ledger failed\. Please reload in a minute\./);
  assert.doesNotMatch(html, /No seller on Base matches/);
});

test("SellersIndexView: 検索で見つからないときはそう言う", () => {
  const board = buildSellerBoard([{ host: "shop.example", listings: 1 }], [], FETCHED);
  const html = renderToStaticMarkup(
    createElement(SellersIndexView, { board, page: 1, q: "nope.dev", search: searchSellers(board.sellers, "nope.dev"), revalidateSec: 300 }),
  );
  assert.match(html, /No seller on Base matches <code>nope\.dev<\/code>/);
});

test("FixFirstView: seller の側が先、vet402 の側は「直すものは無い」節、手間の段", () => {
  const latest: LatestRow[] = [
    { ...proven({ endpointId: "a", status: "settle_failed", httpStatusPaid: 500, attemptedAt: "2026-09-20T00:00:00Z" }), host: "one.example" },
    { ...r({ endpointId: "b", status: "settle_failed", httpStatusPaid: 402, attemptedAt: "2026-09-14T00:00:00Z" }), host: "two.example" },
    { ...proven({ endpointId: "c", status: "settled", httpStatusPaid: 307, txHash: TX }), host: "two.example" },
    { ...r({ endpointId: "d", status: "no_eligible_accept", network: null }), host: "three.example" },
  ];
  const board = buildSellerBoard(
    [
      { host: "one.example", listings: 1 },
      { host: "two.example", listings: 2 },
      { host: "three.example", listings: 1 },
    ],
    latest,
    FETCHED,
    null,
    // 2026-09-29 第4巡: seller の側は別の日に 2 回以上で確定（出品 a は 09-19 にも同じ形の失敗がある）。
    new Map([["a", new Set(["2026-09-19"])]]),
  );
  const html = renderToStaticMarkup(createElement(FixFirstView, { board, revalidateSec: 300 }));
  const sellerAt = html.indexOf("Server error on the paid request");
  const oursAt = html.indexOf("vet402&#x27;s wallet was out of USDC");
  const otherAt = html.indexOf("Not grouped yet");
  const notPaidAt = html.indexOf("Not bought: no payment option vet402 can sign");
  assert.ok(sellerAt > 0 && oursAt > sellerAt && otherAt > oursAt && notPaidAt > otherAt, "seller → vet402 → unsorted → not bought");
  assert.match(html, /Not bought: vet402 did not pay/);
  assert.match(html, /<h1[^>]*>What to fix first, as of 2026-09-20<\/h1>/);
  assert.match(html, /On vet402&#x27;s side: nothing for sellers to fix/);
  assert.match(html, /effort 2: a server change/);
  assert.match(html, /Not counted against either side/);
  assert.match(html, /\(3 of 3 that vet402 paid for\)/);
  assert.match(html, /href="\/sellers\/one\.example"/);
  assert.match(html, /Read from the database 2026-09-28 13:04 UTC/);
});

test("SellerDetailView: 決済してから断った POST（本文を送る前の期間）は保留で、こちらが本文を送っていなかった事実が並ぶ", () => {
  const d = buildSellerDetail(
    "paid.example",
    [{ endpointId: "p1", resourceKey: "paid.example/q", resourceUrl: "https://paid.example/q", method: "POST", priceAmount: "1000" }],
    [r({ endpointId: "p1", status: "settled", httpStatusPaid: 422, txHash: TX, method: "POST", declaresBody: false, attemptedAt: "2026-09-09T00:00:00Z" })],
    FETCHED,
  );
  const html = renderToStaticMarkup(createElement(SellerDetailView, { detail: d, page: 1, now: 0, revalidateSec: 300 }));
  assert.match(html, /Payment settled, then the input was rejected/);
  assert.match(html, /not sorted \(held\)/);
  assert.doesNotMatch(html, /Took the payment/);
  assert.equal(d.summary.seller, 0, "a held row is never on the seller's side");
  assert.match(html, /this listing declares no body/);
});

test("SellerDetailView: rebuyEligible は retest がこの売り手のこの行を選んだときだけ（markRebuyEligible）", () => {
  const d = buildSellerDetail("shop.example", eps, rows, FETCHED);
  const latest: LatestRow[] = rows.map((x) => ({ ...x, host: "shop.example" }));
  const hosts = [{ host: "shop.example", listings: 4 }];
  const on = buildSellerBoard(hosts, latest, FETCHED, new Map([["shop.example", { endpointId: "e1", reason: "unfunded" }]])).sellers[0];
  const html = renderToStaticMarkup(createElement(SellerDetailView, { detail: markRebuyEligible(d, on), page: 1, now: 0, revalidateSec: 300 }));
  assert.match(html, /This seller is eligible for a re-buy\s+under the rules on the/);
  assert.match(html, /this listing is eligible for a re-buy under the rules on the/);
  assert.doesNotMatch(html, /will appear/);
  const other = buildSellerBoard(hosts, latest, FETCHED, new Map([["shop.example", { endpointId: "e3", reason: "unfunded" }]])).sellers[0];
  const html2 = renderToStaticMarkup(createElement(SellerDetailView, { detail: markRebuyEligible(d, other), page: 1, now: 0, revalidateSec: 300 }));
  assert.doesNotMatch(html2, /eligible for a re-buy/, "retest picked a different row than this page's latest");
});

test("SellerDetailView: 照合待ちの行は失敗と書かず、時刻も書かず中立に書く（理由があれば添える）", () => {
  const d = buildSellerDetail(
    "wait.example",
    [{ endpointId: "w1", resourceKey: "wait.example/x", resourceUrl: "https://wait.example/x", method: "GET", priceAmount: "1000" }],
    [r({ endpointId: "w1", status: "settle_claimed", httpStatusPaid: 200, txHash: TX, attemptedAt: "2026-09-28T00:10:00Z" })],
    FETCHED,
  );
  assert.equal(d.summary.pending, 1);
  assert.equal(d.summary.vet402 + d.summary.seller + d.summary.unsorted, 0);
  const html = renderToStaticMarkup(createElement(SellerDetailView, { detail: d, page: 1, now: 0, revalidateSec: 300 }));
  assert.match(html, /awaiting on-chain verification/);
  assert.ok(html.includes("The seller returned a settlement receipt, and vet402 has not confirmed that transaction on-chain yet. Until it is confirmed or refuted, this purchase is neither delivered nor failed."));
  assert.doesNotMatch(html, /\d{2}:\d{2} UTC each day|its check runs at|has not found it yet/, "no schedule is promised; no reason, no reason sentence");
  const withReason = buildSellerDetail(
    "wait.example",
    [{ endpointId: "w1", resourceKey: "wait.example/x", resourceUrl: "https://wait.example/x", method: "GET", priceAmount: "1000" }],
    [r({ endpointId: "w1", status: "settle_claimed", httpStatusPaid: 200, txHash: TX, verifyReason: "tx_not_found", attemptedAt: "2026-09-28T00:10:00Z" })],
    FETCHED,
  );
  const html2 = renderToStaticMarkup(createElement(SellerDetailView, { detail: withReason, page: 1, now: 0, revalidateSec: 300 }));
  assert.ok(html2.includes("vet402 looked for that transaction on-chain and has not found it yet (tx_not_found)."));
  assert.doesNotMatch(html, /failed on vet402|vet402&#x27;s side\.<\/strong>|Nothing for the seller to fix/);
  const board = buildSellerBoard([{ host: "wait.example", listings: 1 }], [{ ...d.listings[0].latest!.facts, host: "wait.example" }], FETCHED);
  const ff = renderToStaticMarkup(createElement(FixFirstView, { board, revalidateSec: 300 }));
  assert.match(ff, /\(0 of 1 that vet402 paid for\)/);
  assert.match(ff, /1 more are awaiting on-chain verification and are not counted here/);
});

test("売り手頁の <title> は最新の購入日つきの事実の言い方で、60 字を超えるなら接尾辞を落とす（2026-09-29）", () => {
  assert.equal(sellerPageTitle("a.io"), "a.io: x402 purchase results on Base | vet402");
  assert.ok(sellerPageTitle("a.io").length <= TITLE_MAX);
  assert.equal(sellerPageTitle("a.io", "2026-09-22T00:01:36Z"), "a.io: x402 purchase results on Base, latest attempt 2026-09-22");
  assert.equal(
    sellerPageTitle("a.io", "2026-10-19T03:31:00Z", "BSC"),
    "a.io: x402 purchase results on Base, latest attempt 2026-10-19 on BSC",
  );
  assert.equal(sellerPageTitle("api.example.com", "2026-09-22T00:01:36Z"), "api.example.com: x402 purchase results on Base, latest attempt 2026-09-22");
  assert.equal(sellerPageTitle("x.io", "garbage"), "x.io: x402 purchase results on Base | vet402");
  assert.doesNotMatch(sellerPageTitle("a.io", "2026-09-22T00:01:36Z"), /working/);
  assert.equal(
    sellerDescription("mailpulse.theaslangroupllc.com", "BSC"),
    "What happened when vet402 paid mailpulse.theaslangroupllc.com over x402. The latest purchase is on BSC: each purchase result, what to fix, and whose side a failure was on.",
  );
  assert.equal(
    sellerDescription("shop.example", null),
    "What happened when vet402 paid shop.example over x402 on Base: each purchase result, what to fix, and whose side a failure was on.",
  );
  const page = readFileSync("src/app/sellers/[host]/page.tsx", "utf8");
  assert.match(page, /sellerDescription\(host, head\.chain\)/);
  assert.match(page, /sellerDescription\(detail\.host, head\.chain\)/);
});

test("売り手一覧は 640px 未満でラベル付きのカードになり、表は 640px 以上だけ（2026-09-28）", () => {
  const board = buildSellerBoard([{ host: "shop.example", listings: 3 }], [], FETCHED);
  const html = renderToStaticMarkup(createElement(SellersIndexView, { board, page: 1, q: "", search: null, revalidateSec: 300 }));
  assert.match(html, /<ul[^>]*class="[^"]*sm:hidden/);
  assert.match(html, /<dt[^>]*>Seller&#x27;s side \(attribution under review\)<\/dt>/, "2026-10-21 A-17: 一覧のカードも見直し中と言う");
  assert.match(html, /<div class="hidden sm:block">/);
  assert.match(html, /<input[^>]*class="[^"]*text-base[^"]*"[^>]*name="q"/, "iOS の自動拡大を避ける 16px");
});
