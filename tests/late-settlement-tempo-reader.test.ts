// ============================================================
// Tempo の読み手（2026-11-03・recover-late.ts makeTempoTransferReader / makeTempoMemoReader）。
//
// 守ること:
//  1. 読むのは USDC.e（0x20C0…8b50）の TransferWithMemo(from = 購入元, to = 受取先) だけ。1 回の問いは 5,000 ブロック以内。
//  2. Tempo 以外の network・TEMPO_RPC_URL なし・chainId が 4217 でない RPC・先端が窓に届いていない RPC は null。公開 RPC へ黙って倒れない。
//  3. 時刻からのブロック番号の見積もり（0.56 秒/ブロック）は、そのブロックの実際の時刻で確かめる。直せなければ例外。
//  4. memo の読み手は、レシートの TransferWithMemo（topics[1] = 購入元）の memo（topics[3]）だけを返す。読めなければ null。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toBytes } from "viem";
import { TEMPO_TRANSFER_READ_CHUNK_BLOCKS, makeTempoMemoReader, makeTempoTransferReader, type ChainTransfer } from "@/lib/settlements/recover-late";
import { TEMPO_PUBLIC_RPC_URL, TEMPO_USDC_E } from "@/lib/observatory/mpp-payer";

const PAYER = "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670";
const PAY_TO = "0x7d1f3a9c5b2e8d4f6a0c1b3e5d7f9a2c4e6b8d0f";
const TEMPO = "eip155:4217";
const TX = `0x${"c1".repeat(32)}`;
const MEMO = `0x${"a1".repeat(32)}`;
/** 2026-11-03T15:18Z 実測: rpc.tempo.xyz のヘッド 47,252,884・0.561 秒/ブロック。 */
const MS_PER_BLOCK = 561;
const ANCHOR_BLOCK = 47_000_000n;
const ANCHOR_MS = Date.parse("2026-09-30T00:00:34Z");
const HEAD = ANCHOR_BLOCK + 10_000n;
/** 試行 00:00:25 の行の窓（2 分前〜30 分後）。 */
const FROM = new Date("2026-09-29T23:58:25Z");
const TO = new Date("2026-09-30T00:30:25Z");

type Log = { blockNumber: bigint | null; transactionHash: string | null; args: { from: string; to: string; amount?: bigint; memo?: string } };
type GetLogsCall = { address: string; args: { from: string; to: string }; fromBlock: bigint; toBlock: bigint; event?: { name?: string } };

