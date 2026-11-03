// ============================================================
// Arc の読み手（2026-11-03・recover-late.ts makeArcTransferReader）。
//
// 守ること:
//  1. 読むのは Arc の USDC（0x3600…0000）の Transfer(from = 購入元, to = 受取先) だけ。1 回の問いは 5,000 ブロック以内。
//  2. Arc 以外の network・ARC_RPC_URL なし・chainId が 5042 でない RPC・先端が窓に届いていない RPC は null。
//     chain/arc.ts の arcRpcUrl は公開 RPC へ倒れるが、この読み手は倒れない（決め手の nonce・認可の読み手が ARC_RPC_URL 必須）。
//  3. 時刻からのブロック番号の見積もり（0.51 秒/ブロック）は、そのブロックの実際の時刻で確かめる。直せなければ例外。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { ARC_TRANSFER_READ_CHUNK_BLOCKS, makeArcTransferReader, makeChainTransferReader, type ChainTransfer } from "@/lib/settlements/recover-late";
import { ARC_PUBLIC_RPC_URL, ARC_USDC_ADDRESS } from "@/lib/chain/arc";

const PAYER = "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670";
const PAY_TO = "0x3f0b2c7d9a1e4f6c8b5d7e9f1a2b3c4d5e6f7a8b";
const ARC = "eip155:5042";
const TX = `0x${"9c".repeat(32)}`;
/** 2026-11-03T15:18Z 実測: rpc.mainnet.arc.io のヘッド 29,347,957・0.507 秒/ブロック。 */
const MS_PER_BLOCK = 507;
const ANCHOR_BLOCK = 27_000_000n;
const ANCHOR_MS = Date.parse("2026-10-18T00:00:33Z");
const HEAD = ANCHOR_BLOCK + 10_000n;
/** 試行 00:00:21 の行の窓。 */
const FROM = new Date("2026-10-17T23:58:21Z");
const TO = new Date("2026-10-18T00:30:21Z");

type Log = { blockNumber: bigint | null; transactionHash: string | null; args: { from: string; to: string; value?: bigint } };
type GetLogsCall = { address: string; args: { from: string; to: string }; fromBlock: bigint; toBlock: bigint };

function fakeArc(o: { chainId?: number; head?: bigint; timeOf?: (n: bigint) => number; logs?: Log[] } = {}) {
  const timeOf = o.timeOf ?? ((n: bigint) => ANCHOR_MS + Number(n - ANCHOR_BLOCK) * MS_PER_BLOCK);
  const head = o.head ?? HEAD;
  const getLogsCalls: GetLogsCall[] = [];
  const client = {
    getChainId: async () => o.chainId ?? 5042,
    getBlock: async (q: { blockTag?: string; blockNumber?: bigint }) => {
      const n = q.blockNumber ?? head;
      if (n < 0n || n > head) throw new Error(`block ${n} is out of range`);
      return { number: n, timestamp: BigInt(Math.floor(timeOf(n) / 1000)) };
    },
    getLogs: async (q: GetLogsCall) => {
      getLogsCalls.push(q);
      return (o.logs ?? []).filter((l) => l.blockNumber === null || (l.blockNumber >= q.fromBlock && l.blockNumber <= q.toBlock));
    },
  };
  return { client: client as never, getLogsCalls };
}

const settled: Log = { blockNumber: ANCHOR_BLOCK, transactionHash: TX, args: { from: PAYER, to: PAY_TO, value: 50000n } };
const query = { network: ARC, payer: PAYER, payTo: PAY_TO, from: FROM, to: TO, timeoutMs: 10_000 };

test("Arc reader: reads the Arc USDC Transfer from the payer to the payee inside the window, in chunks of at most 5,000 blocks", async () => {
  const rpc = fakeArc({ logs: [settled] });
  const out = await makeArcTransferReader(rpc.client)(query);
  assert.deepEqual(out, [{ txHash: TX, from: PAYER, to: PAY_TO, value: "50000", blockTime: "2026-10-18T00:00:33.000Z" }] satisfies ChainTransfer[]);
  assert.equal(rpc.getLogsCalls.length, 1);
  for (const c of rpc.getLogsCalls) {
    assert.equal(c.address, ARC_USDC_ADDRESS, "only Arc USDC");
    assert.deepEqual(c.args, { from: PAYER, to: PAY_TO });
    assert.ok(c.toBlock - c.fromBlock + 1n <= ARC_TRANSFER_READ_CHUNK_BLOCKS);
  }
  const blockAt = (t: Date) => ANCHOR_BLOCK + BigInt(Math.round((t.getTime() - ANCHOR_MS) / MS_PER_BLOCK));
  assert.ok(rpc.getLogsCalls[0].fromBlock <= blockAt(FROM));
  assert.ok(rpc.getLogsCalls[0].toBlock >= blockAt(TO));
  assert.deepEqual(await makeArcTransferReader(fakeArc({ logs: [] }).client)(query), []);
});

