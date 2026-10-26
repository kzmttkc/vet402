/**
 * 購入レーンの説明頁（2026-10-26）。
 *
 * チェーンの集合は supported-chains-data の lane 行だけ。件数は頁が台帳から読む。
 * ここには件数を書かない。公開文: we/our/us・セミコロン・ダッシュを使わない。
 */
import { SUPPORTED_CHAINS, type LaneChain } from "@/components/site/supported-chains-data";

export type GuideChain = {
  slug: string;
  chain: string;
  asset: string;
  /** 頁の先頭 2 文。 */
  lead: readonly [string, string];
  title: string;
  description: string;
};

const LEADS: Record<string, readonly [string, string]> = {
  Base: [
    "vet402 measures x402 payments on Base.",
    "The pinned settlement asset on Base is USDC.",
  ],
  Solana: [
    "vet402 measures x402 payments on Solana.",
    "The pinned settlement asset on Solana is USDC.",
  ],
  Tempo: [
    "vet402 measures payments on Tempo over the MPP rail.",
    "The pinned settlement asset on Tempo is USDC.e.",
  ],
  XRPL: [
    "vet402 measures x402 payments on XRPL.",
    "The pinned settlement asset on XRPL is RLUSD, and settlement goes through the t54 facilitator.",
  ],
  Arc: [
    "vet402 measures x402 payments on Arc.",
    "The pinned settlement asset on Arc is USDC.",
  ],
  Celo: [
    "vet402 measures x402 payments on Celo.",
    "The pinned settlement asset on Celo is USDC.",
  ],
};

function slugOf(chain: string): string {
  return chain.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export const GUIDE_CHAINS: GuideChain[] = SUPPORTED_CHAINS.filter((row): row is LaneChain => row.kind === "lane").map(
  (row) => {
    const lead = LEADS[row.chain];
    if (!lead) throw new Error(`x402 guide lead missing for lane ${row.chain}`);
    if (row.asset !== lead[1].match(/asset on .+ is ([^.]+)\./)?.[1] && !lead[1].includes(row.asset)) {
      throw new Error(`x402 guide asset drifted for ${row.chain}`);
    }
    return {
      slug: slugOf(row.chain),
      chain: row.chain,
      asset: row.asset,
      lead,
      title: `${row.chain} ${row.asset} payments measured by vet402`,
      description: `${lead[0]} ${lead[1]} Counts on the page are the L1 row from the public ledger.`,
    };
  },
);

export function guideChainBySlug(slug: string): GuideChain | undefined {
  return GUIDE_CHAINS.find((c) => c.slug === slug);
}
