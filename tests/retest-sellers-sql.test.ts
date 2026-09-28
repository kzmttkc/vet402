// ============================================================
// retest の 1 段目（RETEST_SELLERS_SQL）と censusHostSql の置き場所（src/lib/observatory/retest-sellers-sql.ts）。
// l1-runner から文を変えずに移した。l1-runner が同じもの（同じオブジェクト）を使い、置き場所が支払いの
// 依存を持たないことを固定する。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

test("l1-runner の RETEST_SELLERS_SQL は retest-sellers-sql.ts のものと同じ", async () => {
  const runner = await import("@/lib/observatory/l1-runner");
  const mod = await import("@/lib/observatory/retest-sellers-sql");
  assert.equal(runner.RETEST_SELLERS_SQL, mod.RETEST_SELLERS_SQL);
  const d = new PgDialect();
  assert.equal(d.sqlToQuery(mod.censusHostSql(sql`e.resource_key`)).sql, `lower(regexp_replace(split_part(e.resource_key, '/', 1), ':[0-9]+$', ''))`);
});

test("retest-sellers-sql.ts は支払いの依存を import しない", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/observatory/retest-sellers-sql.ts"), "utf8");
  const imports = [...src.matchAll(/^import[^;]*from "([^"]+)";/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ["./delivery", "./request-body", "./request-query", "drizzle-orm"]);
});
