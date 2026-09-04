// ============================================================
// 2026-09-04 金の経路監査 P1-4(c): 一度 failed になった測定は二度と書けなかった。
//
// hasRegistryWriteForHash は status を問わず行の存在だけを見ていて、
// publishValidation の INSERT も ON CONFLICT DO NOTHING だった。つまり
// 本番の 14 行（原因は「validator は request を自己開始できない」という設計欠陥）は、
// 原因が直っても永久に書けないまま。ここでは
//   submitted → duplicate（二度書かない）
//   failed    → 再試行できる
//   pending   → 再試行しない（飛行中の行を二重送信しない）
// を DB 実走で固定する。**本番の 14 行はこのテストでも触らない**——
// ここが使うのはローカルのテスト DB だけ。
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/registry-retry-failed.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";
import { randomUUID } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("registry failed retry (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("failed の測定は書き直せる／submitted と pending は書かない", async (t) => {
    const { buildValidationRecord, hasRegistryWriteForHash, publishValidation } = await import(
      "@/lib/chain/registry"
    );
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;

    const endpointId = randomUUID();
    const record = (key: string) =>
      buildValidationRecord({
        endpointId,
        agentId: 42n,
        level: "l1",
        verdict: "pass",
        evidenceUri: `https://vet402.com/observatory/e/${endpointId}`,
        requestKey: key,
      });

    const wallet = (calls: string[]) =>
      ({
        account: { address: "0x1111111111111111111111111111111111111111" },
        chain: { id: 8453 },
        async writeContract(req: { functionName: string }) {
          calls.push(req.functionName);
          return `0x${"ab".repeat(32)}`;
        },
      }) as never;

    const seed = async (requestHash: string, status: string) => {
      await db.execute(sql`
        INSERT INTO registry_writes (request_hash, endpoint_id, agent_id, level, response, evidence_uri, status)
        VALUES (${requestHash}, ${endpointId}::uuid, '42', 'l1', 100, 'https://vet402.com/x', ${status})
        ON CONFLICT (request_hash) DO UPDATE SET status = EXCLUDED.status
      `);
    };

    t.before(() => {
      process.env.REGISTRY_WRITES_ENABLED = "true";
    });
    t.after(async () => {
      delete process.env.REGISTRY_WRITES_ENABLED;
      await db.execute(sql`DELETE FROM registry_writes WHERE endpoint_id = ${endpointId}::uuid`);
    });

    await t.test("submitted は duplicate（先行判定でも publish でも書かない）", async () => {
      const r = record("submitted-key");
      await seed(r.requestHash, "submitted");
      assert.equal(await hasRegistryWriteForHash(r.requestHash), true);
      const calls: string[] = [];
      const out = await publishValidation({
        record: r,
        walletClient: wallet(calls),
        currentMaxFeeWei: 1n,
        waitForReceipt: async () => undefined,
      });
      assert.equal(out.status, "duplicate");
      assert.deepEqual(calls, []);
    });

    await t.test("failed は先行判定を通り、書き直せる", async () => {
      const r = record("failed-key");
      await seed(r.requestHash, "failed");
      assert.equal(await hasRegistryWriteForHash(r.requestHash), false, "failed が duplicate 扱いのまま");
      const calls: string[] = [];
      const out = await publishValidation({
        record: r,
        walletClient: wallet(calls),
        currentMaxFeeWei: 1n,
        waitForReceipt: async () => undefined,
      });
      assert.equal(out.status, "submitted");
      assert.deepEqual(calls, ["validationRequest", "validationResponse"]);
    });

    await t.test("pending は書き直さない（飛行中の行を二重送信しない）", async () => {
      const r = record("pending-key");
      await seed(r.requestHash, "pending");
      const calls: string[] = [];
      const out = await publishValidation({
        record: r,
        walletClient: wallet(calls),
        currentMaxFeeWei: 1n,
        waitForReceipt: async () => undefined,
      });
      assert.equal(out.status, "duplicate");
      assert.deepEqual(calls, []);
    });

    await t.test("日次上限に達したら同一文で止まる", async () => {
      process.env.REGISTRY_DAILY_MAX_WRITES = "0";
      const calls: string[] = [];
      const out = await publishValidation({
        record: record("cap-key"),
        walletClient: wallet(calls),
        currentMaxFeeWei: 1n,
        waitForReceipt: async () => undefined,
      });
      delete process.env.REGISTRY_DAILY_MAX_WRITES;
      assert.equal(out.status, "daily_cap");
      assert.deepEqual(calls, []);
    });
  });
}
