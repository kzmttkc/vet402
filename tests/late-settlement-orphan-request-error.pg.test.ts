// ============================================================
// 2026-09-29 会計監査 7 周目（高）: auth_nonce のある request_error を遅延回収の対象にする（recover-late.ts）。
//
// 孤児掃除（sweepOrphanedInFlight）は今日から auth_nonce のある in_flight 行を settle_failed へ倒すが、それより前に
// 掃除された行は request_error（reason = orphaned_in_flight）のまま残る。本番では 3 行が、チェーン上では 3〜4 秒後に
// 決済済みなのに、公開台帳では「払っていない」行のまま——審査員が export をチェーンと突き合わせると合わない。
//
// 守ること:
//  1. auth_nonce のある request_error は、索引に一致する着金が 1 本に決まれば settle_claimed へ貼る（settled は名乗らない）。
//     lateSettlement.priorStatus = request_error、訂正ログに before.status = request_error が残る。
//  2. spent_units は動かさない（予約・上限の合計は status を見ずに spent_units を足すので、回収の前後で同じ）。
//  3. auth_nonce の無い request_error（資格情報が外へ出ていない行）は、一致する着金があっても触らない。
//  4. 索引に無い着金はチェーン直読み（readTransfers）で貼る。孤児の行は先に読まれる群に入っている。
//  5. nonce で持ち主を決める経路（readNonces）でも同じ行を拾う。
// Run: TEST_DATABASE_URL=postgres:///vet402_observatory_test_r7d \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/late-settlement-orphan-request-error.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("late settlement orphan request_error (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const PAY_TO = "0xea1bf2a0b45ed328a52a4aa3744669f6ae525866";
  const PAYER = "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670";
  const CHAIN = "eip155:8453";
  const ORPHAN_META = {
    note: "reserved and possibly signed; the runner died before the outcome was written",
    phase: "sweep",
    reason: "orphaned_in_flight",
    sweptAt: "2026-09-06T12:07:33Z",
  };

  test("auth_nonce のある request_error（孤児掃除の旧い行）を遅延回収する", async (t) => {
    const late = await import("@/lib/settlements/recover-late");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql, eq } = await import("drizzle-orm");
    const db = getDb()!;

    const attemptedAt = new Date("2026-09-06T07:01:27Z");
    const reset = () => db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases, settlements, correction_log`);
    const seedEndpoint = async () => {
      const id = randomUUID();
      await db.insert(schema.x402Endpoints).values({
        id,
        resourceKey: `GET https://seller.example/api/${id}`,
        resourceUrl: `https://seller.example/api/${id}`,
        method: "GET",
        payTo: PAY_TO,
        network: CHAIN,
        status: "active",
        lastSeenAt: new Date(),
      });
      return id;
    };
    const seedOrphan = async (over: { nonce?: string | null; amount?: string; at?: Date } = {}) => {
      const amount = over.amount ?? "50000";
      const [row] = await db
        .insert(schema.x402L1Purchases)
        .values({
          endpointId: await seedEndpoint(),
          status: "request_error",
          network: CHAIN,
          payTo: PAY_TO,
          payer: PAYER,
          amountUnits: amount,
          spentUnits: amount,
          attemptedAt: over.at ?? attemptedAt,
          txHash: null,
          authNonce: over.nonce === undefined ? `0x${"c3".repeat(32)}` : over.nonce,
          rawResponseMeta: ORPHAN_META,
        })
        .returning();
      return row.id;
    };
    const seedSettlement = async (txHash: string, amount = "50000", blockTime = new Date(attemptedAt.getTime() + 4_000)) => {
      await db.insert(schema.settlements).values({
        chain: CHAIN,
        txHash,
        purchaseId: `${CHAIN}:${txHash}`,
        asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        amount,
        payer: PAYER,
        payee: PAY_TO,
        blockTime,
        source: "chain_index",
        attribution: "confirmed",
      });
    };
    const rowOf = async (id: string) => (await db.select().from(schema.x402L1Purchases).where(eq(schema.x402L1Purchases.id, id)))[0];
    const correctionsOf = async (id: string) => {
      const raw = await db.execute(sql`SELECT before, after, reason FROM correction_log WHERE subject_id = ${id} ORDER BY created_at ASC, id ASC`);
      return (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as { before: Record<string, unknown>; after: Record<string, unknown>; reason: string }[];
    };
    const totalSpent = async () => {
      const raw = await db.execute(sql`SELECT coalesce(sum(spent_units::numeric), 0)::text AS s FROM x402_l1_purchases`);
      return ((Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as { s: string }[])[0].s;
    };

    await t.test("索引に一致する着金が 1 本なら settle_claimed へ貼り、priorStatus と訂正ログに request_error が残る", async () => {
      await reset();
      const id = await seedOrphan();
      const tx = `0x0fd25312${"ab".repeat(28)}`;
      await seedSettlement(tx);
      const before = await totalSpent();

      const s = await late.recoverLateSettlements();
      assert.deepEqual(s.links, [{ purchaseId: id, txHash: tx }]);
      const row = await rowOf(id);
      assert.equal(row.status, "settle_claimed", "settled を名乗らせてはいけない（照合器が nonce まで読んで決める）");
      assert.equal(row.txHash, tx);
      assert.equal(row.settlementVerified, null);
      assert.equal(row.spentUnits, "50000", "spent_units を動かしている");
      assert.equal(await totalSpent(), before, "予約・上限の合計（spent_units の総和）が回収の前後で変わった");
      const meta = row.rawResponseMeta as { reason?: string; lateSettlement?: Record<string, unknown> };
      assert.equal(meta.reason, "orphaned_in_flight", "孤児掃除の記録を壊している");
      assert.equal(meta.lateSettlement?.priorStatus, "request_error");
      assert.equal(meta.lateSettlement?.txHash, tx);

      const log = await correctionsOf(id);
      assert.equal(log.length, 1);
      assert.equal(log[0].reason, "settlement_backfill");
      assert.deepEqual(log[0].before, { status: "request_error", txHash: null });
      assert.deepEqual(log[0].after, { status: "settle_claimed", txHash: tx });

      assert.equal((await late.recoverLateSettlements()).recovered, 0, "同じ行を二度貼っている");
    });

    await t.test("auth_nonce の無い request_error（資格情報が外へ出ていない）は一致しても触らない", async () => {
      await reset();
      const noNonce = await seedOrphan({ nonce: null });
      const blank = await seedOrphan({ nonce: "  " });
      await seedSettlement(`0x${"e1".repeat(32)}`);
      assert.equal((await late.recoverLateSettlements()).recovered, 0);
      for (const id of [noNonce, blank]) {
        const row = await rowOf(id);
        assert.equal(row.status, "request_error");
        assert.equal(row.txHash, null);
      }
      assert.equal((await correctionsOf(noNonce)).length, 0);
    });

    await t.test("候補が 2 行ある tx は、request_error が混ざっていても nonce が決まらなければ貼らない", async () => {
      await reset();
      const a = await seedOrphan();
      const [b] = await db
        .insert(schema.x402L1Purchases)
        .values({
          endpointId: await seedEndpoint(),
          status: "settle_failed",
          network: CHAIN,
          payTo: PAY_TO,
          payer: PAYER,
          amountUnits: "50000",
          spentUnits: "50000",
          attemptedAt,
          authNonce: `0x${"d4".repeat(32)}`,
        })
        .returning();
      await seedSettlement(`0x${"e2".repeat(32)}`);
      assert.equal((await late.recoverLateSettlements()).recovered, 0);
      assert.equal((await rowOf(a)).status, "request_error");
      assert.equal((await rowOf(b.id)).status, "settle_failed");

      // レシートの nonce で持ち主が request_error の行に決まれば、その行だけ貼る。
      const s = await late.recoverLateSettlements({ readNonces: async () => [`0x${"c3".repeat(32)}`] });
      assert.equal(s.recoveredByNonce, 1);
      assert.deepEqual(s.links, [{ purchaseId: a, txHash: `0x${"e2".repeat(32)}` }]);
      assert.equal((await rowOf(b.id)).status, "settle_failed");
    });

    await t.test("索引に無い着金はチェーン直読みで貼る（孤児の行も読む対象）", async () => {
      await reset();
      const at = new Date(Date.now() - 3 * 3600_000);
      const id = await seedOrphan({ amount: "1000", at });
      const tx = `0x3194e8e9${"cd".repeat(28)}`;
      const reads: string[] = [];
      const s = await late.recoverLateSettlements({
        readTransfers: async (q) => {
          reads.push(`${q.payer}->${q.payTo}`);
          return [{ txHash: tx, from: PAYER, to: PAY_TO, value: "1000", blockTime: new Date(at.getTime() + 4_000).toISOString() }];
        },
      });
      assert.deepEqual(reads, [`${PAYER}->${PAY_TO}`]);
      assert.equal(s.recoveredFromChain, 1);
      const row = await rowOf(id);
      assert.equal(row.status, "settle_claimed");
      assert.equal(row.txHash, tx);
      assert.equal(row.spentUnits, "1000");
      const meta = row.rawResponseMeta as { lateSettlement?: Record<string, unknown> };
      assert.equal(meta.lateSettlement?.priorStatus, "request_error");
      assert.equal(meta.lateSettlement?.source, "chain_read");
      assert.deepEqual((await correctionsOf(id))[0].before, { status: "request_error", txHash: null });
    });

    await t.test("auth_nonce の無い request_error はチェーン直読みの対象にもしない", async () => {
      await reset();
      await seedOrphan({ nonce: null, amount: "1000", at: new Date(Date.now() - 3 * 3600_000) });
      let called = 0;
      const s = await late.recoverLateSettlements({ readTransfers: async () => (called++, []) });
      assert.equal(called, 0);
      assert.equal(s.chainRowsRead, 0);
    });

    await t.test("LATE_PRIOR_STATUSES は照合器の戻し先に request_error を含む", () => {
      assert.ok((late.LATE_PRIOR_STATUSES as readonly string[]).includes("request_error"));
      assert.ok(!(late.LATE_RECOVERABLE_STATUSES as readonly string[]).includes("request_error"), "nonce の条件なしで request_error を足していない");
    });
  });
}
