// ============================================================
// api_keys.first_used_at（2026-09-28 PMF 計測）。
//   1. ALTER 適用前の行（旧コードが書いた行）を migration が埋める
//   2. scripts/sql/2026-09-28-api-keys-first-used.sql は既存行を last_used_at で埋め、再実行しても値を変えない
//   3. 適用後は初回だけ first_used_at が入り、2 回目以降は last_used_at だけが進む
//   4. verifyApiKey（認証の本線）がこの記帳を呼ぶ
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  test("api_keys first_used_at (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("api_keys first_used_at", async (t) => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { createApiKey, touchApiKeyUsage, verifyApiKey } = await import("@/lib/db/api-keys");
    const db = getDb()!;
    const rowsOf = <T,>(raw: unknown) => (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows) as T[];
    const migration = readFileSync(join(process.cwd(), "scripts/sql/2026-09-28-api-keys-first-used.sql"), "utf8");
    const created: string[] = [];

    const read = async (id: string) =>
      rowsOf<{ first: string | null; last: string | null }>(
        await db.execute(sql`
          SELECT first_used_at::text AS first, last_used_at::text AS last FROM api_keys WHERE id = ${id}::uuid
        `),
      )[0];

    // 適用前の DB を再現する（専用テスト DB の中だけ。最後に migration で戻す）。
    // 旧コードの行は first_used_at を持たないので、生の SQL で入れる。
    await db.execute(sql`ALTER TABLE api_keys DROP COLUMN IF EXISTS first_used_at`);

    try {
      const legacy = rowsOf<{ id: string }>(
        await db.execute(sql`
          INSERT INTO api_keys (name, key_hash, last_used_at)
          VALUES ('first-used-test:used', 'first-used-test-hash-1', '2026-09-01T00:00:00Z'),
                 ('first-used-test:unused', 'first-used-test-hash-2', NULL)
          RETURNING id::text AS id
        `),
      );
      const used = { id: legacy[0].id };
      const unused = { id: legacy[1].id };
      created.push(used.id, unused.id);

      await t.test("migration は既存行を last_used_at で埋め、未使用は NULL のまま", async () => {
        await db.execute(sql.raw(migration));
        const u = await read(used.id);
        assert.notEqual(u.first, null);
        assert.equal(u.first, u.last);
        assert.equal((await read(unused.id)).first, null);
      });

      await t.test("migration の再実行で既存の first_used_at は変わらない", async () => {
        const before = (await read(used.id)).first;
        await db.execute(sql`UPDATE api_keys SET last_used_at = '2026-09-20T00:00:00Z' WHERE id = ${used.id}::uuid`);
        await db.execute(sql.raw(migration));
        assert.equal((await read(used.id)).first, before);
      });

      await t.test("初回だけ first_used_at が入り、2 回目は last_used_at だけ進む", async () => {
        await touchApiKeyUsage(unused.id, new Date("2026-09-10T00:00:00Z"));
        const first = await read(unused.id);
        assert.notEqual(first.first, null);
        assert.equal(first.first, first.last);

        await touchApiKeyUsage(unused.id, new Date("2026-09-17T00:00:00Z"));
        const second = await read(unused.id);
        assert.equal(second.first, first.first);
        assert.notEqual(second.last, first.last);
        assert.ok(Date.parse(second.last!) > Date.parse(second.first!));
      });

      await t.test("verifyApiKey の認証成功で first_used_at が入る", async () => {
        const fresh = await createApiKey({ name: "first-used-test:verify" });
        created.push(fresh.id);
        assert.equal((await read(fresh.id)).first, null);
        const rec = await verifyApiKey(fresh.key);
        assert.equal(rec?.id, fresh.id);
        // verifyApiKey は記帳を待たない（応答を遅らせない）ので、書き込みを短く待つ。
        let row = await read(fresh.id);
        for (let i = 0; i < 50 && row.first === null; i++) {
          await new Promise((r) => setTimeout(r, 20));
          row = await read(fresh.id);
        }
        assert.notEqual(row.first, null);
        assert.equal(row.first, row.last);
      });

      await t.test("認証に失敗したトークンでは何も書かない", async () => {
        const other = await createApiKey({ name: "first-used-test:reject" });
        created.push(other.id);
        assert.equal(await verifyApiKey(`${other.key}x`), null);
        await new Promise((r) => setTimeout(r, 100));
        assert.equal((await read(other.id)).first, null);
      });
    } finally {
      await db.execute(sql.raw(migration));
      for (const id of created) await db.execute(sql`DELETE FROM api_keys WHERE id = ${id}::uuid`);
    }
  });
}
