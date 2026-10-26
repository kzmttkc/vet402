/**
 * 購入レーンの説明頁（2026-10-26）。
 *
 * チェーンの集合は supported-chains-data の lane 行だけ。件数は頁が台帳から読む。
 * ここには件数を書かない。公開文: we/our/us・セミコロン・ダッシュを使わない。
 * 結び付けと再読の文は settlement-verify*.ts の手順から引く。CAIP-2 は chainNetwork。
 */
import { SUPPORTED_CHAINS, type LaneChain } from "@/components/site/supported-chains-data";
import { chainNetwork, publicChainLabel } from "@/lib/observatory/chains";

export type GuideChain = {
  slug: string;
  /** chainLabel() の結合キー。表示名は publicName。 */
  chain: string;
  publicName: string;
  asset: string;
  caip2: string;
  /** H1 と Article の headline。 */
  headline: string;
  /** 購入を決済へ結ぶ材料。 */
  tie: string;
  /** 再読が何を合わせるか。 */
  reread: string;
  /** 頁の先頭 2 文。 */
  lead: readonly [string, string];
  title: string;
  description: string;
};

const EVM_TIE = "The purchase is tied to its settlement by the EIP-3009 authorization nonce.";
const EVM_REREAD = "The re-read matches that nonce on the transfer.";

const FACTS: Record<string, { tie: string; reread: string }> = {
  Base: { tie: EVM_TIE, reread: EVM_REREAD },
  Arc: { tie: EVM_TIE, reread: EVM_REREAD },
  Celo: { tie: EVM_TIE, reread: EVM_REREAD },
  Arbitrum: { tie: EVM_TIE, reread: EVM_REREAD },
  BSC: { tie: EVM_TIE, reread: EVM_REREAD },
  Solana: {
    tie: "The purchase is tied to its settlement by a memo written on the transaction.",
    reread: "The re-read matches that memo.",
  },
  Tempo: {
    tie: "The purchase is tied to its settlement by the indexed memo of a TIP-20 TransferWithMemo.",
    reread: "The re-read matches that memo.",
  },
  XRPL: {
    tie: "The purchase is tied to its settlement by the hash of the signed blob.",
    reread: "The re-read matches that hash.",
  },
  "stellar:pubnet": {
    tie: "The purchase is checked on the payer, the payee, the amount, and the asset.",
    reread: "The re-read checks the payer, the payee, the amount, and the asset. The row is published in the amount and payee tier.",
  },
};

const LEADS: Record<string, readonly [string, string]> = {
  Base: ["vet402 measures x402 payments on Base.", "The pinned settlement asset on Base is USDC."],
  Solana: ["vet402 measures x402 payments on Solana.", "The pinned settlement asset on Solana is USDC."],
  Tempo: [
    "vet402 measures agent payments on Tempo over MPP (Machine Payments Protocol).",
    "The pinned settlement asset on Tempo is USDC.e.",
  ],
  XRPL: [
    "vet402 measures x402 payments on XRPL.",
    "The pinned settlement asset on XRPL is RLUSD, and settlement goes through the t54 facilitator.",
  ],
  Arc: ["vet402 measures x402 payments on Arc.", "The pinned settlement asset on Arc is USDC."],
  Celo: ["vet402 measures x402 payments on Celo.", "The pinned settlement asset on Celo is USDC."],
  "stellar:pubnet": ["vet402 measures x402 payments on Stellar.", "The pinned settlement asset on Stellar is USDC."],
  Arbitrum: ["vet402 measures x402 payments on Arbitrum One.", "The pinned settlement asset on Arbitrum One is USDC."],
  BSC: ["vet402 measures x402 payments on BNB Chain.", "The pinned settlement asset on BNB Chain is USD1."],
};

function slugOf(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function headlineOf(row: LaneChain, publicName: string): string {
  if (row.chain === "Tempo") return `Agent payments on Tempo over MPP (${row.asset})`;
  return `x402 payments on ${publicName} (${row.asset})`;
}

function descriptionOf(row: LaneChain, headline: string, caip2: string): string {
  const gloss = row.chain === "Tempo" ? " MPP is the Machine Payments Protocol." : "";
  const text = `${headline}. CAIP-2 ${caip2}.${gloss}`;
  if (text.length > 160) throw new Error(`x402 guide description is ${text.length} characters for ${row.chain}`);
  return text;
}

export const GUIDE_CHAINS: GuideChain[] = SUPPORTED_CHAINS.filter((row): row is LaneChain => row.kind === "lane").map(
  (row) => {
    const lead = LEADS[row.chain];
    const facts = FACTS[row.chain];
    if (!lead) throw new Error(`x402 guide lead missing for lane ${row.chain}`);
    if (!facts) throw new Error(`x402 guide facts missing for lane ${row.chain}`);
    if (!lead[1].includes(row.asset)) throw new Error(`x402 guide asset drifted for ${row.chain}`);
    const publicName = publicChainLabel(row.chain);
    const caip2 = chainNetwork(row.chain);
    if (!caip2) throw new Error(`x402 guide CAIP-2 missing for lane ${row.chain}`);
    const headline = headlineOf(row, publicName);
    return {
      slug: slugOf(publicName),
      chain: row.chain,
      publicName,
      asset: row.asset,
      caip2,
      headline,
      tie: facts.tie,
      reread: facts.reread,
      lead,
      title: headline,
      description: descriptionOf(row, headline, caip2),
    };
  },
);

export function guideChainBySlug(slug: string): GuideChain | undefined {
  return GUIDE_CHAINS.find((c) => c.slug === slug);
}
