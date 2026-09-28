// ============================================================
// docs/metrics/pmf-funnel.sql（2026-09-28 PMF 計測）の定義を固定する。
// 自社の除外は実行時の一覧だけで決まり、キーの「使った」「2 週目も使った」は
// first_used_at / last_used_at から数える。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  test("pmf funnel sql (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("pmf funnel sql", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;
    const rowsOf = <T,>(raw: unknown) => (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows) as T[];
    const source = readFileSync(join(process.cwd(), "docs/metrics/pmf-funnel.sql"), "utf8");
    assert.ok(source.includes(":'self_emails'"));
    const run = async (selfEmails: string) => {
      const literal = `'${selfEmails.replace(/'/g, "''")}'`;
      const text = source.replace(":'self_emails'", literal);
      const r = rowsOf<Record<string, string | number>>(await db.execute(sql.raw(text)))[0];
      return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]));
    };

    await db.execute(sql`TRUNCATE api_keys, accounts`);
    const acc = rowsOf<{ id: string; email: string }>(
      await db.execute(sql`
        INSERT INTO accounts (email, plan, created_at) VALUES
          ('owner@self.test', 'pro', now() - interval '40 days'),
          ('alice@ext.test', 'free', now() - interval '30 days'),
          ('bob@ext.test', 'pro', now() - interval '2 days'),
          ('carol@ext.test', 'free', now() - interval '1 days')
        RETURNING id::text AS id, email
      `),
    );
    const id = (email: string) => acc.find((a) => a.email === email)!.id;
    await db.execute(sql`
      INSERT INTO api_keys (user_id, key_hash, created_at, first_used_at, last_used_at) VALUES
        (${id("owner@self.test")}::uuid, 'pmf-h1', now() - interval '40 days', now() - interval '39 days', now()),
        (${id("alice@ext.test")}::uuid,  'pmf-h2', now() - interval '30 days', now() - interval '29 days', now() - interval '3 days'),
        (${id("bob@ext.test")}::uuid,    'pmf-h3', now() - interval '2 days',  now() - interval '1 days',  now()),
        (${id("carol@ext.test")}::uuid,  'pmf-h4', now() - interval '1 days',  NULL, NULL),
        (NULL,                           'pmf-h5', now() - interval '1 days',  now(), now())
    `);

    const r = await run(" Owner@Self.test ,");
    assert.deepEqual(r, {
      external_accounts: 3,
      external_accounts_7d: 2,
      external_keys: 3,
      external_keys_7d: 2,
      external_keys_used: 2,
      external_keys_first_used_7d: 1,
      external_keys_week2: 1,
      paid_accounts: 1,
      self_emails_excluded: 1,
    });

    // 除外が空なら自社も外部として数える（除外は一覧だけで決まる）。
    const all = await run("");
    assert.equal(all.external_accounts, 4);
    assert.equal(all.paid_accounts, 2);
    assert.equal(all.external_keys_week2, 2);
    assert.equal(all.self_emails_excluded, 0);

    await db.execute(sql`TRUNCATE api_keys, accounts`);
  });
}
