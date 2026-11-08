/** Public line for a failed health read. No internal names, no dashes. */
export const LIVENESS_PUBLIC_SENTENCE =
  "Seller checks may say not verifiable until the index catches up. If a check cannot be verified, do not pay. See status.";

/** Copy for the public outage line. `ok` and unknown statuses produce nothing. */
export function livenessBannerMessage(status: string | undefined): string | null {
  if (status === "error" || status === "degraded") return LIVENESS_PUBLIC_SENTENCE;
  return null;
}

/**
 * A health body may replace the line only when it carries a real verdict.
 * `error` and `degraded` are HTTP 503 (the poller code) with the verdict in
 * the body, so a non-OK response still counts for those two. `rate_limited`,
 * a missing status, and any other non-OK body must not write a new failure
 * or clear the one on screen.
 */
export function healthBodyUpdatesBanner(ok: boolean, status: string | undefined): boolean {
  if (status === "error" || status === "degraded") return true;
  return ok && status === "ok";
}

/**
 * A cached line is usable only while it is fresh and still the current public
 * sentence. An older failure string is a miss, so the next read replaces it.
 */
export function freshLivenessCache(
  message: string | null,
  at: number,
  now: number,
  ttlMs: number,
): string | null | undefined {
  if (!Number.isFinite(at) || now - at > ttlMs) return undefined;
  if (message === null) return null;
  if (message === LIVENESS_PUBLIC_SENTENCE) return message;
  return undefined;
}
