import type { Erc8004ExtraChain, Erc8004MatchRead } from "@/lib/observatory/erc8004-match";
import {
  ERC8004_INDEXED_CHAIN,
  ERC8004_SOLANA_CAIP,
  type Erc8004ScannedChain,
  type Erc8004UnavailableChain,
} from "@/lib/observatory/erc8004-match";
import { ERC8004_ATTEST_WRITER } from "@/lib/observatory/erc8004-attest";
import { publicChainLabel } from "@/lib/observatory/chains";

export const ERC8004_PAGE_MATCH_RULE =
  "A registered agent counts when the lowercase payTo on a vet402 purchase row equals the indexed owner or agentWallet of that agent on the chain.";

export const ERC8004_PAGE_NOT_COUNTED =
  "Agent display names, fuzzy address matches, and registration-file endpoint URLs are not counted.";

export const ERC8004_OBSERVATORY_CHAINS = [ERC8004_INDEXED_CHAIN, "eip155:1", "eip155:56", ERC8004_SOLANA_CAIP] as const;

export type Erc8004ObservatoryChainKey = (typeof ERC8004_OBSERVATORY_CHAINS)[number];

export function erc8004HeadlineChainLabel(
  chain: Erc8004ObservatoryChainKey | Erc8004ExtraChain | typeof ERC8004_SOLANA_CAIP,
): string {
  if (chain === ERC8004_INDEXED_CHAIN) return "Base";
  if (chain === "eip155:1") return "Ethereum";
  if (chain === "eip155:56") return "BNB Chain";
  if (chain === ERC8004_SOLANA_CAIP) return "Solana (8004-solana)";
  return publicChainLabel(chain);
}

export function erc8004MatchedFraction(
  chain: Erc8004ObservatoryChainKey | typeof ERC8004_SOLANA_CAIP,
  data: Erc8004MatchRead,
): { fraction: string; matched: number; scanned: number } | { unavailable: true; reason: string } {
  if (data.status !== "ok") {
    return { unavailable: true, reason: data.reason };
  }
  const row = data.byChain[chain as keyof typeof data.byChain];
  if (row.status === "unavailable") {
    return { unavailable: true, reason: row.reason };
  }
  return {
    fraction: `${row.matchedAgents.toLocaleString("en-US")} of ${row.scannedAgents.toLocaleString("en-US")}`,
    matched: row.matchedAgents,
    scanned: row.scannedAgents,
  };
}

export function erc8004BaseTotals(data: Erc8004MatchRead): {
  matchedPayTo: number;
  matchedPurchases: number;
  matchedSettled: number;
} | null {
  if (data.status !== "ok") return null;
  return {
    matchedPayTo: data.matchedPayTo,
    matchedPurchases: data.matchedPurchases,
    matchedSettled: data.matchedSettled,
  };
}

export function shortErc8004Address(address: string): string {
  return address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/** Keyless GET /api/v1/erc8004/check when the chain is Base (the route reads Reputation Registry on Base). */
export function erc8004KeylessCheckHref(chainId: string, agentId: string): string | null {
  if (chainId !== ERC8004_INDEXED_CHAIN) return null;
  const params = new URLSearchParams({
    chain: ERC8004_INDEXED_CHAIN,
    agentId,
    client: ERC8004_ATTEST_WRITER,
  });
  return `/api/v1/erc8004/check?${params.toString()}`;
}

export function erc8004ChainRow(
  data: Erc8004MatchRead,
  chain: Erc8004ObservatoryChainKey,
): Erc8004ScannedChain | Erc8004UnavailableChain | null {
  if (data.status !== "ok") return null;
  return data.byChain[chain];
}