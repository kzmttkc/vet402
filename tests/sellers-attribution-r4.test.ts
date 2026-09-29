// ============================================================
// 2026-09-29 第4巡の敵対的監査（名指しされた売り手の弁護士・逆方向の誤り・初めて来た売り手）。
//   A1 seller の側は同じ出品で別の UTC の日に 2 回以上。1 回だけは「not sorted: one failure so far」
//   A2 行ごとの証拠（署名した支払いの要点・支払い付き要求への応答の要点・記録済みのものだけ）
//   A3 冒頭の帯は seller の側（確定）の行がある頁だけ・該当の行に印
//   B4 索引に無い着金・入れ替え可能な組（chooseLinks）
//   B5 2xx で売り手が tx を名指した行は照合待ち（失敗にしない）
//   B6 export の held_reason と頁の原因が違う行は両方を書く
//   B7 決済済みで入力を送っていなかった行は「charged, then rejected …」（どちらの側にも数えない）
//   C9〜14 カード・バッジの分母・最新の売り手側の状態・用語・異議のリンク・タップ領域
// 判定 API と共有の classifyRow は変えない（src/lib/decision は別の担当）。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  classifyRow,
  classifySellerRow,
  exportReasonLine,
  fixMode,
  ONCE_SIDE_LABEL,
  paidEvidenceLines,
  sideLabelOf,
  type SellerRowFacts,
} from "@/lib/sellers/fix-modes";
import { buildRecordSides, buildSellerBoard, buildSellerDetail, recordRowKey } from "@/lib/sellers/board";
import { disputeHref, SellerDetailView, UNDER_RECHECK } from "@/components/site/sellers/SellersViews";
import { endpointReceiptBadge } from "@/lib/badge/receipt-badge";
import { chooseLinks } from "@/lib/settlements/recover-late";

const TX = `0x${"cd".repeat(32)}`;
const NONCE = `0x${"ab".repeat(32)}`;

function row(p: Partial<SellerRowFacts>): SellerRowFacts {
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
    ...p,
  };
}

/** (a)〜(e) を満たす行（関門の後・入力の記録あり・宣言の待ち時間が短い）。 */
function proven(p: Partial<SellerRowFacts>): SellerRowFacts {
  return row({
    amountUnits: "10000",
    payTo: `0x${"11".repeat(20)}`,
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payer: "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670",
    declaresHeaders: false,
    pathTemplate: false,
    listingMaxTimeoutSeconds: 20,
    meta: { requestBody: "none", requestQuery: "empty" },
    ...p,
  });
}

