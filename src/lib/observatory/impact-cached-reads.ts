// ============================================================
// /impact 専用の読み取りキャッシュ（2026-11-07）。
//
// 実測（2026-11-07, 本番 curl, TTFB）: /impact は冷 3.8s・温 2.3s。
// stats / coverage は cached-reads があったが未使用で、残り 4 読みも毎回 DB。
// 窓は他の公開頁と同じ PUBLIC_READ_REVALIDATE（値は 1 つだけ・public-read-revalidate.ts）。
// 頁の export const revalidate = 900 は nonce のため効いていないので、根拠にしない。
//
// **API ルートはここを使わない**（tests/public-page-cache.test.ts）。
// ============================================================
import { unstable_cache } from "next/cache";
import { PUBLIC_READ_REVALIDATE } from "./public-read-revalidate";
import {
  getCoverageShare,
  getObservatoryStats,
  type CoverageShare,
  type ObservatoryStats,
} from "@/lib/observatory/reader";
import { computeSpendGuardBacktest, type BacktestResult } from "@/lib/observatory/backtest";
import { getDecisionFeed, getLatestSettledReceipts, type DecisionFeed, type SettledReceipt } from "@/lib/observatory/decisions";
import { getAnchors, type AnchorRow } from "@/lib/observatory/anchors";

export type ImpactHeadlineRead = { stats: ObservatoryStats; coverage: CoverageShare; readAt: string };
export type BacktestRead = BacktestResult & { readAt: string };
export type DecisionFeedRead = DecisionFeed & { readAt: string };
export type AnchorsRead = { rows: AnchorRow[]; readAt: string };
export type SettledReceiptsRead = { rows: SettledReceipt[]; readAt: string };

/**
 * §1 の段落は stats と coverage の数を並べる（"{stats.activeEndpoints} active" と
 * "of the {coverage.activeEndpoints} active records"）。別々のキャッシュだと埋まる時刻がずれ、
 * 同じ段落に別の時点の数が並ぶので、1 つの読みにまとめて readAt を 1 つにする。
 */
export const getImpactHeadlineCached: () => Promise<ImpactHeadlineRead> = unstable_cache(
  async () => {
    const readAt = new Date().toISOString();
    const [stats, coverage] = await Promise.all([getObservatoryStats(), getCoverageShare()]);
    return { stats, coverage, readAt };
  },
  ["observatory:impact-headline:readAt"],
  { revalidate: PUBLIC_READ_REVALIDATE, tags: ["observatory", "impact"] },
);

export const getSpendGuardBacktestCached: () => Promise<BacktestRead> = unstable_cache(
  async () => {
    const readAt = new Date().toISOString();
    return { ...(await computeSpendGuardBacktest()), readAt };
  },
  ["observatory:backtest:impact:readAt"],
  { revalidate: PUBLIC_READ_REVALIDATE, tags: ["observatory", "impact"] },
);

export const getDecisionFeed30Cached: () => Promise<DecisionFeedRead> = unstable_cache(
  async () => {
    const readAt = new Date().toISOString();
    return { ...(await getDecisionFeed(30)), readAt };
  },
  ["observatory:decisions-30d:impact:readAt"],
  { revalidate: PUBLIC_READ_REVALIDATE, tags: ["observatory", "impact"] },
);

export const getImpactAnchorsCached: () => Promise<AnchorsRead> = unstable_cache(
  async () => {
    const readAt = new Date().toISOString();
    return { rows: await getAnchors(1), readAt };
  },
  ["observatory:anchors-1d:impact:readAt"],
  { revalidate: PUBLIC_READ_REVALIDATE, tags: ["observatory", "impact"] },
);

export const getLatestSettledReceipts5Cached: () => Promise<SettledReceiptsRead> = unstable_cache(
  async () => {
    const readAt = new Date().toISOString();
    return { rows: await getLatestSettledReceipts(5), readAt };
  },
  ["observatory:settled-receipts-5:impact:readAt"],
  { revalidate: PUBLIC_READ_REVALIDATE, tags: ["observatory", "impact"] },
);

export function withoutReadAt<T extends { readAt: string }>({ readAt, ...rest }: T): Omit<T, "readAt"> {
  void readAt;
  return rest;
}
