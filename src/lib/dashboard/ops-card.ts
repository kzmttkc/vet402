// ============================================================
// P3 運用画面のカード形（買い手・売り手の集計ラベルと率の並べ方）。
// ============================================================
import { deliveredRates } from "@/lib/observatory/delivered-rates";
import { pct1 } from "@/lib/util/pct";
import { formatUsdcUnits } from "@/lib/util/usd";

export type OpsSectionState = "empty" | "has_data";

export type OpsDeliveredRateRow = {
  deliveredOfAttemptsPct: number | null;
  notDeliveredOfAttemptsPct: number | null;
  deliveredOfNotHeldPct: number | null;
  notDeliveredOfNotHeldPct: number | null;
  deliveredOfFinalOutcomePct: number | null;
  notDeliveredOfFinalOutcomePct: number | null;
  denominators: { attempts: number; notHeld: number; finalOutcome: number };
};

export type BuyerYourKeySection = {
  state: OpsSectionState;
  total: number;
  byChain: { chain: string; count: number }[];
  days: number;
  emptyMessage: string;
};

export type BuyerPaymentsSection = {
  state: OpsSectionState;
  paymentCount: number;
  verifiedUsdcTotal: string;
  verifiedUsdcTotalUnits: string;
  unverifiedOnChainCount: number;
  emptyMessage: string;
};

export type BuyerMeasurementSection = {
  state: OpsSectionState;
  attempts: number;
  delivered: number;
  failed: number;
  held: number;
  awaitingReread: number;
  rates: OpsDeliveredRateRow;
  emptyMessage: string;
};

export type BuyerCard = {
  yourKey: BuyerYourKeySection;
  paymentsReported: BuyerPaymentsSection;
  vet402Measurement: BuyerMeasurementSection;
};

export type SellerRevenueSection = {
  state: OpsSectionState;
  measurementSettledCount: number;
  measurementSettledUsdc: string;
  reportedVerifiedCount: number;
  reportedVerifiedUsdc: string;
};

export type SellerDeliveredSection = {
  state: OpsSectionState;
  attempts: number;
  delivered: number;
  held: number;
  awaitingReread: number;
  rates: OpsDeliveredRateRow;
};

export type SellerDisputesSection = {
  state: OpsSectionState;
  purchaseIdsChecked: number;
  truncated: boolean;
  recordsPresent: number;
  disputeCount: number;
  p2Live: boolean;
  note: string | null;
  truncatedNote: string | null;
  checkedLine: string;
  noRecordsMessage: string | null;
};

export type SellerReputationSection = {
  state: OpsSectionState;
  pass: number;
  fail: number;
  withdrawn: number;
  unverified: number;
};

export type SellerCard = {
  wallet: string;
  revenue: SellerRevenueSection;
  delivered: SellerDeliveredSection;
  disputes: SellerDisputesSection;
  reputation: SellerReputationSection;
};

export type SellerCardUnverified = {
  ok: false;
  reason: string;
};

export type SellerCardResult = { ok: true; card: SellerCard } | SellerCardUnverified;

/** Buyer measurement lede and seller delivered section share the same rate footnote. */
export const OPS_VET402_L1_MEASUREMENT_LEDE =
  "Across all sellers vet402 measured. These counts are not limited to this API key or wallet.";

export const OPS_NOT_DELIVERED_RATE_NOTE =
  "Not delivered % is (denominator minus delivered) divided by denominator for each label above. Held rows stay in the attempts denominator. Rows awaiting a second read stay in the not held denominator.";

export function opsDeliveredRateUnavailableMessage(attempts: number, denominator: number): string {
  if (attempts === 0) return "No purchases on record yet";
  if (denominator === 0) return "Denominator is 0 (all attempts are held or awaiting a second read)";
  return "Rate unavailable";
}

export function formatOpsRateTripletLine(
  label: string,
  attempts: number,
  denominator: number,
  delivered: number | null,
  notDelivered: number | null,
): string {
  if (delivered === null) return `${label}: ${opsDeliveredRateUnavailableMessage(attempts, denominator)}`;
  return `${label}: delivered ${delivered.toFixed(1)}%, not delivered ${notDelivered?.toFixed(1) ?? "n/a"}%`;
}

export function sellerDisputesCheckedLine(purchaseIdsChecked: number): string {
  return `Checked the latest ${purchaseIdsChecked} purchases for this wallet`;
}

export function sellerDisputesNoRecordsMessage(
  truncated: boolean,
  purchaseIdsChecked: number,
): string {
  if (truncated) {
    return `No trade disputes among the latest ${purchaseIdsChecked} purchases`;
  }
  return "No trade disputes on record";
}

export function sellerDisputesTruncatedNote(
  truncated: boolean,
  purchaseIdsChecked: number,
): string | null {
  if (!truncated) return null;
  return `Purchases older than the latest ${purchaseIdsChecked} for this wallet were not checked.`;
}

export function buildOpsDeliveredRates(l1: {
  attempts: number;
  delivered: number;
  inconclusive: number;
  awaitingReread: number;
}): OpsDeliveredRateRow {
  const base = deliveredRates(l1);
  const { attempts, notHeld, finalOutcome } = base.denominators;
  return {
    deliveredOfAttemptsPct: base.deliveredOfAttemptsPct,
    notDeliveredOfAttemptsPct: pct1(attempts - l1.delivered, attempts),
    deliveredOfNotHeldPct: base.deliveredOfNotHeldPct,
    notDeliveredOfNotHeldPct: pct1(notHeld - l1.delivered, notHeld),
    deliveredOfFinalOutcomePct: base.deliveredOfFinalOutcomePct,
    notDeliveredOfFinalOutcomePct: pct1(finalOutcome - l1.delivered, finalOutcome),
    denominators: base.denominators,
  };
}

