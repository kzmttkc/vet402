// rpc.ts retry rules: a gateway upstream timeout is retried a bounded number of
// times; a plain JSON-RPC error is not retried at all.
//
// Run from the repo root: npx tsx --test packages/rwa/test/rpc.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { rpcCall } from "../rpc";

function scripted(responses: object[]) {
  let calls = 0;
  const fetchImpl = (async () => {
    const body = responses[Math.min(calls, responses.length - 1)];
    calls++;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, count: () => calls };
}
const opts = (f: typeof fetch) => ({ fetchImpl: f, urls: ["http://rpc.test"], sleep: async () => {} });
const DEADLINE = { id: 0, error: { code: -32000, message: 'Post "http://10.0.0.1:8547/rpc": context deadline exceeded' } };

test("a gateway upstream timeout is retried and the later answer is returned", async () => {
  const s = scripted([DEADLINE, { id: 0, result: "0x1237" }]);
  assert.equal(await rpcCall("eth_chainId", [], opts(s.fetchImpl)), "0x1237");
  assert.equal(s.count(), 2);
});

test("the upstream-timeout retry is bounded to two extra attempts", async () => {
  const s = scripted([DEADLINE]);
  await assert.rejects(rpcCall("eth_chainId", [], { ...opts(s.fetchImpl), retries: 5 }), /deadline exceeded/);
  assert.equal(s.count(), 3);
});

test("a plain JSON-RPC error is not retried", async () => {
  const s = scripted([{ id: 0, error: { code: -32602, message: "invalid argument" } }]);
  await assert.rejects(rpcCall("eth_call", [], opts(s.fetchImpl)), /invalid argument/);
  assert.equal(s.count(), 1);
});

test("only head-side methods may fall back to the second RPC", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (url: string, init: { body: string }) => {
    seen.push(url);
    const b = JSON.parse(init.body);
    const id = Array.isArray(b) ? b[0].id : b.id;
    if (seen.length === 1) return new Response(JSON.stringify({ id, error: { code: -32000, message: "rate limited upstream" } }), { status: 429 });
    return new Response(JSON.stringify({ id, result: "0x1" }), { status: 200 });
  }) as unknown as typeof fetch;
  // An archive read stays on the primary: one URL, retried there.
  seen.length = 0;
  await rpcCall("eth_getTransactionReceipt", ["0x0"], { fetchImpl, retries: 1, sleep: async () => {} });
  assert.equal(new Set(seen).size, 1, `archive read must not reach the fallback: ${[...new Set(seen)].join(", ")}`);
  // A head read may use the fallback.
  seen.length = 0;
  await rpcCall("eth_blockNumber", [], { fetchImpl, retries: 0, sleep: async () => {} });
  assert.equal(new Set(seen).size, 2, "eth_blockNumber should try the fallback");
});
