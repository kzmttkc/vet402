// ============================================================
// ERC-8004 段階 A の照合 SQL を実 DB で固定する（2026-11-08）。
//   1. owner 0xAbC… と pay_to 0xabc… は一致（大小を畳む）
//   2. 1 桁違いのアドレスは一致しない
//   3. agents が空なら agent_wallet の索引は空と注記し、0 件の走査として扱わない
//   4. 1 つの payTo が複数の agent を持っても、購入は 1 回だけ数える（SQL の合計）
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_erc8004_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/erc8004-match.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("erc8004 match SQL (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("erc8004 match: exact address equality only", async () => {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { readErc8004Match } = await import("@/lib/observatory/erc8004-match");
    const db = getDb()!;

    const owner = "0xabcdef0000000000000000000000000000000001";
    const nearMiss = "0xabcdef0000000000000000000000000000000002";
    const endpoint = "00000000-0000-4000-8000-000000008004";

    await db.execute(sql`TRUNCATE x402_l1_purchases, owner_agents, agents`);
    await db.execute(sql`DELETE FROM indexer_checkpoints WHERE scope = 'identity_registry'`);
    await db.execute(sql`INSERT INTO indexer_checkpoints (scope, last_block) VALUES ('identity_registry', 123)`);
    await db.execute(sql`INSERT INTO owner_agents (owner, agent_id) VALUES (${owner}, 7), (${owner}, 9), (${nearMiss}, 8)`);
    await db.execute(sql`
      INSERT INTO x402_l1_purchases (endpoint_id, status, pay_to) VALUES
        (${endpoint}, 'settled', ${owner.toUpperCase().replace("0X", "0x")}),
        (${endpoint}, 'settle_failed', ${owner}),
        (${endpoint}, 'settled', '0xabcdef0000000000000000000000000000000003')
    `);

    const s = await readErc8004Match();
    assert.equal(s.status, "ok");
    if (s.status !== "ok") return;
    assert.equal(s.scannedAgents, 3);
    assert.equal(s.matchedAgents, 2);
    assert.equal(s.matchedPayTo, 1);
    assert.equal(s.matchedPurchases, 2);
    assert.equal(s.matchedSettled, 1);
    assert.deepEqual(s.matches.map((m) => [m.agentId, m.payTo, m.matchKind]), [["7", owner, "owner"], ["9", owner, "owner"]]);
    assert.ok(s.notes.includes("agent_wallet index empty"));
    assert.equal(s.byChain["eip155:8453"].indexBlock, "123");
  });
}
