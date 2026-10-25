// ============================================================
// 公開 HTML ページ専用の読み取りキャッシュ（2026-09-05 SEO/AEO 是正）。
//
// 実測（2026-09-05, 本番 curl, 日本から）:
//   /                        TTFB 0.82s   x-vercel-cache: MISS
//   /observatory             TTFB 0.80s   MISS
//   /observatory/methodology TTFB 0.64s   MISS
//   /faq                     TTFB 0.34s   MISS   ← DB を引かない頁＝下限
// 全公開頁が `private, no-cache, no-store` で毎回 SSR される。原因は
// src/proxy.ts が CSP に per-request nonce を入れており、ルート layout が
// `headers()` でそれを読むこと。Next.js の仕様上、nonce を読むツリーは
// 動的レンダリングになる（`export const revalidate` を書いても効かない）。
// つまり CDN キャッシュを効かせるには CSP を弱めるしかなく、それは
// SEO の判断ではなくセキュリティの判断なので、ここではやらない。
//
// 代わりに「毎回 SSR する」ことは受け入れたまま、SSR の中身を安くする。
// 上の差（0.82s vs 0.34s）はほぼ全部が集計 SQL の時間なので、頁が読む
// 集計だけを Next の Data Cache に載せる。TTFB は Core Web Vitals の
// server response time に直接効き、クロール時の 1 頁あたりのコストも下がる。
//
// 鮮度の窓は SSR のコストを下げる再利用である。2026-10-20 の実測では被覆の
// 分子が 6 分で動いた。プローブは cron の間も終わるので、この窓は件数が
// 次の cron まで凍るという意味ではない。頁は readAt を出し、API の
// retrievedAt とは別に読む。
//
// **API ルートはここを使わない。** `/api/v1/observatory/state` は body に
// `retrievedAt` を入れて「取得時刻つきで引用してよい」と宣言している面なので、
// このキャッシュを API に噛ませると、その時刻が充填時刻のまま残る。HTML 頁は
// 同じ充填で readAt を刻み、描画のたびに新しい Date を出さない
// （tests/public-page-cache.test.ts が、API ルートがこのファイルを import しないことを固定する）。
// ============================================================
import { unstable_cache } from "next/cache";
import { PUBLIC_READ_REVALIDATE } from "./public-read-revalidate";
import {
  getChainScope,
  getCoverageShare,
  getObservatoryOverview,
  getObservatoryStats,
  getObservatoryStatsByChain,
  getUnverifiedBreakdown,
  type ChainScope,
  type ChainStats,
  type CoverageShare,
  type ObservatoryOverview,
  type ObservatoryStats,
  type UnverifiedBreakdown,
} from "@/lib/observatory/reader";

/** 頁が描いた集計の読んだ時刻。キャッシュが埋まった時刻で、描画のたびに進まない。 */
export type ObservatoryStatsRead = ObservatoryStats & { readAt: string };
export type CoverageShareRead = CoverageShare & { readAt: string };

/** 窓の値と理由は public-read-revalidate.ts（/sellers が reader.ts の依存を読まずに同じ値を使うため・2026-09-28）。 */
export { PUBLIC_READ_REVALIDATE };

/**
 * `readAt` は DB を読んだ時刻（キャッシュを埋めた時点・ISO8601 UTC）。2026-10-21: トップ頁の
 * 「The public ledger」はこの日付を出す。描画時刻ではなく読んだ時刻なので、窓の中で頁を開いても嘘にならない。
 * キーは readAt の無い旧い形と分けた（observatory:stats:readAt）ので、デプロイ直後も readAt は必ずある。
 */
export const getObservatoryStatsCached: () => Promise<ObservatoryStatsRead> = unstable_cache(
  async () => ({ ...(await getObservatoryStats()), readAt: new Date().toISOString() }),
  ["observatory:stats:readAt"],
  { revalidate: PUBLIC_READ_REVALIDATE, tags: ["observatory"] },
);

