import { and, desc, eq, gte, ne } from "drizzle-orm";
import { getDb } from "./client";
import { isMissingSchemaError } from "./pg-errors";
import { trustEvents, verdictOutcomes } from "./schema";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import type { AccuracyRow } from "@/lib/scoring/accuracy";
import type { BenchmarkRow } from "@/lib/scoring/benchmark-report";
import { OPERATOR_BENCHMARK_SOURCE } from "@/lib/benchmark/dataset";

/**
 * The read side of verdict_outcomes (2026-08-05 R&D).
 *
 * Joins each outcome to the verdict it judges, so the accuracy module can
 * answer "of the ALLOWs we issued, how many later went bad". Same defensive
 * posture as every other module touching post-launch tables: a missing table
 * or column degrades to an empty result and a log line, never a 500 — the
 * public /accuracy page has an honest empty state and must render even when
 * the database predates the migration.
 */
export async function fetchAccuracyRows(windowDays = 90): Promise<AccuracyRow[]> {
  const db = getDb();
  if (!db) return [];

  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  try {
    const rows = await db
      .select({
        trustEventId: verdictOutcomes.trustEventId,
        recommendation: trustEvents.recommendation,
        outcomeType: verdictOutcomes.outcomeType,
        source: verdictOutcomes.source,
        detectedAt: verdictOutcomes.detectedAt,
      })
      .from(verdictOutcomes)
      .innerJoin(trustEvents, eq(trustEvents.id, verdictOutcomes.trustEventId))
      // Operator-benchmark rows are excluded HERE, at the query, not in the
      // callers: the external accuracy report is the product's central
      // honesty claim, and self-seeded rows padding it — because some future
      // caller forgot to filter — would be the exact fabrication /accuracy
      // exists to reject. Benchmark rows have their own reader below.
      .where(
        and(
          gte(verdictOutcomes.detectedAt, since),
          ne(verdictOutcomes.source, OPERATOR_BENCHMARK_SOURCE),
        ),
      )
      .limit(50_000);

    return rows.map((r) => ({
      trustEventId: r.trustEventId,
      recommendation: r.recommendation,
      outcomeType: r.outcomeType,
      source: r.source,
      detectedAt: r.detectedAt,
    }));
  } catch (error) {
    if (isMissingSchemaError(error)) {
      // Table not migrated yet — the page's empty state covers this.
      return [];
    }
    logServerErrorSafe("accuracy_rows_fetch", error);
    return [];
  }
}

/**
 * Read side of the operator benchmark (2026-08-06): ONLY rows the benchmark
 * runner wrote (source = 'operator_benchmark'), joined to the seeded verdict
 * for its recommendation. The mirror image of the exclusion in
 * fetchAccuracyRows — together they partition verdict_outcomes so no row can
 * be counted in both reports. Same degrade-to-empty posture: /accuracy must
 * render on a database that predates the tables.
 */
export async function fetchBenchmarkRows(windowDays = 90): Promise<BenchmarkRow[]> {
  const db = getDb();
  if (!db) return [];

  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  try {
    const rows = await db
      .select({
        relatedWallet: verdictOutcomes.relatedWallet,
        recommendation: trustEvents.recommendation,
        outcomeType: verdictOutcomes.outcomeType,
        detectedAt: verdictOutcomes.detectedAt,
      })
      .from(verdictOutcomes)
      .innerJoin(trustEvents, eq(trustEvents.id, verdictOutcomes.trustEventId))
      .where(
        and(
          gte(verdictOutcomes.detectedAt, since),
          eq(verdictOutcomes.source, OPERATOR_BENCHMARK_SOURCE),
        ),
      )
      .orderBy(desc(verdictOutcomes.detectedAt))
      .limit(50_000);

    return rows;
  } catch (error) {
    if (isMissingSchemaError(error)) return [];
    logServerErrorSafe("benchmark_rows_fetch", error);
    return [];
  }
}
