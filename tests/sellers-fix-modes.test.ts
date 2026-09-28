// ============================================================
// /sellers の失敗の分類表（src/lib/sellers/fix-modes.ts）と集計（board.ts）。
//
// 固定すること:
//   - 既知の失敗が、正しい種類と正しい側に入る（本番の台帳に実在する status × HTTP の組）
//   - vet402 の側の失敗（残高切れ・宣言本文を送っていなかった期間の 400/422）が seller 側に入らない
//   - 種類ごとの件数の合計が、届かなかった出品の数と一致する（分からない行は unsorted）
//   - 売り手の単位（ホスト名）の規則が census の censusHostOf と同じ
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BASE_USDC_ADDRESS,
  classifyRow,
  DECLARED_BODY_SENT_SINCE,
  evidenceOf,
  FIX_MODES,
  fixMode,
  isBodyNotSent,
  observed402Line,
  rowNote,
  SIGNED_ROW_STATUSES,
  type SellerRowFacts,
} from "@/lib/sellers/fix-modes";
import { BASE_USDC } from "@/lib/observatory/x402-payer";
import { SIGNED_STATUSES } from "@/lib/decision/seller-facts";
import { payerFundsAtSigning, PAYER_FUNDS_GATE_SINCE } from "@/lib/observatory/payer-balance-history";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DECLARED_BODY_SENT_SINCE as RUNNER_SINCE } from "@/lib/observatory/l1-runner";
import { DECLARED_BODY_SENT_SINCE as CANON_SINCE } from "@/lib/observatory/request-body";
import { buildSellerBoard, buildSellerDetail, exportDaysFor, searchSellers, type LatestRow } from "@/lib/sellers/board";
import { parseSellerHostParam, sellerHostOf, sellerHostOfResourceKey } from "@/lib/sellers/host";
import { censusHostOf } from "@/lib/observatory/l1-runner";
import { heldReasonOf } from "@/lib/observatory/delivery";

