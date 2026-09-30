// The look-alike search and its place in the record (SPEC patch 021). Offline:
// every RPC and Alchemy call is mocked.
//
// Run from the repo root: npx tsx --test packages/rwa/test/lookalike-scan.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeAbiParameters } from "viem";
import type { RwaReceipt } from "../classify";
import { NVDA, USDG } from "../config";
import { TOPICS } from "../events";
import { assembleFacts } from "../facts";
import {
  buildLookalikes,
  fixtureFor,
  RECENT_SPAN_BLOCKS,
  RECENT_SPANS,
  scanLookalikes,
  transfersFromReceipts,
  usdgCounterparties,
  type LookalikeFixture,
  type TokenMeta,
} from "../lookalike-scan";
import { recordedPoolResolver } from "../pools";
import { padAddress } from "../rpc";

const FX = JSON.parse(readFileSync(join(process.cwd(), "fixtures/rwa/lookalikes-demo.json"), "utf8")) as LookalikeFixture;
const W = FX.address;
const FAKE_NVDA = "0x5dd716fe12275b69f04b26beeca343843c8e3539";
const FAKE_USDG = "0x4190ee598c2a69d35bef53c83d152ae0f25ea416";
const REAL_PEER = "0x1eb96a9cec4ca4a2a945a99478b52bc49a6d77c3";
const noSleep = async () => {};

const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
function transferLog(token: string, from: string, to: string, amount: bigint, logIndex: number) {
  return { address: token, topics: [TOPICS.transfer, padAddress(from), padAddress(to)], data: word(amount), logIndex };
}

test("the demo fixture states its source and range, and holds only the two look-alikes", () => {
  assert.equal(fixtureFor("0xE9B08727131E34010b34006c660D4c1B436EC25f")?.address, W);
  assert.equal(fixtureFor(NVDA.token), null);
  assert.equal(FX.scanned_from_block, 0);
  assert.ok(FX.scanned_to_block >= 76_012_674);
  assert.match(FX.source, /no address filter/);
  assert.equal(FX.tokens_seen.length, 34, "non-canonical tokens met by the full search");
  assert.deepEqual(Object.keys(FX.tokens).sort(), [FAKE_USDG, FAKE_NVDA]);
  assert.ok(FX.counterparties.includes(REAL_PEER));
});

test("from the fixture: the fake NVDA received and the fake USDG made to look like a payment to a real counterparty", () => {
  const meta = new Map<string, TokenMeta>(Object.entries(FX.tokens));
  const got = buildLookalikes(FX.transfers.map((t) => ({ ...t, found_by: "fixture" as const })), meta, W, FX.counterparties);
  assert.equal(got.length, 2);
  const [usdg, nvda] = got;

  assert.equal(usdg.token.toLowerCase(), FAKE_USDG);
  assert.equal(usdg.symbol_raw, "U⟨U+17B5⟩S⟨U+17B5⟩DG");
  assert.equal(usdg.imitates, "USDG");
  assert.equal(usdg.direction, "sent");
  assert.equal(usdg.counterparty, "0x1eb99afad224b2523a6d6aa88b36da33b8b177c3");
  assert.equal(usdg.mimics, REAL_PEER);
  assert.deepEqual(usdg.reasons, ["imitates_usdg", "hidden_characters", "mimics_counterparty", "not_canonical_address"]);
  assert.equal(usdg.first_seen_block, 63379129);
  assert.equal(usdg.counted, false);

  assert.equal(nvda.token.toLowerCase(), FAKE_NVDA);
  assert.equal(nvda.name_raw, "NVIDIA Robinhood Coin");
  assert.equal(nvda.imitates, "NVDA");
  assert.equal(nvda.direction, "received");
  assert.equal(nvda.amount_raw, "25000000000000000000");
  assert.equal(nvda.first_seen_block, 73953009);
  assert.equal(nvda.tx, "0x1b838f40a43d54b7ce3364f08f723516170be2d03fdbcd6ab801c79f7f77b51b");
  assert.ok(nvda.reasons.includes("name_claims_robinhood_stock_token"));
  assert.ok(nvda.reasons.includes("code_hash_differs"));
  assert.equal(nvda.mimics, null);
  assert.equal(nvda.counted, false);
});

