// ============================================================
// vet402 — 所有者索引の書き込みは「残す行の upsert を全部書き終えてから、消す文を始める」（2026-10-31 レビュー M-1）。
//
// 初版の applyOwnerAgentChanges は upsert の束と delete の束を同じ並びで 4 本並列に流していた。
// 別の束の upsert が落ちても delete は走るので、レビューは実 DB で次を再現した:
//   agent 42 に (A,42) がある → ownerOf が答えず Transfer A→B → (A,42) を消し (B,42) を書く変更
//   → B の INSERT だけ落とすトリガー → agent 9042 の行が 0 本（実在のエージェントが候補から消える＝fail-open）。
// ここでは同じ形を、本物の並列の書き込み（applyOwnerAgentChanges そのもの）と、B の INSERT だけを落とす
// トリガー（(B, 9042) の INSERT だけを拒む）で作り、消す文が 1 つも走らないことを確かめる。DB は TEST_DATABASE_URL の実 Postgres。
// ============================================================
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : "TEST_DATABASE_URL not set";

const A = `0x${"a".repeat(40)}` as Address;
const B = `0x${"b".repeat(40)}` as Address;
const C = `0x${"c".repeat(40)}` as Address;
const D = `0x${"d".repeat(40)}` as Address;

before(async () => {
  if (!TEST_DB) return;
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;
});

after(async () => {
  if (!TEST_DB) return;
  const { getDb } = await import("@/lib/db/client");
  const { sql } = await import("drizzle-orm");
  const db = getDb()!;
  await db.execute(sql`DROP TRIGGER IF EXISTS owner_agents_refuse_b ON owner_agents`);
  await db.execute(sql`DROP FUNCTION IF EXISTS owner_agents_refuse_b()`);
});

async function rows(): Promise<string[]> {
  const { getDb } = await import("@/lib/db/client");
  const { sql } = await import("drizzle-orm");
  const res = await getDb()!.execute(sql`SELECT owner, agent_id::text AS id FROM owner_agents WHERE agent_id IN (9042, 9043)`);
  const list = (Array.isArray(res) ? res : (res as { rows: unknown[] }).rows) as { owner: string; id: string }[];
  return list.map((r) => `${r.owner}:${r.id}`).sort();
}

test("one upsert batch failing midway lets no delete run: the agent keeps its row instead of dropping to zero", { skip }, async () => {
  const { getDb } = await import("@/lib/db/client");
  const { sql } = await import("drizzle-orm");
  const { applyOwnerAgentChanges } = await import("@/lib/db/owner-index-writer");
  const { ownerChangesForSegment } = await import("@/lib/indexer/owner-indexer");
  const db = getDb()!;

  // このファイルの行は agent 9042・9043 だけ（owner-index-budget.pg.test.ts は agent_id < 1000。並列でも混ざらない）。
  await db.execute(sql`DELETE FROM owner_agents WHERE agent_id IN (9042, 9043)`);
  await db.execute(sql`DROP TRIGGER IF EXISTS owner_agents_refuse_b ON owner_agents`);
  await db.execute(sql.raw(`
    CREATE OR REPLACE FUNCTION owner_agents_refuse_b() RETURNS trigger AS $$
    BEGIN
      -- 少し待ってから落とす: 並べて流した他の束（delete）が先に走れる時間を作る（初版の穴を確実に踏む）。
      -- 拒むのは (B, 9042) だけ: 他の pg テストがファイル並列で同じ表に書いても巻き込まない（再レビュー N-2）。
      IF NEW.owner = '${B}' AND NEW.agent_id = 9042 THEN PERFORM pg_sleep(0.3); RAISE EXCEPTION 'refuse insert for B'; END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`));
  await db.execute(sql`
    CREATE TRIGGER owner_agents_refuse_b BEFORE INSERT ON owner_agents
    FOR EACH ROW EXECUTE FUNCTION owner_agents_refuse_b()`);

  // 元の行: (A,9042)・(C,9043)・(D,9043)（レビューの再現の agent 42・43 と同じ形）。
  await db.execute(sql`
    INSERT INTO owner_agents (owner, agent_id) VALUES (${A}, 9042), (${C}, 9043), (${D}, 9043)`);

  // 9042: ownerOf が答えない → イベントだけで A→B（(A,9042) を消し (B,9042) を書く）。
  // 9043: ownerOf = D → C→D で行を全部消して (D,9043) だけ残す（wipe の delete）。
  const { changes } = ownerChangesForSegment(
    [],
    [
      { args: { tokenId: 9042n, from: A, to: B }, blockNumber: 10n, logIndex: 0 },
      { args: { tokenId: 9043n, from: C, to: D }, blockNumber: 10n, logIndex: 1 },
    ],
    new Map<string, Address | null | "unavailable">([
      ["9042", "unavailable"],
      ["9043", D],
    ]),
  );
  // 本物の書き手が並列で流す束が、upsert・組の delete・wipe の delete に分かれていること（前提の確認）。
  assert.ok(changes.upserts.length >= 2 && changes.deletePairs.length === 1 && changes.wipe.length === 1);

  await assert.rejects(applyOwnerAgentChanges(changes), (error: { message?: string; cause?: { message?: string } }) =>
    /refuse insert for B/.test(`${error?.message} ${error?.cause?.message}`),
  );

  const after = await rows();
  assert.ok(after.includes(`${A}:9042`), `(A,9042) が消された — upsert の段が終わる前に消す文が走った: ${after.join(" ")}`);
  assert.ok(after.includes(`${C}:9043`), `(C,9043) が消された — wipe の delete が走った: ${after.join(" ")}`);
  assert.ok(after.some((r) => r.endsWith(":9042")), "agent 9042 の行が 0 本（fail-open）");

  // トリガーを外して書き直すと、正しい最終形になる（次の回が同じ区切りを読み直したのと同じ）。
  await db.execute(sql`DROP TRIGGER owner_agents_refuse_b ON owner_agents`);
  await applyOwnerAgentChanges(changes);
  assert.deepEqual(await rows(), [`${B}:9042`, `${D}:9043`].sort());
});