let seq = 0;
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
function row(p: Partial<SellerRowFacts> & Flags): SellerRowFacts {
  seq++;
  return {
    endpointId: p.endpointId ?? `ep-${seq}`,
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
const TX = `0x${"ab".repeat(32)}`;
const PAYER = "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670";

/**
 * 2026-09-29 第2巡: seller の側に置く根拠（(b)〜(e)）を全部そろえた行。署名した条件・支払いウォレット・
 * 送った入力の記録（本文・クエリ）・ヘッダとパスの宣言なし・出品の maxTimeoutSeconds（待ち時間以下）。
 * 残高は署名の時刻が関門（PAYER_FUNDS_GATE_SINCE）以降なので funded。
 */
function proven(p: Partial<SellerRowFacts> & Flags): SellerRowFacts {
  const r = row(p);
  return {
    amountUnits: "10000",
    payTo: `0x${"11".repeat(20)}`,
    asset: BASE_USDC_ADDRESS,
    payer: PAYER,
    declaresHeaders: false,
    pathTemplate: false,
    listingMaxTimeoutSeconds: 20,
    ...r,
    meta: r.meta ?? { requestBody: (r.method ?? "").toUpperCase() === "POST" ? "empty" : "none", requestQuery: "empty" },
  };
}

/** [説明, 行, 期待する種類（null = delivered）, 期待する側] */
const KNOWN: [string, SellerRowFacts, string | null, string][] = [
  ["settled 200", row({ status: "settled", httpStatusPaid: 200, txHash: TX }), null, "delivered"],
  ["settled 202", row({ status: "settled", httpStatusPaid: 202, txHash: TX }), null, "delivered"],
  // vet402 の側
  ["残高切れ期間の 402", row({ status: "settle_failed", httpStatusPaid: 402, attemptedAt: "2026-09-14T03:00:00Z" }), "payer_unfunded", "vet402"],
  ["残高切れ期間の 500", row({ status: "settle_failed", httpStatusPaid: 500, attemptedAt: "2026-09-13T00:00:00Z" }), "payer_unfunded", "vet402"],
  [
    "宣言本文を送る前の POST 400（本文を宣言）",
    row({ status: "settle_failed", httpStatusPaid: 400, method: "POST", declaresBody: true, attemptedAt: "2026-09-10T00:00:00Z" }),
    "body_not_sent",
    "vet402",
  ],
  [
    "宣言本文を送る前の POST 422（本文を宣言）",
    row({ status: "settle_failed", httpStatusPaid: 422, method: "post", declaresBody: true, attemptedAt: "2026-09-16T23:25:54Z" }),
    "body_not_sent",
    "vet402",
  ],
  ["over_cap", row({ status: "over_cap", network: null }), "vet402_limit", "vet402"],
  ["budget_denied", row({ status: "budget_denied" }), "vet402_limit", "vet402"],
  ["halted", row({ status: "halted" }), "vet402_limit", "vet402"],
  ["request_error", row({ status: "request_error", network: null }), "vet402_error", "vet402"],
  ["in_flight", row({ status: "in_flight" }), "vet402_error", "vet402"],
  ["settle_claimed（照合待ち・失敗でも delivered でもない）", row({ status: "settle_claimed", httpStatusPaid: 200, txHash: TX }), null, "pending"],
  // seller の側
  ["期間外の 402（根拠がそろった行）", proven({ status: "settle_failed", httpStatusPaid: 402, attemptedAt: "2026-09-20T00:00:00Z" }), "payment_refused", "seller"],
  [
    "Solana の期間内 402 は残高切れではないが、関門より前で残高を示せない（2026-09-29 第2巡）",
    proven({ status: "settle_failed", httpStatusPaid: 402, attemptedAt: "2026-09-14T00:00:00Z", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", payer: "34CMQ3HB3aDWPxwAbLSbQPrBtrFhi354zAsfbb3z5v2z" }),
    "funds_unproven",
    "unsorted",
  ],
  ["期間外の 500（根拠がそろった行）", proven({ status: "settle_failed", httpStatusPaid: 500 }), "server_error_paid", "seller"],
  ["期間外の 500・送った入力の記録なし（2026-09-29 第2巡）", { ...proven({ status: "settle_failed", httpStatusPaid: 500 }), meta: null }, "input_unrecorded", "unsorted"],
  ["settled 502", proven({ status: "settled", httpStatusPaid: 502, txHash: TX }), "server_error_paid", "seller"],
  [
    "関門より前・残高を組み直して価格未満（agentsonly.vip 2026-09-12 18:02・1.0 USDC・残高約 0.18）",
    proven({ status: "settle_failed", httpStatusPaid: 502, attemptedAt: "2026-09-12T18:02:18Z", amountUnits: "1000000" }),
    "payer_short",
    "vet402",
  ],
  [
    "関門より前・残高を組み直して価格以上（同じ時刻の 0.01 USDC）",
    proven({ status: "settle_failed", httpStatusPaid: 502, attemptedAt: "2026-09-12T18:02:18Z", amountUnits: "10000" }),
    "server_error_paid",
    "seller",
  ],
  [
    "宣言したヘッダを送っていない 5xx（400/422 以外）は not sorted",
    proven({ status: "settle_failed", httpStatusPaid: 503, declaresHeaders: true }),
    "input_not_sent",
    "unsorted",
  ],
  [
    "宣言クエリを使わなかった（refused）402",
    proven({ status: "settle_failed", httpStatusPaid: 402, meta: { requestBody: "none", requestQuery: "refused" } }),
    "input_not_sent",
    "unsorted",
  ],
  [
    "宣言クエリを足した支払い付きの要求に 402（払った条件が支払い付きの要求の条件と同じだと示せない）",
    proven({ status: "settle_failed", httpStatusPaid: 402, meta: { requestBody: "none", requestQuery: "declared" } }),
    "refused_changed_request",
    "unsorted",
  ],
  [
    "宣言本文を足した POST に 402",
    proven({ status: "settle_failed", httpStatusPaid: 402, method: "POST", meta: { requestBody: "declared", requestQuery: "empty" } }),
    "refused_changed_request",
    "unsorted",
  ],
  [
    "宣言クエリを足した支払い付きの要求に 500 は seller（明示の失敗・入力は送った）",
    proven({ status: "settle_failed", httpStatusPaid: 500, meta: { requestBody: "none", requestQuery: "declared" } }),
    "server_error_paid",
    "seller",
  ],
  ["署名した条件の記録が無い", proven({ status: "settle_failed", httpStatusPaid: 500, amountUnits: null }), "other", "unsorted"],
  ["Base で USDC 以外の資産", proven({ status: "settle_failed", httpStatusPaid: 500, asset: "0xdeadbeef" }), "other", "unsorted"],
  [
    "本文を送った後の POST 400",
    row({ status: "settle_failed", httpStatusPaid: 400, method: "POST", declaresBody: true, bodyRecorded: true, attemptedAt: "2026-09-20T00:00:00Z" }),
    "refused_no_charge",
    "unsorted",
  ],
  [
    "本文を宣言していない POST の 400（送る前でも我々の落ち度とは言えない）",
    row({ status: "settle_failed", httpStatusPaid: 400, method: "POST", declaresBody: false, attemptedAt: "2026-09-10T00:00:00Z" }),
    "refused_no_charge",
    "unsorted",
  ],
  [
    "GET の 422（本文を送らない）",
    row({ status: "settle_failed", httpStatusPaid: 422, method: "GET", declaresBody: true, attemptedAt: "2026-09-10T00:00:00Z" }),
    "refused_no_charge",
    "unsorted",
  ],
  [
    "決済された POST 400 でも、本文を宣言した出品に {} を送った期間なら vet402 の側（レビュー 2026-09-28）",
    row({ status: "settled", httpStatusPaid: 400, txHash: TX, method: "POST", declaresBody: true, attemptedAt: "2026-09-10T00:00:00Z" }),
    "body_not_sent",
    "vet402",
  ],
  [
    "決済された POST 400・本文を宣言していない出品は seller（決済してから入力を断った）",
    row({ status: "settled", httpStatusPaid: 400, txHash: TX, method: "POST", declaresBody: false, attemptedAt: "2026-09-10T00:00:00Z" }),
    "settled_then_rejected",
    "unsorted",
  ],
  // クエリ（Base で宣言クエリを送り始めたのは 2026-09-27T23:27:16Z）
  [
    "Base の GET 400・クエリを宣言・送る前",
    row({ status: "settle_failed", httpStatusPaid: 400, declaresQuery: true, attemptedAt: "2026-09-27T23:27:15Z" }),
    "query_not_sent",
    "vet402",
  ],
  [
    "Base の GET 422・決済済み・クエリを宣言・送る前",
    row({ status: "settled", httpStatusPaid: 422, txHash: TX, declaresQuery: true, attemptedAt: "2026-09-20T00:00:00Z" }),
    "query_not_sent",
    "vet402",
  ],
  [
    "Base の GET 400・クエリを宣言・境界の時刻（送った後）",
    row({ status: "settle_failed", httpStatusPaid: 400, declaresQuery: true, attemptedAt: "2026-09-27T23:27:16Z" }),
    "refused_no_charge",
    "unsorted",
  ],
  [
    "Base の GET 400・クエリの記録あり",
    row({ status: "settle_failed", httpStatusPaid: 400, declaresQuery: true, queryRecorded: true, attemptedAt: "2026-09-20T00:00:00Z" }),
    "refused_no_charge",
    "unsorted",
  ],
  [
    "Base の GET 400・クエリを宣言していない",
    row({ status: "settle_failed", httpStatusPaid: 400, declaresQuery: false, attemptedAt: "2026-09-20T00:00:00Z" }),
    "refused_no_charge",
    "unsorted",
  ],
  [
    "Base の GET 400・任意のクエリだけ（required が空）はこちらの落ち度にしない（共有の判定）",
    row({ status: "settle_failed", httpStatusPaid: 400, optionalQueryOnly: true, attemptedAt: "2026-09-20T00:00:00Z" }),
    "refused_no_charge",
    "unsorted",
  ],
  [
    "Base の GET 400・必須のクエリ・記録が empty（送っていない）は vet402 の側（共有の判定）",
    row({ status: "settle_failed", httpStatusPaid: 400, declaresQuery: true, meta: { requestQuery: "empty" }, attemptedAt: "2026-09-21T00:00:00Z" }),
    "query_not_sent",
    "vet402",
  ],
  [
    "Base の GET 401・クエリを宣言（400/422 だけが対象）",
    row({ status: "settle_failed", httpStatusPaid: 401, declaresQuery: true, attemptedAt: "2026-09-20T00:00:00Z" }),
    "refused_no_charge",
    "unsorted",
  ],
  [
    "Solana の 400・クエリを宣言（Base の境目は Base だけ）",
    row({ status: "settle_failed", httpStatusPaid: 400, declaresQuery: true, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", attemptedAt: "2026-09-20T00:00:00Z" }),
    "refused_no_charge",
    "unsorted",
  ],
  ["settled 404", row({ status: "settled", httpStatusPaid: 404, txHash: TX }), "settled_then_rejected", "unsorted"],
  ["settled 422", row({ status: "settled", httpStatusPaid: 422, txHash: TX }), "settled_then_rejected", "unsorted"],
  ["settle_failed 415", row({ status: "settle_failed", httpStatusPaid: 415 }), "refused_no_charge", "unsorted"],
  ["settle_failed 401", row({ status: "settle_failed", httpStatusPaid: 401 }), "refused_no_charge", "unsorted"],
  ["settled 403", row({ status: "settled", httpStatusPaid: 403, txHash: TX }), "settled_then_refused", "unsorted"],
  ["settle_failed 405", row({ status: "settle_failed", httpStatusPaid: 405 }), "refused_no_charge", "unsorted"],
  ["settle_failed 429", row({ status: "settle_failed", httpStatusPaid: 429 }), "refused_no_charge", "unsorted"],
  ["settle_failed HTTP なし・出品の maxTimeoutSeconds が待ち時間以下", proven({ status: "settle_failed", httpStatusPaid: null }), "no_response_paid", "seller"],
  [
    "settle_failed HTTP なし・出品の maxTimeoutSeconds が待ち時間より長い（anansidata.xyz の 300）",
    proven({ status: "settle_failed", httpStatusPaid: null, listingMaxTimeoutSeconds: 300 }),
    "stopped_waiting",
    "unsorted",
  ],
  ["settle_failed HTTP なし・出品の maxTimeoutSeconds が読めない", proven({ status: "settle_failed", httpStatusPaid: null, listingMaxTimeoutSeconds: null }), "stopped_waiting", "unsorted"],
  ["settled HTTP なし（遅延回収・打ち切りの後に着金）", proven({ status: "settled", httpStatusPaid: null, txHash: TX }), "stopped_waiting", "unsorted"],
  ["settle_failed 408（tx なし）は課金なし", proven({ status: "settle_failed", httpStatusPaid: 408 }), "refused_no_charge", "unsorted"],
  ["settle_failed 201", row({ status: "settle_failed", httpStatusPaid: 201 }), "answered_no_charge", "unsorted"],
  ["delivered_no_receipt", row({ status: "delivered_no_receipt", httpStatusPaid: 200 }), "answered_no_charge", "unsorted"],
  ["delivered_no_receipt・tx あり（課金なしではない）", proven({ status: "delivered_no_receipt", httpStatusPaid: 200, txHash: TX }), "no_receipt", "seller"],
  ["settle_claim_refuted", proven({ status: "settle_claim_refuted", httpStatusPaid: 200, txHash: TX }), "claim_refuted", "seller"],
  ["settle_claimed_unverifiable", proven({ status: "settle_claimed_unverifiable", httpStatusPaid: 200, txHash: "nope" }), "claim_malformed", "seller"],
  // 署名していない（not bought・L1 の結果ではない・2026-09-29 第2巡）
  ["no_402 404", row({ status: "no_402", network: null, unpaidStatus: 404 }), "gone", "not_bought"],
  ["no_402 410", row({ status: "no_402", network: null, unpaidStatus: 410 }), "gone", "not_bought"],
  ["no_402 200", row({ status: "no_402", network: null, unpaidStatus: 200 }), "free_200", "not_bought"],
  ["no_402 530", row({ status: "no_402", network: null, unpaidStatus: 530 }), "down", "not_bought"],
  ["no_402 403", row({ status: "no_402", network: null, unpaidStatus: 403 }), "unpaid_auth", "not_bought"],
  ["no_402 405", row({ status: "no_402", network: null, unpaidStatus: 405 }), "unpaid_wrong_method", "not_bought"],
  ["no_402 429", row({ status: "no_402", network: null, unpaidStatus: 429 }), "unpaid_rate_limited", "not_bought"],
  ["no_402 400", row({ status: "no_402", network: null, unpaidStatus: 400 }), "no_402", "not_bought"],
  ["no_402 ステータス不明", row({ status: "no_402", network: null, unpaidStatus: null }), "no_402", "not_bought"],
  ["no_eligible_accept（upto だけの 402 など）", row({ status: "no_eligible_accept", network: null }), "no_accept", "not_bought"],
  ["price_mismatch", row({ status: "price_mismatch", network: null }), "price_mismatch", "not_bought"],
  ["payto_mismatch", row({ status: "payto_mismatch", network: null }), "payto_mismatch", "not_bought"],
  // unsorted
  ["settled 307", proven({ status: "settled", httpStatusPaid: 307, txHash: TX }), "other", "unsorted"],
  ["settled 409", row({ status: "settled", httpStatusPaid: 409, txHash: TX }), "settled_then_refused", "unsorted"],
  ["語彙に無い status", row({ status: "something_new" }), "other", "unsorted"],
];

test("既知の失敗は、決まった種類と側に入る", () => {
  for (const [label, r, key, side] of KNOWN) {
    const c = classifyRow(r);
    assert.equal(c.mode?.key ?? null, key, `${label}: 種類`);
    assert.equal(c.bucket, side, `${label}: 側`);
      if (c.mode) assert.equal(c.mode.side, c.bucket, `${label}: bucket は mode.side と同じ`);
  }
});

test("vet402 の側の失敗は seller 側に入らない（残高切れ・本文を送っていなかった期間）", () => {
  const ours = KNOWN.filter(([, , key]) => key === "payer_unfunded" || key === "body_not_sent");
  assert.ok(ours.length >= 4);
  for (const [label, r] of ours) assert.equal(classifyRow(r).bucket, "vet402", label);
  // 残高切れの判定は delivery.ts の heldReasonOf（export の held_reason）と同じ
  for (const [, r, key] of KNOWN) {
    const held = heldReasonOf({ status: r.status, httpStatusPaid: r.httpStatusPaid, txHash: r.txHash, attemptedAt: r.attemptedAt, network: r.network });
    assert.equal(held === "payer_unfunded", key === "payer_unfunded");
  }
});

test("body_not_sent の境界: 時刻・POST・記録なし・宣言あり・400/422（retest の (b) に決済済みを足したもの）", () => {
  const base = row({ status: "settle_failed", httpStatusPaid: 400, method: "POST", declaresBody: true, attemptedAt: "2026-09-16T23:25:54Z" });
  assert.equal(isBodyNotSent(base), true);
  assert.equal(isBodyNotSent({ ...base, attemptedAt: DECLARED_BODY_SENT_SINCE }), false, "境界の時刻は含まない");
  assert.equal(isBodyNotSent({ ...base, method: "GET" }), false);
  assert.equal(isBodyNotSent({ ...base, meta: { requestBody: "empty" } }), false);
  assert.equal(isBodyNotSent({ ...base, schema: null }), false);
  assert.equal(isBodyNotSent({ ...base, txHash: TX }), false);
  assert.equal(isBodyNotSent({ ...base, httpStatusPaid: 401 }), false);
  // retest の (b) は tx の無い settle_failed だけを買い直すが、/sellers は決済済みの行もこちらの側に置く
  assert.equal(isBodyNotSent({ ...base, status: "settled", txHash: TX }), true);
  assert.equal(isBodyNotSent({ ...base, status: "delivered_no_receipt" }), false);
});

test("分類表: 鍵が重複せず、文言が空でなく、vet402 の側は売り手に直させない", () => {
  const keys = FIX_MODES.map((m) => m.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const m of FIX_MODES) {
    assert.ok(m.title && m.what && m.fix, m.key);
    if (m.side === "vet402") assert.match(m.fix, /^Nothing for the seller to fix\./, m.key);
  }
  // 2026-09-29: 売り手の側に数えない種類（保留 2・課金なし 2・vet402 に落ち度が無いと示せない 5）と未分類 1
  assert.deepEqual(
    FIX_MODES.filter((m) => m.side === "unsorted").map((m) => m.key).sort(),
    [
      "answered_no_charge",
      "funds_unproven",
      "input_not_sent",
      "input_unrecorded",
      "other",
      "refused_changed_request",
      "refused_no_charge",
      "settled_then_refused",
      "settled_then_rejected",
      "stopped_waiting",
    ],
  );
  // 署名しなかった行は「vet402 did not pay」とだけ書き、売り手に作り替えを求めない（2026-09-29 第2巡: 「exact を出せ」）
  for (const m of FIX_MODES.filter((x) => x.side === "not_bought")) {
    assert.match(m.fix, /^Nothing is counted against the seller: vet402 did not pay/, m.key);
    assert.match(m.title, /^Not bought: /, m.key);
  }
  assert.doesNotMatch(FIX_MODES.map((m) => m.fix).join("\n"), /Offer an exact accept/);
  assert.equal(fixMode("no-such-key").key, "other");
});

function latest(host: string, r: SellerRowFacts): LatestRow {
  return { ...r, host };
}

test("集計: 種類ごとの合計 = 届かなかった出品、出品の内訳の合計 = 出品数", () => {
  const rows: LatestRow[] = KNOWN.map(([, r], i) => latest(`h${i % 7}.example`, r));
  const hosts = Array.from({ length: 7 }, (_, i) => ({ host: `h${i}.example`, listings: 20 }));
  hosts.push({ host: "never-bought.example", listings: 3 });
  const board = buildSellerBoard(hosts, rows, "2026-09-28T00:00:00.000Z");
  const failed = board.totals.seller + board.totals.vet402 + board.totals.unsorted;
  const grouped = board.groups.reduce((a, g) => a + g.listings, 0);
  assert.equal(grouped, failed + board.totals.notPaid, "groups add up to the failures and the not-bought rows");
  // 失敗 + 払わなかった + 照合待ち + delivered = 試した出品（照合待ちは種類の束に入らない）
  assert.equal(board.totals.delivered + board.totals.pending + failed + board.totals.notPaid, KNOWN.length);
  assert.equal(board.totals.notPaid, KNOWN.filter(([, , , side]) => side === "not_bought").length);
  assert.equal(board.totals.delivered, KNOWN.filter(([, , , side]) => side === "delivered").length);
  assert.equal(board.totals.pending, KNOWN.filter(([, , , side]) => side === "pending").length);
  assert.ok(board.totals.pending >= 1);
  assert.ok(!board.groups.some((g) => Object.keys(g.statuses).includes("settle_claimed")), "fix-first never groups a pending row");
  assert.equal(board.totals.listings, 7 * 20 + 3);
  assert.equal(board.totals.notTried, board.totals.listings - KNOWN.length);
  for (const s of board.sellers) {
    assert.equal(s.delivered + s.pending + s.seller + s.vet402 + s.unsorted + s.notPaid + s.notTried, s.listings, s.host);
  }
  for (const g of board.groups) {
    assert.equal(g.sellers.reduce((a, s) => a + s.listings, 0), g.listings, g.key);
    assert.equal(Object.values(g.statuses).reduce((a, b) => a + b, 0), g.listings, g.key);
  }
  // 並び: seller の側 → vet402 → unsorted
  const sides = board.groups.map((g) => g.side);
  const order = { seller: 0, vet402: 1, unsorted: 2, not_bought: 3 } as const;
  for (let i = 1; i < sides.length; i++) assert.ok(order[sides[i - 1]] <= order[sides[i]]);
  // まだ買っていない売り手は一覧の末尾
  assert.equal(board.sellers.at(-1)?.host, "never-bought.example");
  assert.equal(board.totals.sellersTried, 7);
});

test("集計: カタログに無いホストの行は数えない", () => {
  const board = buildSellerBoard([{ host: "a.example", listings: 1 }], [latest("gone.example", row({ status: "settled", httpStatusPaid: 200, txHash: TX }))], "t");
  assert.equal(board.totals.delivered, 0);
  assert.equal(board.groups.length, 0);
});

test("rebuyEligible: retest の SQL がこの売り手のこの行を選び、その行がこちらの側のときだけ（旗 off＝null なら書かない）", () => {
  const unfunded = row({ endpointId: "e1", status: "settle_failed", httpStatusPaid: 402, attemptedAt: "2026-09-14T00:00:00Z" });
  const laterSeller = proven({ endpointId: "e2", status: "settle_failed", httpStatusPaid: 500, attemptedAt: "2026-09-20T00:00:00Z" });
  const one = [{ host: "s.example", listings: 2 }];
  // 旗 off（retest の結果なし）: こちらの側の失敗でも rebuyEligible にしない
  assert.equal(buildSellerBoard(one, [latest("s.example", unfunded)], "t", null).sellers[0].rebuyEligible, false);
  // retest がこの売り手のこの行を選んだ
  const b1 = buildSellerBoard(one, [latest("s.example", unfunded)], "t", new Map([["s.example", { endpointId: "e1", reason: "unfunded" }]]));
  assert.equal(b1.sellers[0].rebuyEligible, true);
  assert.equal(b1.sellers[0].rebuyEndpointId, "e1");
  // retest が別の行を選んだ（全チェーンの最新行が別）: 食い違うので書かない
  assert.equal(buildSellerBoard(one, [latest("s.example", unfunded)], "t", new Map([["s.example", { endpointId: "other", reason: "unfunded" }]])).sellers[0].rebuyEligible, false);
  // 同じ行でも理由が違う（retest は別チェーンの行を「本文」で選んだ）: 書かない
  assert.equal(buildSellerBoard(one, [latest("s.example", unfunded)], "t", new Map([["s.example", { endpointId: "e1", reason: "body" }]])).sellers[0].rebuyEligible, false);
  // retest がこの売り手を選んでいない
  assert.equal(buildSellerBoard(one, [latest("s.example", unfunded)], "t", new Map([["x.example", { endpointId: "e1", reason: "unfunded" }]])).sellers[0].rebuyEligible, false);
  // この頁の最新の行が seller の側
  const b2 = buildSellerBoard(one, [latest("s.example", unfunded), latest("s.example", laterSeller)], "t", new Map([["s.example", { endpointId: "e2", reason: "unfunded" }]]));
  assert.equal(b2.sellers[0].rebuyEligible, false, "the page's latest row is on the seller's side");
  // 価格の上限はこちらの側でも買い直しの理由ではない
  const over = row({ endpointId: "e3", status: "over_cap", attemptedAt: "2026-09-21T00:00:00Z" });
  assert.equal(buildSellerBoard([{ host: "s.example", listings: 1 }], [latest("s.example", over)], "t", new Map([["s.example", { endpointId: "e3", reason: "unfunded" }]])).sellers[0].rebuyEligible, false);
});

test("1 売り手: 最新の行で数え、届いた後の行に「直った」とは書かず事実だけ持つ", () => {
  const eps = [
    { endpointId: "e1", resourceKey: "s.example/a", resourceUrl: "https://s.example/a", method: "POST", priceAmount: "1000" },
    { endpointId: "e2", resourceKey: "s.example:8443/b", resourceUrl: "https://s.example:8443/b", method: "GET", priceAmount: "1000" },
    { endpointId: "e3", resourceKey: "s.example/c", resourceUrl: "https://s.example/c", method: "GET", priceAmount: "1000" },
  ];
  const rows = [
    row({ endpointId: "e1", status: "settle_failed", httpStatusPaid: 402, attemptedAt: "2026-09-14T00:00:00Z" }),
    row({ endpointId: "e1", status: "settled", httpStatusPaid: 200, txHash: TX, attemptedAt: "2026-09-28T12:00:00Z", selection: "retest" }),
    row({ endpointId: "e2", status: "no_402", network: null, unpaidStatus: 404, attemptedAt: "2026-09-27T00:00:00Z", selection: "census" }),
  ];
  const d = buildSellerDetail("s.example", eps, rows, "2026-09-28T13:00:00.000Z");
  assert.equal(d.summary.listings, 3);
  assert.equal(d.summary.delivered, 1);
  assert.equal(d.summary.seller, 0);
  assert.equal(d.summary.notPaid, 1, "the no_402 row is not a purchase");
  assert.equal(d.summary.notTried, 1);
  assert.equal(d.listings[0].endpointId, "e1", "most recent purchase first");
  assert.equal(d.listings[0].deliveredAfterFailure, true);
  assert.equal(d.listings[0].earlier.length, 1);
  assert.equal(d.listings[0].earlier[0].mode?.key, "payer_unfunded");
  assert.equal(d.listings[0].latest?.txUrl, `https://basescan.org/tx/${TX}`);
  assert.equal(d.listings[2].latest, null);
  assert.deepEqual(d.selectedBy, { census: 1, retest: 1 });
  assert.equal(d.listings[1].latest?.inExport, true);
});

test("export の窓: 行が入る最小の days、366 日を超えたら null", () => {
  const now = Date.parse("2026-09-28T12:00:00Z");
  assert.equal(exportDaysFor("2026-09-28T11:00:00Z", now), 2);
  assert.equal(exportDaysFor("2026-09-20T12:00:00Z", now), 9);
  assert.equal(exportDaysFor("2025-01-01T00:00:00Z", now), null);
});

test("売り手の単位は census と同じ規則（小文字・ポートを落とす）", () => {
  for (const h of ["API.Verigrace.com:4449", "api.verigrace.com:4450", "x.example", "X.EXAMPLE:80", "a:b:1"]) {
    assert.equal(sellerHostOf(h), censusHostOf(h), h);
  }
  assert.equal(sellerHostOfResourceKey("api.verigrace.com:4451/v1/x"), "api.verigrace.com");
});

test("URL の [host] は DB の前に落とす", () => {
  assert.equal(parseSellerHostParam("api.example.com"), "api.example.com");
  assert.equal(parseSellerHostParam("API.Example.com:8443"), "api.example.com");
  assert.equal(parseSellerHostParam("%E0%A4%A"), null);
  assert.equal(parseSellerHostParam("a b"), null);
  assert.equal(parseSellerHostParam("x'; drop table"), null);
  assert.equal(parseSellerHostParam("a..b"), null);
  assert.equal(parseSellerHostParam("-a.com"), null);
  assert.equal(parseSellerHostParam("a".repeat(254)), null);
});

test("検索: URL を貼っても、完全一致を先に・部分一致を後に", () => {
  const board = buildSellerBoard(
    [
      { host: "api.example.com", listings: 1 },
      { host: "api.example.com.evil", listings: 1 },
      { host: "other.dev", listings: 1 },
    ],
    [],
    "t",
  );
  const r = searchSellers(board.sellers, "https://API.example.com:443/path?x=1");
  assert.equal(r.exact?.host, "api.example.com");
  assert.deepEqual(r.matches.map((s) => s.host), ["api.example.com.evil"]);
  assert.deepEqual(searchSellers(board.sellers, "   ").matches, []);
});

test("決済してから入力を断った行: 事実の言い方で、保留（売り手に数えない）", () => {
  const m = fixMode("settled_then_rejected");
  assert.equal(classifyRow(row({ status: "settled", httpStatusPaid: 400, txHash: TX, method: "POST", declaresBody: true, attemptedAt: "2026-09-10T00:00:00Z" })).bucket, "vet402");
  assert.equal(m.side, "unsorted");
  assert.equal(m.title, "Payment settled, then the input was rejected");
  assert.equal(m.sideLabel, "not sorted (held)");
  assert.match(m.what, /held_reason settled_4xx/);
  assert.match(m.fix, /^Nothing is counted against the seller\./);
  // 非難の響きの語を使わない（2026-09-29 敵対的監査）
  const all = FIX_MODES.map((x) => `${x.title} ${x.what} ${x.fix}`).join("\n");
  assert.doesNotMatch(all, /Took the payment|took the payment before|refused the input/);
  const before = row({ status: "settled", httpStatusPaid: 400, txHash: TX, method: "POST", declaresBody: false, attemptedAt: "2026-09-10T00:00:00Z" });
  assert.equal(classifyRow(before).mode?.key, "settled_then_rejected");
  assert.match(rowNote(before, "settled_then_rejected") ?? "", /when vet402 sent an empty JSON body on paid POST requests; this listing declares no body/);
  assert.match(rowNote({ ...before, status: "settle_failed", txHash: null }, "refused_no_charge") ?? "", /empty JSON body/);
  assert.equal(rowNote({ ...before, attemptedAt: DECLARED_BODY_SENT_SINCE }, "settled_then_rejected"), null, "after the cutover");
  assert.equal(rowNote({ ...before, meta: { requestBody: "empty" } }, "settled_then_rejected"), null, "a body was recorded");
  assert.equal(rowNote({ ...before, method: "GET" }, "settled_then_rejected"), null, "GET sends no body");
  assert.equal(rowNote(before, "server_error_paid"), null);
});

test("DECLARED_BODY_SENT_SINCE の値は request-body.ts の 1 か所だけ（retest と /sellers が同じ値を読む）", () => {
  assert.equal(RUNNER_SINCE, CANON_SINCE);
  assert.equal(DECLARED_BODY_SENT_SINCE, CANON_SINCE);
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e)) files.push(p);
    }
  };
  walk(join(process.cwd(), "src"));
  const holders = files.filter((f) => readFileSync(f, "utf8").includes(`"${CANON_SINCE}"`)).map((f) => f.slice(process.cwd().length + 1));
  assert.deepEqual(holders, ["src/lib/observatory/request-body.ts"]);
});

test("BASE_DECLARED_QUERY_SINCE の値は request-query.ts の 1 か所だけ（/sellers はそこから読む）", async () => {
  const { BASE_DECLARED_QUERY_SINCE: CANON_Q } = await import("@/lib/observatory/request-query");
  const { BASE_DECLARED_QUERY_SINCE: FROM_MODES } = await import("@/lib/sellers/fix-modes");
  assert.equal(FROM_MODES, CANON_Q);
  assert.equal(CANON_Q, "2026-09-27T23:27:16Z");
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e)) files.push(p);
    }
  };
  walk(join(process.cwd(), "src"));
  const holders = files.filter((f) => readFileSync(f, "utf8").includes(`"${CANON_Q}"`)).map((f) => f.slice(process.cwd().length + 1));
  assert.deepEqual(holders, ["src/lib/observatory/request-query.ts"]);
});

