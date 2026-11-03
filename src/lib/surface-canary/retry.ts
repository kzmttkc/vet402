// ============================================================
// 面の間のずれを見る計器の取り直しの決まり（scripts/surface-consistency-canary.ts が使う）。
//
// 429（枠）・503（一時停止）・504（関数の時間切れ）は、面が言っていることではなく取得の失敗なので取り直す。
// 2026-11-02 の赤は /api/v1/observatory/l0/export.csv の 504 FUNCTION_INVOCATION_TIMEOUT 1 回で標本が 0 になった。
// ============================================================
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 503, 504]);
const MIN_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 90_000;
const DEFAULT_BACKOFF_MS = 15_000;

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status);
}

/** Retry-After（秒）か ratelimit-reset（epoch 秒）を待つ。どちらも無ければ 15 秒から倍々。attempt は 0 始まり。 */
export function retryBackoffMs(headers: Headers, now: number, attempt: number): number {
  const ra = Number(headers.get("retry-after"));
  const reset = Number(headers.get("ratelimit-reset"));
  const wait =
    Number.isFinite(ra) && ra > 0
      ? ra * 1000
      : Number.isFinite(reset) && reset > 1e9
        ? reset * 1000 - now
        : DEFAULT_BACKOFF_MS * 2 ** attempt;
  return Math.min(Math.max(wait, MIN_BACKOFF_MS), MAX_BACKOFF_MS);
}
