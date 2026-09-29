// ============================================================
// 2026-09-29 敵対的監査 5 周目（名指しされた売り手の弁護士・4 周目の修正の確認役）。
//   1 頁と判定 API の非対称: 「Nothing is counted against the seller」を弱め、出品ごとに判定 API の答え（公開 API を
//     閲覧者のブラウザが呼ぶ）と、数え方が違う旨の 1 文と /docs/api へのリンク
//   2 届かなかった L1 の行を載せる記録頁は noindex・sitemap-observatory.xml から外す
//   3 冒頭の要約は「売り手について言える直近の結果」が主、最新の試行の数は補足
//   4 売り手の名指した tx の期限（照合器・台帳のコード）: 分類と表示の側
//   5 決済が成立していない行は「signed」「attempted」、応答が無い行に PAYMENT-RESPONSE の語を出さない、見出しの日付は
//     最新の試行の日で、読み出した時刻は別に出す
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  classifyRow,
  classifySellerRow,
  fixMode,
  FIX_MODES,
  rowNote,
  SELLER_NAMED_TX_NOT_FOUND,
  SELLER_NAMED_TX_NOT_FOUND_AFTER_DAYS,
  type SellerRowFacts,
} from "@/lib/sellers/fix-modes";
import { buildRecordSides, buildSellerDetail, showRow, type SellerEndpointFacts } from "@/lib/sellers/board";
import { DECISION_AUTO_LISTINGS, SellerDetailView, termsLabel } from "@/components/site/sellers/SellersViews";
import { answerOf, decisionApiHref } from "@/components/site/sellers/DecisionAnswer";
import { sellerNamedTxExpired, SELLER_NAMED_TX_EXPIRY_MS } from "@/lib/observatory/settlement-verifier";

const ROOT = process.cwd();
const TX = `0x${"cd".repeat(32)}`;
const RID = "a".repeat(64);
const FETCHED = "2026-09-29T04:10:00.000Z";

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

const ep = (id: string, over: Partial<SellerEndpointFacts> = {}): SellerEndpointFacts => ({
  endpointId: id,
  resourceKey: `s.example/${id}`,
  resourceUrl: `https://s.example/${id}`,
  method: "GET",
  priceAmount: "10000",
  resourceId: RID,
  ...over,
});

test("1: 公開の分類表に「Nothing is counted against the seller」が残っていない（この頁の数え方だと書く）", () => {
  for (const m of FIX_MODES) {
    assert.doesNotMatch(`${m.what} ${m.fix}`, /Nothing is counted against|not counted against the seller/, m.key);
    if (m.side !== "seller" && m.side !== "vet402" && m.key !== "other") {
      assert.match(`${m.what} ${m.fix}`, /This page (does not count|counts the row against neither)/, m.key);
    }
  }
});

test("1: 出品ごとに判定 API の答えの欄（公開 API へのリンク・先頭の数件だけ自動）と、読み方の 1 文と /docs/api", () => {
  const eps = Array.from({ length: DECISION_AUTO_LISTINGS + 2 }, (_, i) => ep(`e${i}`));
  const rows = eps.map((e, i) => proven({ endpointId: e.endpointId, status: "settle_failed", httpStatusPaid: 500, attemptedAt: `2026-09-2${i % 8}T12:00:00Z` }));
  const d = buildSellerDetail("s.example", [...eps, ep("never", { resourceId: null })], rows, FETCHED);
  const html = renderToStaticMarkup(createElement(SellerDetailView, { detail: d, page: 1, now: Date.parse(FETCHED), revalidateSec: 300 }));
  const links = html.match(new RegExp(`href="${decisionApiHref(RID).replace(/[?]/g, "\\?")}"`, "g")) ?? [];
  assert.equal(links.length, eps.length, "試行のある出品ごとに判定 API の答えへのリンク（JS が無くても開ける）");
  assert.match(html, /Decision API now:/);
  assert.match(html, /cautious for the payer/);
  assert.match(html, /href="\/docs\/api#verdicts"/);
  assert.equal(decisionApiHref(RID), `/api/v1/resources/${RID}/decision?role=payer`);
});

