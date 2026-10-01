// ============================================================
// §7.1 EVM 決済索引 — 区切りごとのチェックポイント（2026-10-02）。
//
// 事故: Base は受取先 1,864 件（500 件ずつ 4 スライス）× 40,000 ブロックを全部読み切らないと
// チェックポイントが進まなかった。10/1 23:06 JST の混んだ区間から getLogs が毎回予算切れ
// （deadline_exceeded）で投げ、チェーンごと skipped・何も保存されず、同じ区間を毎日やり直していた。
//
// 守ること:
//  1. Base は 4,000 ブロックずつ区切って読み、読み切った区切りの終わりをチェックポイントに残す
//  2. getLogs の deadline_exceeded は「ここまで」: チェーンを skipped にせず partial で返し、
//     前の区切りまでの行と進捗は残る
//  3. それ以外の RPC の失敗は従来どおり投げる（呼び手が error: として数える）が、
//     それまでに読み切った区切りの進捗は残る
//  4. 次の走査は保存した続きから読む（同じ区間をやり直さない）
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/settlements-evm-subwindow.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("settlements evm sub-windows (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("EVM index saves progress per sub-window and survives a deadline mid-run", async () => {
    const { EVM_INDEX_CHAINS, indexEvmChain } = await import("@/lib/settlements/index-evm");
    const { DeadlineExceededError } = await import("@/lib/util/deadline");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;
    const rows = <T,>(raw: unknown) => [...((Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[])];

    const base = EVM_INDEX_CHAINS.find((c) => c.caip2 === "eip155:8453")!;
    const W = base.subWindowBlocks!;
    assert.equal(W, 4_000n);
    assert.equal(base.maxBlocksPerRun % W, 0n, "the run splits into whole windows");

    const PAYEE = "0x00000000000000000000000000000000000000b1";
    const PAYER = "0x00000000000000000000000000000000000000c1";
    await db.execute(sql`TRUNCATE x402_endpoints, x402_l0_probes, x402_l1_purchases, settlements, indexer_checkpoints`);
    await db.execute(sql`
      INSERT INTO x402_endpoints (resource_key, resource_url, source, method, network, pay_to, price_amount, price_asset, status, resource_id)
      VALUES ('seller.example/api', 'https://seller.example/api', 'cdp_bazaar', 'GET', 'eip155:8453', ${PAYEE}, '10000', ${base.usdc.toLowerCase()}, 'active', 'res-base-sw')
    `);
    const TIP = 50_000_000n;
    const client = {
      getBlockNumber: async () => TIP,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: 1_789_000_000n + blockNumber * 2n }),
    };
    const firstFrom = TIP - base.confirmations - base.initialLookbackBlocks;
    // 1 区切りに 1 件ずつ転送がある
    const txAt = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
    const logsIn = (from: bigint, to: bigint) => {
      const out = [];
      for (let w = firstFrom; w <= to; w += W) {
        const b = w + 5n;
        if (b >= from && b <= to) out.push({ transactionHash: txAt(b), blockNumber: b, args: { from: PAYER, to: PAYEE, value: 10_000n } });
      }
      return out;
    };
    const classifier = { classify: async () => "none" as const, testWallets: new Set<string>(), sameCluster: () => false };
    const checkpoint = async () =>
      rows<{ last_block: string }>(await db.execute(sql`SELECT last_block::text AS last_block FROM indexer_checkpoints WHERE scope = 'settlements:eip155:8453'`))[0]?.last_block;

    // 1) 3 つ目の区切りで getLogs が予算切れ → 2 区切りぶん保存して partial で返す（skipped にしない）
    let calls = 0;
    const deadlineOnThird = (async (_c: unknown, p: { fromBlock: bigint; toBlock: bigint }) => {
      calls++;
      if (calls === 3) throw new DeadlineExceededError("getLogsChunked", 150);
      return logsIn(p.fromBlock, p.toBlock);
    }) as never;
    const s1 = await indexEvmChain(base, { client: client as never, getLogs: deadlineOnThird, classifier, budgetMs: 30_000 });
    assert.equal(s1.skipped, undefined, JSON.stringify(s1));
    assert.equal(s1.partial, true);
    assert.equal(s1.inserted, 2, "rows from the two finished windows are kept");
    assert.equal(s1.checkpoint, String(firstFrom + 2n * W - 1n));
    assert.equal(await checkpoint(), String(firstFrom + 2n * W - 1n));

    // 2) 次の走査は続きから読み、最後まで読み切る
    const ranges: bigint[] = [];
    const ok = (async (_c: unknown, p: { fromBlock: bigint; toBlock: bigint }) => {
      ranges.push(p.fromBlock);
      return logsIn(p.fromBlock, p.toBlock);
    }) as never;
    const s2 = await indexEvmChain(base, { client: client as never, getLogs: ok, classifier, budgetMs: 30_000 });
    assert.equal(ranges[0], firstFrom + 2n * W, "resumes after the saved window, not from the start");
    assert.equal(s2.partial ?? false, true, "still behind the tip, so lag keeps partial on");
    assert.equal(s2.checkpoint, String(firstFrom + 2n * W + base.maxBlocksPerRun - 1n));
    assert.equal(s2.inserted, Number(base.maxBlocksPerRun / W));

    // 3) 予算切れ以外の失敗は投げる。それでも読み切った区切りは残る
    let n = 0;
    const rpcDown = (async (_c: unknown, p: { fromBlock: bigint; toBlock: bigint }) => {
      n++;
      if (n === 2) throw new Error("rpc down");
      return logsIn(p.fromBlock, p.toBlock);
    }) as never;
    const before = BigInt((await checkpoint())!);
    await assert.rejects(indexEvmChain(base, { client: client as never, getLogs: rpcDown, classifier, budgetMs: 30_000 }), /rpc down/);
    assert.equal(await checkpoint(), String(before + W), "the window read before the failure is saved");
  });
}
