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
import { EVM_INDEX_CHAINS, TRANSFER_WITH_MEMO_EVENT, evmIndexLag, isEvmChainIndexable, perChainBudgetMs } from "@/lib/settlements/index-evm";
import { decodeEventLog } from "viem";
import { readFileSync } from "node:fs";
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
  assert.equal(arc.blocksPerDay, 86_400n);
  // 2026-09-17 review: the cron runs once a day; 40,000 blocks/run could never catch up with
  // 86,400 blocks/day. One run must cover more than a day, so a lagging day is recovered.
  assert.ok(arc.maxBlocksPerRun >= 120_000n, `maxBlocksPerRun ${arc.maxBlocksPerRun} < 120,000`);
  assert.ok(arc.maxBlocksPerRun > arc.blocksPerDay);
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
      blocksPerDay: 43_200n,
      makeClient: undefined,
    },
  );
});

// ---- 2026-09-17 review 1: the per-chain budget divides by INDEXABLE chains, not table rows ----

test("perChainBudgetMs: Arc's row does not take budget away from Base while ARC_RPC_URL is unset", () => {
  const saved = { arc: process.env.ARC_RPC_URL, polygon: process.env.POLYGON_RPC_URL };
  try {
    delete process.env.ARC_RPC_URL;
    delete process.env.POLYGON_RPC_URL;
    // Base alone is indexable → the whole budget (never less than the pre-Arc 60s of a 2-row table).
    assert.equal(perChainBudgetMs(120_000), 120_000);
    assert.ok(perChainBudgetMs(120_000) >= 60_000, "must not be below what Base had before Arc was added");
    process.env.ARC_RPC_URL = "https://rpc.example.invalid";
    assert.equal(perChainBudgetMs(120_000), 60_000, "Base + Arc indexable → halves");
    process.env.POLYGON_RPC_URL = "https://polygon.example.invalid";
    assert.equal(perChainBudgetMs(120_000), 40_000, "three indexable → thirds");
    assert.equal(perChainBudgetMs(30_000), 20_000, "floor of 20s per chain");
  } finally {
    if (saved.arc === undefined) delete process.env.ARC_RPC_URL;
    else process.env.ARC_RPC_URL = saved.arc;
    if (saved.polygon === undefined) delete process.env.POLYGON_RPC_URL;
    else process.env.POLYGON_RPC_URL = saved.polygon;
  }
});

test("perChainBudgetMs never divides by zero (a table with nothing indexable still returns the budget)", () => {
  const none = [{ ...byId(5042)!, rpcEnv: "NEVER_SET_RPC_URL_FOR_THIS_TEST" }];
  assert.equal(perChainBudgetMs(90_000, none), 90_000);
});

// ---- 2026-09-17 review 2: lag past one day is fail-loud (lagBlocks + partial) ----

test("evmIndexLag: null while within a day of the safe tip, the block gap once behind by more than a day", () => {
  const arc = byId(5042)!;
  assert.equal(evmIndexLag(arc, 1_000_000n, 1_000_000n), null, "caught up");
  assert.equal(evmIndexLag(arc, 1_000_000n, 1_000_000n - 86_400n), null, "exactly a day is not yet lag");
  assert.equal(evmIndexLag(arc, 1_000_000n, 1_000_000n - 86_401n), 86_401n);
  const base = byId(8453)!;
  assert.equal(evmIndexLag(base, 500_000n, 500_000n - 43_200n), null);
  assert.equal(evmIndexLag(base, 500_000n, 400_000n), 100_000n, "Base is measured against its own 43,200/day");
});

test("indexEvmChain reports lag in the summary (lagBlocks set, partial true) — the source wires evmIndexLag in", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const src = readFileSync(join(process.cwd(), "src", "lib", "settlements", "index-evm.ts"), "utf8");
  assert.match(src, /const lag = evmIndexLag\(chain, safeTip, nextCheckpoint\)/);
  assert.match(src, /summary\.lagBlocks = String\(lag\)/);
  assert.match(src, /summary\.partial = true;\s*\n\s*logServerError\("settlements\.index_evm\.lag"/);
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

// ---- Tempo の TransferWithMemo の宣言（2026-09-18・本番の receipt で実測）----
test("TransferWithMemo is declared with an INDEXED memo and decodes the production log (tx 0xbd1049ed…95e8)", () => {
  const memoInput = TRANSFER_WITH_MEMO_EVENT.inputs.find((i) => i.name === "memo");
  assert.equal(memoInput?.indexed, true, "memo is topics[3] on Tempo; a non-indexed declaration drops amount and memo from args");
  const p32 = (a: string) => `0x${"0".repeat(24)}${a.slice(2)}` as `0x${string}`;
  const decoded = decodeEventLog({
    abi: [TRANSFER_WITH_MEMO_EVENT],
    topics: [
      "0x57bc7354aa85aed339e000bccffabbc529466af35f0772c8f8ee1145927de7f0",
      p32("0xc9c7b38c0942914fc8ea12063bc92dcd3b581670"),
      p32("0xca4e835f803cb0b7c428222b3a3b98518d4779fe"),
      "0xef1ed712018bdbf8cc304c4816750e6065bcf287cc18ca700fbeb5c7584f9206",
    ],
    data: `0x${(40_000n).toString(16).padStart(64, "0")}`,
  });
  const args = decoded.args as { amount: bigint; memo: string };
  assert.equal(args.amount, 40_000n);
  assert.equal(args.memo, "0xef1ed712018bdbf8cc304c4816750e6065bcf287cc18ca700fbeb5c7584f9206");
});

test("a transfer log decoded without an amount is not written as a zero-amount row (source check: no `?? 0n`)", () => {
  const src = readFileSync("src/lib/settlements/index-evm.ts", "utf8");
  assert.ok(!/args\.amount \?\? 0n/.test(src), "the silent `?? 0n` fallback must not come back");
  assert.match(src, /undecodable_log/);
});

