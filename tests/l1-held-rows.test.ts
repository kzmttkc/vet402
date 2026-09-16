// ============================================================
// 売り手の不履行として数えない L1 行（Issue #29・2026-09-17）。
//
// 正典は src/lib/observatory/delivery.ts の heldReasonOf / heldReasonSql。
//   settled_4xx     … settled かつ有料応答 4xx（2026-09-05 からの既存規則）
//   unsettled_4xx   … settle_failed・tx なし・有料応答 4xx（402 以外）。
//                     売り手が決済せずに我々の要求を断った（A）
//   payer_unfunded  … settle_failed・tx なし・402・Base・我々の購入元ウォレットの
//                     USDC が尽きていた期間の内側（C）
// 5xx は救わない。期間の外の 402 は従来どおり売り手の記録。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  heldReasonOf,
  heldReasonSql,
  inconclusivePredicate,
  isInconclusive,
  PAYER_UNFUNDED_WINDOWS,
} from "@/lib/observatory/delivery";
import { assembleSellerFacts, type PurchaseInput } from "@/lib/decision/seller-facts";
import { decidePayer } from "@/lib/decision/rules";

const IN_WINDOW = "2026-09-14T06:00:00Z";
const row = (over: Partial<Parameters<typeof heldReasonOf>[0]> = {}) => ({
  status: "settle_failed",
  httpStatusPaid: 400,
  txHash: null as string | null,
  attemptedAt: "2026-09-12T06:01:26Z" as string | Date | null,
  network: "eip155:8453" as string | null,
  ...over,
});

test("A: settle_failed・tx なし・400 は unsettled_4xx（決済されずに断られた要求は売り手の不履行ではない）", () => {
  assert.equal(heldReasonOf(row()), "unsettled_4xx");
  for (const code of [400, 401, 403, 404, 405, 415, 422, 499]) {
    assert.equal(heldReasonOf(row({ httpStatusPaid: code })), "unsettled_4xx", String(code));
  }
});

test("A の境界: 402 は A に入らない（期間の外の 402 は売り手が支払いを受け付けなかった事実）", () => {
  assert.equal(heldReasonOf(row({ httpStatusPaid: 402 })), null);
});

test("A の境界: 5xx は救わない・tx ありは従来どおり・2xx/null は対象外", () => {
  for (const code of [500, 502, 503]) assert.equal(heldReasonOf(row({ httpStatusPaid: code })), null, String(code));
  assert.equal(heldReasonOf(row({ txHash: "0xabc" })), null, "tx のある settle_failed は A に入れない");
  assert.equal(heldReasonOf(row({ httpStatusPaid: null })), null);
  assert.equal(heldReasonOf(row({ httpStatusPaid: 399 })), null);
  assert.equal(heldReasonOf(row({ httpStatusPaid: 500 - 0 })), null);
});

test("既存: settled かつ 4xx は settled_4xx のまま（5xx・2xx は数える）", () => {
  assert.equal(heldReasonOf(row({ status: "settled", txHash: "0xabc", httpStatusPaid: 400 })), "settled_4xx");
  assert.equal(heldReasonOf(row({ status: "settled", txHash: "0xabc", httpStatusPaid: 402 })), "settled_4xx");
  assert.equal(heldReasonOf(row({ status: "settled", txHash: "0xabc", httpStatusPaid: 500 })), null);
  assert.equal(heldReasonOf(row({ status: "settled", txHash: "0xabc", httpStatusPaid: 200 })), null);
});

test("他の status は対象外（settle_claimed / delivered_no_receipt / settle_claim_refuted）", () => {
  for (const status of ["settle_claimed", "delivered_no_receipt", "settle_claim_refuted", "settle_claimed_unverifiable", "budget_denied"]) {
    assert.equal(heldReasonOf(row({ status })), null, status);
  }
});

