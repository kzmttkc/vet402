// ============================================================
// Celo の Transfer の読み手（2026-10-11・recover-late.ts makeCeloTransferReader）。
//
// 遅延回収の Celo のレーンは、この読み手の答えで「着金が窓にあった / 無かった」を決める。空の配列は「窓を読み切って
// 無かった」の意味で、呼び手はその行を二度と読まない——だから **読めたと言えないときに空を返してはいけない**。
//
// 守ること:
//  1. 読むのは Celo の USDC（0xcebA…118C）の Transfer(from = 購入元, to = 受取先) だけ。1 回の問いは 2,000 ブロック以内。
//  2. Celo 以外の network・CELO_RPC_URL なし・chainId が 42220 でない RPC・先端が窓に届いていない RPC は null
//     （＝読めなかった。呼び手は貼らず、印も付けない）。公開 RPC へ黙って倒れない。
//  3. 時刻からのブロック番号の見積もりは、そのブロックの実際の時刻で確かめる。合わなければ直し、直せなければ例外。
//  4. 形の欠けた log は黙って捨てず、例外にする。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CELO_TRANSFER_READ_CHUNK_BLOCKS,
  makeCeloTransferReader,
  makeChainTransferReader,
  type ChainTransfer,
  type TransferReader,
} from "@/lib/settlements/recover-late";
import { CELO_PUBLIC_RPC_URL, CELO_USDC_ADDRESS } from "@/lib/chain/celo";

const PAYER = "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670";
const PAY_TO = "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0";
const CELO = "eip155:42220";
const TX = "0x23421d63dd6932fd7ea4710409a6ec7a8be0d9c59ac339a7bb35bb78ae2cd07a";

/** 2026-10-11 に forno で読んだ実物: ブロック 79,785,112 の時刻が 02:31:10 UTC。1 秒に 1 ブロック。 */
const ANCHOR_BLOCK = 79_785_112n;
const ANCHOR_MS = Date.parse("2026-10-11T02:31:10Z");
const HEAD = 79_808_292n;
/** 試行 02:30:53 の行の窓（2 分前〜30 分後）。 */
const FROM = new Date("2026-10-11T02:28:53Z");
const TO = new Date("2026-10-11T03:00:53Z");

type Log = { blockNumber: bigint | null; transactionHash: string | null; args: { from: string; to: string; value?: bigint } };
type GetLogsCall = { address: string; args: { from: string; to: string }; fromBlock: bigint; toBlock: bigint };

/**
 * 偽の Celo の RPC。`timeOf` はブロック番号 → 時刻（ms）。既定は 1 秒に 1 ブロック（実測どおり）。
 * `logs` はブロック番号で絞って返す（範囲の外の log は返さない——読む範囲が窓を外せば見つからない）。
 */
