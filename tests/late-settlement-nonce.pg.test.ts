// ============================================================
// 遅延回収の曖昧さを、レシートの EIP-3009 nonce で解く（2026-09-29 敵対的監査・penny402.fun）。
//
// 本番の形: 同じ payer から同じ payTo へ 2500 単位の購入が 16 秒違いで 2 行（koan 00:02:08・tarot 00:02:24）、
// 着金も 2 本（00:02:11 と 00:02:27）。索引（settlements）には nonce が無いので、どちらの tx も候補が 2 行で、
// 遅延回収はどちらにも貼らず、頁は「決済を確認できず」と書いていた。
//
// 固定すること:
//   - 読み手（readNonces）を渡せば、tx ごとに nonce が一致する 1 行だけへ貼る（逆の組にはしない）
//   - 読み手を渡さなければ従来どおり貼らない（推定しない）
//   - 読めない・一致が 0 行・auth_nonce が無い行は貼らない
//   - 貼った行は settle_claimed（照合器が改めて決める）で、matchedBy と訂正ログが残る
//
// Run: TEST_DATABASE_URL=postgres:///vet402_observatory_test_attr \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/late-settlement-nonce.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("late settlement nonce link (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const PAY_TO = "0x9d0bb5da24cade855dee8d1231a1c416e0bb2ffe";
  const PAYER = "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670";
  const CHAIN = "eip155:8453";
  const NONCE_KOAN = "0x0d4612ff13aefe46297d19bdbdff5b7b80d5861eef13dfc868a24402fcbad9cc";
  const NONCE_TAROT = "0x3b4336ca6254e106d15ec1df1e86f853f0a18d80061b4171dafe9c01e82c3c11";
  const TX_A = "0x65862479c7dd2d101a501edd95ec39daa3683aee40e315dee21668f4baecd5f3"; // koan の nonce を消費
  const TX_B = "0xcebdcfd6d836334c32cddb48240e9d6a2714dbde300d56190dccd0a157044f9a"; // tarot の nonce を消費

  test("候補が 2 行の tx を、レシートの nonce で持ち主の 1 行に貼る", async (t) => {
    const { recoverLateSettlements } = await import("@/lib/settlements/recover-late");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql, eq } = await import("drizzle-orm");
    const db = getDb()!;

    const reset = () => db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases, settlements, correction_log`);
    const seedEndpoint = async (name: string) => {
      const id = randomUUID();
      await db.insert(schema.x402Endpoints).values({
        id,
        resourceKey: `penny.example/${name}-${id}`,
        resourceUrl: `https://penny.example/${name}`,
        method: "POST",
        payTo: PAY_TO,
        network: CHAIN,
        status: "active",
        lastSeenAt: new Date(),
      });
      return id;
    };
    const seedPurchase = async (endpointId: string, at: string, nonce: string | null) => {
      const [row] = await db
        .insert(schema.x402L1Purchases)
        .values({
          endpointId,
          status: "delivered_no_receipt",
          network: CHAIN,
          payTo: PAY_TO,
          payer: PAYER,
          amountUnits: "2500",
          spentUnits: "2500",
          attemptedAt: new Date(at),
          authNonce: nonce,
          httpStatusPaid: 200,
          txHash: null,
        })
        .returning();
      return row.id;
    };
    const seedSettlement = async (txHash: string, at: string) =>
      db.insert(schema.settlements).values({
        chain: CHAIN,
        txHash,
        purchaseId: `${CHAIN}:${txHash}`,
        asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        amount: "2500",
        payer: PAYER,
        payee: PAY_TO,
        blockTime: new Date(at),
        source: "chain_index",
        attribution: "confirmed",
      });
    const seedPenny = async (nonces: { koan: string | null; tarot: string | null } = { koan: NONCE_KOAN, tarot: NONCE_TAROT }) => {
      await reset();
      const koan = await seedPurchase(await seedEndpoint("koan"), "2026-09-28T00:02:08.350Z", nonces.koan);
      const tarot = await seedPurchase(await seedEndpoint("tarot"), "2026-09-28T00:02:24.125Z", nonces.tarot);
      await seedSettlement(TX_A, "2026-09-28T00:02:11Z");
      await seedSettlement(TX_B, "2026-09-28T00:02:27Z");
      return { koan, tarot };
    };
    const reads: string[] = [];
    const reader = async ({ txHash, payer }: { network: string; txHash: string; payer: string }) => {
      reads.push(txHash);
      assert.equal(payer.toLowerCase(), PAYER);
      if (txHash.toLowerCase() === TX_A) return [NONCE_KOAN];
      if (txHash.toLowerCase() === TX_B) return [NONCE_TAROT];
      return null;
    };
    const rowOf = async (id: string) => (await db.select().from(schema.x402L1Purchases).where(eq(schema.x402L1Purchases.id, id)))[0];

    await t.test("読み手なし: 従来どおりどちらにも貼らない", async () => {
      const { koan, tarot } = await seedPenny();
      const s = await recoverLateSettlements();
      assert.equal(s.recovered, 0);
      assert.equal(s.recoveredByNonce, 0);
      for (const id of [koan, tarot]) assert.equal((await rowOf(id)).status, "delivered_no_receipt");
    });

    await t.test("読み手あり: 各 tx を nonce の一致する行へ（時刻の近さで選ばない）", async () => {
      const { koan, tarot } = await seedPenny();
      reads.length = 0;
      const s = await recoverLateSettlements({ readNonces: reader });
      assert.equal(s.recovered, 2);
      assert.equal(s.recoveredByNonce, 2);
      assert.equal(reads.length, 2, "one receipt per ambiguous tx");
      const k = await rowOf(koan);
      const tr = await rowOf(tarot);
      assert.equal(k.status, "settle_claimed", "never settled before the verifier re-reads it");
      assert.equal(k.txHash, TX_A);
      assert.equal(tr.status, "settle_claimed");
      assert.equal(tr.txHash, TX_B);
      const late = (k.rawResponseMeta as Record<string, Record<string, unknown>>).lateSettlement;
      assert.equal(late.matchedBy, "authorization_nonce");
      assert.equal(late.priorStatus, "delivered_no_receipt");
      assert.equal(late.txHash, TX_A);
      const corr = await db.execute(sql`SELECT count(*)::int AS n FROM correction_log WHERE reason = 'settlement_backfill'`);
      const n = (Array.isArray(corr) ? corr : (corr as unknown as { rows: { n: number }[] }).rows)[0] as { n: number };
      assert.equal(n.n, 2);
      // もう一度流しても何も変わらない（候補が消えている）
      const again = await recoverLateSettlements({ readNonces: reader });
      assert.equal(again.recovered, 0);
    });

    await t.test("読めない（null）・一致 0 行・auth_nonce の無い行には貼らない", async () => {
      const { koan, tarot } = await seedPenny();
      assert.equal((await recoverLateSettlements({ readNonces: async () => null })).recovered, 0);
      assert.equal((await recoverLateSettlements({ readNonces: async () => [`0x${"99".repeat(32)}`] })).recovered, 0);
      assert.equal((await recoverLateSettlements({ readNonces: async () => { throw new Error("rpc"); } })).recovered, 0);
      for (const id of [koan, tarot]) assert.equal((await rowOf(id)).status, "delivered_no_receipt");
      // koan の nonce が無い: TX_A は誰にも貼らない。TX_B は tarot の nonce と一致するので tarot に貼る
      const r2 = await seedPenny({ koan: null, tarot: NONCE_TAROT });
      const s = await recoverLateSettlements({ readNonces: reader });
      assert.equal(s.recovered, 1);
      assert.equal((await rowOf(r2.koan)).status, "delivered_no_receipt");
      assert.equal((await rowOf(r2.tarot)).txHash, TX_B);
    });

    await t.test("1 本の tx が 2 行の nonce を両方消費している（あり得ない形）なら貼らない", async () => {
      const { koan, tarot } = await seedPenny();
      const s = await recoverLateSettlements({ readNonces: async () => [NONCE_KOAN, NONCE_TAROT] });
      assert.equal(s.recovered, 0);
      for (const id of [koan, tarot]) assert.equal((await rowOf(id)).status, "delivered_no_receipt");
    });
  });
}
