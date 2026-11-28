// presign cache miss の切り分け・並列読み・同等性（2026-11-28 依頼 V）。
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  __resetCheckSellerLatencyHelpersForTests,
  __setCheckSellerCacheForTests,
  checkSellerFreezeForCache,
  makeGetCheckSellerCached,
  type CheckSellerCacheTiming,
} from "@/lib/api/check-seller-cache";
import { formatPresignCheckTiming } from "@/lib/api/check-seller-miss-timing";
import { handlePresign } from "@/lib/api/presign-handler";
import { checkSeller, type CheckSellerDeps } from "@/lib/mcp/tools";
import type { DecideRequest } from "@/lib/decision/decide";
import type { CheckSellerOutput } from "@/lib/mcp/schemas";

const URL = "https://api.example.org/x";
const OBS = "00000000-0000-0000-0000-000000000001";

function post(challenge: Record<string, unknown>): Request {
  return new Request("https://vet402.com/api/v1/check/presign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...challenge, url: URL }),
  });
}

const CHALLENGE = {
  x402Version: 2,
  resource: { url: URL },
  accepts: [
    { scheme: "exact", network: "eip155:8453", amount: "1000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x0000000000000000000000000000000000000001" },
  ],
};

function baseOutput(verified: boolean): CheckSellerOutput {
  return checkSellerFreezeForCache({
    evidence_age: null,
    canonical_url: URL,
    method: "GET",
    not_in_catalog: false,
    recommendation: "ALLOW",
    reason_codes: [],
    reasons: [],
    delivery: null,
    l0_status: null,
    verified_terms: verified
      ? {
          purchase_id: "eip155:8453:0xabc",
          pay_to: "0x0000000000000000000000000000000000000001",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          amount: "1000",
          decimals: 6,
          network: "eip155:8453",
          scheme: "exact",
          protocol: "x402",
          verified_at: "2026-11-01T00:00:00.000Z",
        }
      : null,
    verified_pay_to_by_network: [],
    spending_halted: false,
    refunds: null,
    freshness: { l0: null, l1: null, l2: null },
    l1_purchases: [],
    same_host_listings: [],
    listing_sources: [],
    note: null,
    record_url: null,
    diagnose_url: null,
    method_url: "https://vet402.com/docs/methodology",
    as_of: "2026-11-28T00:00:00.000Z",
    truncated: false,
    next_action: null,
    rules_version: "2026-11-13.1",
  });
}

function depsFromOutput(out: CheckSellerOutput, failL1?: boolean): CheckSellerDeps & { counts: { resolve: number; decide: number; l1: number } } {
  const counts = { resolve: 0, decide: 0, l1: 0 };
  return {
    counts,
    resolve: (async () => {
      counts.resolve++;
      return { resource: { observatory_id: OBS, canonical_url: URL, method: "GET" }, endpoints: [] };
    }) as unknown as CheckSellerDeps["resolve"],
    decide: (async (req: DecideRequest) => {
      counts.decide++;
      if (req && "missTiming" in req && req.missTiming) {
        req.missTiming.db_outcomes = 12;
        req.missTiming.db_decide = 3;
      }
      return {
        recommendation: out.recommendation,
        reason_codes: out.reason_codes,
        reasons: [],
        facts: {
          l0: { status: "pass" },
          l1: { n_attempts: 1, n_delivered: 1, n_settled: 1, last_attempt_at: null },
          l2: { status: "undeclared" },
          payees: ["eip155:8453:0x0000000000000000000000000000000000000001"],
        },
        verified_terms: out.verified_terms,
        verified_pay_to_by_network: out.verified_pay_to_by_network,
        scoredAt: out.as_of,
        freshness: out.freshness,
        spending_halted: out.spending_halted,
        evidence_age: null,
        rules_version: out.rules_version,
      };
    }) as unknown as CheckSellerDeps["decide"],
    l1Purchases: async () => {
      counts.l1++;
      if (failL1) throw new Error("l1 read failed");
      return [];
    },
  };
}

const staleCoalesced = (() => {
  let n = 0;
  return ((fn: () => Promise<unknown>) => async () => {
    n++;
    if (n === 1) return { out: baseOutput(true), cacheReadAt: "2026-01-01T00:00:00.000Z" };
    return fn();
  }) as unknown as Parameters<typeof makeGetCheckSellerCached>[0];
})();

afterEach(() => {
  __setCheckSellerCacheForTests(null);
  __resetCheckSellerLatencyHelpersForTests();
});

