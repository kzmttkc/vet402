// ============================================================
// 2026-09-04 金の経路監査 P2: 日次予算の日境界が session TimeZone に依存していた。
//
// `attempted_at >= date_trunc('day', now() AT TIME ZONE 'utc')` は、右辺が
// **naive timestamp**（UTC の深夜という「壁時計の値」）なので、timestamptz と
// 比べる瞬間に session の TimeZone で解釈される。つまり接続の TimeZone が
// 変わるだけで「今日」がずれ、日次 $25 の窓が最大 1 日ぶん重なるか空く。
//
// ローカルの test DB で実測（2026-09-04）:
//   TimeZone=UTC               → 2026-09-04 00:00+00
//   TimeZone=Asia/Tokyo        → 2026-09-04 00:00+09  （= 09-03 15:00 UTC）
//   TimeZone=America/Los_Angeles → 2026-09-04 00:00-07（= 09-04 07:00 UTC）
// 同じ SQL が 3 つの違う瞬間を指していた。
//
// 監査メモの `(now() AT TIME ZONE 'utc')::date AT TIME ZONE 'utc'` も**同じ理由で
// 直らない**——date は timestamptz へ暗黙変換されるので、Asia/Tokyo では
// 2026-09-03 06:00 UTC を指す（上と同じ手順で実測）。正しいのは
// `date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc'`——
// naive timestamp を timestamp のまま UTC と宣言して timestamptz へ戻す形。
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/utc-day-boundary.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("utc day boundary (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("UTC 日の始まりは session TimeZone を変えても同じ瞬間を指す", async () => {
    const { utcDayStart } = await import("@/lib/db/utc-day");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;

    const instants: string[] = [];
    for (const tz of ["UTC", "Asia/Tokyo", "America/Los_Angeles"]) {
      await db.execute(sql.raw(`SET TimeZone = '${tz}'`));
      const raw = await db.execute(sql`SELECT extract(epoch from ${utcDayStart()})::bigint AS epoch`);
      const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as {
        epoch: string | number;
      }[];
      instants.push(String(rows[0].epoch));
    }
    await db.execute(sql.raw("SET TimeZone = 'UTC'"));
    assert.equal(new Set(instants).size, 1, `TimeZone ごとに違う瞬間を指している: ${instants.join(" / ")}`);
  });

  test("旧い書き方は実際に TimeZone でずれる（この検査自体が計器の確認）", async () => {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;

    const instants: string[] = [];
    for (const tz of ["UTC", "Asia/Tokyo"]) {
      await db.execute(sql.raw(`SET TimeZone = '${tz}'`));
      const raw = await db.execute(
        sql`SELECT extract(epoch from (date_trunc('day', now() AT TIME ZONE 'utc'))::timestamptz)::bigint AS epoch`,
      );
      const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as {
        epoch: string | number;
      }[];
      instants.push(String(rows[0].epoch));
    }
    await db.execute(sql.raw("SET TimeZone = 'UTC'"));
    assert.equal(new Set(instants).size, 2, "旧い書き方がずれない——この検査は何も守っていない");
  });

  test("予算の日境界を書いている場所は全部この 1 つの式を使う", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const path of [
      ["src", "lib", "observatory", "l1-runner.ts"],
      ["src", "lib", "chain", "registry.ts"],
    ]) {
      const source = readFileSync(join(process.cwd(), ...path), "utf8");
      assert.doesNotMatch(
        source,
        /date_trunc\('day', now\(\) AT TIME ZONE 'utc'\)(?! AT TIME ZONE)/i,
        `${path.join("/")} に session TimeZone 依存の日境界が残っている`,
      );
      assert.match(source, /utcDayStart\(\)/, `${path.join("/")} が共通の式を使っていない`);
    }
  });
}
