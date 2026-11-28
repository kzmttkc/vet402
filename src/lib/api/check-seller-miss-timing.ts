// presign / check の cache miss（direct・coalesced）の Server-Timing 細分段（値は ms のみ）。

export type CheckSellerMissTimingMs = {
  db_resolve?: number;
  /** loadSellerFacts（判定の売り手事実の DB 読み）。 */
  db_outcomes?: number;
  /** decide の残り（registry・refunds の付与など）。 */
  db_decide?: number;
  /** 応答用の最新 L1 数件。 */
  db_l1_recent?: number;
  /** verified_terms が無いときの facts.payees 取得（check と同じ 1 回から取れれば 0）。 */
  terms_payees?: number;
};

export type CheckSellerCachePath = "direct" | "fresh" | "prefetch" | "coalesced";

export type CheckSellerCacheTiming = {
  path?: CheckSellerCachePath;
  miss?: CheckSellerMissTimingMs;
  /** presign の terms 照合用。応答には出さない。 */
  catalogPayees?: string[];
};

const MISS_PATHS = new Set(["direct", "coalesced"]);

export function isCheckSellerMissPath(path: string | undefined): boolean {
  return path !== undefined && MISS_PATHS.has(path);
}

function durLine(name: string, ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms)) return null;
  return `${name};dur=${ms.toFixed(1)}`;
}

/**
 * この要求の中で売り手を読んだ時だけ細分段を足す。direct・coalesced に加えて、fresh でも 60 秒の check cache に
 * 値が無く、この要求の中で読んだ時（初めての売り手の多く）は段が入る。他の呼び手が残した値を返した fresh と
 * prefetch は miss が空なので、親の cache;dur だけになる（2026-11-28: 初回の売り手の 96/99 が fresh で段が出なかった）。
 */
export function formatPresignCheckTiming(
  cacheMs: number,
  cachePath: string,
  termsMs: number,
  miss?: CheckSellerMissTimingMs,
): string {
  const desc = cachePath ? `;desc="${cachePath}"` : "";
  const parts = [`cache;dur=${cacheMs.toFixed(1)}${desc}`];
  if (miss) {
    for (const line of [
      durLine("db_resolve", miss.db_resolve),
      durLine("db_outcomes", miss.db_outcomes),
      durLine("db_decide", miss.db_decide),
      durLine("db_l1_recent", miss.db_l1_recent),
      durLine("terms_payees", miss.terms_payees),
    ]) {
      if (line) parts.push(line);
    }
  }
  parts.push(`terms;dur=${termsMs.toFixed(1)}`);
  return parts.join(", ");
}