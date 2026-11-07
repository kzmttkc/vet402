// ============================================================
// Vouch — multichain registry (C-8).
//
// The property that matters: a chain that is not explicitly enabled must be
// UNREACHABLE, not merely unlikely. A read silently falling back to Base
// while claiming to be Ethereum would score the wrong registration — worse
// than an error in every way. Base itself must stay always-on with behaviour
// byte-identical to the pre-multichain code.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHAINS,
  DEFAULT_CHAIN_ID,
  chainById,
  chainBySlug,
  enabledChainSlugs,
  isChainEnabled,
  rpcUrlFor,
} from "@/lib/chain/chains";
import { getPublicClient } from "@/lib/chain/client";

test("base is the default and is always enabled", () => {
  assert.equal(DEFAULT_CHAIN_ID, 8453);
  const base = chainById(8453)!;
  assert.ok(isChainEnabled(base), "base must never be gated behind an env var");
  assert.equal(rpcUrlFor(base), process.env.BASE_RPC_URL?.trim() || "https://mainnet.base.org");
  assert.ok(enabledChainSlugs().includes("base"));
});

test("slugs resolve case-insensitively and unknowns are null", () => {
  assert.equal(chainBySlug("base")?.id, 8453);
  assert.equal(chainBySlug("  Ethereum ")?.id, 1);
  assert.equal(chainBySlug("solana"), null);
  assert.equal(chainBySlug(""), null);
});

test("ethereum is registered but env-gated", () => {
  const eth = chainById(1)!;
  assert.equal(eth.slug, "ethereum");
  const saved = process.env.ETHEREUM_RPC_URL;
  delete process.env.ETHEREUM_RPC_URL;
  assert.equal(isChainEnabled(eth), false, "no env var → not enabled");
  assert.equal(rpcUrlFor(eth), null);
  process.env.ETHEREUM_RPC_URL = "https://example-rpc.invalid";
  assert.equal(isChainEnabled(eth), true);
  assert.equal(rpcUrlFor(eth), "https://example-rpc.invalid");
  if (saved === undefined) delete process.env.ETHEREUM_RPC_URL;
  else process.env.ETHEREUM_RPC_URL = saved;
});

test("getPublicClient throws for unknown and not-enabled chains — no silent fallback", () => {
  assert.throws(() => getPublicClient(999999), /unsupported_chain/);
  const saved = process.env.ETHEREUM_RPC_URL;
  delete process.env.ETHEREUM_RPC_URL;
  assert.throws(() => getPublicClient(1), /chain_not_enabled/);
  if (saved !== undefined) process.env.ETHEREUM_RPC_URL = saved;
});

test("getPublicClient with no argument still builds a Base client", () => {
  const client = getPublicClient();
  assert.equal(client.chain?.id, 8453);
});

test("per-chain scan windows differ (Base 0.2s blocks since 2026-11-05 vs Ethereum 12s)", () => {
  // 2026-11-07: Base was 43,200 (2 s). Day windows on Base go through its block-time schedule
  // (tests/block-clock.test.ts); this constant is the current rate only.
  assert.equal(CHAINS[8453].blocksPerDay, 432_000);
  assert.equal(CHAINS[1].blocksPerDay, 7_200);
});

test("every registered chain has a blockscout host for wallet metrics", () => {
  for (const chain of Object.values(CHAINS)) {
    assert.ok(chain.blockscoutApi?.startsWith("https://"), chain.slug);
  }
});
