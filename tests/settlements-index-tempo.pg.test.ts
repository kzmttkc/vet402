// ============================================================
// §7.2 決済索引 — Tempo（MPP）の USDC.e 転送と memo 帰属（2026-09-17）。
//
// RPC は偽物（client と getLogs の差し替え）。守ること:
//   - 受取先は x402_endpoints（network eip155:4217・L0 が学習した pay_to）から引く
//   - Transfer と TransferWithMemo を両方読み、同じ tx は 1 行に畳む
//   - memo が MPP の tag（keccak256("mpp")[0..3] + 0x01）なら raw.mppAttributed=true、
//     素の Transfer / 他の memo は false または無し。Resource への帰属は従来の規則
//     （payTo × amount）で、memo は帰属を変えない
//   - 表の Tempo 行は TEMPO_RPC_URL が無くても索引の対象（既定 RPC を持つ）
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/settlements-index-tempo.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("settlements index tempo (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("Tempo settlement index", async (t) => {
    const { EVM_INDEX_CHAINS, TRANSFER_EVENT, TRANSFER_WITH_MEMO_EVENT, indexEvmChain, isEvmChainIndexable } = await import("@/lib/settlements/index-evm");
    const { encodeMppAttributionMemo, MPP_CLIENT_ID, TEMPO_USDC_E } = await import("@/lib/observatory/mpp-payer");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;
    const rows = <T,>(raw: unknown) => [...((Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[])];

    const tempo = EVM_INDEX_CHAINS.find((c) => c.caip2 === "eip155:4217");
    assert.ok(tempo, "Tempo is in the EVM index chain table");
    const chain = tempo!;
    assert.equal(chain.usdc.toLowerCase(), TEMPO_USDC_E.toLowerCase());
    assert.equal(chain.rpcEnv, "TEMPO_RPC_URL");
    assert.equal(chain.memoTransfers, true);
    assert.ok(chain.maxBlocksPerRun >= 86_400n, "one run must cover a day of ~1s blocks");
    const savedRpc = process.env.TEMPO_RPC_URL;
    t.after(() => (savedRpc === undefined ? delete process.env.TEMPO_RPC_URL : (process.env.TEMPO_RPC_URL = savedRpc)));
    delete process.env.TEMPO_RPC_URL;
    assert.equal(isEvmChainIndexable(chain), false, "no env → not indexable (skipped as TEMPO_RPC_URL_unset, no public-RPC fallback; review #7/#8)");
    const { perChainBudgetMs } = await import("@/lib/settlements/index-evm");
    const withoutTempo = perChainBudgetMs(120_000);
    process.env.TEMPO_RPC_URL = "https://rpc.tempo.example";
    assert.equal(isEvmChainIndexable(chain), true);
    assert.ok(perChainBudgetMs(120_000) <= withoutTempo, "the per-chain budget divides by indexable chains, so Tempo only takes a share once it is indexable");

    const PAYEE = "0xca4e835f803cb0b7c428222b3a3b98518d4779fe";
    const PAYER = "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670";
    const OTHER_PAYER = "0x00000000000000000000000000000000000000aa";
    const MEMO = encodeMppAttributionMemo({ challengeId: "p-1", realm: "fal.mpp.tempo.xyz", clientId: MPP_CLIENT_ID });
    const NOT_MPP = `0x${"42".repeat(32)}`;
    const TX_PLAIN = `0x${"a1".repeat(32)}`;
    const TX_MPP = `0x${"a2".repeat(32)}`;
    const TX_OTHER_MEMO = `0x${"a3".repeat(32)}`;

    await db.execute(sql`TRUNCATE x402_endpoints, x402_l0_probes, x402_l1_purchases, settlements, indexer_checkpoints`);
    await db.execute(sql`
      INSERT INTO x402_endpoints (resource_key, resource_url, source, method, network, pay_to, price_amount, price_asset, status, resource_id)
      VALUES ('fal.mpp.tempo.xyz/fal-ai/flux/dev', 'https://fal.mpp.tempo.xyz/fal-ai/flux/dev', 'mpp_directory', 'POST',
              'eip155:4217', ${PAYEE}, '25000', ${TEMPO_USDC_E.toLowerCase()}, 'active', 'res-tempo-1')
    `);

    const client = {
      getBlockNumber: async () => 40_000_100n,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: 1_789_000_000n + (blockNumber - 39_000_000n) }),
    };
    const calls: { event: string; to: string[] }[] = [];
    const getLogs = (async (_c: unknown, params: { event: { name: string }; args: { to: string[] } }) => {
      calls.push({ event: params.event.name, to: params.args.to });
      if (params.event.name === TRANSFER_EVENT.name) {
        return [
          { transactionHash: TX_PLAIN, blockNumber: 40_000_000n, args: { from: OTHER_PAYER, to: PAYEE, value: 25_000n } },
          { transactionHash: TX_MPP, blockNumber: 40_000_001n, args: { from: PAYER, to: PAYEE, value: 25_000n } },
          { transactionHash: TX_OTHER_MEMO, blockNumber: 40_000_002n, args: { from: OTHER_PAYER, to: PAYEE, value: 7n } },
        ];
      }
      if (params.event.name === TRANSFER_WITH_MEMO_EVENT.name) {
        return [
          { transactionHash: TX_MPP, blockNumber: 40_000_001n, args: { from: PAYER, to: PAYEE, amount: 25_000n, memo: MEMO } },
          { transactionHash: TX_OTHER_MEMO, blockNumber: 40_000_002n, args: { from: OTHER_PAYER, to: PAYEE, amount: 7n, memo: NOT_MPP } },
        ];
      }
      return [];
    }) as never;

    const classifier = { classify: async () => "none" as const, testWallets: new Set<string>(), sameCluster: () => false };
    const summary = await indexEvmChain(chain, { client: client as never, getLogs, classifier, budgetMs: 30_000 });
    assert.equal(summary.skipped, undefined, JSON.stringify(summary));
    assert.equal(summary.payees, 1);
    assert.equal(summary.logs, 5, "3 Transfer + 2 TransferWithMemo read");
    assert.equal(summary.inserted, 3, "same tx folds into one row");
    assert.deepEqual(
      calls.map((c) => c.event),
      [TRANSFER_EVENT.name, TRANSFER_WITH_MEMO_EVENT.name],
      "both events are asked for, the learned payee is the filter",
    );
    assert.deepEqual(calls[0].to, [PAYEE]);

    const settled = rows<{ tx_hash: string; attribution: string; amount: string; payer: string; raw: Record<string, unknown> }>(
      await db.execute(sql`SELECT tx_hash, attribution, amount, payer, raw FROM settlements WHERE chain = 'eip155:4217' ORDER BY tx_hash`),
    );
    const byTx = new Map(settled.map((s) => [s.tx_hash, s]));
    const plain = byTx.get(TX_PLAIN)!;
    assert.equal(plain.raw.memo, undefined, "plain Transfer carries no memo");
    assert.equal(plain.raw.mppAttributed, undefined);
    assert.equal(plain.attribution, "confirmed", "payTo × declared amount (single endpoint) → confirmed by the existing rule, memo or not");
    const mpp = byTx.get(TX_MPP)!;
    assert.equal(mpp.raw.memo, MEMO);
    assert.equal(mpp.raw.mppAttributed, true, "MPP tag → attributable to MPP");
    assert.equal(mpp.amount, "25000");
    assert.equal(mpp.payer, PAYER);
    assert.equal(mpp.attribution, "confirmed");
    const other = byTx.get(TX_OTHER_MEMO)!;
    assert.equal(other.raw.memo, NOT_MPP);
    assert.equal(other.raw.mppAttributed, false, "a memo without the MPP tag is not MPP");
    assert.equal(other.attribution, "probable", "the single-endpoint payee rule stays: amount 7 ≠ 25000 → probable, not confirmed");

    // Base の既存挙動は変えない（レビュー #10）: 同じ tx のログ 2 本は畳まず、1 行の insert + 1 回の update。
    const base = EVM_INDEX_CHAINS.find((c) => c.caip2 === "eip155:8453")!;
    await db.execute(sql`
      INSERT INTO x402_endpoints (resource_key, resource_url, source, method, network, pay_to, price_amount, price_asset, status, resource_id)
      VALUES ('seller.example/api', 'https://seller.example/api', 'cdp_bazaar', 'GET', 'eip155:8453', ${PAYEE}, '25000', ${base.usdc.toLowerCase()}, 'active', 'res-base-1')
    `);
    const baseCalls: string[] = [];
    const baseGetLogs = (async (_c: unknown, params: { event: { name: string } }) => {
      baseCalls.push(params.event.name);
      return [
        { transactionHash: `0x${"b1".repeat(32)}`, blockNumber: 40_000_000n, args: { from: PAYER, to: PAYEE, value: 25_000n } },
        { transactionHash: `0x${"b1".repeat(32)}`, blockNumber: 40_000_000n, args: { from: PAYER, to: PAYEE, value: 25_000n } },
      ];
    }) as never;
    const baseSummary = await indexEvmChain(base, { client: client as never, getLogs: baseGetLogs, classifier, budgetMs: 30_000 });
    assert.deepEqual(baseCalls, [TRANSFER_EVENT.name], "Base asks for Transfer only (no TransferWithMemo)");
    assert.equal(baseSummary.logs, 2);
    assert.equal(baseSummary.inserted, 1);
    assert.equal(baseSummary.updated, 0, "Base: same-tx logs reach the existing batch upsert, which keeps the first by purchase_id (unchanged behaviour); the memo fold never runs here");

    // チェックポイントは Tempo 固有の scope。初回は safeTip − 遡り幅 から maxBlocksPerRun ぶんだけ進む
    // （3 日分の遡りは 1 回では終わらず、次回に持ち越す——Base と同じ）。
    const safeTip = 40_000_100n - chain.confirmations;
    const firstFrom = safeTip - chain.initialLookbackBlocks;
    assert.equal(summary.fromBlock, String(firstFrom));
    assert.equal(summary.toBlock, String(firstFrom + chain.maxBlocksPerRun - 1n));
    const cp = rows<{ scope: string; last_block: string }>(await db.execute(sql`SELECT scope, last_block::text AS last_block FROM indexer_checkpoints WHERE scope = 'settlements:eip155:4217'`));
    assert.equal(cp.length, 1);
    assert.equal(cp[0].last_block, String(firstFrom + chain.maxBlocksPerRun - 1n));
  });
}
