// ============================================================
// P3 運用ダイジェストのメール下書き（送信は別工程）。
// ============================================================
import {
  formatOpsRateTripletLine,
  OPS_NOT_DELIVERED_RATE_NOTE,
  type BuyerCard,
} from "@/lib/dashboard/ops-card";

export function renderOpsDigestEmailDraft(card: BuyerCard): { subject: string; text: string } {
  const subject = "vet402 operations digest";
  const m = card.vet402Measurement;
  const rates = m.rates;
  const lines = [
    "vet402 operations digest (draft, not sent automatically).",
    "",
    `Your key (last ${card.yourKey.days} days): ${card.yourKey.total} decision API calls`,
    `Payments you reported: ${card.paymentsReported.paymentCount} rows, ${card.paymentsReported.verifiedUsdcTotal} verified on chain`,
    card.paymentsReported.unverifiedOnChainCount > 0
      ? `Could not verify on chain: ${card.paymentsReported.unverifiedOnChainCount} rows (not in the verified total)`
      : "",
    "",
    "vet402 measurement purchases (not your wallet alone):",
    `Attempts ${m.attempts}, delivered ${m.delivered}, held ${m.held}, awaiting a second read ${m.awaitingReread}`,
    formatOpsRateTripletLine(
      "of attempts",
      m.attempts,
      rates.denominators.attempts,
      rates.deliveredOfAttemptsPct,
      rates.notDeliveredOfAttemptsPct,
    ),
    formatOpsRateTripletLine(
      "excluding held",
      m.attempts,
      rates.denominators.notHeld,
      rates.deliveredOfNotHeldPct,
      rates.notDeliveredOfNotHeldPct,
    ),
    formatOpsRateTripletLine(
      "final outcome only",
      m.attempts,
      rates.denominators.finalOutcome,
      rates.deliveredOfFinalOutcomePct,
      rates.notDeliveredOfFinalOutcomePct,
    ),
    "",
    OPS_NOT_DELIVERED_RATE_NOTE,
  ].filter(Boolean);
  return { subject, text: lines.join("\n") };
}
