// ============================================================
// BNB の Transfer の読み手（2026-10-19・recover-late.ts makeBnbTransferReader）。
//
// USD1 は 18 桁。遅延回収が台帳（6 桁）と突き合わせる value は 10^12 で割った額。
// 割り切れない額は返さない。BNB_RPC_URL が無ければ null（公開 RPC へ倒れない）。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeBnbTransferReader, BNB_TRANSFER_READ_CHUNK_BLOCKS } from "@/lib/settlements/recover-late";
import { BNB_PUBLIC_RPC_URL, BNB_USD1_ADDRESS } from "@/lib/chain/bnb";

const PAYER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const PAY_TO = "0x9999999999999999999999999999999999999999";
const BNB = "eip155:56";
const TX = "0x" + "ab".repeat(32);
const ANCHOR_BLOCK = 80_000_000n;
const ANCHOR_MS = Date.parse("2026-10-19T00:00:00Z");
const HEAD = ANCHOR_BLOCK + 10_000n;
const FROM = new Date(ANCHOR_MS - 2 * 60_000);
const TO = new Date(ANCHOR_MS + 30 * 60_000);

type Log = { blockNumber: bigint | null; transactionHash: string | null; args: { from: string; to: string; value?: bigint } };

function fakeBnb(o: { chainId?: number; logs?: Log[] } = {}) {
  const timeOf = (n: bigint) => ANCHOR_MS + Number(n - ANCHOR_BLOCK) * 1000;
  const getLogsCalls: { address: string; fromBlock: bigint; toBlock: bigint }[] = [];
  const client = {
    getChainId: async () => o.chainId ?? 56,
    getBlock: async (q: { blockTag?: string; blockNumber?: bigint }) => {
      const n = q.blockNumber ?? HEAD;
      return { number: n, timestamp: BigInt(Math.floor(timeOf(n) / 1000)) };
    },
    getLogs: async (q: { address: string; fromBlock: bigint; toBlock: bigint }) => {
      getLogsCalls.push(q);
      return (o.logs ?? []).filter((l) => l.blockNumber !== null && l.blockNumber >= q.fromBlock && l.blockNumber <= q.toBlock);
    },
  };
  return { client: client as never, getLogsCalls };
}

const query = { network: BNB, payer: PAYER, payTo: PAY_TO, from: FROM, to: TO, timeoutMs: 10_000 };

test("BNB late reader: 18 桁の USD1 を 6 桁で返し、割り切れない額と公開 RPC は使わない", async () => {
  const exact = 10n ** 17n;
  const dust = exact + 1n;
  const rpc = fakeBnb({
    logs: [
      { blockNumber: ANCHOR_BLOCK, transactionHash: TX, args: { from: PAYER, to: PAY_TO, value: exact } },
      { blockNumber: ANCHOR_BLOCK + 1n, transactionHash: "0x" + "cd".repeat(32), args: { from: PAYER, to: PAY_TO, value: dust } },
    ],
  });
  const out = await makeBnbTransferReader(rpc.client)(query);
  assert.deepEqual(out, [{ txHash: TX, from: PAYER, to: PAY_TO, value: "100000", blockTime: "2026-10-19T00:00:00.000Z" }]);
  assert.equal(rpc.getLogsCalls.length >= 1, true);
  for (const c of rpc.getLogsCalls) {
    assert.equal(c.address, BNB_USD1_ADDRESS);
    assert.ok(c.toBlock - c.fromBlock + 1n <= BNB_TRANSFER_READ_CHUNK_BLOCKS);
  }
  assert.equal(await makeBnbTransferReader(rpc.client)({ ...query, network: "eip155:8453" }), null);
  assert.equal(await makeBnbTransferReader(fakeBnb({ chainId: 8453 }).client)(query), null);

  const saved = process.env.BNB_RPC_URL;
  const realFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    requested.push(String(input instanceof Request ? input.url : input));
    throw new Error("no network in this test");
  }) as never;
  try {
    delete process.env.BNB_RPC_URL;
    assert.equal(await makeBnbTransferReader()(query), null);
    assert.equal(requested.length, 0, `公開 RPC へ出ない (${BNB_PUBLIC_RPC_URL})`);
  } finally {
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.BNB_RPC_URL;
    else process.env.BNB_RPC_URL = saved;
  }
});
