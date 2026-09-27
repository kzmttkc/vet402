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
  classifyRow,
  DECLARED_BODY_SENT_SINCE,
  FIX_MODES,
  fixMode,
  isBodyNotSent,
  rowNote,
  type SellerRowFacts,
} from "@/lib/sellers/fix-modes";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DECLARED_BODY_SENT_SINCE as RUNNER_SINCE } from "@/lib/observatory/l1-runner";
import { DECLARED_BODY_SENT_SINCE as CANON_SINCE } from "@/lib/observatory/request-body";
import { buildSellerBoard, buildSellerDetail, exportDaysFor, searchSellers, type LatestRow } from "@/lib/sellers/board";
import { parseSellerHostParam, sellerHostOf, sellerHostOfResourceKey } from "@/lib/sellers/host";
import { censusHostOf } from "@/lib/observatory/l1-runner";
import { heldReasonOf } from "@/lib/observatory/delivery";

let seq = 0;
function row(p: Partial<SellerRowFacts>): SellerRowFacts {
  seq++;
  return {
    endpointId: p.endpointId ?? `ep-${seq}`,
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
const TX = `0x${"ab".repeat(32)}`;

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
  ["settle_claimed（照合待ち）", row({ status: "settle_claimed", httpStatusPaid: 200, txHash: TX }), "settlement_pending", "vet402"],
  // seller の側
  ["期間外の 402", row({ status: "settle_failed", httpStatusPaid: 402, attemptedAt: "2026-09-20T00:00:00Z" }), "payment_refused", "seller"],
  ["Solana の期間内 402 は残高切れではない", row({ status: "settle_failed", httpStatusPaid: 402, attemptedAt: "2026-09-14T00:00:00Z", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }), "payment_refused", "seller"],
  ["期間外の 500", row({ status: "settle_failed", httpStatusPaid: 500 }), "server_error_paid", "seller"],
  ["settled 502", row({ status: "settled", httpStatusPaid: 502, txHash: TX }), "server_error_paid", "seller"],
  [
    "本文を送った後の POST 400",
    row({ status: "settle_failed", httpStatusPaid: 400, method: "POST", declaresBody: true, bodyRecorded: true, attemptedAt: "2026-09-20T00:00:00Z" }),
    "input_rejected",
    "seller",
  ],
  [
    "本文を宣言していない POST の 400（送る前でも我々の落ち度とは言えない）",
    row({ status: "settle_failed", httpStatusPaid: 400, method: "POST", declaresBody: false, attemptedAt: "2026-09-10T00:00:00Z" }),
    "input_rejected",
    "seller",
  ],
  [
    "GET の 422（本文を送らない）",
    row({ status: "settle_failed", httpStatusPaid: 422, method: "GET", declaresBody: true, attemptedAt: "2026-09-10T00:00:00Z" }),
    "input_rejected",
    "seller",
  ],
  [
    "決済された POST 400 は retest と同じく我々の側にしない（決済してから入力を断った）",
    row({ status: "settled", httpStatusPaid: 400, txHash: TX, method: "POST", declaresBody: true, attemptedAt: "2026-09-10T00:00:00Z" }),
    "settled_then_rejected",
    "seller",
  ],
  ["settled 404", row({ status: "settled", httpStatusPaid: 404, txHash: TX }), "settled_then_rejected", "seller"],
  ["settled 422", row({ status: "settled", httpStatusPaid: 422, txHash: TX }), "settled_then_rejected", "seller"],
  ["settle_failed 415", row({ status: "settle_failed", httpStatusPaid: 415 }), "input_rejected", "seller"],
  ["settle_failed 401", row({ status: "settle_failed", httpStatusPaid: 401 }), "auth", "seller"],
  ["settled 403", row({ status: "settled", httpStatusPaid: 403, txHash: TX }), "auth", "seller"],
  ["settle_failed 405", row({ status: "settle_failed", httpStatusPaid: 405 }), "wrong_method", "seller"],
  ["settle_failed 429", row({ status: "settle_failed", httpStatusPaid: 429 }), "rate_limited", "seller"],
  ["settle_failed HTTP なし", row({ status: "settle_failed", httpStatusPaid: null }), "no_response_paid", "seller"],
  ["settled HTTP なし（遅延回収）", row({ status: "settled", httpStatusPaid: null, txHash: TX }), "no_response_paid", "seller"],
  ["settle_failed 201", row({ status: "settle_failed", httpStatusPaid: 201 }), "no_receipt", "seller"],
  ["delivered_no_receipt", row({ status: "delivered_no_receipt", httpStatusPaid: 200 }), "no_receipt", "seller"],
  ["settle_claim_refuted", row({ status: "settle_claim_refuted", httpStatusPaid: 200, txHash: TX }), "claim_refuted", "seller"],
  ["settle_claimed_unverifiable", row({ status: "settle_claimed_unverifiable", httpStatusPaid: 200, txHash: "nope" }), "claim_malformed", "seller"],
  ["no_402 404", row({ status: "no_402", network: null, unpaidStatus: 404 }), "gone", "seller"],
  ["no_402 410", row({ status: "no_402", network: null, unpaidStatus: 410 }), "gone", "seller"],
  ["no_402 200", row({ status: "no_402", network: null, unpaidStatus: 200 }), "free_200", "seller"],
  ["no_402 530", row({ status: "no_402", network: null, unpaidStatus: 530 }), "down", "seller"],
  ["no_402 403", row({ status: "no_402", network: null, unpaidStatus: 403 }), "auth", "seller"],
  ["no_402 400", row({ status: "no_402", network: null, unpaidStatus: 400 }), "no_402", "seller"],
  ["no_402 ステータス不明", row({ status: "no_402", network: null, unpaidStatus: null }), "no_402", "seller"],
  ["no_eligible_accept", row({ status: "no_eligible_accept", network: null }), "no_accept", "seller"],
  ["price_mismatch", row({ status: "price_mismatch", network: null }), "price_mismatch", "seller"],
  ["payto_mismatch", row({ status: "payto_mismatch", network: null }), "payto_mismatch", "seller"],
  // unsorted
  ["settled 307", row({ status: "settled", httpStatusPaid: 307, txHash: TX }), "other", "unsorted"],
  ["settled 409", row({ status: "settled", httpStatusPaid: 409, txHash: TX }), "other", "unsorted"],
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

test("body_not_sent は retest の (b) と同じ境界: 時刻・POST・記録なし・宣言あり・tx なし・400/422", () => {
  const base = row({ status: "settle_failed", httpStatusPaid: 400, method: "POST", declaresBody: true, attemptedAt: "2026-09-16T23:25:54Z" });
  assert.equal(isBodyNotSent(base), true);
  assert.equal(isBodyNotSent({ ...base, attemptedAt: DECLARED_BODY_SENT_SINCE }), false, "境界の時刻は含まない");
  assert.equal(isBodyNotSent({ ...base, method: "GET" }), false);
  assert.equal(isBodyNotSent({ ...base, bodyRecorded: true }), false);
  assert.equal(isBodyNotSent({ ...base, declaresBody: false }), false);
  assert.equal(isBodyNotSent({ ...base, txHash: TX }), false);
  assert.equal(isBodyNotSent({ ...base, httpStatusPaid: 401 }), false);
  assert.equal(isBodyNotSent({ ...base, status: "settled" }), false);
});

test("分類表: 鍵が重複せず、文言が空でなく、vet402 の側は売り手に直させない", () => {
  const keys = FIX_MODES.map((m) => m.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const m of FIX_MODES) {
    assert.ok(m.title && m.what && m.fix, m.key);
    if (m.side === "vet402") assert.match(m.fix, /^Nothing for the seller to fix\./, m.key);
  }
  assert.equal(FIX_MODES.filter((m) => m.side === "unsorted").length, 1);
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
  assert.equal(grouped, failed, "groups add up to the failures");
  assert.equal(board.totals.delivered + failed, KNOWN.length);
  assert.equal(board.totals.delivered, KNOWN.filter(([, , k]) => k === null).length);
  assert.equal(board.totals.listings, 7 * 20 + 3);
  assert.equal(board.totals.notBought, board.totals.listings - KNOWN.length);
  for (const s of board.sellers) {
    assert.equal(s.delivered + s.seller + s.vet402 + s.unsorted + s.notBought, s.listings, s.host);
  }
  for (const g of board.groups) {
    assert.equal(g.sellers.reduce((a, s) => a + s.listings, 0), g.listings, g.key);
    assert.equal(Object.values(g.statuses).reduce((a, b) => a + b, 0), g.listings, g.key);
  }
  // 並び: seller の側 → vet402 → unsorted
  const sides = board.groups.map((g) => g.side);
  const order = { seller: 0, vet402: 1, unsorted: 2 } as const;
  for (let i = 1; i < sides.length; i++) assert.ok(order[sides[i - 1]] <= order[sides[i]]);
  // まだ買っていない売り手は一覧の末尾
  assert.equal(board.sellers.at(-1)?.host, "never-bought.example");
  assert.equal(board.totals.sellersBought, 7);
});

test("集計: カタログに無いホストの行は数えない", () => {
  const board = buildSellerBoard([{ host: "a.example", listings: 1 }], [latest("gone.example", row({ status: "settled", httpStatusPaid: 200, txHash: TX }))], "t");
  assert.equal(board.totals.delivered, 0);
  assert.equal(board.groups.length, 0);
});

test("retestDue: 売り手の最新の行が vet402 の側（残高切れ・本文）のときだけ", () => {
  const unfunded = row({ endpointId: "e1", status: "settle_failed", httpStatusPaid: 402, attemptedAt: "2026-09-14T00:00:00Z" });
  const laterSeller = row({ endpointId: "e2", status: "settle_failed", httpStatusPaid: 500, attemptedAt: "2026-09-20T00:00:00Z" });
  const b1 = buildSellerBoard([{ host: "s.example", listings: 2 }], [latest("s.example", unfunded)], "t");
  assert.equal(b1.sellers[0].retestDue, true);
  const b2 = buildSellerBoard([{ host: "s.example", listings: 2 }], [latest("s.example", unfunded), latest("s.example", laterSeller)], "t");
  assert.equal(b2.sellers[0].retestDue, false, "later seller-side failure wins");
  const over = row({ endpointId: "e3", status: "over_cap", attemptedAt: "2026-09-21T00:00:00Z" });
  const b3 = buildSellerBoard([{ host: "s.example", listings: 1 }], [latest("s.example", over)], "t");
  assert.equal(b3.sellers[0].retestDue, false, "our price ceiling is not a retest case");
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
  assert.equal(d.summary.seller, 1);
  assert.equal(d.summary.notBought, 1);
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

test("決済してから入力を断った行: 文面が「決済してから断った」と「こちらが本文を送っていなかった期間」を言う", () => {
  const m = fixMode("settled_then_rejected");
  assert.equal(m.side, "seller");
  assert.match(m.what, /took the payment before it checked the input/);
  assert.match(m.what, /vet402 itself sent an empty JSON body on paid POST requests/);
  assert.match(m.fix, /Check the input before you settle/);
  const before = row({ status: "settled", httpStatusPaid: 400, txHash: TX, method: "POST", declaresBody: true, attemptedAt: "2026-09-10T00:00:00Z" });
  assert.match(rowNote(before, "settled_then_rejected") ?? "", /this listing declares a body, which vet402 did not send/);
  assert.match(rowNote({ ...before, declaresBody: false }, "settled_then_rejected") ?? "", /this listing declares no body/);
  assert.match(rowNote({ ...before, status: "settle_failed", txHash: null }, "input_rejected") ?? "", /empty JSON body/);
  assert.equal(rowNote({ ...before, attemptedAt: DECLARED_BODY_SENT_SINCE }, "settled_then_rejected"), null, "after the cutover");
  assert.equal(rowNote({ ...before, bodyRecorded: true }, "settled_then_rejected"), null, "a body was recorded");
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
