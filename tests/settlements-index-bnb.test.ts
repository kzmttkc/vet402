// ============================================================
// BNB Chain（eip155:56）の決済索引（2026-10-19・段B2b）。
//
// USD1 は 18 桁。索引の額は台帳と同じ 6 桁（10^12 で割る）。割り切れない額は行にしない。
// BNB_RPC_URL が無ければ索引は動かない。公開 RPC へは倒れない。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { EVM_INDEX_CHAINS, evmIndexLedgerAmount, isEvmChainIndexable } from "@/lib/settlements/index-evm";
import { BNB_USD1_ADDRESS } from "@/lib/chain/bnb";
import { readFileSync } from "node:fs";

test("BNB index: USD1 の 18 桁を 6 桁で記録し、BNB_RPC_URL が無ければ索引しない", () => {
  const row = EVM_INDEX_CHAINS.find((c) => c.chainId === 56);
  assert.ok(row, "eip155:56 missing from EVM_INDEX_CHAINS");
  assert.equal(row.caip2, "eip155:56");
  assert.equal(row.usdc, BNB_USD1_ADDRESS);
  assert.equal(row.rpcEnv, "BNB_RPC_URL");
  assert.equal(row.blocksPerDay, 86_400n);
  assert.ok(row.maxBlocksPerRun > row.blocksPerDay);
  const src = readFileSync("src/lib/settlements/index-evm.ts", "utf8");
  assert.equal(src.includes("bsc-dataseed"), false, "索引は公開 RPC の URL を持たない");
  assert.equal(src.includes("BNB_PUBLIC_RPC_URL"), false);

  const saved = process.env.BNB_RPC_URL;
  try {
    delete process.env.BNB_RPC_URL;
    assert.equal(isEvmChainIndexable(row), false);
    assert.throws(() => row.makeClient!(), /BNB_RPC_URL_unset/);
    process.env.BNB_RPC_URL = "http://127.0.0.1:9";
    assert.equal(isEvmChainIndexable(row), true);
    assert.doesNotThrow(() => row.makeClient!());
  } finally {
    if (saved === undefined) delete process.env.BNB_RPC_URL;
    else process.env.BNB_RPC_URL = saved;
  }

  assert.equal(evmIndexLedgerAmount(56, 10n ** 17n), 100_000n, "1e17 = $0.10");
  assert.equal(evmIndexLedgerAmount(56, 150_000_000_000_000_000n), 150_000n, "1.5e17");
  assert.equal(evmIndexLedgerAmount(56, 80_000_000_000_000_000n), 80_000n, "8e16");
  assert.equal(evmIndexLedgerAmount(56, 10n ** 17n + 1n), null, "10^12 で割り切れない額は記録しない");
  assert.equal(evmIndexLedgerAmount(56, 0n), null);
  assert.equal(evmIndexLedgerAmount(8453, 3000n), 3000n, "Base の額はそのまま");
  assert.equal(evmIndexLedgerAmount(42220, 6000n), 6000n, "Celo の額はそのまま");
});