test("C: 資金切れ期間の内側の 402（Base・tx なし）は payer_unfunded", () => {
  assert.equal(heldReasonOf(row({ httpStatusPaid: 402, attemptedAt: IN_WINDOW })), "payer_unfunded");
  // Postgres の timestamptz::text 表現でも同じ答え
  assert.equal(heldReasonOf(row({ httpStatusPaid: 402, attemptedAt: "2026-09-14 06:00:00.123456+00" })), "payer_unfunded");
  assert.equal(heldReasonOf(row({ httpStatusPaid: 402, attemptedAt: new Date(IN_WINDOW) })), "payer_unfunded");
  assert.equal(heldReasonOf(row({ httpStatusPaid: 402, attemptedAt: IN_WINDOW, network: "base" })), "payer_unfunded");
});

test("C の境界: 開始は含み、終了（補充後の最初の成立 23:49Z）は含まない", () => {
  const w = PAYER_UNFUNDED_WINDOWS[0];
  assert.equal(w.from, "2026-09-13T00:00:00Z");
  assert.equal(w.until, "2026-09-15T23:49:00Z");
  assert.equal(heldReasonOf(row({ httpStatusPaid: 402, attemptedAt: "2026-09-13T00:00:00Z" })), "payer_unfunded");
  assert.equal(heldReasonOf(row({ httpStatusPaid: 402, attemptedAt: "2026-09-12T23:59:59Z" })), null);
  assert.equal(heldReasonOf(row({ httpStatusPaid: 402, attemptedAt: "2026-09-15T23:48:59Z" })), "payer_unfunded");
  assert.equal(heldReasonOf(row({ httpStatusPaid: 402, attemptedAt: "2026-09-15T23:49:00Z" })), null);
  assert.equal(heldReasonOf(row({ httpStatusPaid: 402, attemptedAt: "2026-09-16T01:00:00Z" })), null);
});

