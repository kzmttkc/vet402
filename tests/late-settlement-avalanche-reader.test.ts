// ============================================================
// Avalanche の Transfer の読み手（2026-10-26・recover-late.ts makeAvalancheTransferReader）。
//
// 遅延回収の Avalanche のレーンは、この読み手の答えで「着金が窓にあった / 無かった」を決める。空の配列は「窓を読み切って
// 無かった」の意味で、呼び手はその行を二度と読まない——だから **読めたと言えないときに空を返してはいけない**。
//
// 守ること:
//  1. 読むのはネイティブ USDC（0xaf88…5831）の Transfer(from = 購入元, to = 受取先) だけ。1 回の問いは 100 ブロック以内
//     （2026-10-26 実測: 公開 RPC は 100 ブロックの USDC Transfer に答え、5,000 は断る）。
//  2. Avalanche 以外の network・AVALANCHE_RPC_URL なし・chainId が 43114 でない RPC・先端が窓に届いていない RPC は null
//     （＝読めなかった。呼び手は貼らず、印も付けない）。公開 RPC へ黙って倒れない。
//  3. 時刻からのブロック番号の見積もりは、そのブロックの実際の時刻で確かめる。合わなければ直し、直せなければ例外。
//  4. 形の欠けた log は黙って捨てず、例外にする。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AVALANCHE_TRANSFER_READ_CHUNK_BLOCKS,
  makeAvalancheTransferReader,
  makeChainTransferReader,
  type ChainTransfer,
  type TransferReader,
} from "@/lib/settlements/recover-late";
import { AVALANCHE_PUBLIC_RPC_URL, AVALANCHE_USDC_ADDRESS } from "@/lib/chain/avalanche";

const PAYER = "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670";
const PAY_TO = "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0";
const ARB = "eip155:43114";
const TX = "0x23421d63dd6932fd7ea4710409a6ec7a8be0d9c59ac339a7bb35bb78ae2cd07a";

/** 2026-10-26 実測のブロック間隔 970 ms で、窓の中に置く錨。 */
const ANCHOR_BLOCK = 517_100_000n;
const ANCHOR_MS = Date.parse("2026-10-26T10:42:25Z");
const BLOCK_MS = 970;
const HEAD = ANCHOR_BLOCK + 50_000n;
const FROM = new Date("2026-10-26T10:40:25Z");
const TO = new Date("2026-10-26T11:12:25Z");

type Log = { blockNumber: bigint | null; transactionHash: string | null; args: { from: string; to: string; value?: bigint } };
type GetLogsCall = { address: string; args: { from: string; to: string }; fromBlock: bigint; toBlock: bigint };

function fakeAvax(o: { chainId?: number; head?: bigint; timeOf?: (n: bigint) => number; logs?: Log[] } = {}) {
  const timeOf = o.timeOf ?? ((n: bigint) => ANCHOR_MS + Number(n - ANCHOR_BLOCK) * BLOCK_MS);
  const head = o.head ?? HEAD;
  const getLogsCalls: GetLogsCall[] = [];
  const blockReads: bigint[] = [];
  const client = {
    getChainId: async () => o.chainId ?? 43114,
    getBlock: async (q: { blockTag?: string; blockNumber?: bigint }) => {
      const n = q.blockNumber ?? head;
      if (q.blockNumber !== undefined) blockReads.push(n);
      if (n < 0n || n > head) throw new Error(`block ${n} is out of range`);
      return { number: n, timestamp: BigInt(Math.floor(timeOf(n) / 1000)) };
    },
    getLogs: async (q: GetLogsCall) => {
      getLogsCalls.push(q);
      return (o.logs ?? []).filter((l) => l.blockNumber === null || (l.blockNumber >= q.fromBlock && l.blockNumber <= q.toBlock));
    },
  };
  return { client: client as never, getLogsCalls, blockReads };
}

const settled: Log = { blockNumber: ANCHOR_BLOCK, transactionHash: TX, args: { from: PAYER, to: PAY_TO, value: 6000n } };
const query = { network: ARB, payer: PAYER, payTo: PAY_TO, from: FROM, to: TO, timeoutMs: 10_000 };
const blockAt = (t: Date) => ANCHOR_BLOCK + BigInt(Math.round((t.getTime() - ANCHOR_MS) / BLOCK_MS));