test("presign miss: Server-Timing lists db_resolve and db_outcomes on coalesced path", async () => {
  __setCheckSellerCacheForTests(staleCoalesced);
  const d = depsFromOutput(baseOutput(true));
  const res = await handlePresign(post(CHALLENGE), d);
  assert.equal(res.status, 200);
  const timing = res.headers.get("server-timing") ?? "";
  assert.match(timing, /cache;dur=[0-9.]+;desc="coalesced"/);
  assert.match(timing, /db_resolve;dur=[0-9.]+/);
  assert.match(timing, /db_outcomes;dur=[0-9.]+/);
  assert.match(timing, /terms;dur=[0-9.]+, sign;dur=/);
});

test("presign miss: verified_terms なしでも decide は 1 回（terms 用の再読みなし）", async () => {
  __setCheckSellerCacheForTests(((fn: () => Promise<unknown>) => async () => fn()) as unknown as Parameters<typeof makeGetCheckSellerCached>[0]);
  const d = depsFromOutput(baseOutput(false));
  const res = await handlePresign(post(CHALLENGE), d);
  assert.equal(res.status, 200);
  assert.equal(d.counts.decide, 1);
  assert.equal(d.counts.resolve, 1);
  const timing = res.headers.get("server-timing") ?? "";
  assert.doesNotMatch(timing, /terms_payees;dur=[1-9]/);
});

test("parallel read failure: l1Purchases が落ちたら 503", async () => {
  __setCheckSellerCacheForTests(((fn: () => Promise<unknown>) => async () => fn()) as unknown as Parameters<typeof makeGetCheckSellerCached>[0]);
  const d = depsFromOutput(baseOutput(true), true);
  const res = await handlePresign(post(CHALLENGE), d);
  assert.equal(res.status, 503);
});

test("checkSeller: timing 付きの出力は timing なしと同じ（verified_terms なし）", async () => {
  const d = depsFromOutput(baseOutput(false));
  const plain = await checkSeller(d, { url: URL });
  const timing: CheckSellerCacheTiming = { miss: {} };
  const withTiming = await checkSeller(d, { url: URL }, timing);
  assert.deepEqual(
    { ...withTiming, as_of: plain.as_of },
    plain,
  );
  assert.ok(timing.catalogPayees?.length);
});

test("formatPresignCheckTiming: fresh では細分段を出さない", () => {
  const s = formatPresignCheckTiming(5, "fresh", 1, { db_resolve: 9, db_outcomes: 8 });
  assert.match(s, /^cache;dur=5.0;desc="fresh", terms;dur=1.0$/);
  assert.doesNotMatch(s, /db_resolve/);
});

test("local miss benchmark: parallel decide+l1 は直列より短い（モック遅延）", async () => {
  const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  let decideMs = 0;
  let l1Ms = 0;
  const slowDeps = {
    resolve: async () => ({ resource: { observatory_id: OBS, canonical_url: URL, method: "GET" }, endpoints: [] }),
    decide: async (req: { missTiming?: { db_outcomes?: number } }) => {
      const t0 = performance.now();
      await delay(30);
      decideMs = performance.now() - t0;
      if (req.missTiming) req.missTiming.db_outcomes = decideMs;
      return {
        recommendation: "ALLOW",
        reason_codes: [],
        reasons: [],
        facts: { l0: { status: "pass" }, l1: { n_attempts: 0, n_delivered: 0, n_settled: 0, last_attempt_at: null }, l2: { status: "undeclared" }, payees: [] },
        verified_terms: null,
        verified_pay_to_by_network: [],
        scoredAt: "2026-11-28T00:00:00.000Z",
        freshness: { l0: null, l1: null, l2: null },
        spending_halted: false,
        evidence_age: null,
        rules_version: "2026-11-13.1",
      };
    },
    l1Purchases: async () => {
      const t0 = performance.now();
      await delay(25);
      l1Ms = performance.now() - t0;
      return [];
    },
  } as unknown as CheckSellerDeps;
  const timing: CheckSellerCacheTiming = { miss: {} };
  const t0 = performance.now();
  await checkSeller(slowDeps, { url: URL }, timing);
  const wall = performance.now() - t0;
  assert.ok(wall < decideMs + l1Ms - 15, `parallel wall ${wall} vs sequential sum ${decideMs + l1Ms}`);
  assert.ok((timing.miss?.db_l1_recent ?? 0) >= 20);
});