import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { sellerHostOfResourceKey } from "@/lib/sellers/host";
import { HOST_BADGE_WINDOW_DAYS } from "@/lib/sellers/reader";
import { answeredHttpPredicate } from "@/lib/observatory/delivery";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("readHostBadgeStats (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("readHostBadgeStats matches export.csv rules for a known host window", async () => {
    const { getDb } = await import("@/lib/db/client");
    const { readHostBadgeStats } = await import("@/lib/sellers/reader");
    const db = getDb();
    assert.ok(db);
    const raw = await db.execute(sql`
      SELECT e.resource_key, pu.status, pu.http_status_paid
      FROM x402_l1_purchases pu
      JOIN x402_endpoints e ON e.id = pu.endpoint_id
      WHERE pu.attempted_at >= now() - make_interval(days => ${HOST_BADGE_WINDOW_DAYS}::int)
        AND pu.status = 'settled'
      LIMIT 5000`);
    const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Record<string, unknown>[];
    const byHost = new Map<string, { settled: number; answered: number }>();
    for (const r of rows) {
      const h = sellerHostOfResourceKey(String(r.resource_key));
      const cur = byHost.get(h) ?? { settled: 0, answered: 0 };
      cur.settled++;
      const http = Number(r.http_status_paid);
      if (http >= 200 && http <= 299 && http !== 202) cur.answered++;
      byHost.set(h, cur);
    }
    const host = [...byHost.entries()].sort((a, b) => b[1].settled - a[1].settled)[0]?.[0];
    assert.ok(host, "need at least one host with settled rows in the test DB");
    const stats = await readHostBadgeStats(db, host);
    const direct = byHost.get(host)!;
    assert.equal(stats.settled, direct.settled);
    assert.equal(stats.answered, direct.answered);
    assert.match(answeredHttpPredicate("pu"), /settled/);
  });
}
