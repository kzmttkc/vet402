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
import { FixFirstView, SellerDetailView, SellersIndexView } from "@/components/site/sellers/SellersViews";
import { buildSellerBoard, buildSellerDetail, searchSellers, type LatestRow } from "@/lib/sellers/board";
import type { SellerRowFacts } from "@/lib/sellers/fix-modes";

const TX = `0x${"cd".repeat(32)}`;
const FETCHED = "2026-09-28T13:04:05.000Z";

function r(p: Partial<SellerRowFacts>): SellerRowFacts {
  return {
    endpointId: "e1",
    status: "settle_failed",
    httpStatusPaid: null,
    txHash: null,
    attemptedAt: "2026-09-20T12:00:00Z",
    network: "eip155:8453",
    method: "GET",
    declaresBody: false,
    bodyRecorded: false,
    unpaidStatus: null,
    selection: null,
    ...p,
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
  assert.match(html, /<h1[^>]*>shop\.example<\/h1>/);
  assert.match(html, /vet402&#x27;s side/);
  assert.match(html, /vet402&#x27;s wallet was out of USDC/);
  assert.match(html, /vet402 did not send the declared request body/);
  assert.match(html, /Nothing for the seller to fix\./);
  assert.match(html, /Re-buy:/);
  assert.match(html, /Your most recent purchase failed on vet402&#x27;s side/, "the seller's latest row (09-14 402) is ours");
  assert.match(html, new RegExp(`href="https://basescan.org/tx/${TX}"`));
  assert.match(html, /href="\/api\/v1\/observatory\/export\.csv\?days=\d+"/);
  assert.match(html, /<code>attempted_at<\/code> 2026-09-12T00:00:00Z/);
  assert.match(html, /The latest purchase delivered\. An earlier purchase listed below did not\./);
  assert.doesNotMatch(html, /\bfixed\b/i, "never claim a fix");
  assert.match(html, /href="\/observatory\/methodology"/);
  assert.match(html, /href="\/observatory\/e\/e1"/);
  assert.match(html, /not yet bought/);
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
  assert.match(html, /2 sellers with 6 Base listings; vet402 has bought from 1 of the sellers/);
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
    { ...r({ endpointId: "a", status: "settle_failed", httpStatusPaid: 400, attemptedAt: "2026-09-20T00:00:00Z" }), host: "one.example" },
    { ...r({ endpointId: "b", status: "settle_failed", httpStatusPaid: 402, attemptedAt: "2026-09-14T00:00:00Z" }), host: "two.example" },
    { ...r({ endpointId: "c", status: "settled", httpStatusPaid: 307, txHash: TX }), host: "two.example" },
  ];
  const board = buildSellerBoard(
    [
      { host: "one.example", listings: 1 },
      { host: "two.example", listings: 2 },
    ],
    latest,
    FETCHED,
  );
  const html = renderToStaticMarkup(createElement(FixFirstView, { board, revalidateSec: 300 }));
  const sellerAt = html.indexOf("The paid request was refused as invalid");
  const oursAt = html.indexOf("vet402&#x27;s wallet was out of USDC");
  const otherAt = html.indexOf("Not grouped yet");
  assert.ok(sellerAt > 0 && oursAt > sellerAt && otherAt > oursAt, "seller → vet402 → unsorted");
  assert.match(html, /On vet402&#x27;s side: nothing for sellers to fix/);
  assert.match(html, /effort 1: a listing or config change/);
  assert.match(html, /\(3 of 3 bought\)/);
  assert.match(html, /href="\/sellers\/one\.example"/);
  assert.match(html, /Read from the database 2026-09-28 13:04 UTC/);
});

test("SellerDetailView: 決済してから断った POST（本文を送る前の期間）には、こちらが本文を送っていなかった事実が並ぶ", () => {
  const d = buildSellerDetail(
    "paid.example",
    [{ endpointId: "p1", resourceKey: "paid.example/q", resourceUrl: "https://paid.example/q", method: "POST", priceAmount: "1000" }],
    [r({ endpointId: "p1", status: "settled", httpStatusPaid: 422, txHash: TX, method: "POST", declaresBody: true, attemptedAt: "2026-09-09T00:00:00Z" })],
    FETCHED,
  );
  const html = renderToStaticMarkup(createElement(SellerDetailView, { detail: d, page: 1, now: 0, revalidateSec: 300 }));
  assert.match(html, /Took the payment, then refused the input/);
  assert.match(html, /seller&#x27;s side/);
  assert.match(html, /this listing declares a body, which vet402 did not send/);
});
