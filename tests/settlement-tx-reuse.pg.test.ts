// ============================================================
// 2026-09-04 金の経路監査 P1-1 の DB 側: 決済 tx ハッシュの再利用。
//
// nonce 束縛（settlement-nonce-binding.test.ts）はチェーンの読み方の話。
// こちらは台帳の話——`x402_l1_purchases.tx_hash` に一意制約が無く、同じ tx を
// 何行にでも貼れた（本番 pg_indexes で確認・重複は現時点 0 件）。
//
// 守るもの:
//   1. 署名した nonce が行に残る（auth_nonce）——残っていなければ照合は
//      「我々の署名」と結びつけようがない;
//   2. 照合器はその nonce を verify へ渡す;
//   3. 同じ (network, lower(tx_hash)) が 2 行以上あれば、どちらも settled に
//      しない（どちらが本物か我々には言えない）——tx_hash_reused で refuted;
//   4. 部分一意 index が実在する（本番 DDL は scripts/sql/2026-09-04-w11.sql）。
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/settlement-tx-reuse.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("settlement tx reuse (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = TEST_DB;

  const PAY_TO = "0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea";
  const PAYER = "0x1111111111111111111111111111111111111111";
  const TX = `0x${"ab".repeat(32)}`;
  const NONCE = `0x${"7f".repeat(32)}`;

  test("決済 tx の再利用は settled にならない", async (t) => {
    const { runSettlementVerification } = await import("@/lib/observatory/settlement-verifier");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql, eq } = await import("drizzle-orm");
    const db = getDb()!;

    const seedEndpoint = async () => {
      const endpointId = randomUUID();
      await db.insert(schema.x402Endpoints).values({
        id: endpointId,
        resourceKey: `GET https://seller.example/api/${endpointId}`,
        resourceUrl: `https://seller.example/api/${endpointId}`,
        method: "GET",
        payTo: PAY_TO,
        network: "eip155:8453",
        status: "active",
        lastSeenAt: new Date(),
      });
      return endpointId;
    };

    const seedPurchase = async (endpointId: string, txHash: string | null, authNonce: string | null) => {
      const [row] = await db
        .insert(schema.x402L1Purchases)
        .values({
          endpointId,
          status: "settle_claimed",
          network: "eip155:8453",
          payTo: PAY_TO,
          payer: PAYER,
          amountUnits: "1000",
          spentUnits: "1000",
          txHash,
          authNonce,
          httpStatusPaid: 200,
          payloadNonEmpty: true,
          l2Schema: "no_declaration",
        })
        .returning();
      return row.id;
    };

    const truncate = () =>
      db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases, observed_purchases, settlements, correction_log`);

    await t.test("auth_nonce は照合器から verify へ渡る", async () => {
      await truncate();
      const endpointId = await seedEndpoint();
      await seedPurchase(endpointId, TX, NONCE);
      const seen: (string | null | undefined)[] = [];
      await runSettlementVerification({
        deps: {
          verify: async (input) => {
            seen.push(input.expectedAuthNonce);
            return { ok: false, reason: "tx_not_found" };
          },
          registryHooks: { l1: async () => {}, l2: async () => {} },
        },
      });
      assert.deepEqual(seen, [NONCE], "署名した nonce が照合へ渡っていない");
    });

    await t.test("同じ tx を 2 行が主張していれば、どちらも tx_hash_reused で refuted", async () => {
      await truncate();
      const a = await seedEndpoint();
      const b = await seedEndpoint();
      // 一意 index が入るのは 2026-09-04 以降。**それ以前に書かれた行**は
      // 重複し得るので、index を外して当時の形を再現する（照合器は index が
      // 無い過去のデータに対しても正しく振る舞わなければならない）。
      await db.execute(sql`DROP INDEX IF EXISTS x402_l1_purchases_tx_unique`);
      const idA = await seedPurchase(a, TX, null);
      await db.execute(sql`
        INSERT INTO x402_l1_purchases (endpoint_id, status, network, pay_to, payer, amount_units, spent_units, tx_hash)
        VALUES (${b}::uuid, 'settle_claimed', 'eip155:8453', ${PAY_TO}, ${PAYER}, '1000', '1000', ${TX})
      `);

      let verifyCalls = 0;
      const summary = await runSettlementVerification({
        deps: {
          verify: async () => {
            verifyCalls++;
            return { ok: true, blockTimestamp: null, confirmations: 99n, blockNumber: 1n };
          },
          registryHooks: { l1: async () => {}, l2: async () => {} },
        },
      });

      assert.equal(verifyCalls, 0, "重複 tx でチェーンを読みに行っている（読む前に落とす）");
      assert.equal(summary.refuted, 2);
      const rows = await db
        .select()
        .from(schema.x402L1Purchases)
        .where(eq(schema.x402L1Purchases.id, idA));
      assert.equal(rows[0].status, "settle_claim_refuted");
      assert.match(String(rows[0].settlementVerifyReason), /tx_hash_reused/);

      // 外した index を戻す（次の検査が本番と同じ形を見るように）。
      await truncate();
      await db.execute(sql`
        CREATE UNIQUE INDEX IF NOT EXISTS x402_l1_purchases_tx_unique
          ON x402_l1_purchases (network, lower(tx_hash)) WHERE tx_hash IS NOT NULL
      `);
    });

    await t.test("(network, lower(tx_hash)) の部分一意 index が実在する", async () => {
      const raw = await db.execute(sql`
        SELECT indexdef FROM pg_indexes
        WHERE tablename = 'x402_l1_purchases' AND indexname = 'x402_l1_purchases_tx_unique'
      `);
      const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as { indexdef: string }[];
      assert.equal(rows.length, 1, "部分一意 index が無い");
      assert.match(rows[0].indexdef, /UNIQUE/i);
      assert.match(rows[0].indexdef, /lower\(tx_hash\)/i);
      assert.match(rows[0].indexdef, /WHERE \(tx_hash IS NOT NULL\)/i);
    });
  });
}
