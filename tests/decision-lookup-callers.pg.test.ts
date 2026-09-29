// ============================================================
// /decision の問い合わせ数の重複除去と verified_terms の読み出し（2026-09-29 監査 5 周目・高）。
//
// 守ること:
//  1. 同じ呼び手が同じ endpoint を同じ UTC 日に何回叩いても decision_lookups.n は 1。
//     （以前は 5 回で「問い合わせ多」＝L1 の最優先枠に入った）
//  2. 呼び手が 5 人なら 5（正直な需要は従来どおり昇格させる）。同時の 10 回でも 1。
//  3. 呼び手の材料が無い呼び出しは数えない。2026-09-29 監査 6 周目: 鍵なし（IP）の呼び出しは材料 null＝数えない。
//  4. loadSellerFacts は最後に配達を確かめた購入の条件（verified_terms）を返す。配達していない行は使わない。
//  5. purge は 8 日より古い重複除去の行を消す。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/decision-lookup-callers.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("decision lookup callers (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("decision lookup callers / verified_terms", async (t) => {
    const { recordDecisionLookup } = await import("@/lib/decision/decide");
    const { lookupCallerMaterial } = await import("@/lib/decision/lookup-caller");
    const { loadSellerFacts } = await import("@/lib/decision/seller-facts");
    const { purgeExpiredLogs } = await import("@/lib/cron/log-retention");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;
    const rows = (raw: unknown) => (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];

    async function seedEndpoint(): Promise<string> {
      await db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases, decision_lookups, decision_lookup_callers, x402_l0_probes`);
      const id = randomUUID();
      await db
        .insert(schema.x402Endpoints)
        .values({
          id,
          resourceKey: "seller.example/api",
          resourceUrl: "https://seller.example/api",
          method: "GET",
          network: "eip155:8453",
          payTo: "0x" + "11".repeat(20),
          priceAmount: "10000",
          status: "active",
        } as typeof schema.x402Endpoints.$inferInsert);
      return id;
    }
    const lookups = async (id: string) =>
      Number(rows(await db.execute(sql`SELECT coalesce(sum(n), 0)::int AS n FROM decision_lookups WHERE endpoint_id = ${id}::uuid`))[0].n);

    await t.test("同じ呼び手（同じ鍵）は何回叩いても 1 日 1 回", async () => {
      const id = await seedEndpoint();
      const me = lookupCallerMaterial({ apiKeyId: "key-7" });
      for (let i = 0; i < 7; i++) await recordDecisionLookup(id, me);
      assert.equal(await lookups(id), 1);
    });

    await t.test("同時の 10 回でも 1（主キーの衝突で片方だけが数える）", async () => {
      const id = await seedEndpoint();
      const me = lookupCallerMaterial({ apiKeyId: "key-1" });
      await Promise.all(Array.from({ length: 10 }, () => recordDecisionLookup(id, me)));
      assert.equal(await lookups(id), 1);
    });

    await t.test("鍵なし（IP）の呼び出しは数えない（監査 6 周目: 1 つの IP から日をまたいで・別サイトの閲覧者の IP で数を作れた）", async () => {
      const id = await seedEndpoint();
      for (let i = 1; i <= 6; i++) await recordDecisionLookup(id, lookupCallerMaterial({ ip: `2001:db8:1:${i}::1` }));
      for (let i = 1; i <= 5; i++) await recordDecisionLookup(id, lookupCallerMaterial({ ip: `198.51.100.${i}` }));
      assert.equal(await lookups(id), 0);
    });

    await t.test("鍵が 5 本なら 5（同じ鍵の 2 回目は数えない）", async () => {
      const id = await seedEndpoint();
      for (let i = 1; i <= 5; i++) await recordDecisionLookup(id, lookupCallerMaterial({ apiKeyId: `k${i}` }));
      await recordDecisionLookup(id, lookupCallerMaterial({ apiKeyId: "k1" }));
      assert.equal(await lookups(id), 5);
    });

    await t.test("呼び手の材料が無い呼び出しは数えない", async () => {
      const id = await seedEndpoint();
      await recordDecisionLookup(id, null);
      await recordDecisionLookup(id, undefined);
      assert.equal(await lookups(id), 0);
    });

    await t.test("purge: 8 日より古い重複除去の行を消し、新しい行は残す", async () => {
      const id = await seedEndpoint();
      await db.execute(sql`INSERT INTO decision_lookup_callers (endpoint_id, day, caller_hash) VALUES
        (${id}::uuid, '2000-01-01', 'old'), (${id}::uuid, ${new Date().toISOString().slice(0, 10)}, 'new')`);
      const r = await purgeExpiredLogs();
      assert.ok((r.lookupCallersDeleted ?? 0) >= 1, JSON.stringify(r));
      const left = rows(await db.execute(sql`SELECT caller_hash FROM decision_lookup_callers WHERE endpoint_id = ${id}::uuid`)).map((x) => x.caller_hash);
      assert.deepEqual(left, ["new"]);
    });

    await t.test("loadSellerFacts: verified_terms は最後に配達を確かめた購入（配達していない新しい行は使わない）", async () => {
      const id = await seedEndpoint();
      const base = { endpointId: id, payer: "0x" + "99".repeat(20), network: "eip155:8453", asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" };
      await db.insert(schema.x402L1Purchases).values([
        { ...base, status: "settled", payTo: "0x" + "11".repeat(20), amountUnits: "10000", spentUnits: "10000", txHash: "0x" + "01".repeat(32), httpStatusPaid: 200, payloadNonEmpty: true, attemptedAt: new Date(Date.now() - 3 * 86400_000) },
        { ...base, status: "settled", payTo: "0x" + "11".repeat(20), amountUnits: "12000", spentUnits: "12000", txHash: "0x" + "02".repeat(32), httpStatusPaid: 200, payloadNonEmpty: true, attemptedAt: new Date(Date.now() - 2 * 86400_000) },
        // 新しいが配達していない（空の本文）→ 使わない
        { ...base, status: "settled", payTo: "0x" + "44".repeat(20), amountUnits: "900000", spentUnits: "900000", txHash: "0x" + "03".repeat(32), httpStatusPaid: 200, payloadNonEmpty: false, attemptedAt: new Date(Date.now() - 1 * 86400_000) },
        // 新しいが決済に失敗 → 使わない
        { ...base, status: "settle_failed", payTo: "0x" + "55".repeat(20), amountUnits: "900000", spentUnits: "900000", httpStatusPaid: 402, payloadNonEmpty: true, attemptedAt: new Date(Date.now() - 3600_000) },
      ] as (typeof schema.x402L1Purchases.$inferInsert)[]);
      const loaded = await loadSellerFacts(id);
      assert.ok(loaded);
      assert.equal(loaded.verifiedTerms?.amount, "12000");
      assert.equal(loaded.verifiedTerms?.pay_to, "0x" + "11".repeat(20));
      assert.equal(loaded.verifiedTerms?.purchase_id, `eip155:8453:0x${"02".repeat(32)}`);
      assert.equal(loaded.verifiedTerms?.scheme, "exact");
    });

    await t.test("loadSellerFacts: 一度も配達していなければ verified_terms は null", async () => {
      const id = await seedEndpoint();
      const loaded = await loadSellerFacts(id);
      assert.equal(loaded?.verifiedTerms, null);
    });
  });
}