test("A1: seller の側は別の日に 2 回以上。1 回だけ・同じ日の 2 回は once（not sorted: one failure so far）", () => {
  const r1 = proven({ status: "settle_failed", httpStatusPaid: 500, attemptedAt: "2026-09-20T12:00:00Z" });
  assert.equal(classifyRow(r1).bucket, "seller", "判定 API と共有の classifyRow は変えない");
  const once = classifySellerRow(r1);
  assert.equal(once.bucket, "unsorted");
  assert.equal(once.mode?.key, "server_error_paid_once");
  assert.equal(sideLabelOf(once.mode!), ONCE_SIDE_LABEL);
  assert.equal(once.mode?.title, "Server error on the paid request", "何が起きたかは元の種類のまま");
  assert.match(once.mode!.fix, /^Nothing is counted against the seller\. .*two different days \(UTC\)\. If this one is real: Check the route's logs/);
  assert.equal(once.confirmedSeller, false);
  const sameDay = classifySellerRow(r1, { sellerFailureDays: ["2026-09-20"] });
  assert.equal(sameDay.bucket, "unsorted", "同じ日の 2 回は確定しない");
  const twoDays = classifySellerRow(r1, { sellerFailureDays: ["2026-09-18"] });
  assert.equal(twoDays.bucket, "seller");
  assert.equal(twoDays.mode?.key, "server_error_paid");
  assert.equal(twoDays.confirmedSeller, true);
});

test("A1: 一覧・売り手頁は出品ごとの日付で数える（reader の日付・手元の行のどちらでも）", () => {
  const a = proven({ endpointId: "a", status: "settle_failed", httpStatusPaid: 500, attemptedAt: "2026-09-20T12:00:00Z" });
  const hosts = [{ host: "s.example", listings: 1 }];
  const onlyOnce = buildSellerBoard(hosts, [{ ...a, host: "s.example" }], "t");
  assert.equal(onlyOnce.totals.seller, 0);
  assert.equal(onlyOnce.totals.unsorted, 1);
  assert.equal(onlyOnce.groups[0].key, "server_error_paid_once");
  const withDays = buildSellerBoard(hosts, [{ ...a, host: "s.example" }], "t", null, new Map([["a", new Set(["2026-09-19"])]]));
  assert.equal(withDays.totals.seller, 1);
  // 売り手頁: 表示する行（最新と以前）から日付を拾う
  const b = proven({ endpointId: "a", status: "settle_failed", httpStatusPaid: 502, attemptedAt: "2026-09-17T08:00:00Z" });
  const eps = [{ endpointId: "a", resourceKey: "s.example/a", resourceUrl: "https://s.example/a", method: "GET", priceAmount: "10000" }];
  const d = buildSellerDetail("s.example", eps, [a, b], "2026-09-28T00:00:00.000Z");
  assert.equal(d.summary.seller, 1);
  assert.equal(d.listings[0].latest?.confirmedSeller, true);
  assert.equal(d.listings[0].earlier[0].confirmedSeller, true);
  assert.equal(d.hasConfirmedSeller, true);
});

test("A2: 行ごとの証拠は記録済みのものだけ（nonce・validBefore は記録なしと書く・本文は出さない）", () => {
  const r = proven({
    status: "settle_failed",
    httpStatusPaid: 500,
    authNonce: NONCE,
    paidContentType: "application/json; charset=utf-8",
    receiptPresent: true,
    receiptSuccess: false,
    receiptErrorReason: "invalid_exact_evm_payload\u0000<script>",
  });
  const ev = paidEvidenceLines(r)!;
  assert.equal(ev.signed, "scheme exact · 0.01 USDC · payTo 0x1111…1111 · nonce 0xabab…abab · validBefore not recorded.");
  assert.match(ev.answer, /^HTTP 500 · Content-Type application\/json; charset=utf-8 · PAYMENT-RESPONSE: success false, errorReason invalid_exact_evm_payload<script>, names no transaction\.$/);
  assert.equal(paidEvidenceLines(row({ status: "no_402", network: null })), null, "署名していない行には無い");
  const noAnswer = paidEvidenceLines(proven({ status: "settle_failed", httpStatusPaid: null, receiptPresent: false }))!;
  assert.match(noAnswer.answer, /^no HTTP answer within \d+ seconds · no PAYMENT-RESPONSE recorded\.$/);
});

test("A3・C9・C13・C14: 帯の印・カード・行ごとの異議（購入の時刻つき）・タップ領域", () => {
  const eps = [
    { endpointId: "a", resourceKey: "s.example/a", resourceUrl: "https://s.example/a", method: "GET", priceAmount: "10000" },
    { endpointId: "b", resourceKey: "s.example/b", resourceUrl: "https://s.example/b", method: "GET", priceAmount: "10000" },
  ];
  const once = buildSellerDetail("s.example", eps, [proven({ endpointId: "a", httpStatusPaid: 500 })], "2026-09-28T00:00:00.000Z");
  assert.equal(once.hasConfirmedSeller, false, "1 回だけの頁に帯を出さない");
  const html1 = renderToStaticMarkup(createElement(SellerDetailView, { detail: once, page: 1, now: Date.parse("2026-09-28T00:00:00Z"), revalidateSec: 300 }));
  assert.doesNotMatch(html1, new RegExp(`>${UNDER_RECHECK}</span>`), "印は seller の側（確定）の行だけ");
  assert.match(html1, /not sorted: one failure so far/);
  assert.doesNotMatch(html1, /<table/, "売り手頁の出品は表でなくカード");
  assert.match(html1, /href="\/observatory\/e\/a\?purchase=2026-09-20T12%3A00%3A00Z#dispute"/);
  assert.match(html1, /Dispute this purchase/);
  assert.match(html1, /class="inline-flex min-h-6 items-center underline"[^>]*>Dispute this purchase/);
  assert.match(html1, /Dispute this record<\/a>/, "「Dispute this record」はリンク");
  const twice = buildSellerDetail(
    "s.example",
    eps,
    [proven({ endpointId: "a", httpStatusPaid: 500 }), proven({ endpointId: "a", httpStatusPaid: 500, attemptedAt: "2026-09-18T01:00:00Z" })],
    "2026-09-28T00:00:00.000Z",
  );
  const html2 = renderToStaticMarkup(createElement(SellerDetailView, { detail: twice, page: 1, now: 0, revalidateSec: 300 }));
  assert.equal((html2.match(new RegExp(`>${UNDER_RECHECK}</span>`, "g")) ?? []).length, 2, "該当の 2 行に印");
  assert.equal(disputeHref("a", "not-a-time"), "/observatory/e/a#dispute", "形の違う時刻は渡さない");
});

test("B5: 2xx で売り手が tx を名指した行（success:false）は照合待ち。照合器が理由を付けた後は従来どおり", () => {
  const wazir = proven({ status: "delivered_no_receipt", httpStatusPaid: 200, txHash: TX, meta: null });
  assert.equal(classifySellerRow(wazir).bucket, "pending");
  assert.notEqual(classifyRow(wazir).bucket, "pending", "判定 API の分類は変えない");
  const tried = { ...wazir, verifyReason: "tx_not_found" };
  assert.notEqual(classifySellerRow(tried).bucket, "pending");
  const eps = [{ endpointId: "e1", resourceKey: "w.example/a", resourceUrl: "https://w.example/a", method: "GET", priceAmount: "5000" }];
  const d = buildSellerDetail("w.example", eps, [wazir], "2026-09-28T00:00:00.000Z");
  const html = renderToStaticMarkup(createElement(SellerDetailView, { detail: d, page: 1, now: 0, revalidateSec: 300 }));
  assert.match(html, /answered HTTP 200 and the seller named a settlement transaction, although its receipt did not say success/);
});

test("B6: export の held_reason（unsettled_4xx）と頁の原因（残高不足）が違う行は両方を書く", () => {
  assert.equal(
    exportReasonLine("unsettled_4xx", fixMode("payer_short")),
    "In export.csv this row's held_reason is unsettled_4xx (the paid request got a 4xx with no settlement receipt and no transaction). This page names the cause the row shows: vet402's wallet held less USDC than the price.",
  );
  assert.equal(exportReasonLine("unsettled_4xx", fixMode("refused_no_charge")), null, "同じことを言うなら書かない");
  assert.equal(exportReasonLine("payer_unfunded", fixMode("payer_unfunded")), null);
  assert.equal(exportReasonLine(null, fixMode("payer_short")), null);
});

test("B7: 決済済みの 400 で宣言の本文を送っていなかった行は charged_unsent_input（判定 API は vet402 の側のまま）", () => {
  const r = row({
    status: "settled",
    httpStatusPaid: 400,
    txHash: TX,
    method: "POST",
    schema: { properties: { input: { properties: { body: {} } } } },
    attemptedAt: "2026-09-10T00:00:00Z",
  });
  assert.equal(classifyRow(r).mode?.key, "body_not_sent");
  const c = classifySellerRow(r);
  assert.equal(c.bucket, "unsorted");
  assert.equal(c.mode?.key, "charged_unsent_input");
  assert.equal(sideLabelOf(c.mode!), "not sorted: charged, then rejected an input vet402 had not sent");
  assert.match(c.mode!.what, /the seller took the payment, and the request lacked the declared input/);
  // 決済されていない同じ形は vet402 の側のまま
  const unsettled = { ...r, status: "settle_failed", txHash: null };
  assert.equal(classifySellerRow(unsettled).mode?.key, "body_not_sent");
});

test("C10: バッジは vet402 の側の失敗を分母から外し「vet402 side N」と書く（thevaultreport.com 型）", () => {
  const before = endpointReceiptBadge({ attemptCount: 3, settledCount: 2, deliveredCount: 2, inconclusiveCount: 1, inconclusiveSettledCount: 0 });
  assert.equal(before.label, "2/3 settled · 2 delivered · 1 inconclusive");
  const after = endpointReceiptBadge({
    attemptCount: 3,
    settledCount: 2,
    deliveredCount: 2,
    inconclusiveCount: 1,
    inconclusiveSettledCount: 0,
    vet402Side: { count: 1, settled: 0, held: 1, heldSettled: 0 },
  });
  assert.equal(after.label, "2/2 settled · 2 delivered · vet402 side 1");
  assert.match(after.aria, /1 further paid attempt failed on vet402's side/);
  const allOurs = endpointReceiptBadge({ attemptCount: 3, settledCount: 0, inconclusiveCount: 3, vet402Side: { count: 3, held: 3 } });
  assert.equal(allOurs.label, "no result yet · vet402 side 3");
  assert.doesNotMatch(allOurs.label, /not yet measured/);
});

test("C10・D: 記録頁の分類（buildRecordSides）はバッジの外す数と、seller の側（確定）の数を出す", () => {
  const rows = [
    row({ endpointId: "v", status: "settled", httpStatusPaid: 200, txHash: TX, attemptedAt: "2026-09-27T18:02:02Z" }),
    row({ endpointId: "v", status: "settle_failed", httpStatusPaid: 402, attemptedAt: "2026-09-13T12:08:19Z" }),
    row({ endpointId: "v", status: "settled", httpStatusPaid: 200, txHash: `0x${"ef".repeat(32)}`, attemptedAt: "2026-09-04T12:09:51Z" }),
  ];
  const s = buildRecordSides(rows);
  assert.equal(s.vet402Side, 1);
  assert.equal(s.vet402SideHeld, 1);
  assert.equal(s.vet402SideSettled, 0);
  assert.equal(s.confirmedSeller, 0);
  const shown = s.rows.get(recordRowKey(new Date("2026-09-13T12:08:19.123Z"), "settle_failed", null));
  assert.equal(shown?.bucket, "vet402");
  const seller = buildRecordSides([
    proven({ endpointId: "x", httpStatusPaid: 500, attemptedAt: "2026-09-20T00:00:00Z" }),
    proven({ endpointId: "x", httpStatusPaid: 500, attemptedAt: "2026-09-21T00:00:00Z" }),
  ]);
  assert.equal(seller.confirmedSeller, 2);
});

test("C11: 最新の行が vet402 の側で、以前に届いていれば、売り手について何かを言う最新の行を添える", () => {
  const eps = [{ endpointId: "e1", resourceKey: "v.example/a", resourceUrl: "https://v.example/a", method: "GET", priceAmount: "1000" }];
  const d = buildSellerDetail(
    "v.example",
    eps,
    [
      row({ status: "settle_failed", httpStatusPaid: 402, attemptedAt: "2026-09-14T00:00:00Z" }),
      row({ status: "settled", httpStatusPaid: 200, txHash: TX, attemptedAt: "2026-09-04T00:00:00Z" }),
    ],
    "2026-09-28T00:00:00.000Z",
  );
  assert.deepEqual(d.listings[0].lastSellerSignal, { at: "2026-09-04T00:00:00Z", bucket: "delivered" });
  assert.deepEqual(d.sellerView, { delivered: 1, seller: 0, none: 0 });
  const html = renderToStaticMarkup(createElement(SellerDetailView, { detail: d, page: 1, now: 0, revalidateSec: 300 }));
  assert.match(html, /Last result about the seller:<\/strong> delivered on 2026-09-04 00:00 UTC\. The latest attempt failed on vet402&#x27;s side; vet402 has not bought this listing again since\./);
  assert.match(html, /Before that, this listing delivered on 2026-09-04 00:00 UTC; vet402 has not bought it again since\./);
  assert.match(html, /<strong>1<\/strong> delivered · <strong>0<\/strong> failed on the seller&#x27;s side · <strong>0<\/strong> with no such/);
});

test("C12: 用語はその場で 1 文で説明する（status・held_reason）", () => {
  const eps = [{ endpointId: "e1", resourceKey: "v.example/a", resourceUrl: "https://v.example/a", method: "GET", priceAmount: "1000" }];
  const d = buildSellerDetail("v.example", eps, [row({ status: "settle_failed", httpStatusPaid: 402, attemptedAt: "2026-09-14T00:00:00Z" })], "2026-09-28T00:00:00.000Z");
  const html = renderToStaticMarkup(createElement(SellerDetailView, { detail: d, page: 1, now: 0, revalidateSec: 300 }));
  assert.match(html, /<code>settle_failed<\/code><span[^>]*> \(vet402 signed a payment and got no settlement receipt back\)/);
  assert.match(html, /held as <code>payer_unfunded<\/code><span[^>]*> \(a 402 or 5xx while vet402&#x27;s Base wallet was out of USDC/);
});

test("B4: chooseLinks — 1 行・入れ替え可能な組・足りない組・nonce のある組", () => {
  const p = (purchaseId: string, attemptedAt: string, txHash: string, blockTime: string, hasNonce = false) => ({ purchaseId, attemptedAt, txHash, blockTime, hasNonce });
  // fiatdock 型: 1 行・着金 2 本（2 秒後と、別の購入のものらしい 8 分後）→ 早い方
  assert.deepEqual(
    chooseLinks([p("r1", "2026-08-14T09:54:58Z", "0xa", "2026-08-14T09:54:59Z"), p("r1", "2026-08-14T09:54:58Z", "0xb", "2026-08-14T10:03:13Z")]),
    [{ purchaseId: "r1", txHash: "0xa", matchedBy: "unique" }],
  );
  // agent-budget-guard / ai-agent-payment-safety-stack 型: 2 行・2 本・全部の組が候補 → 時刻順
  const set = chooseLinks([
    p("guard", "2026-08-31T12:09:22Z", "0xt1", "2026-08-31T12:09:25Z"),
    p("guard", "2026-08-31T12:09:22Z", "0xt2", "2026-08-31T12:09:27Z"),
    p("stack", "2026-08-31T12:09:25Z", "0xt1", "2026-08-31T12:09:25Z"),
    p("stack", "2026-08-31T12:09:25Z", "0xt2", "2026-08-31T12:09:27Z"),
  ]);
  assert.deepEqual(set, [
    { purchaseId: "guard", txHash: "0xt1", matchedBy: "interchangeable_set" },
    { purchaseId: "stack", txHash: "0xt2", matchedBy: "interchangeable_set" },
  ]);
  // 2 行・1 本は推定しない
  assert.deepEqual(chooseLinks([p("a", "t1", "0xt", "t2"), p("b", "t1", "0xt", "t2")]), []);
  // nonce のある組は時刻順に対にしない（nonce で決める）
  assert.deepEqual(
    chooseLinks([
      p("a", "t1", "0x1", "t2", true),
      p("a", "t1", "0x2", "t3", true),
      p("b", "t1", "0x1", "t2", true),
      p("b", "t1", "0x2", "t3", true),
    ]),
    [],
  );
});