test("Avalanche reader: reads the native USDC Transfer from the payer to the payee inside the window, in chunks of at most 100 blocks", async () => {
  const rpc = fakeAvax({ logs: [settled] });
  const out = await makeAvalancheTransferReader(rpc.client)(query);
  assert.deepEqual(out, [{ txHash: TX, from: PAYER, to: PAY_TO, value: "6000", blockTime: "2026-10-26T10:42:25.000Z" }] satisfies ChainTransfer[]);
  // 32 min window at 970 ms/block is about 1,980 blocks, so more than one 100-block call.
  assert.ok(rpc.getLogsCalls.length >= 15, `expected several chunks, got ${rpc.getLogsCalls.length}`);
  for (const c of rpc.getLogsCalls) {
    assert.equal(c.address, AVALANCHE_USDC_ADDRESS, "only native USDC — never USDC.e");
    assert.deepEqual(c.args, { from: PAYER, to: PAY_TO });
    assert.ok(c.toBlock - c.fromBlock + 1n <= AVALANCHE_TRANSFER_READ_CHUNK_BLOCKS, `chunk ${c.fromBlock}..${c.toBlock}`);
    assert.ok(c.toBlock - c.fromBlock + 1n <= 100n);
  }
  const sorted = [...rpc.getLogsCalls].sort((a, b) => (a.fromBlock < b.fromBlock ? -1 : 1));
  for (let i = 1; i < sorted.length; i++) assert.equal(sorted[i].fromBlock, sorted[i - 1].toBlock + 1n);
  assert.ok(sorted[0].fromBlock <= blockAt(FROM));
  assert.ok(sorted[sorted.length - 1].toBlock >= blockAt(TO));
});

test("Avalanche reader: an empty window is [] (read and found nothing) — and only then", async () => {
  const rpc = fakeAvax({ logs: [] });
  assert.deepEqual(await makeAvalancheTransferReader(rpc.client)(query), []);
  assert.ok(rpc.getLogsCalls.length >= 1, "it did read the window");
  const far = fakeAvax({ logs: [{ ...settled, blockNumber: ANCHOR_BLOCK + 100_000n }] });
  assert.deepEqual(await makeAvalancheTransferReader(far.client)(query), []);
});

test("Avalanche reader: another network is null and the RPC is not touched", async () => {
  for (const network of ["eip155:8453", "base", "eip155:5042", "eip155:42220", "eip155:56", "eip155:431144"]) {
    const rpc = fakeAvax({ logs: [settled] });
    assert.equal(await makeAvalancheTransferReader(rpc.client)({ ...query, network }), null, network);
    assert.equal(rpc.getLogsCalls.length, 0, network);
  }
});

test("Avalanche reader: without AVALANCHE_RPC_URL it reads nothing — no silent fallback to the public RPC", async () => {
  const saved = process.env.AVALANCHE_RPC_URL;
  const realFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    requested.push(String(input instanceof Request ? input.url : input));
    throw new Error("no network in this test");
  }) as never;
  try {
    for (const value of [undefined, "", "   "]) {
      if (value === undefined) delete process.env.AVALANCHE_RPC_URL;
      else process.env.AVALANCHE_RPC_URL = value;
      assert.equal(await makeAvalancheTransferReader()(query), null, JSON.stringify(value));
    }
    assert.equal(requested.length, 0, `nothing may be requested (the public RPC is ${AVALANCHE_PUBLIC_RPC_URL}): ${requested.join(",")}`);
    process.env.AVALANCHE_RPC_URL = "https://arb-rpc.invalid/v2/key";
    await assert.rejects(makeAvalancheTransferReader()(query));
    assert.ok(requested.length >= 1 && requested.every((u) => u.startsWith("https://arb-rpc.invalid/")), requested.join(","));
  } finally {
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.AVALANCHE_RPC_URL;
    else process.env.AVALANCHE_RPC_URL = saved;
  }
});

