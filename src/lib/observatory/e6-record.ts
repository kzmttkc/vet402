// ============================================================
// E6 — 1 件の取引 ID に載せる買い手端と売り手端（ABSORB E6）。
// 測定の異議（disputes.ts）や 3.8 の訂正台帳とは別である。
// 中身の本文は公開しない。受け取った／渡した中身の SHA-256 だけを載せる。
// ============================================================
import { createHash } from "node:crypto";

export type E6PayerLeg = {
  paymentTx: string | null;
  receivedBodyHash: string | null;
  state: string | null;
  payerSignature?: string | null;
  /** 買い手が vet402 を挟んだか（片側だけの例用）。 */
  vet402Relay?: boolean;
};

export type E6SellerLeg = {
  paymentVerified: string | null;
  deliveredBodyHash: string | null;
  deliverySignature: string | null;
  /** 売り手が E5 middleware を載せているか。無いときは false または省略。 */
  vet402Middleware?: boolean;
};

export type E6Record = {
  purchaseId: string;
  payer: E6PayerLeg;
  seller: E6SellerLeg;
  updatedAt: string;
};

export function emptyPayerLeg(): E6PayerLeg {
  return { paymentTx: null, receivedBodyHash: null, state: null, payerSignature: null };
}

export function emptySellerLeg(): E6SellerLeg {
  return { paymentVerified: null, deliveredBodyHash: null, deliverySignature: null };
}

/** 受け取った／渡した応答本文のハッシュ（request_body_sha256 とは別物）。 */
export function hashDeliveredBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function legPresent(leg: E6PayerLeg | E6SellerLeg, keys: string[]): boolean {
  return keys.some((k) => {
    const v = (leg as Record<string, unknown>)[k];
    return v !== null && v !== undefined && v !== false;
  });
}

export function mergeE6Record(
  existing: E6Record | null,
  patch: { purchaseId: string; payer?: Partial<E6PayerLeg>; seller?: Partial<E6SellerLeg> },
): E6Record {
  const payer: E6PayerLeg = { ...emptyPayerLeg(), ...existing?.payer, ...patch.payer };
  const seller: E6SellerLeg = { ...emptySellerLeg(), ...existing?.seller, ...patch.seller };
  return {
    purchaseId: patch.purchaseId,
    payer,
    seller,
    updatedAt: new Date().toISOString(),
  };
}

export function e6DeliveryConfirmed(record: E6Record): boolean {
  const p = record.payer.receivedBodyHash;
  const s = record.seller.deliveredBodyHash;
  if (!p || !s || p !== s) return false;
  if (!record.payer.paymentTx || !record.seller.paymentVerified) return false;
  if (!record.seller.deliverySignature || !record.payer.payerSignature) return false;
  return true;
}

export type E6PublicStage = "not_paid" | "not_delivered" | "content_changed" | null;

/** 公開してよい段の語（3.4）。vet402 は軍配を上げない。 */
export function e6PublicStage(record: E6Record): E6PublicStage {
  if (!record.payer.paymentTx) return "not_paid";
  if (!record.seller.deliveredBodyHash && !record.payer.receivedBodyHash) return "not_delivered";
  const p = record.payer.receivedBodyHash;
  const s = record.seller.deliveredBodyHash;
  if (p && s && p !== s) return "content_changed";
  if (!s && record.payer.paymentTx) return "not_delivered";
  return null;
}

export function e6SidePresent(record: E6Record): { payer: boolean; seller: boolean } {
  return {
    payer: legPresent(record.payer, ["paymentTx", "receivedBodyHash", "state"]),
    seller: legPresent(record.seller, ["paymentVerified", "deliveredBodyHash", "deliverySignature"]),
  };
}

/** 日次 root 用の 1 行検証（過去日の canonicalDayPayload は触らない）。 */
export function e6AnchorVerifyLine(record: E6Record): { line: string; sha256: string } {
  const line = JSON.stringify({
    purchaseId: record.purchaseId,
    payerTx: record.payer.paymentTx ?? "",
    payerHash: record.payer.receivedBodyHash ?? "",
    sellerTx: record.seller.paymentVerified ?? "",
    sellerHash: record.seller.deliveredBodyHash ?? "",
    deliveryConfirmed: e6DeliveryConfirmed(record),
  });
  return { line, sha256: createHash("sha256").update(line, "utf8").digest("hex") };
}
