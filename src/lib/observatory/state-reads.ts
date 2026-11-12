/**
 * The aggregates GET /api/v1/observatory/state publishes (2026-11-08).
 *
 * Read through the same 5-minute shared data cache the HTML pages use, so a CDN
 * miss does not recompute every aggregate live (4.15 s on the first call vs
 * 0.05 s from the CDN, measured 2026-11-08). Outside the Next.js runtime (unit
 * tests call the route directly) there is no data cache and `unstable_cache`
 * throws its incrementalCache invariant. Only that error falls back to a live
 * read: a database error inside the cached read is rethrown as before.
 */
import {
  getChainScopeCached,
  getCoverageShareCached,
  getObservatoryStatsByChainCached,
  getObservatoryStatsCached,
  getPurchaseLifecycleCached,
} from "@/lib/observatory/cached-reads";
import { readPurchaseLifecycleCounts } from "@/lib/observatory/purchase-lifecycle-read";
import { getChainScope, getCoverageShare, getObservatoryStats, getObservatoryStatsByChain } from "@/lib/observatory/reader";

export function isNoDataCacheError(error: unknown): boolean {
  return error instanceof Error && /incrementalCache missing/i.test(error.message);
}

export async function readStateAggregates() {
  try {
    const [statsRead, byChainRead, chainScope, coverageRead, lifecycleRead] = await Promise.all([
      getObservatoryStatsCached(),
      getObservatoryStatsByChainCached(),
      getChainScopeCached(),
      getCoverageShareCached(),
      getPurchaseLifecycleCached(),
    ]);
    const { readAt: statsReadAt, ...stats } = statsRead;
    const { readAt: coverageReadAt, ...coverage } = coverageRead;
    // The oldest of the cached reads, so the body never looks fresher than its numbers.
    const retrievedAt = [statsReadAt, coverageReadAt, byChainRead.readAt].sort()[0]!;
    const publishedAt = [retrievedAt, lifecycleRead.readAt].sort()[0]!;
    return { stats, byChain: byChainRead.rows, chainScope, coverage, lifecycle: lifecycleRead.counts, retrievedAt: publishedAt };
  } catch (error) {
    if (!isNoDataCacheError(error)) throw error;
    const [stats, byChain, chainScope, coverage, lifecycle] = await Promise.all([
      getObservatoryStats(),
      getObservatoryStatsByChain(),
      getChainScope(),
      getCoverageShare(),
      readPurchaseLifecycleCounts(),
    ]);
    return { stats, byChain, chainScope, coverage, lifecycle, retrievedAt: new Date().toISOString() };
  }
}
