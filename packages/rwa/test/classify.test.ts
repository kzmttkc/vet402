// Event classification (SPEC §3). One canonical Transfer leg becomes exactly
// one of: transfer | univ3_swap | univ4_swap | other_unparsed. Nothing is dropped.
//
// Run from the repo root: npx tsx --test packages/rwa/test/classify.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyReceipt, type RwaReceipt, type PoolResolver } from "../classify";
import { TOPICS } from "../events";
import { NVDA, UNISWAP } from "../config";

const ME = "0xa8553db0049fc6843c0d00d0efc08d31848e3c74";
const OTHER = "0x1a18a8b96eac3f980133a18402d04194f1faa4e7";
const POOL = "0x1111111111111111111111111111111111111111";
const SUSHI_POOL = "0x2222222222222222222222222222222222222222";
const ROUTER = UNISWAP.universalRouter;
const NVDA_ADDR = NVDA.token.toLowerCase();

const pad = (addr: string) => `0x000000000000000000000000${addr.slice(2).toLowerCase()}`;
const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
const ONE = 10n ** 18n;

function transfer(from: string, to: string, raw: bigint, logIndex: number, token = NVDA_ADDR) {
  return { address: token, topics: [TOPICS.transfer, pad(from), pad(to)], data: word(raw), logIndex };
}
function v3Swap(pool: string, logIndex: number) {
  return { address: pool, topics: [TOPICS.univ3Swap, pad(ROUTER), pad(ME)], data: "0x", logIndex };
}
function v4Swap(poolId: string, logIndex: number) {
  return { address: UNISWAP.v4PoolManager.toLowerCase(), topics: [TOPICS.univ4Swap, poolId, pad(ROUTER)], data: "0x", logIndex };
}
function receipt(to: string, logs: RwaReceipt["logs"], n = 1): RwaReceipt {
  return { transactionHash: `0x${n.toString(16).padStart(64, "0")}`, blockNumber: 100 + n, from: ME, to, logs };
}

// A resolver that knows one Uniswap v3 pool and one v4 pool holding NVDA.
const V4_ID = `0x${"ab".repeat(32)}`;
const resolver: PoolResolver = {
  async isUniswapV3PoolWith(pool, token) {
    return pool.toLowerCase() === POOL && token.toLowerCase() === NVDA_ADDR;
  },
  async isUniswapV4PoolWith(poolId, token) {
    return poolId === V4_ID && token.toLowerCase() === NVDA_ADDR;
  },
};

const canonical = new Set([NVDA_ADDR]);

test("a direct call to the token contract is a plain transfer, in and out", async () => {
  const inbound = await classifyReceipt(receipt(NVDA_ADDR, [transfer(OTHER, ME, 5n * ONE, 0)], 1), ME, canonical, resolver);
  assert.deepEqual(inbound.map((e) => [e.type, e.raw_delta]), [["transfer", 5n * ONE]]);
  const outbound = await classifyReceipt(receipt(NVDA_ADDR, [transfer(ME, OTHER, 2n * ONE, 0)], 2), ME, canonical, resolver);
  assert.deepEqual(outbound.map((e) => [e.type, e.raw_delta]), [["transfer", -2n * ONE]]);
});

test("a mint (from zero) through the token contract is a transfer with a positive delta", async () => {
  const zero = `0x${"0".repeat(40)}`;
  const events = await classifyReceipt(receipt(NVDA_ADDR, [transfer(zero, ME, ONE, 0), { address: NVDA_ADDR, topics: ["0x37e7f0db" + "0".repeat(56)], data: "0x", logIndex: 1 }], 3), ME, canonical, resolver);
  assert.deepEqual(events.map((e) => [e.type, e.raw_delta]), [["transfer", ONE]]);
});

test("self-to-self legs and legs of non-canonical tokens are ignored", async () => {
  const events = await classifyReceipt(
    receipt(NVDA_ADDR, [transfer(ME, ME, ONE, 0), transfer(OTHER, ME, ONE, 1, "0x3333333333333333333333333333333333333333")], 4),
    ME, canonical, resolver,
  );
  assert.equal(events.length, 0);
});

test("a swap through a verified Uniswap v3 pool holding the token is univ3_swap", async () => {
  const events = await classifyReceipt(
    receipt(ROUTER, [transfer(ME, POOL, 3n * ONE, 0), v3Swap(POOL, 1)], 5),
    ME, canonical, resolver,
  );
  assert.deepEqual(events.map((e) => [e.type, e.raw_delta]), [["univ3_swap", -3n * ONE]]);
});

test("a swap through an unverified v3-shaped pool (Sushi) is other_unparsed, not dropped", async () => {
  const events = await classifyReceipt(
    receipt(ROUTER, [transfer(SUSHI_POOL, ME, 3n * ONE, 0), v3Swap(SUSHI_POOL, 1)], 6),
    ME, canonical, resolver,
  );
  assert.deepEqual(events.map((e) => [e.type, e.raw_delta]), [["other_unparsed", 3n * ONE]]);
});

test("a swap through the v4 PoolManager for a pool holding the token is univ4_swap with Transfer-leg amounts", async () => {
  const events = await classifyReceipt(
    receipt(ROUTER, [transfer(UNISWAP.v4PoolManager, ME, 7n * ONE, 0), v4Swap(V4_ID, 1)], 7),
    ME, canonical, resolver,
  );
  assert.deepEqual(events.map((e) => [e.type, e.raw_delta]), [["univ4_swap", 7n * ONE]]);
});

test("a v4 Swap for a pool that does not hold the token leaves the leg other_unparsed", async () => {
  const events = await classifyReceipt(
    receipt(ROUTER, [transfer(UNISWAP.v4PoolManager, ME, ONE, 0), v4Swap(`0x${"cd".repeat(32)}`, 1)], 8),
    ME, canonical, resolver,
  );
  assert.deepEqual(events.map((e) => e.type), ["other_unparsed"]);
});

test("a canonical leg moved by an unknown contract with no swap event is other_unparsed", async () => {
  const vault = "0x4444444444444444444444444444444444444444";
  const events = await classifyReceipt(receipt(vault, [transfer(ME, vault, ONE, 0)], 9), ME, canonical, resolver);
  assert.deepEqual(events.map((e) => e.type), ["other_unparsed"]);
});

test("every event carries tx, log index, block and token", async () => {
  const [e] = await classifyReceipt(receipt(NVDA_ADDR, [transfer(OTHER, ME, ONE, 4)], 10), ME, canonical, resolver);
  assert.equal(e.tx, `0x${"a".padStart(64, "0")}`);
  assert.equal(e.log_index, 4);
  assert.equal(e.block_number, 110);
  assert.equal(e.token, NVDA_ADDR);
});