test("C の境界: 期間内でも 5xx・tx あり・Solana・時刻不明は数える側（救わない）", () => {
  assert.equal(heldReasonOf(row({ httpStatusPaid: 500, attemptedAt: IN_WINDOW })), null);
  assert.equal(heldReasonOf(row({ httpStatusPaid: 402, attemptedAt: IN_WINDOW, txHash: "0xabc" })), null);
  assert.equal(
    heldReasonOf(row({ httpStatusPaid: 402, attemptedAt: IN_WINDOW, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" })),
    null,
    "尽きていたのは Base の購入元ウォレットだけ",
  );
  assert.equal(heldReasonOf(row({ httpStatusPaid: 402, attemptedAt: null })), null);
  assert.equal(heldReasonOf(row({ httpStatusPaid: 402, attemptedAt: "not a date" })), null);
});

test("isInconclusive は heldReasonOf が理由を返すときだけ true（入口は 1 つ）", () => {
  assert.equal(isInconclusive(row()), true);
  assert.equal(isInconclusive(row({ httpStatusPaid: 402 })), false);
  assert.equal(isInconclusive(row({ httpStatusPaid: 402, attemptedAt: IN_WINDOW })), true);
  assert.equal(isInconclusive(row({ httpStatusPaid: 503 })), false);
});

test("SQL: 3 つの理由と期間の定数が述語に入り、alias は素の識別子だけ", () => {
  const s = heldReasonSql("p");
  assert.ok(s.includes("'settled_4xx'") && s.includes("'unsettled_4xx'") && s.includes("'payer_unfunded'"));
  assert.ok(s.includes("2026-09-13T00:00:00Z") && s.includes("2026-09-15T23:49:00Z"));
  assert.ok(s.includes("p.tx_hash IS NULL"));
  assert.ok(s.includes("<> 402"));
  assert.ok(inconclusivePredicate("p").includes(heldReasonSql("p")));
  assert.throws(() => heldReasonSql("p; DROP TABLE x"), /plain identifier/);
});

// ------------------------------------------------------------------
// seller-facts と decision rules（BLOCK の分母）
// ------------------------------------------------------------------
const probes = [
  { probedAt: "2026-09-16T00:00:00Z", verdict: "pass", dialect: "v2", failReason: null, priceAmount: "declared", priceAsset: null, payTo: "declared" },
  { probedAt: "2026-09-15T00:00:00Z", verdict: "pass", dialect: "v2", failReason: null, priceAmount: "declared", priceAsset: null, payTo: "declared" },
];
const p = (i: number, over: Partial<PurchaseInput>): PurchaseInput => ({
  attemptedAt: `2026-09-1${i}T06:00:00Z`,
  status: "settle_failed",
  latencyMs: 100,
  httpStatusPaid: 402,
  payloadNonEmpty: true,
  l2Schema: "not_checked",
  txHash: null,
  network: "eip155:8453",
  ...over,
});
const facts = (purchases: PurchaseInput[]) =>
  assembleSellerFacts({
    probes,
    purchases,
    settlements30d: { raw: 0, real: 0, test: 0, uniquePayersReal: 0 },
    payees: [],
    declaredSchema: null,
    lastAttemptAt: purchases[0]?.attemptedAt ?? null,
  });

test("C: 資金切れ期間の 402 だけで『納品 0・署名 3』になった相手は BLOCK にならない（WARN・l1_inconclusive）", () => {
  const f = facts([
    p(5, { attemptedAt: "2026-09-15T18:00:00Z" }),
    p(4, { attemptedAt: "2026-09-14T12:00:00Z" }),
    p(3, { attemptedAt: "2026-09-13T06:00:00Z" }),
  ]);
  assert.deepEqual([f.l1.n_attempts, f.l1.n_settled, f.l1.n_inconclusive, f.l1.n_delivered], [3, 0, 3, 0]);
  assert.equal(f.l1.n_probe_error, 3);
  const d = decidePayer(f);
  assert.equal(d.recommendation, "WARN");
  assert.ok(d.reason_codes.includes("l1_inconclusive"), d.reason_codes.join(","));
});

test("C: 期間の外の 402 が 3 件なら従来どおり BLOCK・l1_never_delivered", () => {
  const f = facts([
    p(0, { attemptedAt: "2026-09-16T06:00:00Z" }),
    p(0, { attemptedAt: "2026-09-10T06:00:00Z" }),
    p(0, { attemptedAt: "2026-09-09T06:00:00Z" }),
  ]);
  assert.deepEqual([f.l1.n_attempts, f.l1.n_inconclusive], [3, 0]);
  const d = decidePayer(f);
  assert.equal(d.recommendation, "BLOCK");
  assert.ok(d.reason_codes.includes("l1_never_delivered"));
});

test("A: Douglas 型（settle_failed・400・tx なし）3 件は BLOCK にならない", () => {
  const f = facts([0, 1, 2].map((i) => p(i, { httpStatusPaid: 400, attemptedAt: `2026-09-0${i + 1}T06:00:00Z` })));
  assert.deepEqual([f.l1.n_attempts, f.l1.n_inconclusive, f.l1.n_delivered], [3, 3, 0]);
  const d = decidePayer(f);
  assert.equal(d.recommendation, "WARN");
  assert.ok(d.reason_codes.includes("l1_inconclusive"));
});

test("A: 決済前 4xx 2 件＋5xx 3 件は、5xx 3 件で BLOCK（5xx は救わない）", () => {
  const f = facts([
    ...[0, 1].map((i) => p(i, { httpStatusPaid: 422, attemptedAt: `2026-09-0${i + 1}T06:00:00Z` })),
    ...[2, 3, 4].map((i) => p(i, { httpStatusPaid: 500, attemptedAt: `2026-09-0${i + 1}T06:00:00Z` })),
  ]);
  assert.deepEqual([f.l1.n_attempts, f.l1.n_inconclusive], [5, 2]);
  assert.equal(decidePayer(f).recommendation, "BLOCK");
});

test("/decision の facts.l1 のキーの形は変えない", () => {
  const f = facts([p(3, { attemptedAt: IN_WINDOW })]);
  assert.deepEqual(Object.keys(f.l1).sort(), [
    "last_attempt_at",
    "last_purchase_id",
    "n_attempts",
    "n_delivered",
    "n_inconclusive",
    "n_probe_error",
    "n_settled",
    "observed_at",
    "p50_ms",
    "p95_ms",
  ]);
});
