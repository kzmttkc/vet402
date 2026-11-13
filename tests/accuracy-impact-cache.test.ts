import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AccuracyReportRead, BenchmarkReportRead, L0AccuracyRead, SloSnapshotRead } from "@/lib/scoring/accuracy-cached-reads";
import type {
  ImpactHeadlineRead,
  BacktestRead,
  DecisionFeedRead,
  AnchorsRead,
  SettledReceiptsRead,
} from "@/lib/observatory/impact-cached-reads";
import type { ObservatoryStats } from "@/lib/observatory/reader";
import { emptyPurchaseLifecycle } from "@/lib/observatory/purchase-stage";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const roundTrips = (v: unknown) => assert.deepStrictEqual(JSON.parse(JSON.stringify(v)), v);

test("cached-reads は失敗をキャッシュしない（catch なし）", () => {
  for (const file of ["src/lib/scoring/accuracy-cached-reads.ts", "src/lib/observatory/impact-cached-reads.ts"]) {
    const src = read(file);
    assert.doesNotMatch(src, /\bcatch\b/, `${file} は unstable_cache 内で catch してはいけない`);
  }
});

test("AccuracyReportRead は JSON 往復できる", () => {
  const v: AccuracyReportRead = {
    observedVerdicts: 3,
    resolvedVerdicts: 2,
    neutralOnlyVerdicts: 1,
    partnerReportedVerdicts: 0,
    byRecommendation: [
      { recommendation: "ALLOW", resolved: 1, wentBad: 0, stayedGood: 1, adverseRate: 0 },
      { recommendation: "WARN", resolved: 0, wentBad: 0, stayedGood: 0, adverseRate: null },
      { recommendation: "BLOCK", resolved: 1, wentBad: 0, stayedGood: 1, adverseRate: 0 },
    ],
    allowAdverseRate: 0,
    blockFalsePositiveRate: 0,
    minSample: 10,
    methodologyVersion: 1,
    readAt: "2026-11-07T12:00:00.000Z",
  };
  roundTrips(v);
});

test("BenchmarkReportRead は JSON 往復できる", () => {
  const v: BenchmarkReportRead = {
    knownBad: { total: 1, detected: 1, blocked: 1, warned: 0, missed: 0, detectionRate: 100, missRate: 0 },
    knownGood: { total: 1, allowed: 1, warned: 0, blocked: 0, falsePositiveRate: 0 },
    scans: 2,
    lastScanAt: "2026-11-01T00:00:00.000Z",
    lastScanAddresses: 2,
    lastBroadScan: { date: "2026-11-01", addresses: 2 },
    minSample: 10,
    methodologyVersion: 1,
    readAt: "2026-11-07T12:00:00.000Z",
  };
  roundTrips(v);
});

test("L0AccuracyRead は JSON 往復できる", () => {
  const v: L0AccuracyRead = {
    l0: {
      window_days: 7,
      published_fail: 10,
      false_fail: 1,
      false_fail_rate: 10,
      published_pass: 100,
      false_pass: 2,
      false_pass_rate: 2,
      min_sample: 5,
      slo: {
        false_fail_target_pct: 5,
        false_pass_target_pct: 3,
        false_fail_ok: false,
        false_pass_ok: true,
      },
    },
    readAt: "2026-11-07T12:00:00.000Z",
  };
  roundTrips(v);
});

test("SloSnapshotRead は JSON 往復できる", () => {
  const v: SloSnapshotRead = {
    slo: {
      l1_probe_error_rate_pct: 1.2,
      l1_7d: { attempts: 100, request_errors: 1, signed: 80, held: 5 },
      c1_l0_within_36h_pct: 99,
      c2_l1_within_48h_pct: 98,
      reverse_lookup_confirmed_within_60s_pct: 97,
      published_failure_evidence_complete_pct: 96,
      unmeasured: [],
      targets: {
        l1_probe_error_rate_pct: 5,
        c1_l0_within_36h_pct: 100,
        c2_l1_within_48h_pct: 100,
        reverse_lookup_confirmed_within_60s_pct: 100,
        published_failure_evidence_complete_pct: 100,
        decision_p95_ms_cache_hit: 200,
        decision_availability_monthly_pct: 99.9,
      },
    },
    readAt: "2026-11-07T12:00:00.000Z",
  };
  roundTrips(v);
});

