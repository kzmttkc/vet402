// What a Robinhood Stock Token is on chain (SPEC patch 021).
//
// Robinhood's asset list says which addresses are Stock Tokens. These constants
// say what those addresses are, so a token can be checked without trusting a
// list alone. Each value was measured on Robinhood Chain (4663) and every
// canonical token in registry.json is checked against them
// (packages/rwa/scripts/snapshot-registry.ts --identity-only, test/registry.test.ts).
//
//   - Every Stock Token is a beacon proxy. Its runtime code embeds one beacon
//     address, so all of them share one code hash.
//   - The beacon is also in the EIP-1967 beacon slot of each token.
//   - Every Stock Token was deployed by one factory, which emits a deployment
//     event carrying (token, name, symbol).
//
// A code hash alone is not proof: anyone can deploy the same proxy bytecode
// pointing at the same beacon. The factory event is the second root. A token
// needs both, and an address in Robinhood's list, to be canonical here.

/** keccak256(eth_getCode) of every canonical Stock Token. */
export const STOCK_TOKEN_CODE_HASH = "0x6c1fdd40002dcb440c7fff6a84171404d279ccb057803b65826f7546acd65630";

/** The beacon every Stock Token proxy delegates through (embedded in the runtime code and in the EIP-1967 beacon slot). */
export const STOCK_TOKEN_BEACON = "0xe10b6f6B275de231345c20D14Ab812db62151b00";

/** The Stock Token factory (an EIP-1967 proxy). Its deployment event names every Stock Token it created. */
export const STOCK_TOKEN_FACTORY = "0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046";

/** topic0 of the factory's deployment event. Data: (address token, string name, string symbol). */
export const TOKEN_DEPLOYED_TOPIC0 = "0xd9b0c6a1c0de228715ad0fa09f3259686ee84f8cc675e03ef7e47a9cdafa76d6";