function fakeCelo(o: { chainId?: number; head?: bigint; timeOf?: (n: bigint) => number; logs?: Log[] } = {}) {
  const timeOf = o.timeOf ?? ((n: bigint) => ANCHOR_MS + Number(n - ANCHOR_BLOCK) * 1000);
  const head = o.head ?? HEAD;
  const getLogsCalls: GetLogsCall[] = [];
  const blockReads: bigint[] = [];
  const client = {
    getChainId: async () => o.chainId ?? 42220,
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
const query = { network: CELO, payer: PAYER, payTo: PAY_TO, from: FROM, to: TO, timeoutMs: 10_000 };

test("Celo reader: reads the Celo USDC Transfer from the payer to the payee inside the window, in chunks of at most 2,000 blocks", async () => {
  const rpc = fakeCelo({ logs: [settled] });
  const out = await makeCeloTransferReader(rpc.client)(query);
  assert.deepEqual(out, [{ txHash: TX, from: PAYER, to: PAY_TO, value: "6000", blockTime: "2026-10-11T02:31:10.000Z" }] satisfies ChainTransfer[]);
  assert.ok(rpc.getLogsCalls.length >= 1);
  for (const c of rpc.getLogsCalls) {
    assert.equal(c.address, CELO_USDC_ADDRESS, "only Celo USDC — never another token's Transfer");
    assert.deepEqual(c.args, { from: PAYER, to: PAY_TO });
    assert.ok(c.toBlock - c.fromBlock + 1n <= CELO_TRANSFER_READ_CHUNK_BLOCKS, `chunk ${c.fromBlock}..${c.toBlock}`);
    assert.ok(c.toBlock - c.fromBlock + 1n <= 2_000n);
  }
  // The chunks are contiguous and cover the whole window (02:28:53 .. 03:00:53) with room on both sides.
  const sorted = [...rpc.getLogsCalls].sort((a, b) => (a.fromBlock < b.fromBlock ? -1 : 1));
  for (let i = 1; i < sorted.length; i++) assert.equal(sorted[i].fromBlock, sorted[i - 1].toBlock + 1n);
  const blockAt = (t: Date) => ANCHOR_BLOCK + BigInt((t.getTime() - ANCHOR_MS) / 1000);
  assert.ok(sorted[0].fromBlock <= blockAt(FROM));
  assert.ok(sorted[sorted.length - 1].toBlock >= blockAt(TO));
});

test("Celo reader: an empty window is [] (read and found nothing) — and only then", async () => {
  const rpc = fakeCelo({ logs: [] });
  assert.deepEqual(await makeCeloTransferReader(rpc.client)(query), []);
  assert.ok(rpc.getLogsCalls.length >= 1, "it did read the window");
  // A transfer outside the block range of the window is not returned by the RPC and is not invented.
  const far = fakeCelo({ logs: [{ ...settled, blockNumber: ANCHOR_BLOCK + 10_000n }] });
  assert.deepEqual(await makeCeloTransferReader(far.client)(query), []);
});

test("Celo reader: another network is null and the RPC is not touched", async () => {
  for (const network of ["eip155:8453", "base", "eip155:5042", "eip155:4217", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "eip155:44787"]) {
    const rpc = fakeCelo({ logs: [settled] });
    assert.equal(await makeCeloTransferReader(rpc.client)({ ...query, network }), null, network);
    assert.equal(rpc.getLogsCalls.length, 0, network);
  }
});

test("Celo reader: without CELO_RPC_URL it reads nothing — no silent fallback to the public RPC", async () => {
  const saved = process.env.CELO_RPC_URL;
  const realFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    requested.push(String(input instanceof Request ? input.url : input));
    throw new Error("no network in this test");
  }) as never;
  try {
    for (const value of [undefined, "", "   "]) {
      if (value === undefined) delete process.env.CELO_RPC_URL;
      else process.env.CELO_RPC_URL = value;
      assert.equal(await makeCeloTransferReader()(query), null, JSON.stringify(value));
    }
    assert.equal(requested.length, 0, `nothing may be requested (the public RPC is ${CELO_PUBLIC_RPC_URL}): ${requested.join(",")}`);
    // With the env set, the reader talks to that URL and to nothing else. The request fails here, so the read throws
    // (the caller treats a throw as "could not read"), and it never returns [].
    process.env.CELO_RPC_URL = "https://celo-rpc.invalid/v2/key";
    await assert.rejects(makeCeloTransferReader()(query));
    assert.ok(requested.length >= 1 && requested.every((u) => u.startsWith("https://celo-rpc.invalid/")), requested.join(","));
  } finally {
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.CELO_RPC_URL;
    else process.env.CELO_RPC_URL = saved;
  }
});

test("Celo reader: an RPC that reports another chain id is null — another chain's empty result is not 'no transfer'", async () => {
  for (const chainId of [8453, 5042, 44787, 11142220, 1]) {
    const rpc = fakeCelo({ chainId, logs: [] });
    assert.equal(await makeCeloTransferReader(rpc.client)(query), null, `chainId ${chainId}`);
    assert.equal(rpc.getLogsCalls.length, 0, `chainId ${chainId}`);
  }
});

test("Celo reader: a node whose tip has not reached the end of the window is null — a lagging node's empty result is not 'no transfer'", async () => {
  // Tip at 02:45:00, window ends 03:00:53.
  const lagging = fakeCelo({ head: ANCHOR_BLOCK + 830n, logs: [] });
  assert.equal(await makeCeloTransferReader(lagging.client)(query), null);
  assert.equal(lagging.getLogsCalls.length, 0);
  // Tip exactly at the end of the window is enough.
  const justThere = fakeCelo({ head: ANCHOR_BLOCK + BigInt((TO.getTime() - ANCHOR_MS) / 1000), logs: [settled] });
  assert.equal((await makeCeloTransferReader(justThere.client)(query))?.length, 1);
});

