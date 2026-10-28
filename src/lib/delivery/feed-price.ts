// ============================================================
// 配達フィードの price_usd（2026-10-28 点検）。ネットワークごとの USDC（6 桁）と一致する行だけ。
// 対応表に無いネットワークは資産の名前が "USDC" でも null（Stellar は 7 桁などで桁がずれる）。
// ============================================================
import { toCaip2, usdcAssetForNetwork } from "@/lib/observatory/chains";

/** chains.ts の対応表に無いが、本番のフィードに出る USDC（6 桁）。 */
const FEED_ONLY_USDC: Record<string, string> = {
  "solana:5eykt4usfv8p8njdtrepy1vzqkqzkvdp": "epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v",
};

function feedUsdcAsset(network: string): string | null {
  const known = usdcAssetForNetwork(network);
  if (known) return known.toLowerCase();
  return FEED_ONLY_USDC[(toCaip2(network) ?? network).toLowerCase()] ?? null;
}

export function feedPriceUsd(
  amount: string | null | undefined,
  asset: string | null | undefined,
  network: string | null | undefined,
): number | null {
  if (!amount || !asset || !network || !/^\d{1,30}$/.test(amount)) return null;
  const expected = feedUsdcAsset(network);
  if (!expected || asset.trim().toLowerCase() !== expected) return null;
  const n = Number(amount) / 1_000_000;
  return Number.isFinite(n) ? n : null;
}
