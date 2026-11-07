// ============================================================
// /accuracy 専用の読み取りキャッシュ（2026-11-07）。
//
// 実測（2026-11-07, 本番 curl, TTFB）: /accuracy は冷 12.7s・温 5.0s。
// 原因は他の公開頁と同じ（CSP nonce で毎回 SSR）。集計 SQL を 4 本直列で
// 引いていたので、Data Cache に載せて Promise.all で並列にする。
// 窓は他の公開頁と同じ PUBLIC_READ_REVALIDATE（値は 1 つだけ）。readAt は SQL を投げる前に取る:
// 「168 時間 to {readAt}」の終わりは SQL の now() で、読み終えた時刻ではない。
//
// **API ルートはここを使わない**（tests/public-page-cache.test.ts）。
// ============================================================
import { unstable_cache } from "next/cache";
import { PUBLIC_READ_REVALIDATE } from "@/lib/observatory/public-read-revalidate";
import { fetchAccuracyRows, fetchBenchmarkRows } from "@/lib/db/outcome-reader";
import { computeAccuracyReport, type AccuracyReport } from "@/lib/scoring/accuracy";
import { computeBenchmarkReport, type BenchmarkReport } from "@/lib/scoring/benchmark-report";
import {
  computeL0Accuracy,
  fetchL0AccuracyInput,
  fetchSloSnapshot,
  type L0Accuracy,
  type SloSnapshot,
} from "@/lib/scoring/l0-accuracy";

/** 頁が描いた集計の読んだ時刻（キャッシュ充填時・ISO8601 UTC）。 */
export type AccuracyReportRead = AccuracyReport & { readAt: string };
export type BenchmarkReportRead = BenchmarkReport & { readAt: string };
export type L0AccuracyRead = { l0: L0Accuracy; readAt: string };
export type SloSnapshotRead = { slo: SloSnapshot; readAt: string };

/** 外部利用の正確性レポート（90 日窓）。実測冷 12.7s の主因のひとつ。 */
export const getAccuracyReportCached: () => Promise<AccuracyReportRead> = unstable_cache(
  async () => {
    const readAt = new Date().toISOString();
    return {
      ...computeAccuracyReport(await fetchAccuracyRows(90)),
      readAt,
    };
  },
  ["accuracy:external-report:readAt"],
  { revalidate: PUBLIC_READ_REVALIDATE, tags: ["accuracy"] },
);

/** オペレータベンチマーク（SQL で外部行と分離済み）。 */
export const getBenchmarkReportCached: () => Promise<BenchmarkReportRead> = unstable_cache(
  async () => {
    const readAt = new Date().toISOString();
    return {
      ...computeBenchmarkReport(await fetchBenchmarkRows(90)),
      readAt,
    };
  },
  ["accuracy:benchmark-report:readAt"],
  { revalidate: PUBLIC_READ_REVALIDATE, tags: ["accuracy"] },
);

/** L0 誤 fail / 誤 pass（API の l0 と同じ関数）。 */
export const getL0AccuracyCached: () => Promise<L0AccuracyRead> = unstable_cache(
  async () => {
    const readAt = new Date().toISOString();
    return {
      l0: await fetchL0AccuracyInput().then(computeL0Accuracy),
      readAt,
    };
  },
  ["accuracy:l0:readAt"],
  { revalidate: PUBLIC_READ_REVALIDATE, tags: ["accuracy"] },
);

/** 運用 SLO スナップショット（API の slo と同じ）。 */
export const getSloSnapshotCached: () => Promise<SloSnapshotRead> = unstable_cache(
  async () => {
    const readAt = new Date().toISOString();
    return {
      slo: await fetchSloSnapshot(),
      readAt,
    };
  },
  ["accuracy:slo-snapshot:readAt"],
  { revalidate: PUBLIC_READ_REVALIDATE, tags: ["accuracy"] },
);

export function withoutReadAt<T extends { readAt: string }>({ readAt, ...rest }: T): Omit<T, "readAt"> {
  void readAt;
  return rest;
}