function measurementFailedCount(l1: {
  attempts: number;
  delivered: number;
  inconclusive: number;
  awaitingReread: number;
}): number {
  const finalOutcome = Math.max(0, l1.attempts - l1.inconclusive - l1.awaitingReread);
  return Math.max(0, finalOutcome - l1.delivered);
}

export function buildBuyerCard(input: {
  yourKey: { total: number; byChain: { chain: string; count: number }[]; days: number };
  payments: {
    paymentCount: number;
    verifiedUsdcUnitsSum: string;
    unverifiedOnChainCount: number;
  };
  measurementL1: {
    attempts: number;
    delivered: number;
    inconclusive: number;
    awaitingReread: number;
  };
}): BuyerCard {
  const yourKeyState: OpsSectionState = input.yourKey.total === 0 ? "empty" : "has_data";
  const paymentsState: OpsSectionState = input.payments.paymentCount === 0 ? "empty" : "has_data";
  const measurementState: OpsSectionState = input.measurementL1.attempts === 0 ? "empty" : "has_data";
  const rates = buildOpsDeliveredRates(input.measurementL1);
  return {
    yourKey: {
      state: yourKeyState,
      total: input.yourKey.total,
      byChain: input.yourKey.byChain,
      days: input.yourKey.days,
      emptyMessage: "No decision calls on record yet for this key.",
    },
    paymentsReported: {
      state: paymentsState,
      paymentCount: input.payments.paymentCount,
      verifiedUsdcTotal: formatUsdcUnits(input.payments.verifiedUsdcUnitsSum),
      verifiedUsdcTotalUnits: input.payments.verifiedUsdcUnitsSum,
      unverifiedOnChainCount: input.payments.unverifiedOnChainCount,
      emptyMessage: "No reported payments yet.",
    },
    vet402Measurement: {
      state: measurementState,
      attempts: input.measurementL1.attempts,
      delivered: input.measurementL1.delivered,
      failed: measurementFailedCount(input.measurementL1),
      held: input.measurementL1.inconclusive,
      awaitingReread: input.measurementL1.awaitingReread,
      rates,
      emptyMessage: "No purchases on record yet.",
    },
  };
}

export function buildSellerCard(input: {
  wallet: string;
  revenue: {
    measurementSettledCount: number;
    measurementSettledUnitsSum: string;
    reportedVerifiedCount: number;
    reportedVerifiedUnitsSum: string;
  };
  l1: { attempts: number; delivered: number; inconclusive: number; awaitingReread: number };
  disputes: {
    purchaseIdsChecked: number;
    truncated: boolean;
    recordsPresent: number;
    disputeCount: number;
    p2Live: boolean;
  };
  reputation: { pass: number; fail: number; withdrawn: number; unverified: number };
}): SellerCard {
  const revenueEmpty =
    input.revenue.measurementSettledCount === 0 && input.revenue.reportedVerifiedCount === 0;
  const deliveredState: OpsSectionState = input.l1.attempts === 0 ? "empty" : "has_data";
  const disputesEmpty = input.disputes.disputeCount === 0;
  const reputationEmpty =
    input.reputation.pass === 0 &&
    input.reputation.fail === 0 &&
    input.reputation.withdrawn === 0 &&
    input.reputation.unverified === 0;
  const purchaseIdsChecked = input.disputes.purchaseIdsChecked;
  return {
    wallet: input.wallet,
    revenue: {
      state: revenueEmpty ? "empty" : "has_data",
      measurementSettledCount: input.revenue.measurementSettledCount,
      measurementSettledUsdc: formatUsdcUnits(input.revenue.measurementSettledUnitsSum),
      reportedVerifiedCount: input.revenue.reportedVerifiedCount,
      reportedVerifiedUsdc: formatUsdcUnits(input.revenue.reportedVerifiedUnitsSum),
    },
    delivered: {
      state: deliveredState,
      attempts: input.l1.attempts,
      delivered: input.l1.delivered,
      held: input.l1.inconclusive,
      awaitingReread: input.l1.awaitingReread,
      rates: buildOpsDeliveredRates(input.l1),
    },
    disputes: {
      state: disputesEmpty ? "empty" : "has_data",
      purchaseIdsChecked,
      truncated: input.disputes.truncated,
      recordsPresent: input.disputes.recordsPresent,
      disputeCount: input.disputes.disputeCount,
      p2Live: input.disputes.p2Live,
      note: input.disputes.p2Live
        ? null
        : "Trade dispute records are draft until the public dispute flow is live.",
      truncatedNote: sellerDisputesTruncatedNote(input.disputes.truncated, purchaseIdsChecked),
      checkedLine: sellerDisputesCheckedLine(purchaseIdsChecked),
      noRecordsMessage: disputesEmpty
        ? sellerDisputesNoRecordsMessage(input.disputes.truncated, purchaseIdsChecked)
        : null,
    },
    reputation: {
      state: reputationEmpty ? "empty" : "has_data",
      pass: input.reputation.pass,
      fail: input.reputation.fail,
      withdrawn: input.reputation.withdrawn,
      unverified: input.reputation.unverified,
    },
  };
}

/** Webhook とメール下書きに載せる買い手カード（鍵の値・メール無し）。 */
export function buyerCardWebhookPayload(card: BuyerCard): BuyerCard {
  return card;
}
