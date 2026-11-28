// ============================================================
// J4 (2026-11-17): 売り手ホスト単位の返金集計を判定に載せる（情報のみ）。
//
// verdict / score の変更は 2026-11-30 のレビューまで待つ（seller_refunded_failures は effect: none）。
// ============================================================
import { getDb } from "@/lib/db/client";
import { timedDbExecute } from "@/lib/db/miss-timing";
import { isNoDataCacheError } from "@/lib/observatory/state-reads";
import { sellerHostOf } from "@/lib/sellers/host";
import { getSellerRefundStatsCached } from "@/lib/sellers/cached";
import { readSellerRefundStats } from "@/lib/sellers/refund-reader";
import type { RefundStats } from "@/lib/sellers/refunds";
import { REFUND_NETWORKS_READ, REFUND_WINDOW_DAYS } from "@/lib/sellers/refunds";
import type { DecisionResult } from "./decide";
import { explainReasons } from "./reason-explain";
import type { SellerFacts } from "./types";
export const SELLER_REFUNDED_FAILURES = "seller_refunded_failures" as const;
/** 理由コードを付ける閾値（2026-11-17 依頼主指定）。判定は変えない。 */
export const SELLER_REFUND_RATE_THRESHOLD = 0.5;

export type DecisionHostRefunds = {
  window_days: number;
  networks_read: readonly string[];
  read_through: string | null;
  failures_counted: number;
  paid_units: string;
  refunded_units: string;
  refund_rate: number | null;
};

function rateOf(back: bigint, paid: bigint): number | null {
  if (paid === 0n) return null;
  return Math.round(Number((back * 1_000_000n) / paid) / 100) / 10_000;
}

/** payTo 行をホスト単位に足す（refunds.ts と同じ除外・窓の規則は reader 側で済んでいる）。 */
export function sumHostRefunds(stats: RefundStats): DecisionHostRefunds {
  let failures = 0;
  let paid = 0n;
  let back = 0n;
  for (const row of stats.pay_tos) {
    failures += row.failures_counted;
    try {
      paid += BigInt(row.paid_units);
      back += BigInt(row.refunded_units);
    } catch {
      /* 読めない行は足さない（ありえないが落とさない） */
    }
  }
  return {
    window_days: stats.window_days,
    networks_read: stats.networks_read,
    read_through: stats.read_through,
    failures_counted: failures,
    paid_units: paid.toString(),
    refunded_units: back.toString(),
    refund_rate: rateOf(back, paid),
  };
}

export function shouldEmitSellerRefundedFailures(refunds: DecisionHostRefunds): boolean {
  return (
    refunds.failures_counted >= 1 &&
    refunds.refund_rate !== null &&
    refunds.refund_rate >= SELLER_REFUND_RATE_THRESHOLD
  );
}

export function sellerHostOfCanonicalUrl(canonicalUrl: string): string | null {
  try {
    return sellerHostOf(new URL(canonicalUrl).hostname);
  } catch {
    return null;
  }
}

export type RefundStatsReader = (host: string) => Promise<RefundStats | null>;

async function readRefundStatsCached(host: string): Promise<RefundStats | null> {
  try {
    return await getSellerRefundStatsCached(host);
  } catch (err) {
    if (isNoDataCacheError(err)) {
      const db = getDb();
      if (!db) return null;
      return timedDbExecute(() => readSellerRefundStats(db, { host })) as Promise<RefundStats | null>;
    }
    throw err;
  }
}

/** 売り手ホストの返金集計を先に読み始める（decide が buildDecision と重ねる）。ホストが無ければ null。 */
export function prefetchSellerRefundStats(canonicalUrl: string): Promise<RefundStats | null> | null {
  const host = sellerHostOfCanonicalUrl(canonicalUrl);
  if (!host) return null;
  return readRefundStatsCached(host).catch(() => null);
}

/** 判定に refunds と（閾値を満たせば）理由コードを付ける。recommendation は変えない。 */
export async function attachSellerRefundsToDecision(
  decision: DecisionResult,
  canonicalUrl: string,
  readStats: RefundStatsReader = readRefundStatsCached,
  prefetched: Promise<RefundStats | null> | null | undefined = undefined,
): Promise<DecisionResult> {
  if (decision.role !== "payer") {
    return { ...decision, refunds: null };
  }
  const host = sellerHostOfCanonicalUrl(canonicalUrl);
  if (!host) {
    return { ...decision, refunds: null };
  }
  let stats: RefundStats | null;
  try {
    stats =
      prefetched !== undefined && prefetched !== null
        ? await prefetched
        : await readStats(host);
  } catch {
    return { ...decision, refunds: null };
  }
  if (!stats) {
    return { ...decision, refunds: null };
  }
  const refunds = sumHostRefunds(stats);
  let reason_codes = decision.reason_codes;
  let reasons = decision.reasons;
  if (shouldEmitSellerRefundedFailures(refunds)) {
    reason_codes = [...reason_codes, SELLER_REFUNDED_FAILURES];
    const facts = decision.facts as SellerFacts;
    // 既にある理由の説明（l2 の購入へのリンクなど）は作り直さず、新しい理由の1件だけを足す。
    const added = explainReasons({
      codes: [SELLER_REFUNDED_FAILURES],
      role: "payer",
      basis: decision.l1_basis,
      observatoryId: decision.subject.observatory_id,
      verifiedTerms: decision.verified_terms,
      l2: facts.l2,
      l2PurchaseId: null,
      sellerHost: host,
    });
    reasons = [...(reasons ?? []), ...added];
  }
  return { ...decision, refunds, reason_codes, reasons };
}

export { REFUND_WINDOW_DAYS, REFUND_NETWORKS_READ };