test("Avalanche reader: an RPC that reports another chain id is null — another chain's empty result is not 'no transfer'", async () => {
  for (const chainId of [8453, 5042, 42220, 431144, 1]) {
    const rpc = fakeAvax({ chainId, logs: [] });
    assert.equal(await makeAvalancheTransferReader(rpc.client)(query), null, `chainId ${chainId}`);
    assert.equal(rpc.getLogsCalls.length, 0, `chainId ${chainId}`);
  }
});

test("Avalanche reader: a node whose tip has not reached the end of the window is null — a lagging node's empty result is not 'no transfer'", async () => {
  const lagging = fakeAvax({ head: ANCHOR_BLOCK + 1_000n, logs: [] });
  assert.equal(await makeAvalancheTransferReader(lagging.client)(query), null);
  assert.equal(lagging.getLogsCalls.length, 0);
  const justThere = fakeAvax({ head: blockAt(TO), logs: [settled] });
  assert.equal((await makeAvalancheTransferReader(justThere.client)(query))?.length, 1);
});

test("Avalanche reader: the block estimate is checked against the block's real time and corrected", async () => {
  const stallAt = ANCHOR_BLOCK + 20_000n;
  const timeOf = (n: bigint) => ANCHOR_MS + Number(n - ANCHOR_BLOCK) * BLOCK_MS + (n >= stallAt ? 600_000 : 0);
  const lateInWindow: Log = { blockNumber: blockAt(new Date("2026-10-26T11:44:31Z")), transactionHash: `0x${"5e".repeat(32)}`, args: { from: PAYER, to: PAY_TO, value: 6000n } };
  const rpc = fakeAvax({ timeOf, logs: [settled, lateInWindow] });
  const out = await makeAvalancheTransferReader(rpc.client)(query);
  assert.ok((out?.length ?? 0) >= 1, "the transfer at the anchor is inside the window and must be found");
  assert.ok(out?.some((t) => t.txHash === TX));
});

test("Avalanche reader: when the block for the window cannot be located it throws — it never answers [] for a range it did not read", async () => {
  const rpc = fakeAvax({ timeOf: (n) => ANCHOR_MS + Number(n % 7n) * 5_000_000, logs: [] });
  await assert.rejects(makeAvalancheTransferReader(rpc.client)(query), /could not locate/);
  assert.equal(rpc.getLogsCalls.length, 0);
});

test("Avalanche reader: a malformed log is an error, not a silently dropped transfer", async () => {
  for (const bad of [
    { ...settled, blockNumber: null },
    { ...settled, transactionHash: null },
    { ...settled, args: { from: PAYER, to: PAY_TO } },
  ] as Log[]) {
    const rpc = fakeAvax({ logs: [bad] });
    await assert.rejects(makeAvalancheTransferReader(rpc.client)(query), /without a block, a hash or a value/);
  }
});

test("Avalanche reader: it stops when its time limit has passed", async () => {
  const rpc = fakeAvax({ logs: [settled] });
  await assert.rejects(makeAvalancheTransferReader(rpc.client)({ ...query, timeoutMs: -1 }), /time limit/);
  assert.equal(rpc.getLogsCalls.length, 0);
});

test("chain transfer reader: Avalanche rows go to the Avalanche reader, Celo to Celo, everything else to the Base reader", async () => {
  const seen: string[] = [];
  const base: TransferReader = async (q) => (seen.push(`base:${q.network}`), q.network === "eip155:8453" || q.network === "base" ? [] : null);
  const celo: TransferReader = async (q) => (seen.push(`celo:${q.network}`), []);
  const avalanche: TransferReader = async (q) => (seen.push(`avalanche:${q.network}`), []);
  const reader = makeChainTransferReader({ base, celo, avalanche });
  assert.deepEqual(await reader({ ...query, network: ARB }), []);
  assert.deepEqual(await reader({ ...query, network: "eip155:42220" }), []);
  assert.deepEqual(await reader({ ...query, network: "eip155:8453" }), []);
  assert.equal(await reader({ ...query, network: "eip155:5042" }), null, "Arc is read by nobody");
  assert.deepEqual(seen, ["avalanche:eip155:43114", "celo:eip155:42220", "base:eip155:8453", "base:eip155:5042"]);
});
