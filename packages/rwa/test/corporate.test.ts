// SPEC patch 022: corporate actions (UIMultiplierUpdated) in the record.
//
// Unit checks run on synthetic inputs. The fixture checks replay Fixture C
// (fixtures/rwa/C.corpact.json, the demo wallet's NVDA and QQQ history recorded
// from the chain) with no RPC.
//
// Run from the repo root: npx tsx --test packages/rwa/test/corporate.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { __resetMultiplierMemoForTest, SNAPSHOT, corporateActionsFor, decimal18, expectedMultiplier, readMultiplierUpdates, type TimedMultiplierUpdate } from "../corporate";
import { TOPICS, decodeMultiplierUpdate } from "../events";
import { assembleFacts } from "../facts";
import { recordedPoolResolver } from "../pools";
import { CANONICAL_SET } from "../registry";

const ONE = 10n ** 18n;
const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
const QQQ = "0xd5f3879160bc7c32ebb4dc785f8a4f505888de68";
const word = (n: bigint) => n.toString(16).padStart(64, "0");

// The NVDA log of 2026-09-10 as the chain returns it (tx 0x4ac23f2e…, block 58,952,659).
const NVDA_LOG = {
  address: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec",
  topics: [TOPICS.uiMultiplierUpdated],
  data: `0x${word(ONE)}${word(1000775159164630595n)}${word(1788998430n)}`,
  blockNumber: "0x3838bd3",
  logIndex: "0x0",
  transactionHash: "0x4ac23f2e58e2c4962dcd701c2beff581e87f3995152a29d527c07a3afd67d956",
};

test("the topic is keccak256 of UIMultiplierUpdated(uint256,uint256,uint256)", async () => {
  const { keccak256, toHex } = await import("viem");
  assert.equal(TOPICS.uiMultiplierUpdated, keccak256(toHex("UIMultiplierUpdated(uint256,uint256,uint256)")));
});

test("a UIMultiplierUpdated log decodes to before, after and the effective time", () => {
  const u = decodeMultiplierUpdate(NVDA_LOG)!;
  assert.equal(u.token, NVDA);
  assert.equal(u.block, 58952659);
  assert.equal(u.multiplier_before, ONE);
  assert.equal(u.multiplier_after, 1000775159164630595n);
  assert.equal(new Date(u.effective_at * 1000).toISOString(), "2026-09-10T00:00:30.000Z");
  assert.equal(decodeMultiplierUpdate({ ...NVDA_LOG, topics: [TOPICS.transfer] }), null);
  assert.equal(decodeMultiplierUpdate({ ...NVDA_LOG, data: "0x" }), null);
});

const upd = (block: number, before: bigint, after: bigint, effective = 1_000): TimedMultiplierUpdate => ({
  token: NVDA,
  block,
  log_index: 5,
  tx: `0x${block.toString(16).padStart(64, "0")}`,
  multiplier_before: before,
  multiplier_after: after,
  effective_at: effective,
  time: 900,
});

test("the holding at an update is the replay up to that log, and held:false updates are kept", () => {
  const events = [
    { block_number: 10, log_index: 1, raw_delta: 10n * ONE },
    { block_number: 20, log_index: 1, raw_delta: -4n * ONE },
    { block_number: 20, log_index: 9, raw_delta: -6n * ONE }, // after the update in the same block
  ];
  const acts = corporateActionsFor([upd(5, ONE, 2n * ONE), upd(20, 2n * ONE, 4n * ONE)], events, true);
  assert.equal(acts.length, 2);
  assert.equal(acts[0].held, false);
  assert.equal(acts[0].wallet_raw_at, "0");
  assert.equal(acts[0].ratio, "2");
  assert.equal(acts[1].held, true);
  assert.equal(acts[1].wallet_raw_at, (6n * ONE).toString());
  assert.equal(acts[1].wallet_shares_before, "12.00000000");
  assert.equal(acts[1].wallet_shares_after, "24.00000000");
});

test("a token whose history was not walked keeps its updates but claims no holding", () => {
  const [a] = corporateActionsFor([upd(5, ONE, 2n * ONE)], [], false);
  assert.equal(a.held, null);
  assert.equal(a.wallet_raw_at, null);
  assert.equal(a.wallet_shares_after, null);
});

test("the ratio is a number, never a label", () => {
  assert.equal(decimal18(1000775159164630595n), "1.000775159164630595");
  assert.equal(decimal18(ONE / 2n), "0.5");
  const [a] = corporateActionsFor([upd(5, 2n * ONE, ONE)], [], true);
  assert.equal(a.ratio, "0.5");
});

