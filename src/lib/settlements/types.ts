// ============================================================
// §7.2 Settlement index — チェーン上の x402 関連決済を Resource / Endpoint /
// Payee / Payer に帰属させる。3 経路（L1 購入・POST /payments/x402・
// オンチェーン索引）が同じ行の形に落ちる。
//
//   attribution: confirmed | probable | unmatched
//   wash_flag:   none | self_deal | circular | test
//
// 「実需」= wash / test を除外した値。生値も出す。混ぜて一つの数字にしない（§7.2）。
// ============================================================

export type WashFlag = "none" | "self_deal" | "circular" | "test";
export type Attribution = "confirmed" | "probable" | "unmatched";
export type SettlementSource = "l1_purchase" | "payments_api" | "chain_index";

export type SettlementInput = {
  /** CAIP-2 */
  chain: string;
  txHash: string;
  asset: string | null;
  /** base units, decimal string */
  amount: string | null;
  payer: string | null;
  payee: string | null;
  facilitator?: string | null;
  blockTime: Date | null;
  source: SettlementSource;
  raw?: unknown;
};

export type SettlementRow = SettlementInput & {
  purchaseId: string;
  payerId: string | null;
  payeeId: string | null;
  attribution: Attribution;
  resourceId: string | null;
  endpointId: string | null;
  washFlag: WashFlag;
};
