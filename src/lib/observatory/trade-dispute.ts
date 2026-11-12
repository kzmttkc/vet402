// ============================================================
// P2 — 1 件の取引の争いの画面と公開 JSON（E6 を読む）。測定の異議とは別口。
// ============================================================
import {
  e6DeliveryConfirmed,
  e6PublicStage,
  e6SidePresent,
  type E6Record,
} from "@/lib/observatory/e6-record";
import { isP2LiveComplete } from "@/lib/observatory/p2-live";
import type { P2PartyVerification } from "@/lib/observatory/p2-party-verify";

export const P2_DISPUTE_PAGE_PATH = "/connect/trade-dispute";

export type TradeDisputeViewer = "anonymous" | "payer" | "seller";

export type PublicTradeDisputeJson = {
  purchaseId: string;
  stage: ReturnType<typeof e6PublicStage>;
  deliveryConfirmed: boolean;
  payer: { present: boolean; paymentTx: string | null };
  seller: { present: boolean };
  p2Live: boolean;
  e4Outcome: "inconclusive" | "refund" | null;
};

export function e4OutcomeForStage(stage: ReturnType<typeof e6PublicStage>, deliveryConfirmed: boolean): "inconclusive" | "refund" | null {
  if (deliveryConfirmed) return null;
  if (stage === "not_delivered" || stage === "content_changed") return "inconclusive";
  if (stage === "not_paid") return "refund";
  return null;
}

export function publicTradeDisputeJson(
  record: E6Record,
  _opts: { viewer: TradeDisputeViewer },
): PublicTradeDisputeJson {
  const stage = e6PublicStage(record);
  const deliveryConfirmed = e6DeliveryConfirmed(record);
  const sides = e6SidePresent(record);
  const live = isP2LiveComplete();
  return {
    purchaseId: record.purchaseId,
    stage,
    deliveryConfirmed,
    payer: { present: sides.payer, paymentTx: sides.payer ? record.payer.paymentTx : null },
    seller: { present: sides.seller },
    p2Live: live,
    e4Outcome: live ? e4OutcomeForStage(stage, deliveryConfirmed) : null,
  };
}

export type PartyTradeDisputeView = {
  purchaseId: string;
  payer: {
    vet402Relay: boolean;
    empty: boolean;
    paymentTx?: string | null;
    receivedBodyHash?: string | null;
  };
  seller: {
    vet402Middleware: boolean;
    empty: boolean;
    deliveredBodyHash?: string | null;
  };
  self: { receivedBodyHash?: string | null; deliveredBodyHash?: string | null };
  other: { receivedBodyHash?: string | null; deliveredBodyHash?: string | null };
};

export function partyTradeDisputeView(
  record: E6Record,
  party: "payer" | "seller",
  verification: P2PartyVerification,
): PartyTradeDisputeView {
  const sides = e6SidePresent(record);
  const payerEmpty = !sides.payer;
  const sellerEmpty = !sides.seller;
  const verified = verification.ok;
  const selfHash = party === "payer" ? record.payer.receivedBodyHash : record.seller.deliveredBodyHash;
  return {
    purchaseId: record.purchaseId,
    payer: {
      vet402Relay: record.payer.vet402Relay === true,
      empty: payerEmpty,
      paymentTx: payerEmpty || !verified || party !== "payer" ? undefined : record.payer.paymentTx,
      receivedBodyHash:
        payerEmpty || !verified || party !== "payer" ? undefined : record.payer.receivedBodyHash ?? undefined,
    },
    seller: {
      vet402Middleware: record.seller.vet402Middleware === true,
      empty: sellerEmpty,
      deliveredBodyHash:
        sellerEmpty || !verified || party !== "seller" ? undefined : record.seller.deliveredBodyHash ?? undefined,
    },
    self:
      verified && party === "payer"
        ? { receivedBodyHash: selfHash ?? undefined }
        : verified && party === "seller"
          ? { deliveredBodyHash: selfHash ?? undefined }
          : {},
    other: {},
  };
}
