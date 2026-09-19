// ============================================================
// cron /api/cron/verify-settlements — 行の失敗は **非 200** で鳴らす（2026-09-19 レビュー 3 巡目）。
//
// なぜ非 200 でなければならないか: 監視（Takeshi_Automation/scripts/vet402_verify_settlements.py）は
// 例外と非 200 のときだけ ALERTS に書く。`{ ok: false }` を 200 で返すと、全行が失敗していても無音になる。
// しかも対象の SELECT は `ORDER BY attempted_at ASC LIMIT 200` なので、落ちた行は
// settlement_verified が NULL のまま毎回先頭に居座り、後ろの行が永久に照合されない——`settled` を
// 名乗らせる唯一の経路なので、公開台帳が settle_claimed で凍結したまま誰も気づかない。
// 行ごとの try/catch（summary.rowErrors）を入れた差分は、ここで 500 に変えなければ fail-loud を
// fail-silent に置き換えることになる。
//
// 1 行の失敗は DB 側の例外で作る（catch が実際に受け止める失敗クラスそのもの）。
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/cron-verify-settlements-row-errors.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";
import { randomUUID } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("cron verify-settlements row errors (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const CHAIN = "eip155:8453";

  test("行の失敗は 500 + 件数、失敗が無ければ 200 ok:true", async (t) => {
    const { GET } = await import("@/app/api/cron/verify-settlements/route");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;

    const savedSecret = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "test-cron-secret";
    t.after(async () => {
      if (savedSecret === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = savedSecret;
      await db.execute(sql`DROP TRIGGER IF EXISTS test_fail_one_row ON x402_l1_purchases`);
      await db.execute(sql`DROP FUNCTION IF EXISTS test_fail_one_row()`);
    });

    await db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases, observed_purchases, settlements, correction_log, job_leases`);

    /**
     * pay_to を空にしておくと照合器は「我々が何を期待したか言えない」経路（expected_values_missing）で
     * UPDATE だけを出す——チェーンも RPC も要らないので、行ごとの失敗を決定的に作れる。
     */
    const seedPurchase = async (txHash: string, attemptedAt: Date) => {
      const endpointId = randomUUID();
      await db.insert(schema.x402Endpoints).values({
        id: endpointId,
        resourceKey: `GET https://seller.example/api/${endpointId}`,
        resourceUrl: `https://seller.example/api/${endpointId}`,
        method: "GET",
        payTo: "0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea",
        network: CHAIN,
        status: "active",
        lastSeenAt: new Date(),
      });
      const [row] = await db
        .insert(schema.x402L1Purchases)
        .values({ endpointId, status: "settle_claimed", network: CHAIN, payTo: null, payer: null, amountUnits: null, spentUnits: "1000", txHash, attemptedAt })
        .returning();
      return row.id;
    };
    const call = async () => {
      const res = await GET(
        new Request("http://localhost/api/cron/verify-settlements", { headers: { authorization: "Bearer test-cron-secret" } }) as never,
      );
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };

    const t0 = new Date("2026-09-18T10:00:00Z");
    const failing = await seedPurchase(`0x${"f1".repeat(32)}`, t0);
    await seedPurchase(`0x${"f2".repeat(32)}`, new Date(t0.getTime() + 1000));

    // 関数本体にプレースホルダは使えないので、生成した uuid を DDL の文字列へそのまま埋める
    // （値は我々が randomUUID で作ったもの。形は下の assert で確かめる）。
    assert.match(failing, /^[0-9a-f-]{36}$/);
    await db.execute(
      sql.raw(`
      CREATE FUNCTION test_fail_one_row() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.id = '${failing}'::uuid THEN RAISE EXCEPTION 'simulated row failure'; END IF;
        RETURN NEW;
      END
      $fn$
    `),
    );
    await db.execute(sql`CREATE TRIGGER test_fail_one_row BEFORE UPDATE ON x402_l1_purchases FOR EACH ROW EXECUTE FUNCTION test_fail_one_row()`);

    await t.test("1 行でも失敗したら HTTP 500 で、本文に件数が乗る（監視が ALERTS に書ける）", async () => {
      const { status, body } = await call();
      assert.equal(status, 500, "200 で返すと監視が無音になる");
      assert.equal(body.ok, false);
      assert.equal(body.error, "row_errors");
      assert.equal(body.rowErrors, 1, "件数が本文に無いと ALERTS の抜粋に数字が乗らない");
      assert.equal(body.scanned, 2, "落ちた行で残りの行まで止めていない");
      assert.equal(body.deferred, 1, "2 行目は従来どおり処理される");
    });

    await t.test("失敗が無ければ 200 で ok:true（従来のまま）", async () => {
      await db.execute(sql`DROP TRIGGER test_fail_one_row ON x402_l1_purchases`);
      const { status, body } = await call();
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.rowErrors, 0);
      assert.equal(body.scanned, 2);
      assert.equal(body.deferred, 2);
    });
  });
}
