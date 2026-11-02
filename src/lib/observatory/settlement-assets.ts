// ============================================================
// チェーンごとの決済資産と、購入を決済へ結ぶ材料（2026-11-02 公開面の文言監査 M1）。
//
// WHY: 「USDC on Base, Arc, Celo, Solana and Stellar …」の一文が語彙・FAQ・方法論・State に手書きで
// 並び、Arbitrum One（10/22）と Avalanche C-Chain（10/26）のレーンが入っても誰も足さなかった
// （本番の l1.byChain には settled がある）。/corrections の 10/21 は同じ型の直し。
// 公開の文はこの表から作り、tests/public-wording-definitions.test.ts が表と EVM_PAY_CHAINS を突き合わせる。
// x402-payer.ts は署名の経路なので、公開頁の依存に入れず、テストだけが両方を読む。
// ============================================================

export type SettlementBinding = "eip3009" | "solana_memo" | "tip20_memo" | "signed_blob" | "none";

export type SettlementAssetRow = {
  /** 公開名（publicChainLabel と同じ文字列）。 */
  chain: string;
  asset: "USDC" | "USDC.e" | "RLUSD" | "USD1";
  /** 再読が購入と結びつける一回性の値。none は払い手・宛先・額・資産まで。 */
  binding: SettlementBinding;
};

export const SETTLEMENT_ASSETS: readonly SettlementAssetRow[] = [
  { chain: "Base", asset: "USDC", binding: "eip3009" },
  { chain: "Arc", asset: "USDC", binding: "eip3009" },
  { chain: "Celo", asset: "USDC", binding: "eip3009" },
  { chain: "Solana", asset: "USDC", binding: "solana_memo" },
  { chain: "Stellar", asset: "USDC", binding: "none" },
  { chain: "Arbitrum One", asset: "USDC", binding: "eip3009" },
  { chain: "Avalanche C-Chain", asset: "USDC", binding: "eip3009" },
  { chain: "Tempo", asset: "USDC.e", binding: "tip20_memo" },
  { chain: "XRPL", asset: "RLUSD", binding: "signed_blob" },
  { chain: "BNB Chain", asset: "USD1", binding: "eip3009" },
];

function joinNames(names: readonly string[], conjunction: "and" | "or" = "and"): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} ${conjunction} ${names[names.length - 1]}`;
}

function chainsWithAsset(asset: SettlementAssetRow["asset"]): string {
  return joinNames(SETTLEMENT_ASSETS.filter((r) => r.asset === asset).map((r) => r.chain));
}

function chainsWithBinding(binding: SettlementBinding): string[] {
  return SETTLEMENT_ASSETS.filter((r) => r.binding === binding).map((r) => r.chain);
}

/** "Base, Arc, … and Avalanche C-Chain" */
export const USDC_CHAINS_TEXT = chainsWithAsset("USDC");

/** 短い形（L1 の定義・FAQ）。 */
export const PINNED_ASSETS_TEXT = `USDC on ${USDC_CHAINS_TEXT}, USDC.e on ${chainsWithAsset("USDC.e")}, RLUSD on ${chainsWithAsset("RLUSD")}, USD1 on ${chainsWithAsset("USD1")}`;

/** 発行者まで言う形（settled の定義・方法論・State の説明）。 */
export const PINNED_ASSETS_WITH_ISSUER_TEXT = `USDC on ${USDC_CHAINS_TEXT}, USDC.e on ${chainsWithAsset("USDC.e")}, RLUSD from its fixed issuer on ${chainsWithAsset("RLUSD")}, and USD1 on ${chainsWithAsset("USD1")}`;

/** EIP-3009 の nonce で結ぶチェーン。 */
export const EIP3009_CHAINS_TEXT = joinNames(chainsWithBinding("eip3009"));

/** 一回性の値を結ぶチェーン全部（Stellar を含まない）。 */
export const NONCE_BOUND_CHAINS_TEXT = joinNames(
  SETTLEMENT_ASSETS.filter((r) => r.binding !== "none").map((r) => r.chain),
  "or",
);

/** 公開名またはチェーンの結合キーの資産。表に無ければ null。 */
export function pinnedAssetOf(publicName: string): SettlementAssetRow["asset"] | null {
  return SETTLEMENT_ASSETS.find((r) => r.chain === publicName)?.asset ?? null;
}
