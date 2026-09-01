// §10 証拠規則（純関数）
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPublishableFailure, l0FailureEvidence, type FailureEvidence } from "@/lib/evidence/publishable";

const l0: FailureEvidence = {
  observed_at: "2026-09-01T00:00:00Z",
  resource_id: "r",
  canonical_url: "https://e.com/x",
  probe_type: "L0",
  raw_summary: { status: 200, headers: ["contentType"], error: "no_402" },
  repro: { method: "GET", dialect: "v2", client: "vet402-observatory-l0/1.0" },
};

test("L0 失敗は 6 点揃えば公開可", () => assert.equal(isPublishableFailure(l0), true));
test("再現手順が無ければ非公開", () => assert.equal(isPublishableFailure({ ...l0, repro: null }), false));
test("生ログ要約が無ければ非公開", () => assert.equal(isPublishableFailure({ ...l0, raw_summary: null }), false));
test("resource_id / canonical_url が欠ければ非公開", () => {
  assert.equal(isPublishableFailure({ ...l0, resource_id: "" }), false);
  assert.equal(isPublishableFailure({ ...l0, canonical_url: "" }), false);
});
test("L1/L2 失敗は tx_hash と chain が無ければ非公開", () => {
  assert.equal(isPublishableFailure({ ...l0, probe_type: "L1" }), false);
  assert.equal(isPublishableFailure({ ...l0, probe_type: "L1", tx_hash: "0xab", chain: "eip155:8453" }), true);
  assert.equal(isPublishableFailure({ ...l0, probe_type: "L2", tx_hash: "0xab", chain: null }), false);
});
test("L0 プローブ行から証拠が組める／ID 未算出の行は組めない（内部に留める）", () => {
  const ok = l0FailureEvidence({
    probedAt: "2026-09-01T00:00:00Z",
    resourceId: "r",
    canonicalUrl: "https://e.com/x",
    method: "GET",
    dialect: "v2",
    httpStatus: 200,
    failReason: "no_402",
    rawResponseMeta: { contentType: "text/html", client: "vet402-observatory-l0/1.0" },
  });
  assert.ok(ok && isPublishableFailure(ok));
  assert.deepEqual(ok!.raw_summary?.headers, ["contentType"]);
  const missing = l0FailureEvidence({
    probedAt: "2026-09-01T00:00:00Z",
    resourceId: null,
    canonicalUrl: "https://e.com/x",
    method: "GET",
    dialect: null,
    httpStatus: 200,
    failReason: "no_402",
    rawResponseMeta: null,
  });
  assert.equal(missing, null);
});
