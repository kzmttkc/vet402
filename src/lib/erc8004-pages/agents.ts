// ============================================================
// ERC-8004 agent record pages (2026-11-24 SEO proposal).
// One indexable page per registered agent that vet402's own purchase rows matched
// (exact payTo equality with owner or agentWallet). Data is the same cached read as
// /observatory/erc8004 (getErc8004MatchCached, top 200 by purchase count). No new query.
// ============================================================
import type { Erc8004Match } from "@/lib/observatory/erc8004-match";

export const ERC8004_CHAIN_SLUGS = {
  base: "eip155:8453",
  ethereum: "eip155:1",
  "bnb-chain": "eip155:56",
} as const;

export type Erc8004ChainSlug = keyof typeof ERC8004_CHAIN_SLUGS;

export const ERC8004_CHAIN_NAMES: Record<Erc8004ChainSlug, string> = {
  base: "Base",
  ethereum: "Ethereum",
  "bnb-chain": "BNB Chain",
};

export function chainSlugFor(chainId: string): Erc8004ChainSlug | null {
  for (const [slug, id] of Object.entries(ERC8004_CHAIN_SLUGS)) if (id === chainId) return slug as Erc8004ChainSlug;
  return null;
}

export function agentPagePath(m: Pick<Erc8004Match, "chainId" | "agentId">): string | null {
  const slug = chainSlugFor(m.chainId);
  return slug ? `/erc-8004/agents/${slug}/${encodeURIComponent(m.agentId)}` : null;
}

/** agentId is a decimal tokenId. Anything else is a 404, never a lookup. */
export function parseAgentIdParam(raw: string): string | null {
  return /^[0-9]{1,78}$/.test(raw) ? raw.replace(/^0+(?=\d)/, "") : null;
}

/**
 * Index only agents with at least one settled purchase. An agent whose rows never
 * settled has no delivery fact to show, so its page is served but noindex.
 */
export function agentPageIndexable(rows: Pick<Erc8004Match, "settled">[]): boolean {
  return rows.some((r) => r.settled > 0);
}
