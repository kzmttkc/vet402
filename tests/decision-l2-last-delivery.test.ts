// ============================================================
// L2 は窓に関係なく最後の配達 1 行を読む（2026-11-02.2・監査 H1）。
//
// 公開の規則は "of the latest delivery" だったが、実装は 30 日窓の中の配達だけを見ていた。窓の外へ出ると、確かめた
// 不一致が not_checked に変わり BLOCK が WARN に下がる。時間が経つだけで配達の不一致が軽くなる。
//
// 固定すること:
//   1. 窓の中に配達が無ければ、loadSellerFacts が渡す全履歴の最後の配達で L2 を読む（欠けたキーあり → BLOCK）
//   2. 窓の中に配達があれば、そちらが勝つ。古い行は読まない
//   3. カタログ null でも窓の中に配達が無ければ全履歴の最後の配達で L2 を読む（購入の行に宣言があるかは読むまで分からない）
// 実際の SQL と読む回数は tests/decision-l2-last-delivery.pg.test.ts。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { decidePayer, type L1Timeline } from "@/lib/decision/rules";
import {
  assembleSellerFacts,
  l2ContentTypeOf,
  l2EvidenceOf,
  l2PurchaseIdOf,
  type ProbeInput,
  type PurchaseInput,
  type SellerFactsInput,
} from "@/lib/decision/seller-facts";

const SCHEMA = { properties: { output: { properties: { example: { required: ["id", "name"], properties: { id: {}, name: {} } } } } } };
const RAW_AT = "2026-09-30 15:32:03.123456+00";

const passProbe: ProbeInput = {
  probedAt: "2026-10-31 04:40:50.535817+00",
  verdict: "pass",
  dialect: "v2",
  failReason: null,
  priceAmount: "declared",
  priceAsset: null,
  payTo: "declared",
};

const delivery = (over: Partial<PurchaseInput> = {}): PurchaseInput => ({
  attemptedAt: RAW_AT,
  status: "settled",
  latencyMs: 100,
  httpStatusPaid: 200,
  payloadNonEmpty: true,
  l2Schema: "mismatch",
  txHash: "0xabc",
  network: "eip155:8453",
  l2Detail: { missing: ["id", "name"], declarationHash: "d", responseHash: "r", reason: "missing_keys" },
  contentType: "application/json",
  ...over,
});

const input = (over: Partial<SellerFactsInput>): SellerFactsInput => ({
  probes: [passProbe],
  purchases: [],
  settlements30d: { raw: 0, real: 0, test: 0, uniquePayersReal: 0 },
  payees: [],
  declaredSchema: SCHEMA,
  lastAttemptAt: "2026-09-30T15:32:03.123Z",
  lastSignedAttemptAt: "2026-09-30T15:32:03.123Z",
  lastDeliveredAt: "2026-09-30T15:32:03.123Z",
  ...over,
});

const timeline = (over: Partial<L1Timeline> = {}): L1Timeline => ({
  n_counted: 0,
  n_paid_undelivered: 0,
  n_paid_undelivered_since_delivery: 0,
  latest_counted: null,
  last_delivered_at: "2026-09-30T15:32:03.123Z",
  last_signed_attempt_at: "2026-09-30T15:32:03.123Z",
  ...over,
});

const NOW = new Date("2026-11-02T00:00:00Z");

test("H1: 窓の外の配達が欠けたキーを記録していれば mismatch のまま BLOCK", () => {
  const f = assembleSellerFacts(input({ lastDeliveryOutsideWindow: delivery() }));
  assert.equal(f.l2.status, "mismatch");
  assert.deepEqual(f.l2.missing_keys, ["id", "name"]);
  assert.equal(f.l2.observed_at, "2026-09-30T15:32:03.123Z");
  assert.ok(f.l2.diff_hash, "第三者が再計算するハッシュも窓の外の行から出す");
  const d = decidePayer(f, { l1Timeline: timeline(), now: NOW });
  assert.equal(d.recommendation, "BLOCK");
  assert.ok(d.reason_codes.includes("l2_mismatch"));
  assert.ok(d.reason_codes.includes("l1_stale"), "配達が古いことは別の語で残る");
});

test("H1: 窓の外の配達に欠けたキーの記録が無い不一致は l2_mismatch_unexplained（WARN）", () => {
  const f = assembleSellerFacts(
    input({ lastDeliveryOutsideWindow: delivery({ l2Detail: { missing: [], declarationHash: "d", responseHash: "r", reason: "not_json" } }) }),
  );
  assert.equal(f.l2.status, "mismatch");
  const d = decidePayer(f, { l1Timeline: timeline(), now: NOW });
  assert.equal(d.recommendation, "WARN");
  assert.ok(d.reason_codes.includes("l2_mismatch_unexplained"));
});

