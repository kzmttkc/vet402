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
// 鮮度は「表示している値の更新頻度」から決める。これらの値を書き換えるのは
// vercel.json の日次 cron（catalog-sync 01:00 / l0-probe 10:30 /
// l1-purchase 12:00 / metrics-rollup 10:30 UTC）だけなので、分単位の窓では
// 実質何も古くならない。窓を跨いだ瞬間に次の読み手が新しい値を引く。
//
// **API ルートはここを使わない。** `/api/v1/observatory/state` は body に
// `retrievedAt` を入れて「取得時刻つきで引用してよい」と宣言している面なので、
// キャッシュを噛ませるとその時刻が嘘になる。読み取りキャッシュは
// 時刻を主張しない HTML 頁だけに閉じる（tests/public-page-cache.test.ts が固定）。
// ============================================================
import { unstable_cache } from "next/cache";
import {
  getCoverageShare,
  getObservatoryStats,
  getObservatoryStatsByChain,
  getUnverifiedBreakdown,
  type ChainStats,
  type CoverageShare,
  type ObservatoryStats,
  type UnverifiedBreakdown,
} from "@/lib/observatory/reader";

/**
 * 秒。**1 つの値しか置かない。**
 *
 * 面ごとに 300 / 600 / 3600 と刻みたくなるが、それをやると
 * 「方法論頁の 5 つの内訳の合計は /api/v1/observatory/state の
 * publishedUnverified と一致する」という頁自身の主張が、cron 直後の
 * 最大 1 時間だけ崩れる。頁と API の食い違いを 5 分に閉じ、
 * その 5 分をここに書いておく方が、鮮度を刻んで得られる速度より価値がある。
 */
export const PUBLIC_READ_REVALIDATE = 300;

export const getObservatoryStatsCached: () => Promise<ObservatoryStats> = unstable_cache(
  () => getObservatoryStats(),
  ["observatory:stats"],
  { revalidate: PUBLIC_READ_REVALIDATE, tags: ["observatory"] },
);

export const getCoverageShareCached: () => Promise<CoverageShare> = unstable_cache(
  () => getCoverageShare(),
  ["observatory:coverage-share"],
  { revalidate: PUBLIC_READ_REVALIDATE, tags: ["observatory"] },
);

export const getObservatoryStatsByChainCached: () => Promise<ChainStats[]> = unstable_cache(
  () => getObservatoryStatsByChain(),
  ["observatory:stats-by-chain"],
  { revalidate: PUBLIC_READ_REVALIDATE, tags: ["observatory"] },
);

export const getUnverifiedBreakdownCached: () => Promise<UnverifiedBreakdown> = unstable_cache(
  () => getUnverifiedBreakdown(),
  ["observatory:unverified-breakdown"],
  { revalidate: PUBLIC_READ_REVALIDATE, tags: ["observatory"] },
);