test("Arc reader: another network, another chain id, or a lagging tip is null; the composed reader routes Arc rows here", async () => {
  for (const network of ["eip155:8453", "base", "eip155:42220", "eip155:4217", "eip155:5042002"]) {
    const rpc = fakeArc({ logs: [settled] });
    assert.equal(await makeArcTransferReader(rpc.client)({ ...query, network }), null, network);
    assert.equal(rpc.getLogsCalls.length, 0, network);
  }
  for (const chainId of [8453, 42220, 5042002, 1]) {
    assert.equal(await makeArcTransferReader(fakeArc({ chainId, logs: [] }).client)(query), null, `chainId ${chainId}`);
  }
  const lagging = fakeArc({ head: ANCHOR_BLOCK + 1_000n, logs: [] });
  assert.equal(await makeArcTransferReader(lagging.client)(query), null);
  assert.equal(lagging.getLogsCalls.length, 0);
  const calls: string[] = [];
  const tag = (name: string) => async (q: { network: string }) => (calls.push(`${name}:${q.network}`), []);
  const composed = makeChainTransferReader({ base: tag("base"), celo: tag("celo"), bnb: tag("bnb"), arbitrum: tag("arbitrum"), avalanche: tag("avalanche"), tempo: tag("tempo"), arc: tag("arc"), solana: tag("solana") });
  for (const network of [ARC, "eip155:4217", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "eip155:8453", "eip155:42220"]) await composed({ ...query, network });
  assert.deepEqual(calls, [`arc:${ARC}`, "tempo:eip155:4217", "solana:solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "base:eip155:8453", "celo:eip155:42220"]);
});

test("Arc reader: without ARC_RPC_URL it reads nothing — no silent fallback to the public RPC", async () => {
  const saved = process.env.ARC_RPC_URL;
  const realFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    requested.push(String(input instanceof Request ? input.url : input));
    throw new Error("no network in this test");
  }) as never;
  try {
    for (const value of [undefined, "", "   "]) {
      if (value === undefined) delete process.env.ARC_RPC_URL;
      else process.env.ARC_RPC_URL = value;
      assert.equal(await makeArcTransferReader()(query), null, JSON.stringify(value));
    }
    assert.equal(requested.length, 0, `nothing may be requested (the public RPC is ${ARC_PUBLIC_RPC_URL}): ${requested.join(",")}`);
    process.env.ARC_RPC_URL = "https://arc-rpc.invalid/v2/key";
    await assert.rejects(makeArcTransferReader()(query));
    assert.ok(requested.length >= 1 && requested.every((u) => u.startsWith("https://arc-rpc.invalid/")), requested.join(","));
  } finally {
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.ARC_RPC_URL;
    else process.env.ARC_RPC_URL = saved;
  }
});

test("Arc reader: the block estimate is corrected from real block times; unlocatable blocks, malformed logs and the time limit throw", async () => {
  const slow = (n: bigint) => ANCHOR_MS + Number(n - ANCHOR_BLOCK) * MS_PER_BLOCK * 1.5;
  const lateInWindow: Log = { blockNumber: ANCHOR_BLOCK + 2_200n, transactionHash: `0x${"5e".repeat(32)}`, args: { from: PAYER, to: PAY_TO, value: 50000n } };
  const out = await makeArcTransferReader(fakeArc({ timeOf: slow, logs: [settled, lateInWindow] }).client)(query);
  assert.deepEqual(out?.map((t) => t.txHash), [TX, lateInWindow.transactionHash]);
  const broken = fakeArc({ timeOf: (n) => ANCHOR_MS + Number(n % 7n) * 5_000_000, logs: [] });
  await assert.rejects(makeArcTransferReader(broken.client)(query), /could not locate/);
  assert.equal(broken.getLogsCalls.length, 0);
  for (const bad of [{ ...settled, blockNumber: null }, { ...settled, transactionHash: null }, { ...settled, args: { from: PAYER, to: PAY_TO } }] as Log[]) {
    await assert.rejects(makeArcTransferReader(fakeArc({ logs: [bad] }).client)(query), /without a block, a hash or a value/);
  }
  const rpc = fakeArc({ logs: [settled] });
  await assert.rejects(makeArcTransferReader(rpc.client)({ ...query, timeoutMs: -1 }), /time limit/);
  assert.equal(rpc.getLogsCalls.length, 0);
});
