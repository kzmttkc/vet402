// ============================================================
// 2026-09-29 敵対的監査 4 周目: 台帳の UPDATE と訂正ログが別の文で、訂正ログの失敗を
// 握りつぶしていた（recover-late・settlement-verifier の refute / withdrawLateLink / settled）。
// ここで固定すること:
//   1. 訂正ログが書けないなら、台帳も変わらない（同じ文・fail-loud・次回のバッチで再試行）
//   2. 照合の成否（settled / refuted）には必ず訂正が 1 行ある
//   3. 照合の理由だけの書き込み（status 不変）は訂正ログに載せない（一時的な理由で /corrections を埋めない）
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/correction-log-atomic.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("correction log atomic (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const PAY_TO = "0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea";
  const PAYER = "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670";
  const BASE = "eip155:8453";

  test("訂正ログは台帳の変更と同じ文", async (t) => {
    const { runSettlementVerification } = await import("@/lib/observatory/settlement-verifier");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql, eq } = await import("drizzle-orm");
    const db = getDb()!;
    const rows = <T,>(raw: unknown) => (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];

    const reset = () => db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases, observed_purchases, settlements, correction_log`);
    const seed = async (txByte: string) => {
      const endpointId = randomUUID();
      await db.insert(schema.x402Endpoints).values({
        id: endpointId,
        resourceKey: `GET https://seller.example/api/${endpointId}`,
        resourceUrl: `https://seller.example/api/${endpointId}`,
        method: "GET",
        payTo: PAY_TO,
        network: BASE,
        status: "active",
        lastSeenAt: new Date(),
      });
      const [row] = await db
        .insert(schema.x402L1Purchases)
        .values({
          endpointId,
          status: "settle_claimed",
          network: BASE,
          payTo: PAY_TO,
          payer: PAYER,
          amountUnits: "1000",
          spentUnits: "1000",
          txHash: `0x${txByte.repeat(32)}`,
          authNonce: `0x${"7f".repeat(32)}`,
          httpStatusPaid: 200,
          payloadNonEmpty: true,
          l2Schema: "no_declaration",
          attemptedAt: new Date("2026-09-20T00:00:00Z"),
        })
        .returning();
      return row.id;
    };
    const statusOf = async (id: string) => (await db.select().from(schema.x402L1Purchases).where(eq(schema.x402L1Purchases.id, id)))[0];
    const corrections = async (id: string) =>
      rows<{ before: Record<string, unknown>; after: Record<string, unknown> }>(
        await db.execute(sql`SELECT before, after FROM correction_log WHERE subject_id = ${id} ORDER BY created_at`),
      );
    const hooks = { l1: async () => {}, l2: async () => {} };
    const run = (verify: Parameters<typeof runSettlementVerification>[0] extends infer O ? O extends { deps?: { verify?: infer V } } ? V : never : never) =>
      runSettlementVerification({ deps: { verify, registryHooks: hooks } });

    await t.test("settled: 台帳と訂正が 1 行ずつ", async () => {
      await reset();
      const id = await seed("a1");
      await run(async () => ({ ok: true, blockTimestamp: null, confirmations: 9n, blockNumber: 42n }));
      assert.equal((await statusOf(id)).status, "settled");
      const c = await corrections(id);
      assert.equal(c.length, 1);
      assert.deepEqual(c[0].before, { status: "settle_claimed" });
      assert.deepEqual(c[0].after, { status: "settled", blockNumber: "42" });
    });

    await t.test("refuted: 台帳と訂正が 1 行ずつ", async () => {
      await reset();
      const id = await seed("b1");
      await run(async () => ({ ok: false, reason: "no_matching_transfer" }) as never);
      assert.equal((await statusOf(id)).status, "settle_claim_refuted");
      assert.equal((await corrections(id)).length, 1);
    });

    await t.test("訂正ログが書けないと台帳も変わらない（rowErrors に数え、次回に再試行できる）", async () => {
      await reset();
      const id = await seed("c1");
      await db.execute(
        sql.raw(`
        CREATE OR REPLACE FUNCTION cl_refuse() RETURNS trigger AS $c$
        BEGIN RAISE EXCEPTION 'simulated: correction_log unwritable'; END $c$ LANGUAGE plpgsql;
      `),
      );
      await db.execute(sql`CREATE TRIGGER cl_refuse_trg BEFORE INSERT ON correction_log FOR EACH ROW EXECUTE FUNCTION cl_refuse()`);
      try {
        const summary = await run(async () => ({ ok: true, blockTimestamp: null, confirmations: 9n, blockNumber: 7n }));
        assert.equal(summary.rowErrors, 1, "黙って飲まない");
        assert.equal(summary.verified, 0);
        const r = await statusOf(id);
        assert.equal(r.status, "settle_claimed", "訂正の無い状態変化を作らない");
        assert.equal(r.settlementVerified, null, "次回のバッチがまた拾う");
      } finally {
        await db.execute(sql`DROP TRIGGER IF EXISTS cl_refuse_trg ON correction_log`);
      }
      await run(async () => ({ ok: true, blockTimestamp: null, confirmations: 9n, blockNumber: 7n }));
      assert.equal((await statusOf(id)).status, "settled", "再試行で確定する");
      assert.equal((await corrections(id)).length, 1);
    });

    await t.test("照合の理由だけの書き込み（status 不変）は公開の訂正ログに載せない（2026-09-29 独立レビュー）", async () => {
      await reset();
      const id = await seed("d1");
      const transient = async () => ({ ok: false, reason: "rpc_unavailable" }) as never;
      await run(transient);
      assert.equal((await statusOf(id)).settlementVerifyReason, "rpc_unavailable");
      assert.equal((await corrections(id)).length, 0, "一時的な理由の入れ替わりで /corrections を埋めない");
      await run(transient);
      assert.equal((await corrections(id)).length, 0);
    });

    await t.test("recoverLateSettlements: 貼り付けと訂正が同じ文（訂正が書けなければ貼らない）", async () => {
      const { recoverLateSettlements } = await import("@/lib/settlements/recover-late");
      await reset();
      const id = await seed("e1");
      await db.execute(sql`UPDATE x402_l1_purchases SET status = 'settle_failed', tx_hash = NULL WHERE id = ${id}::uuid`);
      const lateTx = "0x" + "e2".repeat(32);
      await db.insert(schema.settlements).values({
        chain: BASE,
        txHash: lateTx,
        purchaseId: `${BASE}:${lateTx}`,
        asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        amount: "1000",
        payer: PAYER,
        payee: PAY_TO,
        blockTime: new Date("2026-09-20T00:01:00Z"),
        source: "chain_index",
        attribution: "confirmed",
      });
      await db.execute(sql`CREATE TRIGGER cl_refuse_trg BEFORE INSERT ON correction_log FOR EACH ROW EXECUTE FUNCTION cl_refuse()`);
      try {
        await assert.rejects(recoverLateSettlements(), (e: unknown) =>
          /correction_log unwritable/.test(`${String(e)} ${String((e as { cause?: unknown }).cause)}`),
        );
        assert.equal((await statusOf(id)).status, "settle_failed", "訂正の無い貼り付けを作らない");
      } finally {
        await db.execute(sql`DROP TRIGGER IF EXISTS cl_refuse_trg ON correction_log`);
      }
      const r = await recoverLateSettlements();
      assert.equal(r.recovered, 1);
      assert.equal((await statusOf(id)).status, "settle_claimed");
      const c = await corrections(id);
      assert.equal(c.length, 1);
      assert.deepEqual(c[0].before, { status: "settle_failed", txHash: null });
      assert.deepEqual(c[0].after, { status: "settle_claimed", txHash: "0x" + "e2".repeat(32) });
    });
  });
}