test("receipts: non-canonical transfers naming the wallet are picked up, canonical, USDG and unrelated ones are not", () => {
  const other = "0x000000000000000000000000000000000000beef";
  const r: RwaReceipt = {
    transactionHash: "0x" + "ab".repeat(32),
    blockNumber: 100,
    from: other,
    to: null,
    logs: [
      transferLog(FAKE_NVDA, other, W, 5n, 0),
      transferLog(NVDA.token.toLowerCase(), other, W, 5n, 1),
      transferLog(USDG, W, other, 5n, 2),
      transferLog(FAKE_NVDA, other, other, 5n, 3),
    ],
  };
  const got = transfersFromReceipts([r], W);
  assert.equal(got.length, 1);
  assert.equal(got[0].token, FAKE_NVDA);
  assert.equal(got[0].amount_raw, "5");
  assert.equal(got[0].found_by, "receipts");
  assert.deepEqual(usdgCounterparties([{ token: USDG, from: W, to: other }], W), [other]);
});

// A mock of the public RPC: empty logs, and fixed metadata for the fake NVDA.
function rpcMock(opts: { fail?: boolean; logs?: unknown[] } = {}): typeof fetch {
  const str = (s: string) => encodeAbiParameters([{ type: "string" }], [s]);
  return (async (_url: string, init: { body: string }) => {
    if (opts.fail) return new Response("busy", { status: 503 });
    const body = JSON.parse(init.body);
    const list = Array.isArray(body) ? body : [body];
    const out = list.map((c: { id: number; method: string; params: [{ data?: string }] }) => {
      if (c.method === "eth_getLogs") return { jsonrpc: "2.0", id: c.id, result: opts.logs ?? [] };
      if (c.method === "eth_getCode") return { jsonrpc: "2.0", id: c.id, result: "0x6080604052" };
      if (c.method === "eth_call") return { jsonrpc: "2.0", id: c.id, result: c.params[0].data === "0x95d89b41" ? str("NVDA") : str("NVIDIA Robinhood Coin") };
      return { jsonrpc: "2.0", id: c.id, error: { code: -32601, message: "no" } };
    });
    return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), { status: 200 });
  }) as unknown as typeof fetch;
}

test("no key, demo wallet near the fixture's end: fixture plus the recent window cover every block", async () => {
  const block = FX.scanned_to_block + 1000;
  const r = await scanLookalikes(W, block, [], { fixture: FX, alchemy: null, fetchImpl: rpcMock(), sleep: noSleep });
  assert.equal(r.lookalikes.length, 2);
  assert.ok(r.lookalikes.every((l) => l.counted === false && l.found_by === "fixture"));
  assert.equal(r.lookalikes_scope.complete, true);
  assert.deepEqual(r.lookalikes_scope.not_scanned, []);
  assert.deepEqual(r.lookalikes_scope.searched.map((s) => s.source), ["receipts", "recent_logs", "fixture"]);
  const recent = r.lookalikes_scope.searched.find((s) => s.source === "recent_logs")!;
  assert.equal(recent.from_block, block - RECENT_SPANS * RECENT_SPAN_BLOCKS + 1);
});

test("no key, far past the fixture: the gap is written as not scanned", async () => {
  const block = FX.scanned_to_block + 1_000_000;
  const r = await scanLookalikes(W, block, [], { fixture: FX, alchemy: null, fetchImpl: rpcMock(), sleep: noSleep });
  assert.equal(r.lookalikes_scope.complete, false);
  assert.match(r.lookalikes_scope.not_scanned[0], new RegExp(`blocks ${FX.scanned_to_block + 1}-${block - RECENT_SPANS * RECENT_SPAN_BLOCKS}`));
  assert.equal(r.lookalikes.length, 2, "the fixture's finds still stand");
});

test("no key, another wallet: everything before the recent window is not scanned", async () => {
  const other = "0x1111111111111111111111111111111111111111";
  const block = 76_000_000;
  const r = await scanLookalikes(other, block, [], { fixture: null, alchemy: null, fetchImpl: rpcMock(), sleep: noSleep });
  assert.equal(r.lookalikes_scope.complete, false);
  assert.equal(r.lookalikes.length, 0);
  assert.match(r.lookalikes_scope.not_scanned[0], /^ERC-20 transfers in blocks 0-75880000/);
});

test("the recent window finds a fake NVDA and reads its name on chain", async () => {
  const other = "0x1111111111111111111111111111111111111111";
  const block = 76_000_000;
  const log = { address: FAKE_NVDA, topics: [TOPICS.transfer, padAddress("0x3433e16efacb71e0e2cd605489514b648b30abd0"), padAddress(other)], data: word(25n * 10n ** 18n), blockNumber: "0x487ab00", transactionHash: "0x" + "cd".repeat(32), logIndex: "0x3" };
  const r = await scanLookalikes(other, block, [], { fixture: null, alchemy: null, fetchImpl: rpcMock({ logs: [log] }), sleep: noSleep });
  assert.equal(r.lookalikes.length, 1);
  assert.equal(r.lookalikes[0].found_by, "recent_logs");
  assert.equal(r.lookalikes[0].imitates, "NVDA");
  assert.equal(r.lookalikes_scope.tokens_judged, 1);
});

