import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import {
  consumeIpRateLimit,
  ipRateLimitHeaders,
  sharedCacheRateLimitHeaders,
} from "@/lib/api/ip-rate-limit";
import { computeAccuracyReport, type AccuracyReport } from "@/lib/scoring/accuracy";
import { computeBenchmarkReport, type BenchmarkReport } from "@/lib/scoring/benchmark-report";
import { fetchAccuracyRows, fetchBenchmarkRows } from "@/lib/db/outcome-reader";
import { computeL0Accuracy, fetchL0AccuracyInput, fetchSloSnapshot } from "@/lib/scoring/l0-accuracy";
import { getCoverageWeekly } from "@/lib/observatory/coverage-report";
import { SITE_URL } from "@/lib/site-url";
import { logServerError } from "@/lib/util/log";

/**
 * GET /api/v1/accuracy — public, unauthenticated accuracy report.
 *
 * Public ON PURPOSE (2026-08-05 R&D): "of the ALLOW verdicts we issued, N%
 * later showed adverse activity" is only worth anything if anyone can fetch
 * it at any time — an accuracy number shown selectively is marketing, not
 * measurement. The report includes our false-positive rate on BLOCK verdicts
 * with the same prominence as the flattering number, and rates below the
 * minimum sample size are null rather than noise.
 *
 * No customer data on this path: the report is aggregate counts only — no
 * wallet addresses, no agent ids, no per-customer anything.
 *
 * 2026-08-13 (machine-reader persona audit): the customer of this product is a
 * machine, and until now the honesty lived only in the HTML. /accuracy told a
 * human that "100%" counts BLOCK *or* WARN and that "0%" means "none were
 * blocked", not "all were passed" — while this endpoint handed a machine the
 * bare `detectionRate: 100` / `falsePositiveRate: 0` with nothing attached, and
 * public/llms.txt told that machine it need not read the page because the JSON
 * carries "the same numbers". It carried the same numbers without the sentences
 * that say what they mean. `interpretation` closes that gap: the same caveats,
 * in the same words, computed from the same report — never hard-coded, because
 * a frozen sentence becomes a lie the week the address set changes.
 */

const CACHE_TTL_MS = 10 * 60 * 1000;
let cached: { body: unknown; expiresAt: number } | null = null;

/**
 * The disclaimer every scored payload carries (engine.ts issues the per-verdict
 * variants). Repeated here because /faq states as a machine-checkable fact that
 * it travels with the data, and this endpoint publishes rates.
 */
const DISCLAIMER =
  "Scores are informational only and do not constitute a guarantee, credit assessment, or investment advice.";

/**
 * Machine-readable copy of the notes /accuracy prints next to these numbers.
 *
 * WORDING IS COPIED, NOT INVENTED: every sentence below is the same sentence
 * src/app/accuracy/page.tsx renders (§1 legal note, §2 known-bad note, §2
 * known-good note, §3.4 minimum sample). If one side is reworded, reword both —
 * the entire point of this field is that the machine layer and the human layer
 * cannot disagree.
 */
function buildInterpretation(report: AccuracyReport, benchmark: BenchmarkReport) {
  const caveats: string[] = [];

  // §1 legal note — applies to every rate in the document.
  caveats.push(
    "These figures are historical: they describe verdicts vet402 has already issued and outcomes we have already observed, over a rolling 90-day window. They are not a forecast, a service-level commitment, or a warranty of the accuracy of any future score. Past rates can and will move as the sample grows and as the behavior we score changes.",
  );

  // §3.4 minimum sample — the reason a rate can be null.
  caveats.push(
    `A rate is published only at ${report.minSample}+ resolved verdicts for that bucket; below that it is null rather than a number computed from noise.`,
  );

  // §2 known-bad note. Same condition as the page: only claimed when a
  // known-bad address actually stopped at WARN.
  if (benchmark.knownBad.warned > 0) {
    const one = benchmark.knownBad.warned === 1;
    caveats.push(
      `On that ${benchmark.knownBad.detectionRate ?? 0}%: a detection here counts BLOCK or WARN. ` +
        `${benchmark.knownBad.warned} of the ${benchmark.knownBad.total} known-bad addresses ` +
        `${one ? "scores" : "score"} WARN rather than BLOCK, so an integration that lets WARN ` +
        `through would pay ${one ? "it" : "them"}. The SDK and the middleware default to ` +
        `allow-only, which is why that default exists.`,
    );
  }

  // §2 known-good note.
  if (benchmark.knownGood.total > 0 && benchmark.knownGood.allowed === 0) {
    caveats.push(
      `On that 0%: a false positive here counts only a BLOCK on a known-good address. None of ` +
        `the ${benchmark.knownGood.total} known-good addresses currently scores ALLOW — ` +
        `${benchmark.knownGood.warned} of them score WARN — so 0% means "none were blocked", ` +
        `not "all were passed". The engine is cautious on this set, not accurate on it.`,
    );
  }

  return {
    /** operatorBenchmark.knownBad.detectionRate counts BLOCK *or* WARN. */
    detectionRateCountsWarnAsDetection: true,
    /** …and this many of them stopped at WARN, which a WARN-passing caller pays. */
    knownBadWarnOnly: benchmark.knownBad.warned,
    /** operatorBenchmark.knownGood.falsePositiveRate counts BLOCK only. */
    falsePositiveRateCountsBlockOnly: true,
    knownGoodAllowed: benchmark.knownGood.allowed,
    knownGoodWarned: benchmark.knownGood.warned,
    /** Self-seeded benchmark rows are partitioned out of every field above it. */
    externalFiguresExcludeOperatorBenchmark: true,
    /** Below this many resolved verdicts a rate is null, not a number. */
    minSample: report.minSample,
    caveats,
    humanReadable: `${SITE_URL}/accuracy`,
  };
}

