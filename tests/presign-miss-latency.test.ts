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

test("formatPresignCheckTiming: 他の呼び手が残した fresh・prefetch（miss が空）では細分段を出さない", () => {
  for (const path of ["fresh", "prefetch"]) {
    const s = formatPresignCheckTiming(5, path, 1, undefined);
    assert.equal(s, `cache;dur=5.0;desc="${path}", terms;dur=1.0`);
    assert.equal(formatPresignCheckTiming(5, path, 1, {}), s);
  }
});

test("formatPresignCheckTiming: この要求の中で読んだ fresh（初めての売り手）でも細分段を出す", () => {
  const s = formatPresignCheckTiming(5, "fresh", 1, { db_resolve: 9, db_outcomes: 8, db_decide: 2, db_l1_recent: 3 });
  assert.equal(s, 'cache;dur=5.0;desc="fresh", db_resolve;dur=9.0, db_outcomes;dur=8.0, db_decide;dur=2.0, db_l1_recent;dur=3.0, terms;dur=1.0');
});

test("presign: 60 秒の cache に値が無く、この要求で読んだ fresh では Server-Timing に段が出る", async () => {
  __setCheckSellerCacheForTests(((fn: () => Promise<unknown>) => async () => fn()) as unknown as Parameters<typeof makeGetCheckSellerCached>[0]);
  const d = depsFromOutput(baseOutput(true));
  const res = await handlePresign(post(CHALLENGE), d);
  assert.equal(res.status, 200);
  const timing = res.headers.get("server-timing") ?? "";
  assert.match(timing, /cache;dur=[0-9.]+;desc="fresh"/);
  assert.match(timing, /db_resolve;dur=[0-9.]+/);
  assert.match(timing, /db_outcomes;dur=12\.0/);
  assert.doesNotMatch(timing, /https?:|example/);
});

test("checkSeller: decide と l1Purchases は並列に始まる（l1 は decide の終わりを待たない）", async () => {
  const order: string[] = [];
  let releaseDecide!: () => void;
  const decideGate = new Promise<void>((r) => (releaseDecide = r));
  const base = depsFromOutput(baseOutput(true));
  const deps = {
    ...base,
    decide: (async (req: DecideRequest) => {
      order.push("decide:start");
      await decideGate;
      order.push("decide:end");
      return (base.decide as unknown as (r: DecideRequest) => Promise<unknown>)(req);
    }) as unknown as CheckSellerDeps["decide"],
    l1Purchases: async () => {
      order.push("l1:start");
      return [];
    },
  } as CheckSellerDeps;
  const timing: CheckSellerCacheTiming = { miss: {} };
  const run = checkSeller(deps, { url: URL }, timing);
  await new Promise((r) => setImmediate(r));
  assert.ok(order.includes("l1:start"), `l1 started before decide finished: ${order.join(",")}`);
  assert.ok(!order.includes("decide:end"));
  releaseDecide();
  await run;
  assert.equal(typeof timing.miss?.db_l1_recent, "number");
});

test("checkSeller: decision が無い時は l1Purchases の失敗で落ちず、直列の時と同じ not_in_catalog を返す", async () => {
  const base = depsFromOutput(baseOutput(true), true);
  const deps = { ...base, decide: (async () => null) as unknown as CheckSellerDeps["decide"] } as CheckSellerDeps;
  const out = await checkSeller(deps, { url: URL });
  assert.equal(out.not_in_catalog, true);
  assert.deepEqual(out.l1_purchases, []);
});

test("checkSeller: decide が落ちたら投げる（l1 の並列読みが失敗を隠さない）", async () => {
  const base = depsFromOutput(baseOutput(true));
  const deps = {
    ...base,
    decide: (async () => {
      throw new Error("decide read failed");
    }) as unknown as CheckSellerDeps["decide"],
  } as CheckSellerDeps;
  await assert.rejects(checkSeller(deps, { url: URL }), /decide read failed/);
});

test("presign: 他の呼び手が残した fresh では、verified_terms が無い時の terms_payees だけが段に出る", async () => {
  const cached = ((_fn: () => Promise<unknown>) => async () => ({
    out: baseOutput(false),
    cacheReadAt: new Date().toISOString(),
  })) as unknown as Parameters<typeof makeGetCheckSellerCached>[0];
  __setCheckSellerCacheForTests(cached);
  const d = depsFromOutput(baseOutput(false));
  const res = await handlePresign(post(CHALLENGE), d);
  assert.equal(res.status, 200);
  const timing = res.headers.get("server-timing") ?? "";
  assert.match(timing, /cache;dur=[0-9.]+;desc="fresh", terms_payees;dur=[0-9.]+, terms;dur=/);
  assert.doesNotMatch(timing, /db_resolve|db_outcomes|db_decide|db_l1_recent/);
});
