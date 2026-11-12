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

/** /diagnose が publicRateLimit に渡す回数。窓は 60 秒。売り手へ 1 回取りに行くので /resolve より少ない。 */
export const DIAGNOSE_KEYLESS_LIMIT = 20;
export const DIAGNOSE_KEYLESS_WINDOW_MS = 60_000;

/** POST /api/v1/payment-proof と MCP check_payment_proof が同じ桶で使う回数。窓は 60 秒。 */
export const PAYMENT_PROOF_KEYLESS_LIMIT = 20;
export const PAYMENT_PROOF_KEYLESS_WINDOW_MS = 60_000;

/** チェーン読みの時間切れ。これを超えたら 503。公開 RPC へは倒さない。 */
export const PAYMENT_PROOF_RPC_TIMEOUT_MS = 8_000;

export function requestsPerMinute(limit: number, windowMs: number): number {
  return Math.round((limit * 60_000) / windowMs);
}

export function keylessDecisionPerMinute(): number {
  return requestsPerMinute(DECISION_KEYLESS_LIMIT, DECISION_KEYLESS_WINDOW_MS);
}

export function keylessResolvePerMinute(): number {
  return requestsPerMinute(RESOLVE_KEYLESS_LIMIT, RESOLVE_KEYLESS_WINDOW_MS);
}

export function keylessDiagnosePerMinute(): number {
  return requestsPerMinute(DIAGNOSE_KEYLESS_LIMIT, DIAGNOSE_KEYLESS_WINDOW_MS);
}

export function keylessPaymentProofPerMinute(): number {
  return requestsPerMinute(PAYMENT_PROOF_KEYLESS_LIMIT, PAYMENT_PROOF_KEYLESS_WINDOW_MS);
}

/** 鍵なしが開いている間の回数。旗が閉じている状態を「いつも」とは書かない。 */
export function keylessRatesSentence(): string {
  return `While keyless reads are on, /decision answers at ${keylessDecisionPerMinute()} requests a minute per IP and /resolve at ${keylessResolvePerMinute()}.`;
}

export const KEYLESS_READ_STOP = "Keyless reads of /decision can be paused by the operator.";