// 2026-09-02 監査: 静的化された route handler が prerender から古い判定を返すのを防ぐ（09c1fa0 と同じ欠陥）。
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const now = Date.now();

  // Limiter runs BEFORE the cache short-circuit (2026-08-13). Two reasons: the
  // documented ceiling (20/min/IP) was not actually applied to a cache hit, and
  // — the reported defect — a cached response carried no RateLimit-* headers at
  // all, so a machine had nothing on the wire to read its budget from.
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`accuracy:${ip}`, 20, 60_000);
  // Two header sets, because most responses here are served to other callers
  // from the shared CDN cache: `perCaller` (Remaining/Reset/Retry-After) goes
  // only on responses the CDN does not share, `shared` carries the ceiling,
  // which is true for everyone. See sharedCacheRateLimitHeaders.
  const perCallerRlHeaders = ipRateLimitHeaders(limited);
  const rlHeaders = sharedCacheRateLimitHeaders(limited);
  if (!limited.allowed) {
    // 2026-08-06: full RateLimit-* header set, consistent with the other
    // key-less public paths.
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: perCallerRlHeaders });
  }

  if (cached && cached.expiresAt > now) {
    return NextResponse.json(cached.body, {
      headers: {
        ...rlHeaders,
        "Cache-Control": "public, s-maxage=600, stale-while-revalidate=1200",
      },
    });
  }

  try {
    const rows = await fetchAccuracyRows(90);
    const report = computeAccuracyReport(rows);
    // Operator benchmark rides along as its OWN key, never merged into the
    // external fields: fetchAccuracyRows excludes source='operator_benchmark'
    // at the SQL layer and fetchBenchmarkRows selects only it, so the two
    // objects partition verdict_outcomes — a consumer cannot double-count.
    const operatorBenchmark = computeBenchmarkReport(await fetchBenchmarkRows(90));
    // 製品定義書 §12 / §14（2026-09-02）: 測定機関自身の品質。L0 の誤 pass / 誤 fail、
    // 鮮度・逆引き遅延・証拠完備率の SLO、週次カバレッジ。測れない項目は null と
    // unmeasured に名指しで残す（隠さない）。
    const [l0Input, slo, coverageWeekly] = await Promise.all([
      fetchL0AccuracyInput().catch(() => null),
      fetchSloSnapshot().catch(() => null),
      getCoverageWeekly().catch(() => null),
    ]);
    const body = {
      ...report,
      operatorBenchmark,
      l0: l0Input ? computeL0Accuracy(l0Input) : null,
      slo,
      coverageWeekly,
      windowDays: 90,
      generatedAt: new Date(now).toISOString(),
      interpretation: buildInterpretation(report, operatorBenchmark),
      disclaimer: DISCLAIMER,
    };
    cached = { body, expiresAt: now + CACHE_TTL_MS };
    return NextResponse.json(body, {
      headers: {
        ...rlHeaders,
        "Cache-Control": "public, s-maxage=600, stale-while-revalidate=1200",
      },
    });
  } catch (error) {
    logServerError("accuracy_report", error);
    return NextResponse.json(
      { error: "accuracy_unavailable" },
      // Not CDN-cached, so the per-caller numbers are still the caller's own.
      { status: 503, headers: perCallerRlHeaders },
    );
  }
}