test("1: 判定 API の応答から頁に出す部分だけを取り出す（形が違えば null）", () => {
  assert.deepEqual(answerOf({ recommendation: "BLOCK", reason_codes: ["l1_paid_not_delivered", 3], scoredAt: "2026-09-29T04:00:00.000Z" }), {
    recommendation: "BLOCK",
    reasonCodes: ["l1_paid_not_delivered"],
    scoredAt: "2026-09-29T04:00:00.000Z",
  });
  assert.deepEqual(
    answerOf({ recommendation: "BLOCK", reason_codes: ["l0_pass", "l1_never_delivered", "l2_undeclared", "l0_unverified_tls"] })?.reasonCodes,
    ["l1_never_delivered", "l0_unverified_tls", "l0_pass", "l2_undeclared"],
    "主な理由（L1・L0 の pass 以外）を先に",
  );
  assert.equal(answerOf({ recommendation: "MAYBE" }), null);
  assert.equal(answerOf(null), null);
});

test("1: 判定の欄は頁から判定のコードを import しない（ブラウザが公開 API を呼ぶ・関門は sellers-no-payment-imports）", () => {
  const src = readFileSync(join(ROOT, "src/components/site/sellers/DecisionAnswer.tsx"), "utf8");
  assert.match(src, /^"use client";/);
  assert.doesNotMatch(src, /from "@\/lib\/decision/);
});

test("2: 記録頁の noindex と sitemap の除外は、届かなかった購入行が 1 つでもあること（vet402 の側・not sorted・照合待ちを含む）", () => {
  const delivered = row({ status: "settled", httpStatusPaid: 200, txHash: TX, attemptedAt: "2026-09-20T12:00:00Z" });
  assert.equal(buildRecordSides([delivered]).undelivered, 0);
  assert.equal(buildRecordSides([]).undelivered, 0, "L0 だけの頁は従来どおり");
  const vet402 = row({ status: "settle_failed", httpStatusPaid: 402, attemptedAt: "2026-09-14T01:00:00Z" });
  assert.equal(buildRecordSides([delivered, vet402]).undelivered, 1);
  const pending = row({ status: "settle_claimed", httpStatusPaid: 200, txHash: TX, attemptedAt: "2026-09-21T12:00:00Z" });
  assert.equal(buildRecordSides([pending]).undelivered, 1);
  const page = readFileSync(join(ROOT, "src/app/observatory/e/[id]/page.tsx"), "utf8");
  assert.match(page, /sides === null \|\| sides\.undelivered > 0 \? \{ noindex: true \}/);
  const route = readFileSync(join(ROOT, "src/app/sitemap-observatory.xml/route.ts"), "utf8");
  assert.match(route, /readEndpointsWithUndeliveredL1/);
  assert.match(route, /status: 503/);
  const reader = readFileSync(join(ROOT, "src/lib/sellers/reader.ts"), "utf8");
  const fn = reader.slice(reader.indexOf("export async function readEndpointsWithUndeliveredL1"));
  assert.match(fn, /coalesce\(pu\.http_status_paid BETWEEN \$\{DELIVERED_HTTP_MIN\} AND \$\{DELIVERED_HTTP_MAX\}, false\)/, "HTTP が NULL の行を届いた側に落とさない");
});

test("3: 冒頭の要約は売り手について言える直近の結果が主（最新が vet402 の側でも、その前の delivered を数える）", () => {
  const rows = [
    row({ status: "settle_failed", httpStatusPaid: 402, attemptedAt: "2026-09-14T01:00:00Z" }),
    row({ status: "settled", httpStatusPaid: 200, txHash: TX, attemptedAt: "2026-09-12T00:00:00Z" }),
  ];
  const d = buildSellerDetail("s.example", [ep("e1")], rows, FETCHED);
  const html = renderToStaticMarkup(createElement(SellerDetailView, { detail: d, page: 1, now: Date.parse(FETCHED), revalidateSec: 300 }));
  const main = html.indexOf("Latest result about the seller</strong>");
  const sub = html.indexOf("By the latest attempt at each listing");
  assert.ok(main > 0 && sub > main, "主の要約が先、最新の試行の数は後");
  assert.match(html.slice(main, sub), /<strong>1<\/strong> delivered/);
  assert.match(html.slice(sub), /^By the latest attempt at each listing, whatever it was: <strong>0<\/strong> delivered/);
});

test("4: 売り手の名指した tx が見つからないと確定した行は claim_not_found（日付つき）。判定 API の classifyRow は seller の側のまま", () => {
  const r = proven({
    status: "settle_claim_refuted",
    httpStatusPaid: 200,
    txHash: TX,
    verifyReason: `${SELLER_NAMED_TX_NOT_FOUND}: transaction ${TX} not found on eip155:8453, checked through 2026-09-29 (purchase 2026-09-12, 7-day limit)`,
    verifiedAt: "2026-09-29T03:00:00Z",
  });
  assert.equal(classifyRow(r).mode?.key, "claim_not_found");
  assert.equal(classifyRow(r).bucket, "seller");
  const c = classifySellerRow(r);
  assert.equal(c.mode?.key, "claim_not_found_once", "1 回だけなら not sorted: one failure so far");
  const note = rowNote(r, c.mode!.key)!;
  assert.equal(
    note,
    `Recorded as "seller-named tx not found" on 2026-09-29 (UTC): transaction ${TX} not found on eip155:8453, checked through 2026-09-29 (purchase 2026-09-12, 7-day limit).`,
  );
  assert.match(fixMode("claim_not_found").what, new RegExp(`for ${SELLER_NAMED_TX_NOT_FOUND_AFTER_DAYS} days after the purchase`));
  // 入力の記録が無い行（(d) を示せず not sorted）でも、見つからないと確定した事実と日付を添える（api.wines.bet 型）。
  const unrecorded = { ...r, meta: null };
  const cu = classifySellerRow(unrecorded);
  assert.equal(cu.mode?.key, "input_unrecorded");
  assert.match(rowNote(unrecorded, cu.mode!.key)!, /Recorded as "seller-named tx not found" on 2026-09-29 \(UTC\)/);
  const refuted = proven({ status: "settle_claim_refuted", httpStatusPaid: 200, txHash: TX, verifyReason: "no_matching_transfer" });
  assert.equal(classifyRow(refuted).mode?.key, "claim_refuted", "チェーンで否定を読んだ行は従来どおり");
});

test("4: 照合の期限は購入から 7 日（定数）。読めない時刻は期限前に倒す", () => {
  assert.equal(SELLER_NAMED_TX_EXPIRY_MS, SELLER_NAMED_TX_NOT_FOUND_AFTER_DAYS * 86_400_000);
  const now = Date.parse("2026-09-29T12:00:00Z");
  assert.equal(sellerNamedTxExpired("2026-09-12T12:07:55Z", now), true, "api.wines.bet: 17 日");
  assert.equal(sellerNamedTxExpired("2026-09-22T12:00:00Z", now), true, "ちょうど 7 日");
  assert.equal(sellerNamedTxExpired("2026-09-22T12:00:01Z", now), false);
  assert.equal(sellerNamedTxExpired(null, now), false);
  assert.equal(sellerNamedTxExpired("garbage", now), false);
});

test("5: 決済が成立していない行は signed / attempted（paid・bought は settled だけ）", () => {
  const unsettled = showRow(proven({ status: "settle_failed", httpStatusPaid: 500, selection: "retest" }));
  const settled = showRow(proven({ status: "settled", httpStatusPaid: 200, txHash: TX, selection: "census" }));
  assert.equal(termsLabel(unsettled), "The 402 terms vet402 signed:");
  assert.equal(termsLabel(settled), "The 402 terms vet402 paid:");
  const d = buildSellerDetail("s.example", [ep("e1"), ep("e2")], [
    { ...unsettled.facts, endpointId: "e1" },
    { ...settled.facts, endpointId: "e2", attemptedAt: "2026-09-19T12:00:00Z" },
  ], FETCHED);
  const html = renderToStaticMarkup(createElement(SellerDetailView, { detail: d, page: 1, now: Date.parse(FETCHED), revalidateSec: 300 }));
  assert.match(html, /attempted by the <code>retest<\/code>/);
  assert.match(html, /bought by the <code>census<\/code>/);
  assert.doesNotMatch(html, /bought by the <code>retest<\/code>/);
});

test("5: 見出しの日付は最新の試行の日で、読み出した時刻は別の行に出す", () => {
  const d = buildSellerDetail("s.example", [ep("e1")], [proven({ status: "settle_failed", httpStatusPaid: 500, attemptedAt: "2026-09-20T12:00:00Z" })], FETCHED);
  const html = renderToStaticMarkup(createElement(SellerDetailView, { detail: d, page: 1, now: Date.parse(FETCHED), revalidateSec: 300 }));
  assert.match(html, /<h1[^>]*>s\.example: x402 purchase results on Base, latest attempt 2026-09-20<\/h1>/);
  assert.match(html, /Latest attempt: 2026-09-20 12:00 UTC\. This page read the ledger at 2026-09-29 04:10 UTC/);
  assert.doesNotMatch(html, /as of 2026-09-20/);
});
