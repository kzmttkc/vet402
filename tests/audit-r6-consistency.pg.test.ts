// ============================================================
// 2026-09-29 監査 6 周目 7: anchors・coverage・history の日付を UTC で明示した。
//   - 本番（TimeZone=GMT）では旧い式と同じ行・同じ日を返す（計算結果は変わらない）
//   - 接続の TimeZone を変えても同じ行・同じ日を返す（旧い式は変わる——計器の確認）
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/audit-r6-consistency.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("audit r6 consistency pg (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("audit r6: 日付の境界は接続の TimeZone に依らない", async (t) => {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const schema = await import("@/lib/db/schema");
    const { canonicalDayPayload } = await import("@/lib/observatory/anchors");
    const { UTC_DAY_MINUS_7 } = await import("@/lib/observatory/coverage");
    const db = getDb()!;
    const rowsOf = (raw: unknown) =>
      (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];

    await db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases`);
    const endpointId = randomUUID();
    await db.insert(schema.x402Endpoints).values({
      id: endpointId,
      resourceKey: `GET https://seller.example/api/${endpointId}`,
      resourceUrl: `https://seller.example/api/${endpointId}`,
      method: "GET",
      payTo: "0x1111111111111111111111111111111111111111",
      network: "eip155:8453",
      status: "active",
      lastSeenAt: new Date(),
    } as typeof schema.x402Endpoints.$inferInsert);
    // 2026-08-20 の UTC 日に入る 3 行（東京の日付では 08-20 と 08-21 にまたがる）と、前後の日の 2 行
    for (const at of [
      "2026-08-19T23:59:59Z",
      "2026-08-20T00:00:00Z",
      "2026-08-20T14:59:59Z",
      "2026-08-20T18:00:00Z",
      "2026-08-21T00:00:00Z",
    ]) {
      await db.execute(sql`
        INSERT INTO x402_l1_purchases (endpoint_id, status, network, attempted_at, spent_units)
        VALUES (${endpointId}::uuid, 'settled', 'eip155:8453', ${at}::timestamptz, '0')`);
    }

    const inTz = <T>(tz: string, fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>) =>
      db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL TimeZone = '${tz}'`));
        return fn(tx);
      });

    await t.test("anchors: 新しい式は GMT で旧い式と同じ行、どの TimeZone でも同じ payload", async () => {
      const oldIds = (tz: string) =>
        inTz(tz, async (tx) =>
          rowsOf(
            await tx.execute(sql`
              SELECT pu.id::text AS id FROM x402_l1_purchases pu
              WHERE pu.attempted_at >= ${"2026-08-20"}::date AND pu.attempted_at < ${"2026-08-20"}::date + interval '1 day'
              ORDER BY pu.id`),
          ).map((r) => String(r.id)),
        );
      const payloads = new Map<string, string>();
      for (const tz of ["GMT", "UTC", "Asia/Tokyo", "America/Los_Angeles"]) {
        payloads.set(tz, (await inTz(tz, (tx) => canonicalDayPayload(tx, "2026-08-20"))).payload);
      }
      assert.equal(new Set(payloads.values()).size, 1, "TimeZone で anchor の payload が変わった");
      const newIds = (JSON.parse(payloads.get("GMT")!) as { rows: { id: string }[] }).rows.map((r) => r.id);
      assert.equal(newIds.length, 3);
      assert.deepEqual(newIds, await oldIds("GMT"), "本番の TimeZone（GMT）で旧い式と違う行を返した");
      // 計器の確認: 旧い式は Asia/Tokyo で別の行の集合を指す
      assert.notDeepEqual(await oldIds("Asia/Tokyo"), newIds);
    });

    await t.test("coverage: 7 日前の UTC 日は GMT で旧い式と同じ、どの TimeZone でも同じ", async () => {
      const vals = new Map<string, { neu: string; old: string }>();
      for (const tz of ["GMT", "UTC", "Asia/Tokyo", "Pacific/Kiritimati", "America/Los_Angeles"]) {
        const r = await inTz(tz, async (tx) =>
          rowsOf(await tx.execute(sql`SELECT ${UTC_DAY_MINUS_7} AS neu, (current_date - 7)::text AS old`))[0],
        );
        vals.set(tz, { neu: String(r.neu), old: String(r.old) });
      }
      assert.equal(new Set([...vals.values()].map((v) => v.neu)).size, 1, "TimeZone で 7 日前の日が変わった");
      assert.equal(vals.get("GMT")!.neu, vals.get("GMT")!.old, "本番の TimeZone（GMT）で旧い式と違う日を返した");
      const expected = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
      assert.equal(vals.get("GMT")!.neu, expected);
    });

    await t.test("history: 読み取り窓の起点（metrics-rollup）はもとから UTC を明示している", async () => {
      const src = (await import("node:fs")).readFileSync("src/lib/observatory/metrics-rollup.ts", "utf8");
      assert.ok(src.includes("to_char((now() AT TIME ZONE 'utc')::date - ${span}::int, 'YYYY-MM-DD')"));
      const days = new Set<string>();
      for (const tz of ["GMT", "Asia/Tokyo", "America/Los_Angeles"]) {
        const r = await inTz(tz, async (tx) =>
          rowsOf(await tx.execute(sql`SELECT to_char((now() AT TIME ZONE 'utc')::date - 7, 'YYYY-MM-DD') AS d`))[0],
        );
        days.add(String(r.d));
      }
      assert.equal(days.size, 1);
    });

    await db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases`);
  });
}
