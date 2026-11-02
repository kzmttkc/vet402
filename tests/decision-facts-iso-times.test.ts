// ============================================================
// facts の observed_at は ISO 8601 UTC（2026-11-02・監査 M10）。公開は format: date-time で、Postgres の ::text
// （"2026-10-31 04:40:50.535817+00"）は RFC 3339 ではない。freshness は同じ値を読む。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleSellerFacts, type PurchaseInput, type SellerFactsInput } from "@/lib/decision/seller-facts";

const input: SellerFactsInput = {
  probes: [{ probedAt: "2026-10-31 04:40:50.535817+00", verdict: "pass", dialect: "v2", failReason: null, priceAmount: "declared", priceAsset: null, payTo: "declared" }],
  purchases: [],
  settlements30d: { raw: 0, real: 0, test: 0, uniquePayersReal: 0 },
  payees: [],
  declaredSchema: { properties: { output: { properties: { example: { required: ["id"], properties: { id: {} } } } } } },
  lastAttemptAt: null,
};
const delivered: PurchaseInput = {
  attemptedAt: "2026-10-20 00:00:00.5+00",
  status: "settled",
  latencyMs: 100,
  httpStatusPaid: 200,
  payloadNonEmpty: true,
  l2Schema: "match",
  txHash: "0xabc",
  network: "eip155:8453",
  l2Detail: { missing: [], declarationHash: "d", responseHash: "r", reason: null },
};

test("M10: facts の observed_at は ISO 8601 UTC（freshness も同じ値）", () => {
  const f = assembleSellerFacts({ ...input, purchases: [delivered] });
  assert.equal(f.l0.observed_at, "2026-10-31T04:40:50.535Z");
  assert.equal(f.l1.observed_at, "2026-10-20T00:00:00.500Z");
  assert.equal(f.l2.observed_at, "2026-10-20T00:00:00.500Z");
});

test("M10: 読めない時刻は null（捏造しない）・観測が無ければ null", () => {
  const f = assembleSellerFacts({ ...input, probes: [] });
  assert.equal(f.l0.observed_at, null);
  assert.equal(f.l1.observed_at, null);
  assert.equal(f.l2.observed_at, null);
});
