// ============================================================
// 配達フィードの price_usd（2026-10-28 点検）。USDC 6 桁と判別できる行だけ。
// ============================================================
import {
  ARBITRUM_USDC,
  AVALANCHE_USDC,
  BASE_USDC,
  CELO_USDC,
} from "@/lib/observatory/x402-payer";

const USDC_ASSETS = new Set(
  [
    BASE_USDC,
    CELO_USDC,
    ARBITRUM_USDC,
    AVALANCHE_USDC,
    "0x3600000000000000000000000000000000000000",
    "USDC",
    "usdc",
  ].map((a) => a.toLowerCase()),
);

export function feedPriceUsd(amount: string | null | undefined, asset: string | null | undefined): number | null {
  if (!amount || !asset || !/^\d{1,30}$/.test(amount)) return null;
  const a = asset.trim();
  if (!USDC_ASSETS.has(a.toLowerCase()) && !a.toLowerCase().endsWith("usdc")) return null;
  const n = Number(amount) / 1_000_000;
  return Number.isFinite(n) ? n : null;
}
