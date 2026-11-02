// ============================================================
// 配達が窓の外にだけある出品の L1 の語（2026-11-02.2・監査 M2）。
//
// 最後の配達が 30 日より前で窓の中に署名した試行がある出品は、l1_stale が出ず、l1_never_delivered なのに
// last_delivered_at がある答えがあった。全履歴に配達があれば l1_never_delivered と書かず、l1_stale を足す。推奨は変えない。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { decidePayer, type L1Timeline } from "@/lib/decision/rules";
import { assembleSellerFacts, type ProbeInput, type PurchaseInput, type SellerFactsInput } from "@/lib/decision/seller-facts";

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

test("M2: 窓の中の試行が数えられて配達は窓の外だけ → l1_stale と l1_latest_failed。l1_never_delivered と書かない", () => {
  const failed = delivery({ attemptedAt: "2026-10-25 00:00:00+00", httpStatusPaid: 500, l2Schema: null, l2Detail: null });
  const f = assembleSellerFacts(input({ purchases: [failed] }));
  assert.equal(f.l1.n_delivered, 0);
  const d = decidePayer(f, {
    l1Timeline: timeline({ n_counted: 1, latest_counted: { at: "2026-10-25T00:00:00.000Z", delivered: false } }),
    l1NotCounted: { total: 0, by: { vet402_side: 0, held: 0, no_charge: 0 } },
    now: NOW,
  });
  assert.equal(d.recommendation, "WARN");
  assert.ok(!d.reason_codes.includes("l1_never_delivered"), d.reason_codes.join(","));
  assert.equal(d.reason_codes.filter((c) => c === "l1_stale").length, 1);
  assert.ok(d.reason_codes.includes("l1_latest_failed"));
});

test("M2: 窓の中の試行が数えられず配達は窓の外だけ → l1_inconclusive と l1_stale", () => {
  const held = delivery({ attemptedAt: "2026-10-25 00:00:00+00", httpStatusPaid: 400, l2Schema: null, l2Detail: null });
  const f = assembleSellerFacts(input({ purchases: [held] }));
  const d = decidePayer(f, {
    l1Timeline: timeline(),
    l1NotCounted: { total: 1, by: { vet402_side: 0, held: 1, no_charge: 0 } },
    now: NOW,
  });
  assert.equal(d.recommendation, "WARN");
  assert.ok(d.reason_codes.includes("l1_inconclusive"));
  assert.equal(d.reason_codes.filter((c) => c === "l1_stale").length, 1);
  assert.ok(!d.reason_codes.includes("l1_latest_failed"), "数えた試行が無い");
});

test("M2: 全履歴で配達が無ければ l1_never_delivered のまま（l1_stale は足さない）", () => {
  const failed = delivery({ attemptedAt: "2026-10-25 00:00:00+00", httpStatusPaid: 500, l2Schema: null, l2Detail: null });
  const f = assembleSellerFacts(input({ purchases: [failed], lastDeliveredAt: null }));
  const d = decidePayer(f, {
    l1Timeline: timeline({ n_counted: 1, last_delivered_at: null, latest_counted: { at: "2026-10-25T00:00:00.000Z", delivered: false } }),
    now: NOW,
  });
  assert.ok(d.reason_codes.includes("l1_never_delivered"));
  assert.ok(!d.reason_codes.includes("l1_stale"));
  assert.ok(!d.reason_codes.includes("l1_latest_failed"));
});

test("M2: オプトインの免除は変えない（窓の外の配達だけの出品の推奨は上がらない）", () => {
  const failed = delivery({ attemptedAt: "2026-10-25 00:00:00+00", httpStatusPaid: 500, l2Schema: null, l2Detail: null });
  const f = assembleSellerFacts(input({ purchases: [failed], declaredSchema: null }));
  const d = decidePayer(f, {
    allowWithoutL1: true,
    l1Timeline: timeline({ n_counted: 1, latest_counted: { at: "2026-10-25T00:00:00.000Z", delivered: false } }),
    now: NOW,
  });
  assert.equal(d.recommendation, "WARN");
  assert.ok(!d.reason_codes.includes("l1_waived_by_operator"));
});

test("M2: 全履歴で配達が無く数えた失敗がある出品は、opt-in でも ALLOW にならない", () => {
  const failed = delivery({ attemptedAt: "2026-10-25 00:00:00+00", httpStatusPaid: 500, l2Schema: null, l2Detail: null });
  const f = assembleSellerFacts(input({ purchases: [failed], declaredSchema: null, lastDeliveredAt: null }));
  const d = decidePayer(f, {
    allowWithoutL1: true,
    l1Timeline: timeline({ n_counted: 1, last_delivered_at: null, latest_counted: { at: "2026-10-25T00:00:00.000Z", delivered: false } }),
    now: NOW,
  });
  assert.equal(d.recommendation, "WARN");
  assert.ok(d.reason_codes.includes("l1_never_delivered"));
  assert.ok(!d.reason_codes.includes("l1_waived_by_operator"));
});