function fakeTempo(o: { chainId?: number; head?: bigint; timeOf?: (n: bigint) => number; logs?: Log[] } = {}) {
  const timeOf = o.timeOf ?? ((n: bigint) => ANCHOR_MS + Number(n - ANCHOR_BLOCK) * MS_PER_BLOCK);
  const head = o.head ?? HEAD;
  const getLogsCalls: GetLogsCall[] = [];
  const client = {
    getChainId: async () => o.chainId ?? 4217,
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

const settled: Log = { blockNumber: ANCHOR_BLOCK, transactionHash: TX, args: { from: PAYER, to: PAY_TO, amount: 35000n, memo: MEMO } };
const query = { network: TEMPO, payer: PAYER, payTo: PAY_TO, from: FROM, to: TO, timeoutMs: 10_000 };

test("Tempo reader: reads the USDC.e TransferWithMemo from the payer to the payee inside the window, in chunks of at most 5,000 blocks", async () => {
  const rpc = fakeTempo({ logs: [settled] });
  const out = await makeTempoTransferReader(rpc.client)(query);
  assert.deepEqual(out, [{ txHash: TX, from: PAYER, to: PAY_TO, value: "35000", blockTime: "2026-09-30T00:00:34.000Z" }] satisfies ChainTransfer[]);
  assert.equal(rpc.getLogsCalls.length, 1, "one row's window (≈ 3,430 blocks plus the margin) fits one eth_getLogs call");
  for (const c of rpc.getLogsCalls) {
    assert.equal(c.address.toLowerCase(), TEMPO_USDC_E.toLowerCase(), "only USDC.e");
    assert.equal(c.event?.name, "TransferWithMemo", "only the memo event — a plain Transfer cannot be bound to a purchase");
    assert.deepEqual(c.args, { from: PAYER, to: PAY_TO });
    assert.ok(c.toBlock - c.fromBlock + 1n <= TEMPO_TRANSFER_READ_CHUNK_BLOCKS, `chunk ${c.fromBlock}..${c.toBlock}`);
  }
  const blockAt = (t: Date) => ANCHOR_BLOCK + BigInt(Math.round((t.getTime() - ANCHOR_MS) / MS_PER_BLOCK));
  assert.ok(rpc.getLogsCalls[0].fromBlock <= blockAt(FROM));
  assert.ok(rpc.getLogsCalls[0].toBlock >= blockAt(TO));
});

test("Tempo reader: an empty window is [] (read and found nothing) — and only then", async () => {
  const rpc = fakeTempo({ logs: [] });
  assert.deepEqual(await makeTempoTransferReader(rpc.client)(query), []);
  assert.ok(rpc.getLogsCalls.length >= 1);
  const far = fakeTempo({ logs: [{ ...settled, blockNumber: ANCHOR_BLOCK + 9_000n }] });
  assert.deepEqual(await makeTempoTransferReader(far.client)(query), []);
});

test("Tempo reader: another network, another chain id, or a lagging tip is null and the logs are not read", async () => {
  for (const network of ["eip155:8453", "base", "eip155:5042", "eip155:42220", "eip155:42431", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]) {
    const rpc = fakeTempo({ logs: [settled] });
    assert.equal(await makeTempoTransferReader(rpc.client)({ ...query, network }), null, network);
    assert.equal(rpc.getLogsCalls.length, 0, network);
  }
  for (const chainId of [8453, 5042, 42431, 1]) {
    const rpc = fakeTempo({ chainId, logs: [] });
    assert.equal(await makeTempoTransferReader(rpc.client)(query), null, `chainId ${chainId}`);
    assert.equal(rpc.getLogsCalls.length, 0);
  }
  // Tip at 00:15, window ends 00:30:25.
  const lagging = fakeTempo({ head: ANCHOR_BLOCK + BigInt(Math.floor((14.5 * 60_000) / MS_PER_BLOCK)), logs: [] });
  assert.equal(await makeTempoTransferReader(lagging.client)(query), null);
  assert.equal(lagging.getLogsCalls.length, 0);
});

test("Tempo reader: without TEMPO_RPC_URL it reads nothing — no silent fallback to the public RPC", async () => {
  const saved = process.env.TEMPO_RPC_URL;
  const realFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    requested.push(String(input instanceof Request ? input.url : input));
    throw new Error("no network in this test");
  }) as never;
  try {
    for (const value of [undefined, "", "   "]) {
      if (value === undefined) delete process.env.TEMPO_RPC_URL;
      else process.env.TEMPO_RPC_URL = value;
      assert.equal(await makeTempoTransferReader()(query), null, JSON.stringify(value));
      assert.equal(await makeTempoMemoReader()({ network: TEMPO, txHash: TX, payer: PAYER }), null, JSON.stringify(value));
    }
    assert.equal(requested.length, 0, `nothing may be requested (the public RPC is ${TEMPO_PUBLIC_RPC_URL}): ${requested.join(",")}`);
    process.env.TEMPO_RPC_URL = "https://tempo-rpc.invalid/v2/key";
    await assert.rejects(makeTempoTransferReader()(query));
    assert.ok(requested.length >= 1 && requested.every((u) => u.startsWith("https://tempo-rpc.invalid/")), requested.join(","));
  } finally {
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.TEMPO_RPC_URL;
    else process.env.TEMPO_RPC_URL = saved;
  }
});

test("Tempo reader: the block estimate is checked against the block's real time and corrected", async () => {
  // Blocks were 50% slower than the estimate across the whole range: the naive estimate lands far too early.
  const slow = (n: bigint) => ANCHOR_MS + Number(n - ANCHOR_BLOCK) * MS_PER_BLOCK * 1.5;
  const lateInWindow: Log = { blockNumber: ANCHOR_BLOCK + 2_000n, transactionHash: `0x${"5e".repeat(32)}`, args: { from: PAYER, to: PAY_TO, amount: 35000n, memo: MEMO } };
  const rpc = fakeTempo({ timeOf: slow, logs: [settled, lateInWindow] });
  const out = await makeTempoTransferReader(rpc.client)(query);
  assert.deepEqual(out?.map((t) => t.txHash), [TX, lateInWindow.transactionHash], "both transfers are inside the window and must be found");
  const broken = fakeTempo({ timeOf: (n) => ANCHOR_MS + Number(n % 7n) * 5_000_000, logs: [] });
  await assert.rejects(makeTempoTransferReader(broken.client)(query), /could not locate/);
  assert.equal(broken.getLogsCalls.length, 0);
});

