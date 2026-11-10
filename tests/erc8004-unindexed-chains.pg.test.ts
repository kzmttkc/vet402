// ============================================================
// 要件 3.10（2026-11-10）の行 5 を実 DB で固定する: Ethereum・BNB Chain の索引の照合は
// アドレスの完全一致だけ（名前の近さ・1 桁違いは一致しない）。読めない鎖は unavailable。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_erc8004_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/erc8004-unindexed-chains.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("erc8004 chain match SQL (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("erc8004 chain match: exact owner or agentWallet equality only, per chain", async () => {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { readErc8004Match } = await import("@/lib/observatory/erc8004-match");
    const { applyErc8004ChainAgentChanges, erc8004ChainCheckpointScope } = await import("@/lib/db/erc8004-chain-index");
    const db = getDb()!;

    const owner = "0xabcdef0000000000000000000000000000000001";
    const nearMiss = "0xabcdef0000000000000000000000000000000002";
    const wallet = "0xabcdef0000000000000000000000000000000004";
    const endpoint = "00000000-0000-4000-8000-000000008005";

    await db.execute(sql`TRUNCATE x402_l1_purchases, owner_agents, agents, erc8004_chain_agents`);
    await db.execute(sql`DELETE FROM indexer_checkpoints WHERE scope LIKE 'identity_registry%'`);
    await db.execute(sql`INSERT INTO indexer_checkpoints (scope, last_block) VALUES ('identity_registry', 123)`);
    await db.execute(sql`INSERT INTO indexer_checkpoints (scope, last_block) VALUES (${erc8004ChainCheckpointScope("eip155:56")}, 61000000)`);

    // BNB Chain: agent 5 は owner が完全一致、agent 6 は 1 桁違い、agent 8 は agentWallet が一致。
    // agent 10 は燃やされた（行が消える）。Ethereum には索引の到達点が無い。
    await applyErc8004ChainAgentChanges(56, {
      owners: [
        { agentId: 5n, owner },
        { agentId: 6n, owner: nearMiss },
        { agentId: 8n, owner: "0xabcdef0000000000000000000000000000000009" },
        { agentId: 10n, owner },
      ],
      wallets: [{ agentId: 8n, wallet }],
      burned: [],
    });
    await applyErc8004ChainAgentChanges(56, { owners: [], wallets: [], burned: [10n] });
    // 同じ agentId でも別の鎖の行は数えない。
    await applyErc8004ChainAgentChanges(1, { owners: [{ agentId: 5n, owner }], wallets: [], burned: [] });

    await db.execute(sql`
      INSERT INTO x402_l1_purchases (endpoint_id, status, pay_to) VALUES
        (${endpoint}, 'settled', ${owner.toUpperCase().replace("0X", "0x")}),
        (${endpoint}, 'settled', ${wallet}),
        (${endpoint}, 'settled', '0xabcdef0000000000000000000000000000000003')
    `);

    const s = await readErc8004Match();
    assert.equal(s.status, "ok");
    if (s.status !== "ok") return;
    assert.deepEqual(s.byChain["eip155:56"], { status: "scanned", scannedAgents: 3, matchedAgents: 2, indexBlock: "61000000" });
    assert.deepEqual(s.byChain["eip155:1"], { status: "unavailable", reason: "index_not_started" });
    const bnb = s.matches.filter((m) => m.chainId === "eip155:56").map((m) => [m.agentId, m.payTo, m.matchKind]).sort();
    assert.deepEqual(bnb, [["5", owner, "owner"], ["8", wallet, "agent_wallet"]]);
    assert.equal(s.matches.some((m) => m.agentId === "6"), false, "a one-digit near miss never matches");
    assert.equal(s.matchedAgents, 0, "Base totals stay Base");
  });
}
