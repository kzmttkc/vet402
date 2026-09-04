// ============================================================
// pg テストの TRUNCATE を本番へ向けない前段ガード（2026-09-04 監査 D・P2）。
//
// tests/*.pg.test.ts は TEST_DATABASE_URL を DATABASE_URL に入れて `TRUNCATE x402_endpoints,
// settlements, ...` から始まる。TEST_DATABASE_URL に本番（Neon）を入れた瞬間に観測台帳が消える。
// scripts/db-preflight.ts と同じ規則（ホストが *.neon.tech なら拒否）を共通 helper に置き、
// 全 pg テストが TRUNCATE より前にこれを通る。
// ============================================================
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

test("Neon ホストは拒否する（本番 vouch も別 database の neondb も）", () => {
  for (const url of [
    "postgresql://u:p@ep-odd-glade-ajpk06c8-pooler.c-3.us-east-2.aws.neon.tech/vouch?sslmode=require",
    "postgresql://u:p@ep-odd-glade-ajpk06c8.c-3.us-east-2.aws.neon.tech/neondb",
  ]) {
    assert.throws(() => assertTestDatabaseIsNotProduction(url), /neon\.tech/, url);
  }
});

test("ローカル・CI の一時 DB は通す", () => {
  for (const url of [
    "postgres://takeshi@localhost:5432/vet402test",
    "postgres://vouch:vouch_dev@postgres:5432/vouch",
    "postgres://ci@127.0.0.1:5432/ci",
  ]) {
    assert.doesNotThrow(() => assertTestDatabaseIsNotProduction(url), url);
  }
});

test("URL として読めない値は拒否する（黙って通さない）", () => {
  assert.throws(() => assertTestDatabaseIsNotProduction("not a url"));
  assert.throws(() => assertTestDatabaseIsNotProduction(""));
});

test("TRUNCATE を持つ全 pg テストがガードを TRUNCATE より前に呼ぶ", () => {
  const dir = join(process.cwd(), "tests");
  const files = readdirSync(dir).filter((f) => f.endsWith(".pg.test.ts"));
  assert.ok(files.length >= 10, `pg テストが少なすぎる: ${files.length}`);
  for (const f of files) {
    const src = readFileSync(join(dir, f), "utf8");
    // SQL 文としての TRUNCATE（テンプレート直後）。コメント中の語は対象にしない。
    const truncateAt = src.search(/`\s*TRUNCATE\b/);
    if (truncateAt < 0) continue;
    const guardAt = src.indexOf("assertTestDatabaseIsNotProduction(", src.indexOf("pg-test-guard\"") + 1);
    assert.ok(guardAt >= 0, `${f}: assertTestDatabaseIsNotProduction を呼んでいない`);
    assert.ok(guardAt < truncateAt, `${f}: ガードが TRUNCATE より後にある`);
  }
});
