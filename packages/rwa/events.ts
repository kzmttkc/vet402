// Event signatures /rwa decodes (SPEC §3). Values computed with viem's
// toEventSelector on 2026-09-17; the source signatures are in the comments.
export const TOPICS = {
  /** ERC-20 Transfer(address indexed from, address indexed to, uint256 value) */
  transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  /** Uniswap v3 pool Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick).
   *  Sushi v3 pools emit the same signature: the emitter must be verified against the Uniswap factory. */
  univ3Swap: "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67",
  /** Uniswap v4 PoolManager Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee) */
  univ4Swap: "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f",
  /** Uniswap v4 PoolManager Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick) */
  univ4Initialize: "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438",
  /** Stock Token UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAt), no indexed fields.
   *  Checked 2026-09-30 against the chain: viem toEventSelector gives this topic, and the NVDA log in tx
   *  0x4ac23f2e… carries three words (1e18, 1000775159164630595, 1788998430). The same tx called
   *  updateMultiplier(uint256,uint256) (selector 0xbad60f18) with (1000775159164630595, 1788998430), so the
   *  first word is the multiplier before, the second the multiplier after, the third the unix time it takes effect. */
  uiMultiplierUpdated: "0x2205df4534432b2f60654a3fdb48737ffdaf3e9edb1a498bd985bc026b15b055",
} as const;

/** One decoded UIMultiplierUpdated log of a Stock Token. */
export type MultiplierUpdate = {
  /** lower-cased token address */
  token: string;
  block: number;
  log_index: number;
  tx: string;
  /** uiMultiplier before the update, 18 decimals */
  multiplier_before: bigint;
  /** uiMultiplier after the update, 18 decimals */
  multiplier_after: bigint;
  /** unix seconds from which the new multiplier applies, as the token emitted it */
  effective_at: number;
};

/** Decode a UIMultiplierUpdated log. Returns null for any other log shape. */
export function decodeMultiplierUpdate(log: { address: string; topics: string[]; data: string; blockNumber: string | number; logIndex: string | number; transactionHash: string }): MultiplierUpdate | null {
  if (log.topics[0]?.toLowerCase() !== TOPICS.uiMultiplierUpdated || log.topics.length !== 1) return null;
  const data = log.data.startsWith("0x") ? log.data.slice(2) : log.data;
  if (data.length !== 64 * 3) return null;
  const w = (i: number) => BigInt(`0x${data.slice(64 * i, 64 * (i + 1))}`);
  return {
    token: log.address.toLowerCase(),
    block: Number(log.blockNumber),
    log_index: Number(log.logIndex),
    tx: log.transactionHash.toLowerCase(),
    multiplier_before: w(0),
    multiplier_after: w(1),
    effective_at: Number(w(2)),
  };
}

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Last 20 bytes of a 32-byte topic, lower-cased with 0x. */
export function topicToAddress(topic: string): string {
  return `0x${topic.slice(-40).toLowerCase()}`;
}
