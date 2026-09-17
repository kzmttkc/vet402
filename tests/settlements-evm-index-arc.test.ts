// ============================================================
// §7.1 EVM 決済索引 — Arc の行（2026-09-17・Arc レーン）。
//
// 守ること:
//  1. Arc（eip155:5042）は表に載り、USDC は 0x3600…（実測 2026-09-17）。
//  2. ARC_RPC_URL が無ければ索引は静かに skip する（Polygon と同じ作法——
//     公開 RPC へ無言で倒れない。購入元残高の読み手は別で、そちらは公開 RPC へ倒れる）。
//  3. Base の行は 1 バイトも変わらない。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { EVM_INDEX_CHAINS, isEvmChainIndexable } from "@/lib/settlements/index-evm";
import { ARC_CHAIN_ID, ARC_USDC_ADDRESS } from "@/lib/chain/arc";

const byId = (id: number) => EVM_INDEX_CHAINS.find((c) => c.chainId === id);

test("Arc is in the EVM index table with the measured USDC and ARC_RPC_URL", () => {
  const arc = byId(5042);
  assert.ok(arc, "eip155:5042 missing from EVM_INDEX_CHAINS");
  assert.equal(arc.caip2, "eip155:5042");
  assert.equal(arc.chainId, ARC_CHAIN_ID);
  assert.equal(arc.usdc, ARC_USDC_ADDRESS);
  assert.equal(arc.usdc, "0x3600000000000000000000000000000000000000");
  assert.equal(arc.rpcEnv, "ARC_RPC_URL");
  // ~1s blocks: the lookback must express the same 7 days as Base's (2s blocks) window,
  // and the per-run cap must stay inside what one cron pass can read.
  assert.equal(arc.initialLookbackBlocks, 86_400n * 7n);
  assert.ok(arc.maxBlocksPerRun <= 40_000n);
  assert.ok(arc.confirmations >= 32n, "never fewer confirmations than Base");
});

test("Base's row is unchanged", () => {
  const base = byId(8453)!;
  assert.deepEqual(
    { ...base, makeClient: undefined },
    {
      caip2: "eip155:8453",
      chainId: 8453,
      usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      rpcEnv: "BASE_RPC_URL",
      initialLookbackBlocks: 43_200n * 7n,
      maxBlocksPerRun: 40_000n,
      confirmations: 32n,
      makeClient: undefined,
    },
  );
});

test("Arc is indexable only when ARC_RPC_URL is set (unset → skipped quietly, like Polygon)", () => {
  const arc = byId(5042)!;
  const saved = process.env.ARC_RPC_URL;
  try {
    delete process.env.ARC_RPC_URL;
    assert.equal(isEvmChainIndexable(arc), false);
    process.env.ARC_RPC_URL = "   ";
    assert.equal(isEvmChainIndexable(arc), false, "whitespace is unset");
    process.env.ARC_RPC_URL = "https://rpc.example.invalid";
    assert.equal(isEvmChainIndexable(arc), true);
  } finally {
    if (saved === undefined) delete process.env.ARC_RPC_URL;
    else process.env.ARC_RPC_URL = saved;
  }
  assert.equal(isEvmChainIndexable(byId(8453)!), true, "Base has a default RPC and is always indexable");
});

test("Arc builds its own client (it is not in the scoring chain registry, so getPublicClient(5042) is not the path)", () => {
  const arc = byId(5042)!;
  assert.equal(typeof arc.makeClient, "function");
  const saved = process.env.ARC_RPC_URL;
  try {
    process.env.ARC_RPC_URL = "https://rpc.example.invalid";
    const client = arc.makeClient!();
    assert.equal(client.chain?.id, 5042);
  } finally {
    if (saved === undefined) delete process.env.ARC_RPC_URL;
    else process.env.ARC_RPC_URL = saved;
  }
});