test("a refusing RPC never fails the search; it says what it could not read", async () => {
  const r = await scanLookalikes(W, FX.scanned_to_block + 10, [], { fixture: FX, alchemy: null, fetchImpl: rpcMock({ fail: true }), sleep: noSleep, retries: 0 });
  assert.equal(r.lookalikes_scope.complete, false);
  assert.ok(r.lookalikes_scope.not_scanned.some((n) => /recent window/.test(n)));
  assert.equal(r.lookalikes.length, 2, "the fixture still answers");
});

test("with Alchemy: every ERC-20 transfer to and from the wallet, the key never in the record", async () => {
  const other = "0x1111111111111111111111111111111111111111";
  const url = "https://robinhood-mainnet.g.alchemy.com/v2/sk_SECRET_KEY_123";
  const alchemyFetch = (async (_u: string, init: { body: string }) => {
    const req = JSON.parse(init.body);
    const p = req.params[0];
    const transfers = p.toAddress
      ? [{ blockNum: "0x4686ef1", uniqueId: "0x1b83:log:107", hash: "0x1b838f40a43d54b7ce3364f08f723516170be2d03fdbcd6ab801c79f7f77b51b", from: "0x3433e16efacb71e0e2cd605489514b648b30abd0", to: other, value: 25, asset: "NVDA", category: "erc20", rawContract: { value: "0x15af1d78b58c40000", address: FAKE_NVDA, decimal: "0x12" } }]
      : [];
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { transfers } }), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await scanLookalikes(other, 76_000_000, [], { fixture: null, alchemy: { url, fetchImpl: alchemyFetch }, fetchImpl: rpcMock(), sleep: noSleep });
  assert.equal(r.lookalikes_scope.complete, true);
  assert.deepEqual(r.lookalikes_scope.searched.map((s) => s.source), ["alchemy"]);
  assert.equal(r.lookalikes.length, 1);
  assert.equal(r.lookalikes[0].found_by, "alchemy");
  assert.equal(r.lookalikes[0].first_seen_block, 73953009);
  assert.ok(!JSON.stringify(r).includes("SECRET"));
  assert.ok(!JSON.stringify(r).includes("alchemy.com"));
});

test("an Alchemy failure falls back to the public RPC and says so, without the key", async () => {
  const url = "https://robinhood-mainnet.g.alchemy.com/v2/sk_SECRET_KEY_123";
  const bad = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
  const r = await scanLookalikes(W, FX.scanned_to_block + 10, [], { fixture: FX, alchemy: { url, fetchImpl: bad }, fetchImpl: rpcMock(), sleep: noSleep });
  assert.ok(r.lookalikes_scope.not_scanned.some((n) => /Alchemy search failed \(alchemy_getAssetTransfers: refused \(HTTP 401\)\), so the public RPC was used/.test(n)));
  assert.equal(r.lookalikes.length, 2);
  assert.ok(!JSON.stringify(r).includes("SECRET"));
});

// ---- look-alikes never reach the PnL ----------------------------------------

const A = JSON.parse(readFileSync(join(process.cwd(), "fixtures/rwa/A.json"), "utf8"));
const CHAIN = JSON.parse(readFileSync(join(process.cwd(), "fixtures/rwa/A.chain.json"), "utf8"));

function stateFromFixtureA() {
  return {
    token: (A.token.address as string).toLowerCase(),
    raw: BigInt(A.raw),
    uiMultiplier: BigInt(A.ui_multiplier),
    oraclePaused: A.oracle_paused as boolean,
    feed: {
      decimals: A.feed.decimals as number,
      round: {
        roundId: BigInt(A.feed_round.round_id),
        answer: BigInt(A.feed_round.answer),
        startedAt: Number(A.feed_round.started_at),
        updatedAt: Number(A.feed_round.updated_at),
        answeredInRound: BigInt(A.feed_round.answered_in_round),
      },
    },
  };
}