test("the expected multiplier is 1e18 with no update, the last after once in effect, unknown while scheduled", () => {
  assert.equal(expectedMultiplier([], 10), ONE);
  assert.equal(expectedMultiplier([upd(5, ONE, 3n * ONE, 50)], 100), 3n * ONE);
  assert.equal(expectedMultiplier([upd(5, ONE, 3n * ONE, 500)], 100), null);
});

test("the frozen walk covers every canonical token and stays behind its own head", () => {
  assert.equal(SNAPSHOT.chain_id, 4663);
  assert.deepEqual([...SNAPSHOT.tokens_walked].sort(), [...CANONICAL_SET].sort());
  for (const u of SNAPSHOT.updates) {
    assert.ok(CANONICAL_SET.has(u.token), u.token);
    assert.ok(u.block <= SNAPSHOT.to_block);
  }
  // The update Gapwatch's API missed (QQQ, 2026-09-22) is in it.
  assert.ok(SNAPSHOT.updates.some((u) => u.token === QQQ && u.block === 69210998));
});

test("a live read asks the chain only for the tail after the frozen walk, then not again", async () => {
  __resetMultiplierMemoForTest();
  const bodies: unknown[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const list = Array.isArray(body) ? body : [body];
    const out = list.map((c: { id: number; method: string }) => ({ jsonrpc: "2.0", id: c.id, result: c.method === "eth_getLogs" ? [] : { timestamp: "0x1" } }));
    return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const at = SNAPSHOT.to_block + 5;
  const got = await readMultiplierUpdates([NVDA, QQQ], at, { fetchImpl, sleep: async () => {} });
  const calls = bodies.flatMap((b) => (Array.isArray(b) ? b : [b])) as { method: string; params: { fromBlock: string; toBlock: string }[] }[];
  assert.equal(calls.length, 2, "one tail range per token");
  for (const c of calls) {
    assert.equal(c.method, "eth_getLogs");
    assert.equal(Number(c.params[0].fromBlock), SNAPSHOT.to_block + 1);
    assert.equal(Number(c.params[0].toBlock), at);
  }
  assert.deepEqual(
    got.map((u) => u.tx),
    SNAPSHOT.updates.filter((u) => u.token === NVDA || u.token === QQQ).map((u) => u.tx),
  );
  bodies.length = 0;
  await readMultiplierUpdates([NVDA, QQQ], at, { fetchImpl, sleep: async () => {} });
  assert.equal(bodies.length, 0, "the memo answers a repeat");
  __resetMultiplierMemoForTest();
});

// ---- Fixture C: the demo wallet, replayed offline ----

type Recorded = {
  holder: string;
  tokens: string[];
  block: number;
  block_timestamp: number;
  receipts: Parameters<typeof assembleFacts>[0]["receipts"];
  pools: Parameters<typeof recordedPoolResolver>[0];
  states: { token: string; raw: string; uiMultiplier: string; oraclePaused: boolean; feed: null | { decimals: number; round: Record<string, string> } }[];
  multiplier_updates: (Omit<TimedMultiplierUpdate, "multiplier_before" | "multiplier_after"> & { multiplier_before: string; multiplier_after: string })[];
};
const C = JSON.parse(readFileSync(join(process.cwd(), "fixtures/rwa/C.corpact.json"), "utf8")) as Recorded;

const cInput = (withUpdates: boolean) => ({
  address: C.holder,
  block: C.block,
  blockTimestamp: C.block_timestamp,
  receipts: C.receipts,
  states: C.states.map((s) => ({
    token: s.token,
    raw: BigInt(s.raw),
    uiMultiplier: BigInt(s.uiMultiplier),
    oraclePaused: s.oraclePaused,
    feed: s.feed && {
      decimals: s.feed.decimals,
      round: {
        roundId: BigInt(s.feed.round.roundId),
        answer: BigInt(s.feed.round.answer),
        startedAt: Number(s.feed.round.startedAt),
        updatedAt: Number(s.feed.round.updatedAt),
        answeredInRound: BigInt(s.feed.round.answeredInRound),
      },
    },
  })),
  resolver: recordedPoolResolver(C.pools),
  canonical: new Set(C.tokens),
  scopeRule: "fixture C: NVDA and QQQ of the demo wallet",
  ...(withUpdates
    ? { multiplierUpdates: C.multiplier_updates.map((u) => ({ ...u, multiplier_before: BigInt(u.multiplier_before), multiplier_after: BigInt(u.multiplier_after) })) }
    : {}),
});

test("fixture C: the chain's updates for NVDA and QQQ agree with the frozen walk", () => {
  const frozen = SNAPSHOT.updates.filter((u) => C.tokens.includes(u.token) && u.block <= C.block);
  const recorded = C.multiplier_updates.filter((u) => u.block <= SNAPSHOT.to_block);
  assert.deepEqual(
    recorded.map((u) => [u.token, u.block, u.log_index, u.tx, u.multiplier_before, u.multiplier_after, u.effective_at, u.time]),
    frozen.map((u) => [u.token, u.block, u.log_index, u.tx, u.multiplier_before, u.multiplier_after, u.effective_at, u.time]),
  );
});

test("fixture C: the demo wallet held NVDA on 2026-09-10 and QQQ on 2026-09-22 when their multipliers changed", async () => {
  const f = await assembleFacts(cInput(true));
  const bySym = Object.fromEntries(f.tokens.map((t) => [t.symbol, t]));
  const nvda = bySym.NVDA.corporate_actions!.find((a) => a.block === 58952659)!;
  assert.equal(nvda.effective_at, "2026-09-10T00:00:30.000Z");
  assert.equal(nvda.time, "2026-09-09T23:50:42.000Z"); // the block, ten minutes before it takes effect
  assert.equal(nvda.held, true);
  assert.equal(nvda.wallet_raw_at, "82049332007476505675");
  assert.equal(nvda.multiplier_before, ONE.toString());
  assert.equal(nvda.multiplier_after, "1000775159164630595");
  assert.equal(nvda.wallet_shares_before, "82.04933200");
  assert.equal(nvda.wallet_shares_after, "82.11293329");
  const qqq = bySym.QQQ.corporate_actions!.find((a) => a.block === 69210998)!;
  assert.equal(qqq.effective_at.slice(0, 10), "2026-09-22");
  assert.equal(qqq.held, true);
  assert.equal(qqq.wallet_raw_at, "94180700533589531354");
  assert.equal(qqq.multiplier_after, "1000700791241405425");
  assert.equal(qqq.wallet_shares_before, "94.18070053");
  assert.equal(qqq.wallet_shares_after, "94.24670154");
  // Every update of both tokens is listed, held or not.
  assert.equal(bySym.NVDA.corporate_actions!.length + bySym.QQQ.corporate_actions!.length, C.multiplier_updates.length);
  // The logs explain the multiplier each token reports at the fixture block.
  assert.equal(f.gaps.includes("multiplier_history_mismatch"), false);
});

test("fixture C: the holding at each update agrees with a plain sum of the recorded Transfer logs", async () => {
  // Independent of the classifier: add every Transfer of the token to the holder, subtract every one from it.
  const me = C.holder.slice(2).toLowerCase();
  const f = await assembleFacts(cInput(true));
  for (const u of C.multiplier_updates) {
    let raw = 0n;
    for (const r of C.receipts)
      for (const l of r.logs) {
        if (l.address !== u.token || l.topics[0] !== TOPICS.transfer) continue;
        if (r.blockNumber > u.block || (r.blockNumber === u.block && l.logIndex > u.log_index)) continue;
        if (l.topics[2].endsWith(me)) raw += BigInt(l.data);
        if (l.topics[1].endsWith(me)) raw -= BigInt(l.data);
      }
    const row = f.tokens.flatMap((t) => t.corporate_actions ?? []).find((a) => a.tx === u.tx)!;
    assert.equal(row.wallet_raw_at, raw.toString(), u.tx);
  }
});

test("fixture C: corporate actions change no realized, unrealized or balance figure", async () => {
  const without = JSON.parse(JSON.stringify(await assembleFacts(cInput(false))));
  const withCa = JSON.parse(JSON.stringify(await assembleFacts(cInput(true))));
  assert.equal(withCa.realized_usd, without.realized_usd);
  assert.notEqual(withCa.realized_usd, null, "the fixture must carry a realized figure for this check to mean anything");
  for (const t of withCa.tokens) delete t.corporate_actions;
  assert.deepEqual(withCa, without);
});

test("fixture C: a failed read of the logs is named in gaps, and the record is otherwise the same", async () => {
  const without = JSON.parse(JSON.stringify(await assembleFacts(cInput(false))));
  const failed = JSON.parse(JSON.stringify(await assembleFacts({ ...cInput(false), multiplierUpdatesFailed: true })));
  assert.ok(failed.gaps.includes("corporate_actions_not_read"));
  assert.equal(failed.tokens.some((t: { corporate_actions?: unknown }) => t.corporate_actions !== undefined), false);
  failed.gaps = failed.gaps.filter((g: string) => g !== "corporate_actions_not_read");
  assert.deepEqual(failed, without);
});

test("fixture C: a missed update is caught against the multiplier the token reports", async () => {
  const input = cInput(true);
  input.multiplierUpdates = input.multiplierUpdates!.filter((u) => u.block !== 69210998);
  const f = await assembleFacts(input);
  assert.ok(f.gaps.includes("multiplier_history_mismatch"));
});
