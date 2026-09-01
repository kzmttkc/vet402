import { base, mainnet, polygon } from "viem/chains";
import type { Chain } from "viem";

/**
 * Multichain registry (2026-08-05 R&D, C-8).
 *
 * WHY NOW AND NOT EARLIER. The plan was always "tests first, then chain
 * branching" — branching the most safety-critical code with zero tests would
 * have been the riskiest possible order. The fail-closed verdict chain and
 * the scoring helpers went under test on 2026-08-05, so the branch is now
 * safe to introduce. The market side has been multichain for a while:
 * ERC-8004 registrations are LARGEST on Ethereum (25k+ vs Base's 17k), and
 * the registries are deployed at identical CREATE2 addresses on every EVM
 * mainnet, so reads are the same bytes against a different RPC.
 *
 * SHAPE. One registry, keyed by chain id. Base is always enabled (default,
 * fully supported: scores, wallet metrics, x402 settlement). Other chains
 * are ENV-GATED: they exist here but count as enabled only when their RPC
 * env var is set, so production capability is an explicit operator decision
 * and a missing RPC can never silently produce empty-looking chain data.
 *
 * WHAT STAYS BASE-ONLY, DELIBERATELY:
 *   - x402 settlement verification. x402 settles in USDC on Base; verifying
 *     "settlement" against another chain would change what the attestation
 *     means. Revisit when the x402 ecosystem itself is multichain (tracked
 *     as indicator X3 in the seeding plan).
 *   - The owner/funder indexers. They hold Base checkpoints; scoring on
 *     other chains marks owner-derived signals accordingly (the sybil
 *     module's fail-closed flags cover reads that cannot be made).
 */

export interface SupportedChain {
  id: number;
  /** URL/query slug, e.g. ?chain=ethereum */
  slug: string;
  viemChain: Chain;
  /** env var holding the RPC url; null = always on with this default */
  rpcEnv: string | null;
  defaultRpc: string;
  /** blockscout API base for wallet metrics; null = metrics unsupported */
  blockscoutApi: string | null;
  /** approximate blocks per day — used for time-windowed log scans */
  blocksPerDay: number;
  /** earliest block worth scanning for ERC-8004 logs on this chain */
  registryFromBlock: bigint;
}

export const CHAINS: Record<number, SupportedChain> = {
  8453: {
    id: 8453,
    slug: "base",
    viemChain: base,
    rpcEnv: "BASE_RPC_URL",
    defaultRpc: "https://mainnet.base.org",
    blockscoutApi: "https://base.blockscout.com/api",
    blocksPerDay: 43_200, // ~2s blocks
    registryFromBlock: BigInt(41_663_783), // IDENTITY_REGISTRY_FROM_BLOCK (verified on-chain)
  },
  // 製品定義書 §7.1 / §14 P1: 決済索引の次点チェーン。POLYGON_RPC_URL が入るまで
  // isChainEnabled は false（defaultRpc 空）で、索引は skipped として開示する。
  137: {
    id: 137,
    slug: "polygon",
    viemChain: polygon,
    rpcEnv: "POLYGON_RPC_URL",
    defaultRpc: "",
    blockscoutApi: "https://polygon.blockscout.com/api",
    blocksPerDay: 40_000, // ~2.1s blocks
    registryFromBlock: BigInt(60_000_000),
  },
  1: {
    id: 1,
    slug: "ethereum",
    viemChain: mainnet,
    rpcEnv: "ETHEREUM_RPC_URL",
    // No default: enabling Ethereum is an explicit operator action. A public
    // default here would silently commit production to an unvetted provider.
    defaultRpc: "",
    blockscoutApi: "https://eth.blockscout.com/api",
    blocksPerDay: 7_200, // ~12s blocks
    // ERC-8004 went live in this era; scanning earlier is pure waste but not
    // an error. Windowed scans rarely reach this floor anyway.
    registryFromBlock: BigInt(20_000_000),
  },
};

export const DEFAULT_CHAIN_ID = 8453;

export function chainBySlug(slug: string): SupportedChain | null {
  const normalized = slug.trim().toLowerCase();
  for (const chain of Object.values(CHAINS)) {
    if (chain.slug === normalized) return chain;
  }
  return null;
}

export function chainById(id: number): SupportedChain | null {
  return CHAINS[id] ?? null;
}

/** RPC url for the chain, or null when the chain is not enabled here.
 *  Base always resolves (it has a safe default); other chains only when the
 *  operator set their env var. */
export function rpcUrlFor(chain: SupportedChain): string | null {
  const fromEnv = chain.rpcEnv ? process.env[chain.rpcEnv]?.trim() : undefined;
  if (fromEnv) return fromEnv;
  return chain.defaultRpc || null;
}

export function isChainEnabled(chain: SupportedChain): boolean {
  return rpcUrlFor(chain) !== null;
}

/** Slugs a caller may pass right now, given the current environment. */
export function enabledChainSlugs(): string[] {
  return Object.values(CHAINS)
    .filter(isChainEnabled)
    .map((c) => c.slug);
}
