// Robinhood Chain inputs for /rwa (SPEC §2).
//
// Only addresses checked against the chain are listed here. The Uniswap v3
// factory, SwapRouter02, UniversalRouter, v4 PoolManager and PositionManager
// from SPEC §2 come from third-party write-ups; they are added only after the
// Blockscout bytecode check against the official Uniswap deployments.

export const RWA_CHAIN_ID = 4663;
export const RWA_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";

// Golden token for Fixture A (SPEC §11). Checked on 2026-09-17 via eth_call:
// symbol() = "NVDA", decimals() = 18; feed description() = "RHNVDA / USD", decimals() = 8.
export const NVDA = {
  symbol: "NVDA",
  token: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
  feed: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15",
} as const;
