// ============================================================
// L1 購入行から公開の facilitator 識別子を出す（2026-11-25・F8）。
//
// 根拠（行だけから読めるもの）:
//   circle_gateway     raw_response_meta.circleGateway に batchTx がある行
//                      （settlement-source.ts の circle_gateway と同じ規則）
//   xrpl_t54           network が xrpl:0 の行。vet402 が支払う XRPL 封筒は
//                      t54 互換の accept だけ（xrpl402-payer.ts）
//   solana:<feePayer>  challenge の selectedAccept.extra.feePayer（Solana exact）
//   tempo_mpp          network eip155:4217（mpp-payer.ts）
//   stellar_facilitator network stellar:pubnet（Stellar レーン）
//   unknown            上記以外（Base 等の EVM EIP-3009 で売り手側の facilitator URL
//                      は台帳に残っていない）
// ============================================================
import { x402L1Purchases } from "@/lib/db/schema";
import { settlementSourceSql } from "./settlement-source";

export const L1_FACILITATOR_UNKNOWN = "unknown" as const;

/** SQL: facilitator id 文字列。識別できない行は 'unknown'（null にしない）。 */
export function l1FacilitatorIdSql(alias = "pu"): string {
  const p = alias === "" ? "" : `${alias}.`;
  const ch = `${p}${x402L1Purchases.challenge402.name}`;
  return `CASE
    WHEN (${settlementSourceSql(alias)}) = 'circle_gateway' THEN 'circle_gateway'
    WHEN ${p}network = 'xrpl:0' THEN 'xrpl_t54'
    WHEN ${p}network LIKE 'solana:%'
         AND jsonb_typeof(${ch}) = 'object'
         AND coalesce(${ch}->'selectedAccept'->'extra'->>'feePayer', '') <> ''
      THEN 'solana:' || (${ch}->'selectedAccept'->'extra'->>'feePayer')
    WHEN ${p}network = 'eip155:4217' THEN 'tempo_mpp'
    WHEN ${p}network = 'stellar:pubnet' THEN 'stellar_facilitator'
    ELSE '${L1_FACILITATOR_UNKNOWN}'
  END`;
}

export type L1FacilitatorBucket = {
  facilitator: string;
  attempts: number;
  settled: number;
  delivered: number;
  inconclusiveSettled: number;
};

export const EMPTY_UNKNOWN_FACILITATOR_BUCKET: L1FacilitatorBucket = {
  facilitator: L1_FACILITATOR_UNKNOWN,
  attempts: 0,
  settled: 0,
  delivered: 0,
  inconclusiveSettled: 0,
};

/** SQL が unknown 行を返さないときも、公開面では unknown バケットを常に載せる。 */
export function withUnknownFacilitatorBucket(buckets: L1FacilitatorBucket[]): L1FacilitatorBucket[] {
  if (buckets.some((b) => b.facilitator === L1_FACILITATOR_UNKNOWN)) return buckets;
  return [...buckets, { ...EMPTY_UNKNOWN_FACILITATOR_BUCKET }];
}