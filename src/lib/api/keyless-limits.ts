/**
 * 鍵なし読み取りの回数。公開文はここの値から作る（2026-10-26）。
 *
 * /decision は DECISION_KEYLESS_READ が "0" のとき 401 に戻る（env.ts）。
 * 公開文は「いま開いている」と「旗で止まる」の両方を言う。
 */
export const DECISION_KEYLESS_LIMIT = 10;
export const DECISION_KEYLESS_WINDOW_MS = 60_000;

/** /resolve が publicRateLimit に渡す回数。窓は 60 秒。 */
export const RESOLVE_KEYLESS_LIMIT = 60;
export const RESOLVE_KEYLESS_WINDOW_MS = 60_000;

export function requestsPerMinute(limit: number, windowMs: number): number {
  return Math.round((limit * 60_000) / windowMs);
}

export function keylessDecisionPerMinute(): number {
  return requestsPerMinute(DECISION_KEYLESS_LIMIT, DECISION_KEYLESS_WINDOW_MS);
}

export function keylessResolvePerMinute(): number {
  return requestsPerMinute(RESOLVE_KEYLESS_LIMIT, RESOLVE_KEYLESS_WINDOW_MS);
}

/** 鍵なしが開いている間の回数。旗が閉じている状態を「いつも」とは書かない。 */
export function keylessRatesSentence(): string {
  return `While keyless reads are on, /decision answers at ${keylessDecisionPerMinute()} requests a minute per IP and /resolve at ${keylessResolvePerMinute()}.`;
}

export const KEYLESS_READ_STOP = "Keyless reads of /decision stop when DECISION_KEYLESS_READ is 0.";
