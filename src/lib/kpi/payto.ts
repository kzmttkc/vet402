// ============================================================
// vet402 x402 受取アドレス（KPI・着金集計用）。正本は openapi / 実装の宣言。
// ============================================================
import { getAddress } from "viem";
import { PAY_TO } from "@/lib/x402/base-usdc";

/**
 * Base mainnet USDC で vet402 が受け取りに使う payTo（src/lib/x402/base-usdc.ts）。
 * 同じアドレスが Robinhood Chain（eip155:4663）の USDG の受取でもある（packages/rwa/x402.ts）。
 * 4663 の着金は I0 ではまだ読まない（月次ファイルの coverage.x402NetworksNotRead）。
 */
export const VET402_BASE_USDC_PAY_TO = PAY_TO;

/**
 * 着金集計の対象 payTo 一覧（Base USDC）。追加受取先があればここに足す。
 * 2026-11-27 時点の公開 openapi ではこの 1 件のみ。
 */
export function vet402BaseUsdcPayToAddresses(): readonly string[] {
  return [getAddress(VET402_BASE_USDC_PAY_TO)];
}