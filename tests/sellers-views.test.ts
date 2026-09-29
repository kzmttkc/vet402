// ============================================================
// /sellers の描画（src/components/site/sellers/SellersViews.tsx）。頁はデータを引いて渡すだけなので、
// ここで描画の約束を固定する:
//   - 取得時刻（DB を読んだ時刻）を出す。数字は props から出る（文言に件数を焼かない）
//   - vet402 の側の失敗は "vet402's side" と書き、売り手に直させない。買い直しの説明を添える
//   - 決済 tx は Basescan へ、export.csv の該当行へのたどり方を出す
//   - 「直った（fixed）」と書かない。届いた後の行は事実だけ
//   - 方法論へリンクする
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FixFirstView, SellerDetailView, SellersIndexView, sellerPageTitle, TITLE_MAX } from "@/components/site/sellers/SellersViews";
import { buildSellerBoard, buildSellerDetail, markRebuyEligible, searchSellers, type LatestRow } from "@/lib/sellers/board";
import type { SellerRowFacts } from "@/lib/sellers/fix-modes";

const TX = `0x${"cd".repeat(32)}`;
const FETCHED = "2026-09-28T13:04:05.000Z";

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
  assert.match(html, /not tried yet/);
  // 2026-09-29 第2巡: 署名した行には払った条件を出す
  assert.match(html, /The 402 terms vet402 paid:<\/strong> exact\./);
  assert.match(html, /bought by the <code>census<\/code>|\[census\]/);
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
  // 一覧の順: 買った売り手が先
  assert.ok(html.indexOf("/sellers/shop.example") < html.indexOf("/sellers/quiet.example"));
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
  assert.equal(sellerPageTitle("api.example.com", "2026-09-22T00:01:36Z"), "api.example.com: x402 purchase results on Base, latest attempt 2026-09-22");
  assert.equal(sellerPageTitle("x.io", "garbage"), "x.io: x402 purchase results on Base | vet402");
  assert.doesNotMatch(sellerPageTitle("a.io", "2026-09-22T00:01:36Z"), /working/);
});

test("売り手一覧は 640px 未満でラベル付きのカードになり、表は 640px 以上だけ（2026-09-28）", () => {
  const board = buildSellerBoard([{ host: "shop.example", listings: 3 }], [], FETCHED);
  const html = renderToStaticMarkup(createElement(SellersIndexView, { board, page: 1, q: "", search: null, revalidateSec: 300 }));
  assert.match(html, /<ul[^>]*class="[^"]*sm:hidden/);
  assert.match(html, /<dt[^>]*>Seller&#x27;s side<\/dt>/);
  assert.match(html, /<div class="hidden sm:block">/);
  assert.match(html, /<input[^>]*class="[^"]*text-base[^"]*"[^>]*name="q"/, "iOS の自動拡大を避ける 16px");
});
