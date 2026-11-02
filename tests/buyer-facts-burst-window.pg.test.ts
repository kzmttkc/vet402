// ============================================================
// retry_burst_rate は窓の全行で数える（2026-11-02・監査 M1）。古い方の 2,000 行で切っていたので、新しい行にしか
// 再署名の無い payer は retry_burst を逃し、古い行だけに再署名のある payer は誤って BLOCK になっていた。
//
// Run: TEST_DATABASE_URL=postgres://localhost/<test db> \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/buyer-facts-burst-window.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  test("buyer facts burst window (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("retry_burst_rate: 2,000 行を超えても全行で数え、純関数の定義と一致する", async () => {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { loadBuyerFacts, retryBurstRate } = await import("@/lib/decision/buyer-facts");
    const { decidePayee } = await import("@/lib/decision/rules");
    const db = getDb()!;
    await db.execute(sql`TRUNCATE settlements, settlement_daily, funder_wallets`);

    const seed = async (payer: string, tag: string, rows: { n: number; resource: string | null; startMinAgo: number; stepSec: number }[]) => {
      for (const [i, r] of rows.entries()) {
        await db.execute(sql`
          INSERT INTO settlements (chain, tx_hash, purchase_id, asset, amount, payer, payee, payer_id, payee_id,
                                   resource_id, observed_at, block_time, attribution, wash_flag, source)
          SELECT 'eip155:8453', ${`0x${tag}${i}`} || g::text, ${`p-${tag}${i}-`} || g::text, '0xasset', '1000', '0xp', '0xq',
                 ${payer}, 'payee', ${r.resource},
                 now() - (${r.startMinAgo}::int * interval '1 minute') + (g * ${r.stepSec}::int * interval '1 second'),
                 now() - (${r.startMinAgo}::int * interval '1 minute') + (g * ${r.stepSec}::int * interval '1 second'),
                 'confirmed', 'none', 'chain_index'
          FROM generate_series(1, ${r.n}::int) g
        `);
      }
    };
    const rowsOfPayer = async (payer: string) => {
      const raw = await db.execute(sql`SELECT resource_id, coalesce(block_time, observed_at)::text AS at FROM settlements WHERE payer_id = ${payer}`);
      const rows = (Array.isArray(raw) ? raw : (raw as unknown as { rows: unknown[] }).rows) as { resource_id: string | null; at: string }[];
      return rows.map((r) => ({ resourceId: r.resource_id, at: new Date(r.at) }));
    };

    // 古い 2,000 行に再署名なし（10 分間隔）、新しい 1,500 行が 10 秒間隔。以前は 0 と読んだ。
    const lateBurst = "eip155:8453:0x00000000000000000000000000000000000000c1";
    await seed(lateBurst, "a", [
      { n: 2000, resource: "r1", startMinAgo: 25 * 24 * 60, stepSec: 600 },
      { n: 1500, resource: "r1", startMinAgo: 300, stepSec: 10 },
    ]);
    const a = await loadBuyerFacts(lateBurst);
    assert.ok(a.retry_burst_rate !== null && a.retry_burst_rate > 0.3, String(a.retry_burst_rate));
    assert.ok(Math.abs(a.retry_burst_rate! - retryBurstRate(await rowsOfPayer(lateBurst))!) < 1e-9, "純関数と一致");
    assert.ok(decidePayee(a, { now: new Date() }).reason_codes.includes("retry_burst"));

    // 古い 2,000 行が全部再署名、新しい 6,000 行は間隔あり。以前は 1.0 と読んで BLOCK。
    const earlyBurst = "eip155:8453:0x00000000000000000000000000000000000000c2";
    await seed(earlyBurst, "b", [
      { n: 2000, resource: "r2", startMinAgo: 25 * 24 * 60, stepSec: 10 },
      { n: 6000, resource: "r2", startMinAgo: 20 * 24 * 60, stepSec: 240 },
    ]);
    const b = await loadBuyerFacts(earlyBurst);
    assert.ok(b.retry_burst_rate !== null && b.retry_burst_rate < 0.3, String(b.retry_burst_rate));
    assert.ok(Math.abs(b.retry_burst_rate! - retryBurstRate(await rowsOfPayer(earlyBurst))!) < 1e-9, "純関数と一致");
    assert.ok(!decidePayee(b, { now: new Date() }).reason_codes.includes("retry_burst"));

    // resource の付かない行は分母に入れない。全部付かなければ null。
    const noResource = "eip155:8453:0x00000000000000000000000000000000000000c3";
    await seed(noResource, "c", [{ n: 5, resource: null, startMinAgo: 60, stepSec: 5 }]);
    assert.equal((await loadBuyerFacts(noResource)).retry_burst_rate, null);

    // 別の resource にまたがる間隔は数えない。
    const twoResources = "eip155:8453:0x00000000000000000000000000000000000000c4";
    await seed(twoResources, "d", [
      { n: 3, resource: "x", startMinAgo: 60, stepSec: 30 },
      { n: 2, resource: "y", startMinAgo: 60, stepSec: 90 },
    ]);
    assert.equal((await loadBuyerFacts(twoResources)).retry_burst_rate, 2 / 3);

    // ちょうど 60 秒は再署名に数え、61 秒は数えない（純関数の <= と同じ）。
    const exact = "eip155:8453:0x00000000000000000000000000000000000000c5";
    await seed(exact, "e", [{ n: 2, resource: "z60", startMinAgo: 60, stepSec: 60 }, { n: 2, resource: "z61", startMinAgo: 60, stepSec: 61 }]);
    assert.equal((await loadBuyerFacts(exact)).retry_burst_rate, 1 / 2);

    // 31 日前の行は窓の外なので数えない。窓の中の 2 行（間隔あり）だけで 0。
    const oldRow = "eip155:8453:0x00000000000000000000000000000000000000c6";
    await seed(oldRow, "f", [
      { n: 2, resource: "r31", startMinAgo: 31 * 24 * 60, stepSec: 10 },
      { n: 2, resource: "r31", startMinAgo: 120, stepSec: 600 },
    ]);
    assert.equal((await loadBuyerFacts(oldRow)).retry_burst_rate, 0, "31 日前の再署名を数えない");

    await db.execute(sql`TRUNCATE settlements, settlement_daily, funder_wallets`);
  });
}