test("文面: 本文とクエリの送り始めを分けて書き、「宣言どおり送る」を無条件に言わない", () => {
  const all = FIX_MODES.map((m) => `${m.what} ${m.fix}`).join("\n");
  assert.doesNotMatch(all, /vet402 sends the body and query the listing declares/);
  assert.match(fixMode("refused_no_charge").what, /Since 2026-09-16 23:25 UTC vet402 sends the request body the seller's 402 declares/);
  assert.match(fixMode("refused_no_charge").what, /since 2026-09-27 23:27 UTC it adds the query parameters the seller's 402 declares on Base/);
  assert.doesNotMatch(all, /query parameters the listing declares|request body the listing declares/);
  assert.match(fixMode("query_not_sent").what, /Before 2026-09-27 23:27 UTC/);
});

test("/sellers の本文・クエリの判定は共有の判定（request-body.ts / request-query.ts）そのもの", async () => {
  const { bodyNotSentOnOurSide } = await import("@/lib/observatory/request-body");
  const { queryNotSentOnOurSide } = await import("@/lib/observatory/request-query");
  const { notSentInput } = await import("@/lib/sellers/fix-modes");
  // 決済されなかった行では、/sellers の判定と共有の判定が行ごとに同じ答えを出す
  for (const [label, r] of KNOWN) {
    if (r.status === "settled") continue;
    assert.equal(isBodyNotSent(r), bodyNotSentOnOurSide(notSentInput(r)), `${label}: body`);
    assert.equal(classifyRow(r).mode?.key === "query_not_sent", queryNotSentOnOurSide(notSentInput(r)), `${label}: query`);
  }
  // fix-modes.ts は境目の時刻や 400/422 を自分で持たない
  const src = readFileSync(join(process.cwd(), "src/lib/sellers/fix-modes.ts"), "utf8");
  assert.doesNotMatch(src, /2026-09-16T23:25:55Z|2026-09-27T23:27:16Z/);
  assert.doesNotMatch(src, /=== 400 \|\| r\.httpStatusPaid === 422|\[400, 422\]/);
});

test("照合待ち（settle_claimed）は分類表に無く、失敗の種類にならない", () => {
  assert.ok(!FIX_MODES.some((m) => m.key === "settlement_pending"));
  const c = classifyRow(row({ status: "settle_claimed", httpStatusPaid: 400, txHash: TX }));
  assert.equal(c.bucket, "pending");
  assert.equal(c.mode, null);
});

test("任意のクエリだけの出品（Base・境目より前）には、こちらがクエリを足していなかった注記が付く（課金なしなので売り手に数えない）", () => {
  const opt = row({ status: "settle_failed", httpStatusPaid: 404, optionalQueryOnly: true, attemptedAt: "2026-09-20T00:00:00Z" });
  const c = classifyRow(opt);
  assert.equal(c.bucket, "unsorted");
  assert.equal(c.mode?.key, "refused_no_charge");
  assert.equal(rowNote(opt, c.mode!.key), "Before 2026-09-27 23:27 UTC, vet402 did not add query parameters to paid requests on Base; this listing declares optional ones.");
  assert.equal(rowNote({ ...opt, attemptedAt: "2026-09-27T23:27:16Z" }, "refused_no_charge"), null, "after the Base query cutover");
  assert.equal(rowNote({ ...opt, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }, "refused_no_charge"), null, "Base only");
  assert.equal(rowNote({ ...opt, meta: { requestQuery: "declared" } }, "refused_no_charge"), null, "query was sent");
  assert.equal(rowNote(row({ status: "settle_failed", httpStatusPaid: 400, attemptedAt: "2026-09-20T00:00:00Z" }), "refused_no_charge"), null, "no queryParams at all");
  // 本文と両方当たれば 2 つ並べる
  const both = row({ status: "settled", httpStatusPaid: 400, txHash: TX, method: "POST", optionalQueryOnly: true, attemptedAt: "2026-09-10T00:00:00Z" });
  assert.match(rowNote(both, "settled_then_rejected") ?? "", /declares no body\. Before 2026-09-27 23:27 UTC/);
});

test("文面の時刻は共有の境目の定数と同じ（表示用に分まで）", async () => {
  const { DECLARED_BODY_SENT_SINCE: B } = await import("@/lib/observatory/request-body");
  const { BASE_DECLARED_QUERY_SINCE: Q } = await import("@/lib/observatory/request-query");
  const show = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
  const all = FIX_MODES.map((m) => m.what).join("\n");
  assert.ok(all.includes(show(B)), show(B));
  assert.ok(all.includes(show(Q)), show(Q));
});


// ------------------------------------------------------------
// 2026-09-29 第2巡: seller の側は「vet402 に落ち度が無いと示せる行」だけ（(a)〜(e)）
// ------------------------------------------------------------

test("定数の一致: 署名した status の集合は判定 API と同じ・Base の USDC は署名器と同じ", () => {
  assert.deepEqual([...SIGNED_ROW_STATUSES].sort(), [...SIGNED_STATUSES].sort());
  assert.equal(BASE_USDC_ADDRESS, BASE_USDC);
  assert.equal(PAYER_FUNDS_GATE_SINCE, DECLARED_BODY_SENT_SINCE, "the balance gate shipped in the same Production deploy");
});

test("seller の側の行は (a)〜(e) を全部満たす（KNOWN の全行で evidenceOf を当て直す）", () => {
  for (const [label, r, , side] of KNOWN) {
    if (side !== "seller") continue;
    const ev = evidenceOf(r);
    assert.equal(ev.signed, true, `${label}: (a)`);
    assert.equal(ev.terms, true, `${label}: (b)`);
    assert.equal(ev.funds, "funded", `${label}: (c)`);
    assert.equal(ev.inputs, "sent", `${label}: (d)`);
    assert.notEqual(ev.wait, "cut_short", `${label}: (e)`);
  }
});

test("(c) 残高: 関門の後は funded、関門の前は組み直した残高で funded / short / unknown", () => {
  const at = (attemptedAt: string, amountUnits: string, payer = PAYER, network = "eip155:8453") =>
    payerFundsAtSigning({ network, payer, attemptedAt, amountUnits });
  assert.equal(at(PAYER_FUNDS_GATE_SINCE, "1000000"), "funded");
  assert.equal(at("2026-09-12T18:02:18Z", "1000000"), "short", "agentsonly.vip: 1.0 USDC against about 0.18");
  assert.equal(at("2026-09-12T18:02:18Z", "10000"), "funded");
  assert.equal(at("2026-09-14T00:00:00Z", "1000"), "short", "0.000275 USDC left during the unfunded window");
  assert.equal(at("2026-09-10T00:00:00Z", "1000000"), "funded", "at least 1 USDC outside the low periods");
  assert.equal(at("2026-09-10T00:00:00Z", "1500000"), "unknown", "above the floor the table does not say");
  assert.equal(at("2026-09-12T18:01:10Z", "990000"), "unknown", "the balance crossed the price inside the window");
  assert.equal(at("2026-08-20T00:00:00Z", "10000", "0x6777e11fb0a7917b8110b7dab9188aa3f6d23986"), "funded");
  assert.equal(at("2026-09-10T00:00:00Z", "10000", "0xdead"), "unknown", "a wallet that was not rebuilt");
  assert.equal(at("2026-09-10T00:00:00Z", "10000", PAYER, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"), "unknown");
  assert.equal(at("2026-09-10T00:00:00Z", "abc"), "unknown");
  assert.equal(at("not a time", "10000"), "unknown");
});

test("(d) 入力: 本文とクエリの記録・ヘッダ・パスの全部が要る", () => {
  const ok = proven({ status: "settle_failed", httpStatusPaid: 500 });
  assert.equal(evidenceOf(ok).inputs, "sent");
  assert.equal(evidenceOf({ ...ok, meta: { requestBody: "none" } }).inputs, "unrecorded", "no query record");
  assert.equal(evidenceOf({ ...ok, meta: { requestQuery: "empty" } }).inputs, "unrecorded", "no body record");
  assert.equal(evidenceOf({ ...ok, meta: { requestBody: true, requestQuery: "empty" } }).inputs, "unrecorded", "a body record of unknown kind");
  assert.equal(evidenceOf({ ...ok, declaresHeaders: null }).inputs, "unrecorded");
  assert.deepEqual(evidenceOf({ ...ok, pathTemplate: true }).inputGaps, ["path parameters"]);
  assert.deepEqual(evidenceOf({ ...ok, declaresHeaders: true, meta: { requestBody: "none", requestQuery: "refused" } }).inputGaps, ["query", "headers"]);
  const noteRow = { ...ok, declaresHeaders: true };
  assert.equal(classifyRow(noteRow).mode?.key, "input_not_sent");
  assert.equal(rowNote(noteRow, "input_not_sent"), "Not shown for this row: vet402 did not send the declared headers.");
});

test("(e) 待ち時間: 答えが無い行は、出品の maxTimeoutSeconds が待ち時間以下で着金も無い時だけ", () => {
  const r = proven({ status: "settle_failed", httpStatusPaid: null, listingMaxTimeoutSeconds: 300 });
  assert.equal(evidenceOf(r).wait, "cut_short");
  assert.equal(rowNote(r, "stopped_waiting"), "Not shown for this row: vet402 stopped waiting after 20 seconds (the listing's maxTimeoutSeconds is 300).");
  const landed = proven({ status: "settled", httpStatusPaid: null, txHash: TX, listingMaxTimeoutSeconds: 10 });
  assert.equal(classifyRow(landed).mode?.key, "stopped_waiting");
  assert.match(rowNote(landed, "stopped_waiting") ?? "", /the payment landed on-chain afterwards/);
  // 最初に満たせなかった条件で種類が決まり、注記は満たせなかった条件を全部並べる
  const many = { ...proven({ status: "settle_failed", httpStatusPaid: null, attemptedAt: "2026-09-10T00:00:00Z", listingMaxTimeoutSeconds: 300 }), meta: null };
  assert.equal(classifyRow(many).mode?.key, "input_unrecorded");
  assert.match(rowNote(many, "input_unrecorded") ?? "", /no record of the input it sent; vet402 stopped waiting after 20 seconds/);
});

test("そのとき見た 402: 署名した行は払った条件、署名前に止まった行は 402 の accept（記録済みの範囲）", () => {
  const paid = proven({ status: "settle_failed", httpStatusPaid: 500, amountUnits: "50000", listingMaxTimeoutSeconds: 300 });
  const line = observed402Line(paid) ?? "";
  assert.match(line, /^vet402 signed: exact · 0\.05 USDC · payTo 0x1111…1111\. Input sent: body none, query empty\./);
  assert.match(line, /The listing's maxTimeoutSeconds is 300; vet402 waits 20 seconds for the paid answer\./);
  const upto = row({
    status: "no_eligible_accept",
    network: null,
    challenge: [{ scheme: "upto", network: "eip155:8453", amount: "1000000", asset: BASE_USDC_ADDRESS, payTo: `0x${"22".repeat(20)}`, maxTimeoutSeconds: 300 }],
    declaredAmount: "10000",
    declaredPayTo: `0x${"22".repeat(20)}`,
  });
  assert.equal(
    observed402Line(upto),
    "The 402 offered: upto · eip155:8453 · amount 1000000 · asset 0x8335…2913 · payTo 0x2222…2222 · maxTimeoutSeconds 300. The listing declares price 0.01 · payTo 0x2222…2222.",
  );
  assert.equal(observed402Line(row({ status: "no_402", network: null, unpaidStatus: 404 })), "The unpaid request got HTTP 404, not a 402.");
  assert.equal(observed402Line(row({ status: "over_cap", network: null })), null);
});

test("2026-09-29 独立レビュー（BLOCK）: 本文を宣言した出品へ `{}` を送った行・クエリを宣言した出品へクエリ無しの行は seller の側に置かない", () => {
  const bodyDeclared = {
    ...proven({ status: "settle_failed", httpStatusPaid: 402, attemptedAt: "2026-09-20T00:00:00Z", method: "POST" }),
    meta: { requestBody: "empty", requestQuery: "empty" },
    declaredInput: { query: "empty", body: "declared" },
  } as SellerRowFacts;
  assert.notEqual(classifyRow(bodyDeclared).bucket, "seller");
  const queryDeclared = {
    ...proven({ status: "settle_failed", httpStatusPaid: 500, attemptedAt: "2026-09-28T00:00:00Z" }),
    meta: { requestBody: "none", requestQuery: "empty" },
    declaredInput: { query: "declared", body: "empty" },
  } as SellerRowFacts;
  assert.notEqual(classifyRow(queryDeclared).bucket, "seller");
});
