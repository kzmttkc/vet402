// Wallets the /rwa pages offer to a visitor who has no Stock Token wallet of their own (SPEC patch 020).
//
// Each one was picked from chain data only: an EOA that traded canonical Stock
// Tokens through the official Uniswap pools, whose record rebuilds as
// reconstructed or partial with the replay landing on the chain balance, and
// that answered fast. The note says what the record shows, never who owns it.
export type ExampleWallet = { address: string; note: string };

/** Picked and measured on 2026-09-30 (docs/rwa/spec-patches/020-reach.md). Notes are as of that day. */
export const EXAMPLE_WALLETS: readonly ExampleWallet[] = [
  { address: "0xE9B08727131E34010b34006c660D4c1B436EC25f", note: "the demo wallet: holds NVDA and QQQ, 54 Uniswap swaps decoded, partial (as of 2026-09-30)" },
  { address: "0x6d3C1187A60B672C1AECB43a5aAEA9Abeec2b298", note: "a small one: holds SPY, QQQ back to zero, 3 transactions, 2 decoded as Uniswap v4 swaps, partial (as of 2026-09-30)" },
  { address: "0xace64DBF9B86975756A79a28A8614e9E97c707a6", note: "holds NET, which has no Chainlink feed, so no USD mark is shown, partial (as of 2026-09-30)" },
];
