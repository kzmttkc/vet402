// Two chain reads added with rwa-recon-0.2: every canonical balance in one
// Multicall3 call, and a v4 pool key from the PositionManager that is accepted
// only when it hashes back to the pool id. The RPC is faked; nothing reaches the chain.
//
// Run from the repo root: npx tsx --test packages/rwa/test/chain-reads.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeFunctionResult, keccak256, parseAbi } from "viem";
import { MULTICALL3, readBalances } from "../feed";
import { poolKeyFromPositionManager } from "../pools";

const HOLDER = "0xe9b08727131e34010b34006c660d4c1b436ec25f";
const T1 = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
const T2 = "0xd5f3879160bc7c32ebb4dc785f8a4f505888de68";
const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;

function fakeRpc(result: string, seen: unknown[] = []) {
  return (async (_url: string, init: { body: string }) => {
    seen.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 0, result }), { status: 200 });
  }) as unknown as typeof fetch;
}

const aggregate3 = parseAbi([
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns (Result[] returnData)",
]);

test("balances come back from one Multicall3 call, per token", async () => {
  const seen: { params: [{ to: string }] }[] = [];
  const data = encodeFunctionResult({ abi: aggregate3, functionName: "aggregate3", result: [{ success: true, returnData: word(41n) }, { success: true, returnData: word(0n) }] });
  const out = await readBalances([T1, T2], HOLDER, 100, { fetchImpl: fakeRpc(data, seen), retries: 0 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].params[0].to, MULTICALL3);
  assert.equal(out.get(T1), 41n);
  assert.equal(out.get(T2), 0n);
});

test("a failed balanceOf inside the multicall is an error, not a zero", async () => {
  const data = encodeFunctionResult({ abi: aggregate3, functionName: "aggregate3", result: [{ success: true, returnData: word(1n) }, { success: false, returnData: "0x" }] });
  await assert.rejects(readBalances([T1, T2], HOLDER, 100, { fetchImpl: fakeRpc(data), retries: 0 }), /balanceOf failed/);
});

const poolKeysAbi = parseAbi(["function poolKeys(bytes25 poolId) view returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)"]);
const KEY = ["0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", 3000, 60, "0x0000000000000000000000000000000000000000"] as const;
const POOL_ID = keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }], [...KEY]));
const keyResult = encodeFunctionResult({ abi: poolKeysAbi, functionName: "poolKeys", result: [...KEY] });

test("a pool key that hashes to the pool id is accepted", async () => {
  const got = await poolKeyFromPositionManager(POOL_ID, { fetchImpl: fakeRpc(keyResult), retries: 0 });
  assert.deepEqual(got, { currency0: KEY[0].toLowerCase(), currency1: KEY[1].toLowerCase() });
});

test("a pool key for another id (same 25-byte prefix, different tail) is refused", async () => {
  const otherId = `${POOL_ID.slice(0, 52)}${"0".repeat(14)}`;
  assert.equal(await poolKeyFromPositionManager(otherId, { fetchImpl: fakeRpc(keyResult), retries: 0 }), null);
});
