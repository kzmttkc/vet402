// rwa-recon-0.2 (SPEC patch 018): several canonical Stock Tokens in one record.
// Each token is replayed and realized on its own; a Stock-for-Stock trade is not
// priced (its one USDG leg cannot be split without a guess); a token Chainlink
// has no feed for shows shares but no dollars, and says why.
//
// Run from the repo root: npx tsx --test packages/rwa/test/facts-multi.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { METHOD_VERSION, assembleFacts, priceEvents } from "../facts";
import { classifyReceipt, type PoolResolver, type RwaReceipt } from "../classify";
import { TOPICS } from "../events";
import { USDG, UNISWAP } from "../config";
import { CANONICAL_SET, tokenByAddress } from "../registry";

const ME = "0xa8553db0049fc6843c0d00d0efc08d31848e3c74";
const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
const AAOI = "0x521cf887e6531c6f667b5bc4d896e5d9bfe8eb2e"; // listed, no Chainlink feed
const POOL_N = "0x1111111111111111111111111111111111111111";
const POOL_A = "0x3333333333333333333333333333333333333333";
const ROUTER = UNISWAP.universalRouter;
const ONE = 10n ** 18n;
const USD = (d: number) => BigInt(d) * 10n ** 6n;

const pad = (a: string) => `0x000000000000000000000000${a.slice(2).toLowerCase()}`;
const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
const xfer = (token: string, from: string, to: string, raw: bigint, logIndex: number) => ({ address: token, topics: [TOPICS.transfer, pad(from), pad(to)], data: word(raw), logIndex });
const swap = (pool: string, logIndex: number) => ({ address: pool, topics: [TOPICS.univ3Swap, pad(ROUTER), pad(ME)], data: "0x", logIndex });
const rc = (n: number, logs: RwaReceipt["logs"]): RwaReceipt => ({ transactionHash: `0x${n.toString(16).padStart(64, "0")}`, blockNumber: 1000 + n, from: ME, to: ROUTER, logs });

const resolver: PoolResolver = {
  async isUniswapV3PoolWith(pool, token) {
    const p = pool.toLowerCase();
    const t = token.toLowerCase();
    return (p === POOL_N && t === NVDA) || (p === POOL_A && t === AAOI);
  },
  async isUniswapV4PoolWith() {
    return false;
  },
};

const receipts: RwaReceipt[] = [
  // 1: buy 10 NVDA for 2,000 USDG
  rc(1, [xfer(USDG, ME, POOL_N, USD(2000), 0), swap(POOL_N, 1), xfer(NVDA, POOL_N, ME, 10n * ONE, 2)]),
  // 2: sell 5 NVDA for 1,100 USDG → realized +100.00
  rc(2, [xfer(NVDA, ME, POOL_N, 5n * ONE, 0), swap(POOL_N, 1), xfer(USDG, POOL_N, ME, USD(1100), 2)]),
  // 3: buy 2 AAOI for 50 USDG
  rc(3, [xfer(USDG, ME, POOL_A, USD(50), 0), swap(POOL_A, 1), xfer(AAOI, POOL_A, ME, 2n * ONE, 2)]),
  // 4: Stock-for-Stock: 1 NVDA out, 3 AAOI in, USDG only between the pools
  rc(4, [xfer(NVDA, ME, POOL_N, ONE, 0), swap(POOL_N, 1), xfer(USDG, POOL_N, POOL_A, USD(200), 2), swap(POOL_A, 3), xfer(AAOI, POOL_A, ME, 3n * ONE, 4)]),
];

const nvdaState = { token: NVDA, raw: 4n * ONE, uiMultiplier: ONE, oraclePaused: false, feed: { decimals: 8, round: { roundId: 1n, answer: 100n * 10n ** 8n, startedAt: 1_700_000_000, updatedAt: 1_700_000_000, answeredInRound: 1n } } };
const aaoiState = { token: AAOI, raw: 5n * ONE, uiMultiplier: ONE, oraclePaused: false, feed: null };
const input = () => ({ address: ME, block: 2000, blockTimestamp: 1_700_000_100, receipts, states: [aaoiState, nvdaState], resolver });