export const getCoverageShareCached: () => Promise<CoverageShareRead> = unstable_cache(
  async () => ({ ...(await getCoverageShare()), readAt: new Date().toISOString() }),
  ["observatory:coverage-share:readAt"],
  { revalidate: PUBLIC_READ_REVALIDATE, tags: ["observatory"] },
);

/** チェーン表の読み。配列のままキャッシュしていた世代と形が違うのでキーを分けた。 */
export type ChainStatsRead = { rows: ChainStats[]; readAt: string };

export const getObservatoryStatsByChainCached: () => Promise<ChainStatsRead> = unstable_cache(
  async () => ({ rows: await getObservatoryStatsByChain(), readAt: new Date().toISOString() }),
  ["observatory:stats-by-chain:readAt"],
  { revalidate: PUBLIC_READ_REVALIDATE, tags: ["observatory"] },
);

/** L0 のチェーン別表（mainnet だけ）の外に出た件数（2026-09-29 監査 5 周目）。 */
export const getChainScopeCached: () => Promise<ChainScope> = unstable_cache(
  () => getChainScope(),
  ["observatory:chain-scope"],
  { revalidate: PUBLIC_READ_REVALIDATE, tags: ["observatory"] },
);

export const getUnverifiedBreakdownCached: () => Promise<UnverifiedBreakdown> = unstable_cache(
  () => getUnverifiedBreakdown(),
  ["observatory:unverified-breakdown"],
  { revalidate: PUBLIC_READ_REVALIDATE, tags: ["observatory"] },
);


/**
 * 2026-10-25: /observatory は表示のたびに 8.7 万件の一覧を集計していて、サーバーの待ちが 2 秒前後あった。
 * 同じ絞り込みの読みは公開の窓（PUBLIC_READ_REVALIDATE）の間使い回す。キャッシュは JSON なので
 * lastProbedAt の Date は ISO 文字列で預け、取り出すときに Date に戻す（overviewToCache / overviewFromCache）。
 */
/** getObservatoryOverview の引数の形。 */
type ObservatoryOverviewQuery = NonNullable<Parameters<typeof getObservatoryOverview>[0]>;

type CachedOverview = Omit<ObservatoryOverview, "rows"> & {
  rows: Array<Omit<ObservatoryOverview["rows"][number], "lastProbedAt"> & { lastProbedAt: string | null }>;
};

export function overviewToCache(o: ObservatoryOverview): CachedOverview {
  return { ...o, rows: o.rows.map((r) => ({ ...r, lastProbedAt: r.lastProbedAt ? r.lastProbedAt.toISOString() : null })) };
}

export function overviewFromCache(c: CachedOverview): ObservatoryOverview {
  return { ...c, rows: c.rows.map((r) => ({ ...r, lastProbedAt: r.lastProbedAt ? new Date(r.lastProbedAt) : null })) };
}

/** これより深いページは毎回読む。 */
export const OVERVIEW_CACHED_MAX_PAGE = 10;

const overviewCached = unstable_cache(
  async (key: string) => overviewToCache(await getObservatoryOverview(JSON.parse(key) as ObservatoryOverviewQuery)),
  ["observatory:overview:v1"],
  { revalidate: PUBLIC_READ_REVALIDATE, tags: ["observatory"] },
);

/** 絞り込みごとに使い回す。鍵は値のある項目だけを名前順に並べた JSON。 */
export async function getObservatoryOverviewCached(query: ObservatoryOverviewQuery): Promise<ObservatoryOverview> {
  // 深いページは鍵の数を増やすだけなので使い回さない（2026-10-25 審査: page に上限が無く鍵が無制限に増える）。
  if ((query.page ?? 1) > OVERVIEW_CACHED_MAX_PAGE) return getObservatoryOverview(query);
  const entries = Object.entries(query).filter(([, v]) => v !== undefined && v !== null).sort(([a], [b]) => a.localeCompare(b));
  return overviewFromCache(await overviewCached(JSON.stringify(Object.fromEntries(entries))));
}