test("a fake NVDA in the record's own receipts changes nothing counted, and is listed with counted: false", async () => {
  const holder = (A.holder.address as string).toLowerCase();
  const NVDA_LC = (A.token.address as string).toLowerCase();
  const base = {
    address: A.holder.address,
    block: A.block,
    blockTimestamp: A.block_timestamp,
    states: [stateFromFixtureA()],
    resolver: recordedPoolResolver(CHAIN.pools),
    canonical: new Set([NVDA_LC]),
    scopeRule: "fixture A: NVDA only, recorded 2026-09-17",
  };
  const fakeReceipt: RwaReceipt = {
    transactionHash: "0x" + "fe".repeat(32),
    blockNumber: A.block - 5,
    from: "0x3433e16efacb71e0e2cd605489514b648b30abd0",
    to: FAKE_NVDA,
    logs: [transferLog(FAKE_NVDA, "0x3433e16efacb71e0e2cd605489514b648b30abd0", holder, 10n ** 24n, 0)],
  };
  const clean = await assembleFacts({ ...base, receipts: CHAIN.receipts });
  const receipts = [...CHAIN.receipts, fakeReceipt];
  const found = buildLookalikes(transfersFromReceipts(receipts, holder), new Map([[FAKE_NVDA, { symbol: "NVDA", name: "NVIDIA Robinhood Coin", codeHash: "0x" + "11".repeat(32) }]]), holder, []);
  const dirty = await assembleFacts({
    ...base,
    receipts,
    lookalikes: { lookalikes: found, lookalikes_scope: { complete: false, searched: [{ source: "receipts", from_block: null, to_block: A.block, detail: "test" }], not_scanned: ["test"], tokens_judged: 1, tokens_not_judged: 0 } },
  });
  for (const k of ["tokens", "events_summary", "realized_usd", "realized_status", "unrealized_usd", "r1_status", "gaps", "evidence"] as const) assert.deepEqual(dirty[k], clean[k], k);
  assert.equal(dirty.lookalikes.length, 1);
  assert.equal(dirty.lookalikes[0].counted, false);
  assert.equal(dirty.lookalikes[0].amount_raw, (10n ** 24n).toString());
  assert.ok(!dirty.evidence.txs.includes(fakeReceipt.transactionHash));
  assert.equal(clean.lookalikes_scope.complete, false);
  assert.deepEqual(clean.lookalikes, []);
});

test("a hanging RPC is cut at the budget and the record still gets the fixture's finds", async () => {
  const hang = (() => new Promise(() => {})) as unknown as typeof fetch;
  const t = Date.now();
  const r = await scanLookalikes(W, FX.scanned_to_block + 10, [], { fixture: FX, alchemy: null, fetchImpl: hang, sleep: noSleep, budgetMs: 50, timeoutMs: 200 });
  assert.ok(Date.now() - t < 1_000);
  assert.equal(r.lookalikes.length, 2);
  assert.equal(r.lookalikes_scope.complete, false);
  assert.ok(r.lookalikes_scope.not_scanned.some((n) => /recent window/.test(n)));
});

test("the search deadline sits inside the record's own deadline", async () => {
  const { LOOKALIKE_DEADLINE_MS } = await import("../facts");
  const { RECONSTRUCTION_DEADLINE_MS } = await import("../cache");
  const { LOOKALIKE_BUDGET_MS } = await import("../lookalike-scan");
  assert.ok(LOOKALIKE_DEADLINE_MS + 5_000 <= RECONSTRUCTION_DEADLINE_MS);
  assert.ok(LOOKALIKE_BUDGET_MS <= LOOKALIKE_DEADLINE_MS);
});

test("a zero budget still answers from the fixture", async () => {
  const r = await scanLookalikes(W, FX.scanned_to_block + 10, [], { fixture: FX, alchemy: null, fetchImpl: rpcMock(), sleep: noSleep, budgetMs: 0 });
  assert.equal(r.lookalikes.length, 2);
  assert.equal(r.lookalikes_scope.complete, false);
  assert.ok(r.lookalikes_scope.not_scanned.some((n) => /no time was left inside the record's deadline/.test(n)));
});

test("a window cut short says where it stopped, and only the spans read count as searched", async () => {
  const other = "0x1111111111111111111111111111111111111111";
  const block = 76_000_000;
  let calls = 0;
  const flaky = (async (url: string, init: { body: string }) => {
    calls++;
    if (calls > 2) return new Response("busy", { status: 429 });
    return rpcMock()(url, init as RequestInit);
  }) as unknown as typeof fetch;
  const r = await scanLookalikes(other, block, [], { fixture: null, alchemy: null, fetchImpl: flaky, sleep: noSleep });
  const recent = r.lookalikes_scope.searched.find((s) => s.source === "recent_logs")!;
  assert.equal(recent.from_block, block - RECENT_SPAN_BLOCKS + 1);
  assert.equal(r.lookalikes_scope.complete, false);
  assert.match(r.lookalikes_scope.not_scanned[0], new RegExp(`^ERC-20 transfers in blocks 0-${block - RECENT_SPAN_BLOCKS}`));
  assert.match(r.lookalikes_scope.not_scanned[1], new RegExp(`stopped at block ${block - RECENT_SPAN_BLOCKS + 1} after 1 of ${RECENT_SPANS} spans`));
});
