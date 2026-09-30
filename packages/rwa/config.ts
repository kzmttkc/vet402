// Robinhood Chain inputs for /rwa (SPEC §2).
//
// Only addresses checked against the chain are listed here.

export const RWA_CHAIN_ID = 4663;
/** Robinhood's own public RPC. The default read path, and the only one the scripts use (they write the URL into fixtures). */
export const RWA_PUBLIC_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
/** SPEC §9: one fallback, used only when the primary fails. Chosen 2026-09-17 from chainlist (chain 4663 confirmed by eth_chainId).
 *  Measured the same day: it refuses archive reads and genesis-range log queries without a token, so it only covers head-side reads. */
export const RWA_RPC_FALLBACK_URL = "https://robinhood-rpc.publicnode.com";

type Env = Record<string, string | undefined>;

/** An env value used only when it is an https URL. Anything else is ignored, so a typo falls back to the public path instead of taking /rwa down. */
function httpsUrl(v: string | undefined): string | null {
  const t = v?.trim();
  return t && /^https:\/\/[^\s]+$/.test(t) ? t : null;
}

/** Alchemy's Robinhood Chain mainnet host. The key is appended at call time and never stored elsewhere. */
export const ALCHEMY_ROBINHOOD_BASE = "https://robinhood-mainnet.g.alchemy.com/v2/";

/**
 * The Alchemy endpoint for Robinhood Chain (SPEC patch 020), the full URL with
 * its key: RWA_ALCHEMY_URL, else ALCHEMY_API_KEY on ALCHEMY_ROBINHOOD_BASE, else
 * none. Set only in Vercel. It is never logged, echoed or written to a file.
 */
export function rwaAlchemyUrl(env: Env = process.env): string | null {
  const explicit = httpsUrl(env.RWA_ALCHEMY_URL);
  if (explicit) return explicit;
  const key = env.ALCHEMY_API_KEY?.trim();
  return key && /^[A-Za-z0-9_-]+$/.test(key) ? `${ALCHEMY_ROBINHOOD_BASE}${key}` : null;
}

/** The primary read RPC when Alchemy is not in use: RWA_RPC_URL, else the public RPC. */
export function rwaNonAlchemyRpcUrl(env: Env = process.env): string {
  return httpsUrl(env.RWA_RPC_URL) ?? RWA_PUBLIC_RPC_URL;
}

/**
 * The primary read RPC for every /rwa reconstruction, free and paid alike
 * (SPEC patch 020): RWA_ALCHEMY_URL, else RWA_RPC_URL, else the public RPC.
 * ALCHEMY_API_KEY alone does not move the plain reads: it serves only the two
 * enhanced calls in alchemy.ts. Read at call time, so a test or a redeploy can
 * change it without a rebuild.
 */
export function rwaRpcUrl(env: Env = process.env): string {
  return httpsUrl(env.RWA_ALCHEMY_URL) ?? rwaNonAlchemyRpcUrl(env);
}

/** Which kind of primary is in use, for the record and the logs (never the URL itself). */
export function rwaRpcSource(env: Env = process.env): "alchemy" | "custom" | "public" {
  if (httpsUrl(env.RWA_ALCHEMY_URL)) return "alchemy";
  return httpsUrl(env.RWA_RPC_URL) ? "custom" : "public";
}

// Golden token for Fixture A (SPEC §11). Checked on 2026-09-17 via eth_call:
// symbol() = "NVDA", decimals() = 18; feed description() = "RHNVDA / USD", decimals() = 8.
export const NVDA = {
  symbol: "NVDA",
  token: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
  feed: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15",
} as const;

/**
 * Uniswap on Robinhood Chain (SPEC §2). Checked 2026-09-17 two ways:
 *   - robinhoodchain.blockscout.com /api/v2/smart-contracts: each address is a
 *     verified contract with the matching source name (UniswapV3Factory,
 *     SwapRouter02, UniversalRouter, PoolManager, PositionManager)
 *   - developers.uniswap.org/docs/protocols/{v3,v4}/deployments, section
 *     "Robinhood Chain: 4663": same addresses
 * Lower-cased because receipts and topics arrive lower-cased.
 */
export const UNISWAP = {
  v3Factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
  swapRouter02: "0xcaf681a66d020601342297493863e78c959e5cb2",
  universalRouter: "0x8876789976decbfcbbbe364623c63652db8c0904",
  v4PoolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  v4PositionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
} as const;

/** Sushi v3 factory (SPEC §2): verified on Blockscout as a UniswapV3Factory fork. Not a v0 venue; its pools are other_unparsed. */
export const SUSHI_V3_FACTORY = "0xe51960f1b45f1c9fb6d166e6a884f866fc70433b";

/** Quote tokens (SPEC §2). */
export const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
export const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
