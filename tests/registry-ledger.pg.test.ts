// ============================================================
// 2026-09-02 監査 P1-6 / 是正: registry-hook が本番で引く SQL を実 DB で固定する。
//  - hasRegistryWriteForKey: 同じ purchase_id（request_hash）は 2 回書かない
//  - countRegistryWritesToday: 日次上限の分母（UTC 日・status を問わず全行）
//  - loadCoverageTier: endpoint の §7.4 階層（tierOf と同じ表を SQL で写す）
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("registry ledger (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  // TRUNCATE より前に、接続先が本番（Neon）でないことを機械で確かめる（2026-09-04 監査 D・P2）。
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("registry ledger + coverage tier SQL", async (t) => {
    const { hasRegistryWriteForKey, countRegistryWritesToday, requestHashOf } = await import("@/lib/chain/registry");
    const { loadCoverageTier } = await import("@/lib/observatory/coverage");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;
    await db.execute(sql`TRUNCATE x402_endpoints, registry_writes, settlements, decision_lookups, disputes`);

    const endpointId = randomUUID();
    await db.insert(schema.x402Endpoints).values({
      id: endpointId,
      resourceKey: "GET https://seller.example/api",
      resourceUrl: "https://seller.example/api",
      method: "GET",
      payTo: "0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea",
      network: "eip155:8453",
      status: "active",
      lastSeenAt: new Date(),
    });

    await t.test("hasRegistryWriteForKey: 無ければ false、台帳に行があれば true", async () => {
      const key = `eip155:8453:0x${"ab".repeat(32)}`;
      assert.equal(await hasRegistryWriteForKey(key), false);
      await db.insert(schema.registryWrites).values({
        requestHash: requestHashOf(key),
        endpointId,
        agentId: "42",
        level: "l1",
        response: 100,
        status: "submitted",
        txHash: "0xtx",
      });
      assert.equal(await hasRegistryWriteForKey(key), true);
      assert.equal(await hasRegistryWriteForKey(`${key}:l2`), false, "L2 は別 request_hash");
    });

    await t.test("countRegistryWritesToday: 今日（UTC）の全行を数える（failed も数える・昨日は数えない）", async () => {
      await db.insert(schema.registryWrites).values({
        requestHash: requestHashOf("today-failed"),
        endpointId,
        agentId: "42",
        level: "l1",
        response: 0,
        status: "failed",
      });
      await db.insert(schema.registryWrites).values({
        requestHash: requestHashOf("yesterday"),
        endpointId,
        agentId: "42",
        level: "l1",
        response: 100,
        status: "submitted",
        createdAt: new Date(Date.now() - 36 * 3_600_000),
      });
      assert.equal(await countRegistryWritesToday(), 2);
    });

    await t.test("loadCoverageTier: listed 30d のみ → C1", async () => {
      assert.equal(await loadCoverageTier(endpointId), "C1");
    });

    await t.test("loadCoverageTier: 決済帰属（confirmed）あり → C2、宣言があれば C3", async () => {
      await db.insert(schema.settlements).values({
        chain: "eip155:8453",
        txHash: `0x${"cd".repeat(32)}`,
        purchaseId: `eip155:8453:0x${"cd".repeat(32)}`,
        source: "l1_purchase",
        attribution: "confirmed",
        endpointId,
        blockTime: new Date(),
      });
      assert.equal(await loadCoverageTier(endpointId), "C2");
      await db.execute(sql`UPDATE x402_endpoints SET declared_schema = '{"type":"object"}'::jsonb WHERE id = ${endpointId}::uuid`);
      assert.equal(await loadCoverageTier(endpointId), "C3");
    });

    await t.test("loadCoverageTier: open の異議があれば C4（最優先）", async () => {
      await db.insert(schema.disputes).values({
        endpointId,
        subject: "l1",
        reason: "test",
        signer: "0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea",
        message: "m",
        signature: "s",
        status: "open",
      });
      assert.equal(await loadCoverageTier(endpointId), "C4");
      await db.execute(sql`UPDATE disputes SET status = 'closed'`);
      assert.equal(await loadCoverageTier(endpointId), "C3");
    });

    await t.test("loadCoverageTier: 未知の endpoint は C0（書かない側に倒す）", async () => {
      assert.equal(await loadCoverageTier(randomUUID()), "C0");
    });

    await t.test("loadCoverageTier: パステンプレート URL は C0", async () => {
      const tpl = randomUUID();
      await db.insert(schema.x402Endpoints).values({
        id: tpl,
        resourceKey: "GET https://ph.example/v1/e/:siren",
        resourceUrl: "https://ph.example/v1/e/:siren",
        method: "GET",
        status: "active",
        lastSeenAt: new Date(),
      });
      assert.equal(await loadCoverageTier(tpl), "C0");
    });
  });
}