test("the registry fixture tokens used here are what the test assumes", () => {
  assert.equal(tokenByAddress(NVDA)?.symbol, "NVDA");
  assert.ok(tokenByAddress(NVDA)?.feed);
  assert.equal(tokenByAddress(AAOI)?.symbol, "AAOI");
  assert.equal(tokenByAddress(AAOI)?.feed, null);
});

test("a Stock-for-Stock transaction is left unpriced on both sides", async () => {
  const events = [];
  for (const r of receipts) events.push(...(await classifyReceipt(r, ME, CANONICAL_SET as Set<string>, resolver)));
  const tx4 = receipts[3].transactionHash;
  const priced = priceEvents(receipts, events, ME).filter((p) => p.tx === tx4);
  assert.equal(priced.length, 2);
  for (const p of priced) assert.equal(p.quote_usd_cents, null, p.token);
});

test("each token is replayed and realized on its own; totals add up", async () => {
  const f = await assembleFacts(input());
  assert.equal(f.method_version, METHOD_VERSION);
  const bySym = Object.fromEntries(f.tokens.map((t) => [t.symbol, t]));
  assert.equal(bySym.NVDA.replayed_raw, bySym.NVDA.raw);
  assert.equal(bySym.AAOI.replayed_raw, bySym.AAOI.raw);
  assert.equal(bySym.NVDA.realized_usd, "100.00");
  assert.equal(bySym.AAOI.realized_usd, null);
  assert.equal(f.realized_usd, "100.00");
  assert.equal(f.realized_status, "partial"); // the NVDA leg of tx 4 could not be priced
  assert.equal(f.gaps.includes("balance_mismatch"), false);
});

test("a token without a Chainlink feed shows shares, no dollars, and says why", async () => {
  const f = await assembleFacts(input());
  const aaoi = f.tokens.find((t) => t.symbol === "AAOI")!;
  assert.equal(aaoi.shares_ui, "5.00000000");
  assert.equal(aaoi.usd, null);
  assert.equal(aaoi.usd_reason, "no_feed");
  assert.equal(aaoi.feed, null);
  assert.ok(f.gaps.includes("no_feed"));
  assert.equal(f.unrealized_usd, null, "a total that leaves out a held token would read as the whole");
});

test("held tokens are listed by USD mark first, and the record states its scope", async () => {
  const f = await assembleFacts(input());
  assert.deepEqual(f.tokens.map((t) => t.symbol), ["NVDA", "AAOI"]);
  assert.equal(f.tokens[0].usd, "400.00");
  assert.deepEqual(f.scope.scanned, ["AAOI", "NVDA"]);
  assert.equal(f.scope.registry_tokens, 195);
  assert.ok(f.gaps.includes("exited_positions_not_scanned"));
});

test("an event on a token whose state was not read is an error, not a silent drop", async () => {
  await assert.rejects(assembleFacts({ ...input(), states: [nvdaState] }), /no on-chain state read/);
});

test("a token read only for its state is not listed as scanned, and the record says so", async () => {
  const f = await assembleFacts({ ...input(), historyNotWalked: new Set([AAOI]) });
  assert.deepEqual(f.scope.scanned, ["NVDA"]);
  assert.deepEqual(f.scope.history_not_walked, ["AAOI"]);
  assert.ok(f.gaps.includes("history_not_walked"));
});

test("a balance the replay cannot explain makes the record unverified, not reconstructed", async () => {
  const f = await assembleFacts({ ...input(), states: [aaoiState, { ...nvdaState, raw: 7n * ONE }] });
  assert.ok(f.gaps.includes("balance_mismatch"));
  assert.equal(f.r1_status, "unverified");
  assert.equal(f.realized_usd, null, "SPEC §4: no realized figure unless R1 is reconstructed or partial");
  for (const t of f.tokens) {
    assert.equal(t.realized_usd, null, t.symbol);
    assert.equal(t.realized_status, "partial", t.symbol);
  }
});
