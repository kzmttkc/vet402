// §8.1 売り手事実の組み立て（純関数 assembleSellerFacts）
import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleSellerFacts, type ProbeInput, type PurchaseInput } from "@/lib/decision/seller-facts";

const probes: ProbeInput[] = [
  { probedAt: "2026-09-02T00:00:00Z", verdict: "pass", dialect: "v2", failReason: null, priceAmount: "1000", priceAsset: "usdc", payTo: "0xb" },
  { probedAt: "2026-09-01T00:00:00Z", verdict: "pass", dialect: "v2", failReason: null, priceAmount: "1000", priceAsset: "usdc", payTo: "0xb" },
];
const purchases: PurchaseInput[] = [
  { attemptedAt: "2026-09-01T12:00:00Z", status: "settled", latencyMs: 300, httpStatusPaid: 200, payloadNonEmpty: true, l2Schema: "match", txHash: "0x1", network: "eip155:8453" },
  { attemptedAt: "2026-08-31T12:00:00Z", status: "settle_failed", latencyMs: 900, httpStatusPaid: 500, payloadNonEmpty: false, l2Schema: "not_checked", txHash: null, network: "eip155:8453" },
  { attemptedAt: "2026-08-30T12:00:00Z", status: "over_cap", latencyMs: null, httpStatusPaid: null, payloadNonEmpty: null, l2Schema: null, txHash: null, network: "eip155:8453" },
];
const base = { probes, purchases, settlements30d: { raw: 5, real: 3, uniquePayersReal: 2 }, payees: ["eip155:8453:0xb"], declaredSchema: { type: "object" } as unknown };

test("L0: published verdict（2 連続 fail ゲート）と方言・観測時刻", () => {
  const f = assembleSellerFacts(base);
  assert.equal(f.l0.status, "pass");
  assert.equal(f.l0.dialect, "v2");
  assert.equal(f.l0.observed_at, "2026-09-02T00:00:00Z");
  const single = assembleSellerFacts({ ...base, probes: [{ ...probes[0], verdict: "fail", failReason: "no_402" }, probes[1]] });
  assert.equal(single.l0.status, "unverified", "1 回の fail は公開 fail にしない");
});

test("L1: n_attempts は署名した試行のみ（over_cap は数えない）、n_settled は確定、n_delivered は 2xx 非空", () => {
  const f = assembleSellerFacts(base);
  assert.equal(f.l1.n_attempts, 2);
  assert.equal(f.l1.n_settled, 1);
  assert.equal(f.l1.n_delivered, 1);
  assert.equal(f.l1.last_purchase_id, "eip155:8453:0x1");
  assert.equal(f.l1.p50_ms, 300);
});

test("L2: 宣言あり＋直近配達が match → conform、mismatch → mismatch、宣言なし → undeclared、未検査 → undeclared", () => {
  assert.equal(assembleSellerFacts(base).l2.status, "conform");
  assert.match(assembleSellerFacts(base).l2.declaration_hash!, /^[0-9a-f]{64}$/);
  const mis = assembleSellerFacts({ ...base, purchases: [{ ...purchases[0], l2Schema: "mismatch" }] });
  assert.equal(mis.l2.status, "mismatch");
  assert.equal(assembleSellerFacts({ ...base, declaredSchema: null }).l2.status, "undeclared");
  const unchecked = assembleSellerFacts({ ...base, purchases: [{ ...purchases[0], l2Schema: "not_checked" }] });
  assert.equal(unchecked.l2.status, "undeclared", "未検査を mismatch と書かない");
});

test("availability: pass 率、probes 0 は null", () => {
  const f = assembleSellerFacts(base);
  assert.equal(f.availability_30d, 1);
  assert.equal(assembleSellerFacts({ ...base, probes: [] }).availability_30d, null);
});

test("offer_stability: 24h で 3 回以上の実質変更は drifting、probes < 2 は unknown", () => {
  const drift: ProbeInput[] = [0, 1, 2, 3].map((i) => ({ ...probes[0], probedAt: `2026-09-02T0${i}:00:00Z`, priceAmount: String(1000 + i) }));
  assert.equal(assembleSellerFacts({ ...base, probes: drift }).offer_stability, "drifting");
  assert.equal(assembleSellerFacts({ ...base, probes: [probes[0]] }).offer_stability, "unknown");
  assert.equal(assembleSellerFacts(base).offer_stability, "stable");
});

test("wash_dominated: raw ≥ 10 かつ real ≤ raw の 10%", () => {
  assert.equal(assembleSellerFacts({ ...base, settlements30d: { raw: 20, real: 1, uniquePayersReal: 1 } }).wash_dominated, true);
  assert.equal(assembleSellerFacts({ ...base, settlements30d: { raw: 20, real: 5, uniquePayersReal: 3 } }).wash_dominated, false);
  assert.equal(assembleSellerFacts({ ...base, settlements30d: { raw: 5, real: 0, uniquePayersReal: 0 } }).wash_dominated, false);
});

test("trustScore は facts に入らない（§8.3 禁止）", () => {
  const f = assembleSellerFacts(base) as unknown as Record<string, unknown>;
  assert.equal("trustScore" in f, false);
  assert.equal("score" in f, false);
});

test("§6.2 probe_error: 決済は確定したが 4xx（我々のリクエストが不正）は n_attempts に数えない", () => {
  const ours: PurchaseInput[] = [0, 1, 2].map((i) => ({
    attemptedAt: `2026-09-0${i + 1}T12:00:00Z`, status: "settled", latencyMs: 200, httpStatusPaid: 400, payloadNonEmpty: true, l2Schema: "not_checked", txHash: `0x${i}`, network: "eip155:8453",
  }));
  const f = assembleSellerFacts({ ...base, purchases: ours });
  assert.equal(f.l1.n_probe_error, 3);
  assert.equal(f.l1.n_attempts, 0);
  assert.equal(f.l1.n_settled, 0);
  assert.equal(f.l1.n_delivered, 0);
});