test("Tempo reader: a malformed log is an error, and the time limit stops the read", async () => {
  for (const bad of [{ ...settled, blockNumber: null }, { ...settled, transactionHash: null }, { ...settled, args: { from: PAYER, to: PAY_TO, memo: MEMO } }] as Log[]) {
    await assert.rejects(makeTempoTransferReader(fakeTempo({ logs: [bad] }).client)(query), /without a block, a hash or a value/);
  }
  const rpc = fakeTempo({ logs: [settled] });
  await assert.rejects(makeTempoTransferReader(rpc.client)({ ...query, timeoutMs: -1 }), /time limit/);
  assert.equal(rpc.getLogsCalls.length, 0);
});

test("Tempo memo reader: returns the memos of the payer's TransferWithMemo legs in the receipt, lowercased; null when it cannot read", async () => {
  const TOPIC = keccak256(toBytes("TransferWithMemo(address,address,uint256,bytes32)"));
  const TRANSFER_TOPIC = keccak256(toBytes("Transfer(address,address,uint256)"));
  const pad = (addr: string) => `0x${addr.slice(2).toLowerCase().padStart(64, "0")}`;
  const OTHER = "0x902dcf34e53695bdea2ffb354b1a2e58bd598256";
  const receipt = (logs: unknown[], status = "success") => ({ status, blockNumber: ANCHOR_BLOCK, logs });
  const client = (o: { chainId?: number; receipt?: unknown; throws?: boolean }) =>
    ({
      getChainId: async () => o.chainId ?? 4217,
      getTransactionReceipt: async () => {
        if (o.throws) throw new Error("rpc down");
        return o.receipt;
      },
    }) as never;
  const logs = [
    { address: TEMPO_USDC_E, topics: [TRANSFER_TOPIC, pad(PAYER), pad(PAY_TO)], data: "0x" },
    { address: TEMPO_USDC_E.toLowerCase(), topics: [TOPIC, pad(PAYER), pad(PAY_TO), MEMO.toUpperCase().replace("0X", "0x")], data: "0x" },
    { address: TEMPO_USDC_E, topics: [TOPIC, pad(OTHER), pad(PAY_TO), `0x${"ee".repeat(32)}`], data: "0x" },
    { address: "0x1111111111111111111111111111111111111111", topics: [TOPIC, pad(PAYER), pad(PAY_TO), `0x${"dd".repeat(32)}`], data: "0x" },
  ];
  const read = makeTempoMemoReader(client({ receipt: receipt(logs) }));
  assert.deepEqual(await read({ network: TEMPO, txHash: TX, payer: PAYER }), [MEMO], "only USDC.e TransferWithMemo legs sent by the payer");
  assert.deepEqual(await makeTempoMemoReader(client({ receipt: receipt([]) }))({ network: TEMPO, txHash: TX, payer: PAYER }), []);
  assert.equal(await read({ network: "eip155:8453", txHash: TX, payer: PAYER }), null);
  assert.equal(await read({ network: TEMPO, txHash: "not-a-hash", payer: PAYER }), null);
  assert.equal(await makeTempoMemoReader(client({ chainId: 8453, receipt: receipt(logs) }))({ network: TEMPO, txHash: TX, payer: PAYER }), null);
  assert.equal(await makeTempoMemoReader(client({ receipt: receipt(logs, "reverted") }))({ network: TEMPO, txHash: TX, payer: PAYER }), null);
  assert.equal(await makeTempoMemoReader(client({ receipt: null }))({ network: TEMPO, txHash: TX, payer: PAYER }), null);
  assert.equal(await makeTempoMemoReader(client({ throws: true }))({ network: TEMPO, txHash: TX, payer: PAYER }), null);
});
