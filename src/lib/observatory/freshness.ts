// ============================================================
// 公開面ごとの「最大でどれだけ古い値を見うるか」（2026-09-29 監査 6 周目・整合性の監査人）。
//
// llms.txt は「state は up to 15 minutes（s-maxage=900）」と書いていたが、同じ応答は
// stale-while-revalidate=1800 も送るので、CDN は 15 分を過ぎた写しを裏で作り直す間さらに 30 分出せる
// ——最大 45 分。面ごとの実値は各 route の Cache-Control にある。ここに写し、
// tests/audit-r6-consistency.test.ts が route のソースと突き合わせる（片方だけ変わったら落ちる）。
// llms.txt（静的ファイル）と llms-full.txt（ここから生成）の Freshness 節はこの表の行をそのまま載せる。
// ============================================================

export type FreshnessRow = {
  /** 面（llms.txt に出す名前）。 */
  surface: string;
  /** 値を決めているソース（リポ相対）。テストがここを読んで cacheControl を探す。 */
  sources: readonly string[];
  /** 応答の Cache-Control（そのまま）。CDN を通らない面は null。 */
  cacheControl: string | null;
  /** 最大の古さ（秒）。Cache-Control があれば s-maxage + stale-while-revalidate（max-age だけなら max-age）。 */
  maxStaleSec: number;
  /** Cache-Control 以外で古さが決まる面の説明。 */
  mechanism?: string;
};

/** Cache-Control から最大の古さ（秒）: 共有キャッシュは s-maxage（無ければ max-age）＋ stale-while-revalidate。 */
export function maxStaleSecondsOf(cacheControl: string): number {
  const num = (k: string) => {
    const m = new RegExp(`(?:^|[,\\s])${k}=(\\d+)`).exec(cacheControl);
    return m ? Number(m[1]) : null;
  };
  const fresh = num("s-maxage") ?? num("max-age") ?? 0;
  return fresh + (num("stale-while-revalidate") ?? 0);
}

const cc = (surface: string, sources: readonly string[], cacheControl: string): FreshnessRow => ({
  surface,
  sources,
  cacheControl,
  maxStaleSec: maxStaleSecondsOf(cacheControl),
});

export const PUBLIC_FRESHNESS: readonly FreshnessRow[] = [
  {
    surface: "HTML pages that print observatory or /sellers aggregates (/, /observatory, /observatory/state, /sellers)",
    sources: ["src/lib/observatory/public-read-revalidate.ts"],
    cacheControl: null,
    maxStaleSec: 300,
    mechanism:
      "rendered on every request, reading the aggregates through a 5-minute data cache (`PUBLIC_READ_REVALIDATE`, 300 s). A read after the window is served the older copy once while the fresh one is computed, so after a quiet spell one page view can be older than 5 minutes",
  },
  {
    surface: "`GET /api/v1/resources/{resourceId}/decision`",
    sources: ["src/lib/decision/cache.ts"],
    cacheControl: null,
    maxStaleSec: 300,
    mechanism:
      "no `Cache-Control`; each server instance reuses a decision it computed for up to 5 minutes (`DECISION_CACHE_TTL_MS`), so a copy can be up to 5 minutes old",
  },
  cc(
    "`GET /api/v1/observatory/state`",
    ["src/app/api/v1/observatory/state/route.ts"],
    "public, s-maxage=900, stale-while-revalidate=1800",
  ),
  cc(
    "`GET /api/v1/observatory/decisions`",
    ["src/app/api/v1/observatory/decisions/route.ts"],
    "public, s-maxage=900, stale-while-revalidate=1800",
  ),
  cc(
    "`GET /api/v1/observatory/l0/export.csv`",
    ["src/app/api/v1/observatory/l0/export.csv/route.ts"],
    "public, s-maxage=900, stale-while-revalidate=1800",
  ),
  cc(
    "`GET /api/v1/sellers/export.csv`",
    ["src/app/api/v1/sellers/export.csv/route.ts"],
    "public, s-maxage=900, stale-while-revalidate=1800",
  ),
  cc(
    "`GET /api/v1/accuracy`",
    ["src/app/api/v1/accuracy/route.ts"],
    "public, s-maxage=600, stale-while-revalidate=1200",
  ),
  cc(
    "`GET /api/v1/observatory/endpoints/{id}/purchases`",
    ["src/app/api/v1/observatory/endpoints/[id]/purchases/route.ts"],
    "public, s-maxage=600, stale-while-revalidate=1200",
  ),
  cc(
    "`GET /api/v1/observatory/export.csv`, `/history`, `/anchors`, `/backtest`, `/concentration`",
    [
      "src/app/api/v1/observatory/export.csv/route.ts",
      "src/app/api/v1/observatory/history/route.ts",
      "src/app/api/v1/observatory/anchors/route.ts",
      "src/app/api/v1/observatory/backtest/route.ts",
      "src/app/api/v1/observatory/concentration/route.ts",
    ],
    "public, s-maxage=3600, stale-while-revalidate=7200",
  ),
  cc(
    "`GET /api/v1/census/summary`",
    ["src/app/api/v1/census/summary/route.ts"],
    "public, max-age=300, s-maxage=300, stale-while-revalidate=900",
  ),
  cc(
    "key-less object reads (`/api/v1/resolve`, `/resources/{id}`, `/endpoints/{id}`, `/endpoints/{id}/payees`, `/payees/{address}/endpoints`, `/observatory/endpoints/{id}/facts`, `/observatory/corrections`)",
    ["src/lib/api/public-route.ts"],
    "public, max-age=60, s-maxage=60, stale-while-revalidate=300",
  ),
  cc("`/llms.txt` and `/llms-full.txt`", ["next.config.ts", "src/app/llms-full.txt/route.ts"], "public, max-age=3600"),
];

/** 秒を英語の長さに（900 → "15 minutes"、10800 → "3 hours"）。 */
export function humanDuration(sec: number): string {
  if (sec % 3600 === 0) {
    const h = sec / 3600;
    return h === 1 ? "1 hour" : `${h} hours`;
  }
  const m = Math.round(sec / 60);
  return m === 1 ? "1 minute" : `${m} minutes`;
}

/** Freshness 節で表の前に置く 1 文（llms.txt にも同じ文がある・テストが突き合わせる）。 */
export const FRESHNESS_LEAD =
  "Caches: the longest a copy you receive can lag the database, per surface. A shared-cache copy is served fresh for `s-maxage` and, with `stale-while-revalidate`, for that much longer while a fresh one is computed, so the most it can lag is the sum of the two. The `Age` response header says how long the copy you received sat in the cache. A page and the JSON can therefore show different numbers for a while after a run \u2014 compare their retrieval times rather than assume either is newer.";

/** llms.txt / llms-full.txt の Freshness 節に載せる行（Markdown の箇条書き 1 行ずつ）。 */
export function freshnessLines(): string[] {
  return PUBLIC_FRESHNESS.map((r) =>
    r.cacheControl
      ? `- ${r.surface}: \`Cache-Control: ${r.cacheControl}\` — a copy can be up to ${humanDuration(r.maxStaleSec)} old.`
      : `- ${r.surface}: ${r.mechanism}.`,
  );
}
