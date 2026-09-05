// 2026-09-02 監査 P1-10: passport の facts_summary（§14 P2）に単体テストが無かった。
// bound wallet が payTo の Endpoint について L0–L2 の事実だけを要約する（スコアではない）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFactsSummary } from "@/lib/decision/facts-summary";
import type { EndpointRef } from "@/lib/resolve/lookup";
import type { SellerFactsLoaded } from "@/lib/decision/seller-facts";

const ep = (n: number): EndpointRef => ({
  endpoint_id: `hash-${n}`,
  resource_id: null,
  observatory_id: `obs-${n}`,
  canonical_url: `https://seller${n}.example/api`,
  method: "GET",
  payee_id: "eip155:8453:0xb",
  catalog_status: "listed",
  first_seen: null,
  last_seen: null,
});

function loaded(n: number, over: Partial<SellerFactsLoaded["facts"]> = {}): SellerFactsLoaded {
  return {
    facts: {
      l0: { status: "pass", observed_at: null, dialect: "v2", fail_reason: null },
      l1: { n_delivered: n, n_settled: n, n_attempts: n + 1, n_probe_error: 0, p50_ms: null, p95_ms: null, last_purchase_id: null, observed_at: null, last_attempt_at: null },
      l2: { status: "undeclared", declaration_hash: null, response_hash: null, diff_hash: null, missing_keys: null, observed_at: null },
      availability_7d: null,
      availability_30d: null,
      offer_stability: "unknown",
      payees: [],
      settlement_30d_real: 0,
      settlement_30d_raw: 0,
      settlement_30d_test: 0,
      unique_payers_30d_real: 0,
      wash_dominated: false,
      ...over,
    },
    lastAttempt: { at: null, status: null },
    endpoint: { id: `obs-${n}`, resourceId: null, endpointHash: `hash-${n}`, canonicalUrl: `https://seller${n}.example/api`, method: "GET", payTo: "0xb", network: "eip155:8453", payeeId: null },
  };
}

test("先頭 3 件だけ facts を引き、total_endpoints は全件数。読めなかった endpoint は落として null を混ぜない", async () => {
  const asked: string[] = [];
  const out = await buildFactsSummary([ep(1), ep(2), ep(3), ep(4), ep(5)], async (observatoryId) => {
    asked.push(observatoryId);
    if (observatoryId === "obs-2") return null;
    const n = Number(observatoryId.slice(4));
    return loaded(n, n === 3 ? { l0: { status: "fail", observed_at: null, dialect: null, fail_reason: "no_402" }, l2: { status: "mismatch", declaration_hash: "d", response_hash: "r", diff_hash: "x", missing_keys: ["k"], observed_at: null } } : {});
  });
  assert.deepEqual(asked, ["obs-1", "obs-2", "obs-3"], "4 件目以降は引かない");
  assert.equal(out.total_endpoints, 5);
  assert.deepEqual(out.endpoints, [
    { endpoint_id: "hash-1", observatory_id: "obs-1", canonical_url: "https://seller1.example/api", l0: "pass", l1: { n_delivered: 1, n_attempts: 2 }, l2: "undeclared" },
    { endpoint_id: "hash-3", observatory_id: "obs-3", canonical_url: "https://seller3.example/api", l0: "fail", l1: { n_delivered: 3, n_attempts: 4 }, l2: "mismatch" },
  ]);
  assert.ok(!("score" in out) && !JSON.stringify(out).includes("trustScore"), "facts 要約にスコアを入れない（§8.3）");
});
