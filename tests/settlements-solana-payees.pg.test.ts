// ============================================================
// §7.2 Solana 決済索引の受取人の読み出し（listSolanaPayees・2026-09-15）。
//
// 実 DB で SQL を通す（jsonb の横結合と UNION は偽物の DB では検査できない）。
//  - カタログの**全 accept** から Solana の受取人を取る（先頭が Base でも落とさない）
//  - v1 スラグ（solana）と CAIP-2 の両方を拾い、devnet・EVM・delisted は拾わない
//  - カタログ外の discovery は 14 日以内のものだけ
//  - x402_discovery_payees が無い DB でも落ちず、カタログだけで返す
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/settlements-solana-payees.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("solana payees (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("listSolanaPayees", async (t) => {
    const { Keypair } = await import("@solana/web3.js");
    const { listSolanaPayees, SOLANA_CHECKPOINT_SCOPE_PREFIX } = await import("@/lib/settlements/index-solana");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;
    const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
    const k = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(60 + n)).publicKey.toBase58();

    const ensureTable = () =>
      db.execute(sql`CREATE TABLE IF NOT EXISTS x402_discovery_payees (
        chain text NOT NULL, pay_to text NOT NULL, source text NOT NULL,
        first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (chain, pay_to, source))`);
    t.after(() => ensureTable());

    async function seedEndpoints() {
      await db.execute(sql`TRUNCATE x402_endpoints CASCADE`);
      await db.execute(sql`DELETE FROM indexer_checkpoints WHERE scope LIKE 'settlements:solana%'`);
      const ep = (key: string, network: string | null, payTo: string | null, accepts: unknown, status = "active") =>
        db.execute(sql`INSERT INTO x402_endpoints (resource_key, resource_url, source, network, pay_to, raw_accepts, status)
          VALUES (${key}, ${"https://" + key}, 'cdp_bazaar', ${network}, ${payTo}, ${JSON.stringify(accepts)}::jsonb, ${status})`);
      // 1: Base が先頭・Solana が 2 番目（先頭だけ保存する取り込みが落としていた形）
      await ep("a.example/x", "eip155:8453", "0x1111111111111111111111111111111111111111", [
        { network: "eip155:8453", payTo: "0x1111111111111111111111111111111111111111" },
        { network: SOL, payTo: k(1) },
      ]);
      // 2: v1 スラグ
      await ep("b.example/x", "solana", k(2), [{ network: "solana", payTo: k(2) }]);
      // 3: CAIP-2 が先頭（従来も拾えていた形）
      await ep("c.example/x", SOL, k(3), [{ network: SOL, payTo: k(3) }]);
      // 拾わない: devnet / Solana 網に置かれた 0x / delisted
      await ep("d.example/x", "solana-devnet", k(4), [{ network: "solana-devnet", payTo: k(4) }]);
      await ep("e.example/x", "solana", "0xdead", [{ network: "solana", payTo: "0xdead" }]);
      await ep("f.example/x", SOL, k(6), [{ network: SOL, payTo: k(6) }], "delisted");
      // raw_accepts が配列でない行でも落ちない
      await db.execute(sql`INSERT INTO x402_endpoints (resource_key, resource_url, source, network, pay_to, raw_accepts, status)
        VALUES ('g.example/x', 'https://g.example/x', 'cdp_bazaar', NULL, NULL, '{"not":"array"}'::jsonb, 'active')`);
    }

    await t.test("カタログの全 accept と discovery（14 日以内）を合わせ、重複しない", async () => {
      await ensureTable();
      await seedEndpoints();
      await db.execute(sql`TRUNCATE x402_discovery_payees`);
      await db.execute(sql`INSERT INTO x402_discovery_payees (chain, pay_to, source, last_seen_at) VALUES
        (${SOL}, ${k(7)}, 'payai_facilitator', now()),
        (${SOL}, ${k(3)}, 'payai_facilitator', now()),
        (${SOL}, ${k(8)}, 'payai_facilitator', now() - interval '30 days')`);
      await db.execute(sql`INSERT INTO indexer_checkpoints (scope, last_block, updated_at)
        VALUES (${SOLANA_CHECKPOINT_SCOPE_PREFIX + k(1)}, 0, now())`);
      const rows = await listSolanaPayees(db);
      const got = rows.map((r) => r.payTo).sort();
      assert.deepEqual(got, [k(1), k(2), k(3), k(7)].sort(), "1(2番目の accept)・2(v1)・3(CAIP-2)・7(discovery)。3 は重複しない、8 は古い");
      assert.ok(rows.find((r) => r.payTo === k(1))!.checkpointUpdatedAt instanceof Date, "新しい scope のチェックポイントを結合する");
      assert.equal(rows.find((r) => r.payTo === k(2))!.checkpointUpdatedAt, null);
    });

    await t.test("x402_discovery_payees が無い DB でもカタログだけで返す", async () => {
      await seedEndpoints();
      await db.execute(sql`DROP TABLE IF EXISTS x402_discovery_payees`);
      const rows = await listSolanaPayees(db);
      assert.deepEqual(rows.map((r) => r.payTo).sort(), [k(1), k(2), k(3)].sort());
    });
  });
}
