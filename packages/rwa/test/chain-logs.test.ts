// eth_getLogs walking (chain.ts): fixed chunks, and a chunk the RPC refuses
// ("log query timed out", 10,000-log cap) is split in half instead of failing.
//
// Run from the repo root: npx tsx --test packages/rwa/test/chain-logs.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchCanonicalTransfers } from "../chain";
import { TOPICS } from "../events";

const ME = "0xa8553db0049fc6843c0d00d0efc08d31848e3c74";
const TOKEN = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";

/** A fake RPC: refuses any range wider than `maxSpan`, otherwise returns one log per range for the `from` side. */
function fakeRpc(maxSpan: number) {
  const ranges: [number, number][] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const req = JSON.parse(init.body);
    const calls = Array.isArray(req) ? req : [req];
    const responses = calls.map((c: { id: number; params: [{ fromBlock: string; toBlock: string; topics: (string | null)[] }] }) => {
      const from = Number(c.params[0].fromBlock);
      const to = Number(c.params[0].toBlock);
      if (to - from + 1 > maxSpan) return { id: c.id, error: { code: -32000, message: "log query timed out" } };
      ranges.push([from, to]);
      const fromSide = c.params[0].topics[1] !== null;
      const log = {
        address: TOKEN,
        transactionHash: `0x${(from + (fromSide ? 0 : 1)).toString(16).padStart(64, "0")}`,
        blockNumber: `0x${from.toString(16)}`,
        logIndex: "0x0",
        topics: [TOPICS.transfer, fromSide ? `0x000000000000000000000000${ME.slice(2)}` : `0x${"1".repeat(64)}`, fromSide ? `0x${"2".repeat(64)}` : `0x000000000000000000000000${ME.slice(2)}`],
        data: `0x${"0".repeat(63)}1`,
      };
      return { id: c.id, result: [log] };
    });
    return new Response(JSON.stringify(Array.isArray(req) ? responses : responses[0]), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, ranges };
}

test("ranges are walked in fixed chunks and refused chunks are split in half", async () => {
  const { fetchImpl, ranges } = fakeRpc(600);
  const logs = await fetchCanonicalTransfers(TOKEN, ME, 1999, { fetchImpl, retries: 0, sleep: async () => {} }, 1000);
  // two sides × (chunk [0,999] split into [0,499],[500,999]; chunk [1000,1999] split likewise)
  assert.equal(ranges.length, 8);
  for (const [from, to] of ranges) assert.ok(to - from + 1 <= 600, `${from}-${to}`);
  assert.equal(logs.length, 8);
  assert.deepEqual(logs.map((l) => Number(l.blockNumber)), [0, 0, 500, 500, 1000, 1000, 1500, 1500]);
});

test("an RPC error that is not about range size is not retried into a split", async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ id: 0, error: { code: -32602, message: "invalid argument" } }), { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(fetchCanonicalTransfers(TOKEN, ME, 100, { fetchImpl, retries: 0, sleep: async () => {} }, 1000), /invalid argument/);
});