test("Celo reader: the block estimate is checked against the block's real time and corrected", async () => {
  // The chain stalled for 10 minutes at 05:00 UTC: every block before the stall is 600 s older than "1 block per second
  // back from the tip" says. The naive estimate lands 600 blocks too early, so a range built from it ends 600 blocks
  // short of the window's end; the reader must still cover the whole window.
  const stallAt = ANCHOR_BLOCK + 8_930n;
  const timeOf = (n: bigint) => ANCHOR_MS + Number(n - ANCHOR_BLOCK) * 1000 + (n >= stallAt ? 600_000 : 0);
  // A second transfer late in the window (02:59:00), which the uncorrected range would not reach.
  const lateInWindow: Log = { blockNumber: ANCHOR_BLOCK + 1_670n, transactionHash: `0x${"5e".repeat(32)}`, args: { from: PAYER, to: PAY_TO, value: 6000n } };
  const rpc = fakeCelo({ timeOf, logs: [settled, lateInWindow] });
  const out = await makeCeloTransferReader(rpc.client)(query);
  assert.deepEqual(out?.map((t) => t.blockTime), ["2026-10-11T02:31:10.000Z", "2026-10-11T02:59:00.000Z"], "both transfers are inside the window and must be found");
  const lo = rpc.getLogsCalls.reduce((m, c) => (c.fromBlock < m ? c.fromBlock : m), HEAD);
  const hi = rpc.getLogsCalls.reduce((m, c) => (c.toBlock > m ? c.toBlock : m), 0n);
  assert.ok(lo <= ANCHOR_BLOCK - 137n && hi >= ANCHOR_BLOCK + 1_783n, `read ${lo}..${hi}`);
});

test("Celo reader: when the block for the window cannot be located it throws — it never answers [] for a range it did not read", async () => {
  // Block times that do not follow the block number at all (a broken or wrong node).
  const rpc = fakeCelo({ timeOf: (n) => ANCHOR_MS + Number(n % 7n) * 5_000_000, logs: [] });
  await assert.rejects(makeCeloTransferReader(rpc.client)(query), /could not locate/);
  assert.equal(rpc.getLogsCalls.length, 0);
});

test("Celo reader: a malformed log is an error, not a silently dropped transfer", async () => {
  for (const bad of [
    { ...settled, blockNumber: null },
    { ...settled, transactionHash: null },
    { ...settled, args: { from: PAYER, to: PAY_TO } },
  ] as Log[]) {
    const rpc = fakeCelo({ logs: [bad] });
    await assert.rejects(makeCeloTransferReader(rpc.client)(query), /without a block, a hash or a value/);
  }
});

test("Celo reader: it stops when its time limit has passed", async () => {
  const rpc = fakeCelo({ logs: [settled] });
  await assert.rejects(makeCeloTransferReader(rpc.client)({ ...query, timeoutMs: -1 }), /time limit/);
  assert.equal(rpc.getLogsCalls.length, 0);
});

test("chain transfer reader: Celo rows go to the Celo reader, everything else to the Base reader", async () => {
  const seen: string[] = [];
  const base: TransferReader = async (q) => (seen.push(`base:${q.network}`), q.network === "eip155:8453" || q.network === "base" ? [] : null);
  const celo: TransferReader = async (q) => (seen.push(`celo:${q.network}`), []);
  const reader = makeChainTransferReader({ base, celo });
  assert.deepEqual(await reader({ ...query, network: CELO }), []);
  assert.deepEqual(await reader({ ...query, network: "eip155:8453" }), []);
  assert.deepEqual(await reader({ ...query, network: "base" }), []);
  assert.equal(await reader({ ...query, network: "eip155:5042" }), null, "Arc is read by nobody");
  assert.deepEqual(seen, ["celo:eip155:42220", "base:eip155:8453", "base:base", "base:eip155:5042"]);
  // The real Base reader answers null for a Celo row and for an Arc row (unchanged).
  const { makeBaseTransferReader } = await import("@/lib/settlements/recover-late");
  const neverCalled = { getBlock: async () => assert.fail("Base RPC must not be read"), getLogs: async () => assert.fail("Base RPC must not be read") } as never;
  assert.equal(await makeBaseTransferReader(neverCalled)({ ...query, network: CELO }), null);
  assert.equal(await makeBaseTransferReader(neverCalled)({ ...query, network: "eip155:5042" }), null);
});