test("H1: 窓の外の配達が match なら conform（配達が古いので WARN・l1_stale）", () => {
  const f = assembleSellerFacts(
    input({ lastDeliveryOutsideWindow: delivery({ l2Schema: "match", l2Detail: { missing: [], declarationHash: "d", responseHash: "r", reason: null } }) }),
  );
  assert.equal(f.l2.status, "conform");
  const d = decidePayer(f, { l1Timeline: timeline(), now: NOW });
  assert.equal(d.recommendation, "WARN");
  assert.ok(d.reason_codes.includes("l1_stale"));
  assert.ok(!d.reason_codes.includes("l2_not_checked"));
});

test("H1: 窓の中の配達があれば、そちらが勝つ", () => {
  const inWindow = delivery({
    attemptedAt: "2026-10-20 00:00:00+00",
    l2Schema: "match",
    txHash: "0xnew",
    l2Detail: { missing: [], declarationHash: "d", responseHash: "fresh", reason: null },
    contentType: "text/plain",
  });
  const facts = assembleSellerFacts(input({ purchases: [inWindow], lastDeliveryOutsideWindow: delivery() }));
  assert.equal(facts.l2.status, "conform");
  assert.equal(facts.l2.response_hash, "fresh");
  assert.equal(l2ContentTypeOf([inWindow], facts, delivery()), "text/plain");
  assert.equal(l2PurchaseIdOf([inWindow], delivery()), "eip155:8453:0xnew");
});

test("H1: カタログが出力を宣言していなくても、窓の外の配達に宣言ハッシュがあれば conform", () => {
  const f = assembleSellerFacts(input({ declaredSchema: null, lastDeliveryOutsideWindow: delivery({ l2Schema: "match", l2Detail: { missing: [], declarationHash: "d", responseHash: "r", reason: null } }) }));
  assert.equal(f.l2.status, "conform");
  assert.equal(f.l2.observed_at, "2026-09-30T15:32:03.123Z");
});

test("H1: 出力宣言も購入行の宣言も無い出品は undeclared", () => {
  const f = assembleSellerFacts(
    input({ declaredSchema: null, lastDeliveryOutsideWindow: delivery({ l2Schema: "no_declaration", l2Detail: null }) }),
  );
  assert.equal(f.l2.status, "undeclared");
  assert.equal(f.l2.observed_at, null);
});

test("H1: L2 の evidence は判定を決めた行の Content-Type と購入 ID を指す", () => {
  const outside = delivery();
  const f = assembleSellerFacts(input({ lastDeliveryOutsideWindow: outside }));
  assert.equal(l2ContentTypeOf([], f, outside), "application/json");
  const purchaseId = l2PurchaseIdOf([], outside);
  assert.equal(purchaseId, "eip155:8453:0xabc");
  const e = l2EvidenceOf(f, "00000000-0000-4000-8000-000000000000", "application/json", purchaseId);
  assert.equal(e?.purchase_id, purchaseId);
  assert.equal(e?.mismatch_kind, "missing_keys");
});

// 2026-11-02.2（H-A）: 理由の記録が無い古い行は、切れたのか壊れていたのか区別できない。証拠が無いので不一致と書かない。
const legacyRow = (over: Partial<PurchaseInput> = {}) =>
  delivery({
    l2Detail: { missing: [], declarationHash: "d", responseHash: "r", reason: null },
    bodyHead: `{"data":"${"x".repeat(600)}`.slice(0, 500),
    ...over,
  });

test("H-A: 出力の宣言が無く、最後の配達が理由の記録の無い古い行 → undeclared（ALLOW の opt-in を奪わない）", () => {
  const declaredSchema = { properties: { input: {} } };
  const f = assembleSellerFacts(input({ declaredSchema, lastDeliveryOutsideWindow: legacyRow() }));
  assert.equal(f.l2.status, "undeclared");
  assert.equal(decidePayer(f, { allowWithoutL1: true, l1Timeline: timeline(), now: NOW }).recommendation, "ALLOW");
});

test("H-A: 出力の宣言があり、同じ形の行（欠けたキーの記録なし）→ not_checked（WARN・不一致と書かない）", () => {
  const f = assembleSellerFacts(input({ lastDeliveryOutsideWindow: legacyRow() }));
  assert.equal(f.l2.status, "not_checked");
  const d = decidePayer(f, { l1Timeline: timeline(), now: NOW });
  assert.equal(d.recommendation, "WARN");
  assert.ok(!d.reason_codes.includes("l2_mismatch_unexplained"));
});

test("H-A: 理由を記録した新しい形の不一致は変えない（欠けたキーなしは unexplained、ありは BLOCK）", () => {
  const unexplained = assembleSellerFacts(
    input({ lastDeliveryOutsideWindow: legacyRow({ l2Detail: { missing: [], declarationHash: "d", responseHash: "r", reason: "unparseable" } }) }),
  );
  assert.equal(unexplained.l2.status, "mismatch");
  assert.ok(decidePayer(unexplained, { l1Timeline: timeline(), now: NOW }).reason_codes.includes("l2_mismatch_unexplained"));
  const named = assembleSellerFacts(input({ lastDeliveryOutsideWindow: delivery() }));
  assert.equal(decidePayer(named, { l1Timeline: timeline(), now: NOW }).recommendation, "BLOCK");
});