const sampleObservatoryStats: ObservatoryStats = {
  totalEndpoints: 100,
  activeEndpoints: 80,
  delistedEndpoints: 20,
  publishedFail: 5,
  withdrawnFail: 0,
  publishedPass: 70,
  publishedPassActive: 65,
  publishedPassActiveProbeOlderThan7d: 10,
  publishedUnverified: 5,
  methodUndeclared: 2,
  eventCounts: { delisted: 1, relisted: 0, settleDrop: 0 },
  l1: {
    attempts: 50,
    settled: 40,
    delivered: 35,
    inconclusive: 2,
    inconclusiveSettled: 1,
    inconclusiveByReason: { settled4xx: 1, unsettled4xx: 0, payerUnfunded: 0 },
    settledNonceBound: 30,
    settledAmountPayeeOnly: 10,
    settledLateLinked: 5,
    settledCircleGateway: 1,
    settledTimeWindowOk: 38,
    settledTimeWindowUnknown: 2,
    endpointsAttempted: 25,
    endpointsSettled: 20,
    endpointsSettledSellerReceipt: 15,
    endpointsSettledIndexOnly: 5,
    endpointsDelivered: 18,
    awaitingReread: 3,
    awaitingRereadOlderThan1d: 1,
    awaitingRereadOlderThan7d: 0,
    awaitingRereadOldestAttemptAt: null,
    lastAttemptAt: "2026-11-07T10:00:00.000Z",
    byChain: [],
  },
  operatorEndpointsExcluded: 0,
  operatorExclusionConfigured: true,
  latestSnapshot: {
    source: "cdp",
    snapshotDate: "2026-11-06",
    totalCount: 5000,
    fetchedCount: 4800,
    complete: true,
  },
  catalogSnapshots: [],
  cdpBazaarIngestStale: false,
  cdpBazaarLastStrongPassAt: "2026-11-07T00:00:00.000Z",
  lifecycle: emptyPurchaseLifecycle(),
};

test("ImpactHeadlineRead は JSON 往復できる（stats と coverage が 1 つの readAt）", () => {
  const v: ImpactHeadlineRead = {
    stats: sampleObservatoryStats,
    coverage: { activeEndpoints: 80, measuredLast7d: 60, pct: 75 },
    readAt: "2026-11-07T12:00:00.000Z",
  };
  roundTrips(v);
});

test("BacktestRead は JSON 往復できる", () => {
  const v: BacktestRead = {
    attemptsTotal: 100,
    avoided: { count: 5, spentUnits: "5000000" },
    forgone: { count: 2, spentUnits: "2000000" },
    definition: "signed attempts with prior failure signal",
    readAt: "2026-11-07T12:00:00.000Z",
  };
  roundTrips(v);
});

test("DecisionFeedRead は JSON 往復できる", () => {
  const v: DecisionFeedRead = {
    rows: [
      {
        at: "2026-11-06T10:00:00Z",
        endpointId: "e1",
        resourceKey: "a.example",
        network: "eip155:8453",
        decision: "paid_settled",
        amountUnits: "1000",
        spentUnits: "1000",
        txHash: "0xabc",
      },
    ],
    totals: { refused: 0, paidSettled: 1, paidNoSettlement: 0, paidNoReceipt: 0 },
    totalDecisions: 1,
    definition: "test",
    readAt: "2026-11-07T12:00:00.000Z",
  };
  roundTrips(v);
});

test("AnchorsRead は JSON 往復できる", () => {
  const v: AnchorsRead = {
    rows: [
      {
        day: "2026-11-06",
        rootHash: "0xdeadbeef",
        prevRoot: "0xcafe",
        entryCount: 1200,
        anchoredTx: null,
      },
    ],
    readAt: "2026-11-07T12:00:00.000Z",
  };
  roundTrips(v);
});

test("SettledReceiptsRead は JSON 往復できる", () => {
  const v: SettledReceiptsRead = {
    rows: [
      {
        at: "2026-11-06T10:00:00Z",
        endpointId: "e1",
        resourceKey: "a.example",
        network: "eip155:8453",
        amountUnits: "1000",
        txHash: "0xabc",
        settlementSource: "seller_claim",
      },
    ],
    readAt: "2026-11-07T12:00:00.000Z",
  };
  roundTrips(v);
});

test("/accuracy と /impact は表示用 read 時刻に new Date() を使わない", () => {
  for (const file of ["src/app/accuracy/page.tsx", "src/app/impact/page.tsx"]) {
    const src = read(file);
    assert.doesNotMatch(src, /generatedAtUtc|generatedOnUtc/);
    assert.doesNotMatch(src, /const drawnAt = new Date\(\)/);
    assert.doesNotMatch(src, /readAtLabel\(new Date/);
    assert.ok(src.includes("readAt"), `${file} が cached readAt を使っていない`);
  }
});
