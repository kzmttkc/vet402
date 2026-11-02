// ============================================================
// /api/tokyo の IP ごとの枠（_lib/rate-limit.ts）を本物の Postgres で。TEST_DATABASE_URL が無ければ skip。
// 同時に投げても上限を越えて通らない・窓が切れたら数え直す・鍵に IP を入れない。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("tokyo rate limit DB (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("tokyo rate limit: 同時でも上限まで・窓が切れたら数え直す・IP を保存しない", async () => {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { tokyoRateLimit } = await import("@/app/api/tokyo/_lib/rate-limit");
    const db = getDb()!;
    const rule = { bucket: `tokyo-rl-test-${Date.now()}`, limit: 5 };
    const ip = "203.0.113.50";
    const req = () => new Request("http://localhost/api/tokyo/state", { headers: { "x-vercel-forwarded-for": ip } });

    const results = await Promise.all(Array.from({ length: 12 }, () => tokyoRateLimit(req(), rule)));
    assert.equal(results.filter((r) => r === null).length, 5);
    assert.equal(results.filter((r) => r?.status === 429).length, 7);

    const raw = await db.execute(sql`SELECT bucket_key, count FROM ip_rate_limits WHERE bucket_key LIKE ${`${rule.bucket}:%`}`);
    const rows = ((raw as { rows?: unknown[] }).rows ?? raw) as { bucket_key: string; count: number | string }[];
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].count), 12);
    assert.ok(!rows[0].bucket_key.includes(ip), "IP そのものを保存しない");

    await db.execute(sql`UPDATE ip_rate_limits SET reset_at = now() - interval '1 second' WHERE bucket_key = ${rows[0].bucket_key}`);
    assert.equal(await tokyoRateLimit(req(), rule), null, "窓が切れたら数え直す");
    const after = await db.execute(sql`SELECT count, reset_at > now() AS live FROM ip_rate_limits WHERE bucket_key = ${rows[0].bucket_key}`);
    const row = (((after as { rows?: unknown[] }).rows ?? after) as { count: number | string; live: boolean }[])[0];
    assert.equal(Number(row.count), 1);
    assert.equal(row.live, true);
    await db.execute(sql`DELETE FROM ip_rate_limits WHERE bucket_key = ${rows[0].bucket_key}`);
  });
}
