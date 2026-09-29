// ============================================================
// 照合ジョブ — 売り手が名指した tx の期限（2026-09-29 敵対的監査 5 周目・台帳のコード）。
//
// tx_not_found は「まだ見えていない」として status を倒さずに毎日読み直していたので、売り手が名指した tx がチェーンに
// 無いまま照合待ちが続いた（api.wines.bet: 2026-09-12 から 17 日）。受領証の tx がハッシュの形ですらない行
// （ccs-seller の "first-can"）は照合器の対象ですらなかった。
//
// 守ること（2026-09-29 独立レビュー BLOCK の修正込み）:
//  1. 確定は Base / Arc の、購入から SELLER_NAMED_TX_NOT_FOUND_AFTER_DAYS 日を過ぎ、別々の UTC 日に
//     SELLER_NAMED_TX_NOT_FOUND_MIN_DAYS 回以上 tx_not_found で、authorizationState(payer, nonce) が false で、確定の直前の
//     読み直しもまた tx_not_found の行だけ。settle_claim_refuted・settlement_verified=false・理由
//     "seller_named_tx_not_found: …checked through <日付>…"。訂正ログに 1 行（同じ文）。Registry へは書かない。
//  2. どれか欠けたら（期限前・日数不足・認可が使われた／読めない・読み直しが rpc_unavailable・Solana）status を倒さない。
//     「見つからない」の日付は raw_response_meta.txNotFound.days に残る。
//  3. settle_claimed_unverifiable（tx がハッシュの形でない）は期限の後、認可が使われていないと読めたときだけ確定。
//  4. 遅延回収の tx と success:false の申告は、期限を過ぎても tx_not_found のまま deferred（取り消し・戻しへ進めない）。
//  5. readEndpointsWithUndeliveredL1（sitemap の除外）は isDelivered と同じ: settled かつ 2xx 以外の行を 1 つでも持つ出品。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/settlement-verifier-expiry.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";
import { randomUUID } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("settlement verifier expiry (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const PAY_TO = "0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea";
  const PAYER = "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670";
  const CHAIN = "eip155:8453";
  const DAY = 86_400_000;

  test("売り手の名指した tx: 期限の後は seller-named tx not found として確定・期限前は触らない", async () => {
    const { runSettlementVerification } = await import("@/lib/observatory/settlement-verifier");
    const { SELLER_NAMED_TX_NOT_FOUND, SELLER_NAMED_TX_NOT_FOUND_AFTER_DAYS } = await import("@/lib/sellers/fix-modes");
    const { readEndpointsWithUndeliveredL1 } = await import("@/lib/sellers/reader");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql, eq } = await import("drizzle-orm");
    const db = getDb()!;
    await db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases, observed_purchases, settlements, correction_log`);

    const old = new Date(Date.now() - (SELLER_NAMED_TX_NOT_FOUND_AFTER_DAYS + 10) * DAY);
    const fresh = new Date(Date.now() - 2 * DAY);
    const dayAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
    const twoPriorDays = { txNotFound: { days: [dayAgo(2), dayAgo(1)] } };
    const seedEndpoint = async (network: string) => {
      const id = randomUUID();
      await db.insert(schema.x402Endpoints).values({
        id,
        resourceKey: `seller.example/api/${id}`,
        resourceUrl: `https://seller.example/api/${id}`,
        method: "GET",
        payTo: PAY_TO,
        network,
        status: "active",
        lastSeenAt: new Date(),
      });
      return id;
    };
    let n = 0;
    const nonceOf = (k: number) => `0x${k.toString(16).padStart(2, "0").repeat(32)}`;
    const seed = async (over: { status: string; txHash: string; attemptedAt: Date; meta?: Record<string, unknown>; httpStatusPaid?: number | null; network?: string }) => {
      n++;
      const network = over.network ?? CHAIN;
      const [row] = await db
        .insert(schema.x402L1Purchases)
        .values({
          endpointId: await seedEndpoint(network),
          status: over.status,
          network,
          payTo: PAY_TO,
          payer: PAYER,
          amountUnits: "1000",
          spentUnits: "1000",
          txHash: over.txHash,
          authNonce: nonceOf(n),
          httpStatusPaid: over.httpStatusPaid === undefined ? 200 : over.httpStatusPaid,
          payloadNonEmpty: true,
          l2Schema: "no_declaration",
          attemptedAt: over.attemptedAt,
          rawResponseMeta: { phase: "paid", ...(over.meta ?? {}) },
        })
        .returning();
      return row;
    };
    const tx = (c: string) => `0x${c.repeat(64)}`;
    const ready = await seed({ status: "settle_claimed", txHash: tx("1"), attemptedAt: old, meta: twoPriorDays });
    const freshClaim = await seed({ status: "settle_claimed", txHash: tx("2"), attemptedAt: fresh, meta: twoPriorDays });
    const oneDay = await seed({ status: "settle_claimed", txHash: tx("3"), attemptedAt: old });
    const authUsed = await seed({ status: "settle_claimed", txHash: tx("4"), attemptedAt: old, meta: twoPriorDays });
    const authUnreadable = await seed({ status: "settle_claimed", txHash: tx("5"), attemptedAt: old, meta: twoPriorDays });
    const rereadFails = await seed({ status: "settle_claimed", txHash: tx("6"), attemptedAt: old, meta: twoPriorDays });
    const solana = await seed({ status: "settle_claimed", txHash: "5".repeat(88), attemptedAt: old, meta: twoPriorDays, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" });
    const oldMalformed = await seed({ status: "settle_claimed_unverifiable", txHash: "first-can", attemptedAt: old });
    const malformedAuthUnknown = await seed({ status: "settle_claimed_unverifiable", txHash: "third-can", attemptedAt: old });
    const freshMalformed = await seed({ status: "settle_claimed_unverifiable", txHash: "second-can", attemptedAt: fresh });
    const lateLinked = await seed({
      status: "settle_claimed",
      txHash: tx("7"),
      attemptedAt: old,
      meta: { ...twoPriorDays, lateSettlement: { priorStatus: "settle_failed", txHash: tx("7") } },
    });
    const promoted = await seed({
      status: "settle_claimed",
      txHash: tx("8"),
      attemptedAt: old,
      meta: { ...twoPriorDays, namedTxPromotion: { priorStatus: "delivered_no_receipt" } },
    });
    const delivered = await seed({ status: "settled", txHash: tx("9"), attemptedAt: fresh });
    await db.update(schema.x402L1Purchases).set({ settlementVerified: true }).where(eq(schema.x402L1Purchases.id, delivered.id));

    const authByNonce = new Map<string, boolean | null>([
      [authUsed.authNonce!, true],
      [authUnreadable.authNonce!, null],
      [malformedAuthUnknown.authNonce!, null],
    ]);
    const readCalls: string[] = [];
    const l1Calls: unknown[] = [];
    const origError = console.error;
    console.error = () => {};
    let summary;
    try {
      summary = await runSettlementVerification({
        deps: {
          verify: async (input) => {
            readCalls.push(input.txHash);
            // 読み直し（2 回目）だけ RPC が落ちる行。
            if (input.txHash === tx("6") && readCalls.filter((h) => h === tx("6")).length > 1) return { ok: false, reason: "rpc_unavailable" };
            return { ok: false, reason: "tx_not_found" };
          },
          authorizationState: async (input) => (authByNonce.has(input.nonce) ? authByNonce.get(input.nonce)! : false),
          registryHooks: { l1: async (i) => void l1Calls.push(i), l2: async () => {} },
        },
      });
    } finally {
      console.error = origError;
    }
    const rowOf = async (id: string) => (await db.select().from(schema.x402L1Purchases).where(eq(schema.x402L1Purchases.id, id)))[0];
    const corrections = async (id: string) => {
      const raw = await db.execute(sql`SELECT before, after FROM correction_log WHERE subject_id = ${id}`);
      return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as { before: Record<string, unknown>; after: Record<string, unknown> }[];
    };
    const daysOf = (r: { rawResponseMeta: unknown }) => ((r.rawResponseMeta as { txNotFound?: { days?: string[] } }).txNotFound?.days ?? []);
    const today = new Date().toISOString().slice(0, 10);

    // 1
    const a = await rowOf(ready.id);
    assert.equal(a.status, "settle_claim_refuted");
    assert.equal(a.settlementVerified, false);
    assert.ok(a.settlementVerifiedAt);
    assert.match(
      a.settlementVerifyReason ?? "",
      new RegExp(`^${SELLER_NAMED_TX_NOT_FOUND}: transaction ${tx("1")} not found on ${CHAIN} on 3 different days, checked through \\d{4}-\\d{2}-\\d{2} \\(purchase \\d{4}-\\d{2}-\\d{2}, ${SELLER_NAMED_TX_NOT_FOUND_AFTER_DAYS}-day limit\\)$`),
    );
    assert.deepEqual(daysOf(a), [dayAgo(2), dayAgo(1), today]);
    assert.equal(readCalls.filter((h) => h === tx("1")).length, 2, "確定の直前にもう一度読む");
    const ca = await corrections(ready.id);
    assert.equal(ca.length, 1);
    assert.equal(ca[0].before.status, "settle_claimed");
    assert.equal(ca[0].after.status, "settle_claim_refuted");
    assert.equal(ca[0].after.reason, SELLER_NAMED_TX_NOT_FOUND);
    assert.equal(l1Calls.length, 0, "Registry へは書かない");
    // 2
    for (const [r, why] of [
      [freshClaim, "期限前"],
      [authUsed, "認可が使われた（お金は動いた）"],
      [authUnreadable, "認可が読めない"],
      [rereadFails, "読み直しが RPC の失敗"],
      [solana, "Solana は対象外"],
    ] as const) {
      const x = await rowOf(r.id);
      assert.equal(x.status, "settle_claimed", why);
      assert.equal(x.settlementVerified, null, why);
      assert.equal((await corrections(r.id)).length, 0, why);
    }
    const one = await rowOf(oneDay.id);
    assert.equal(one.status, "settle_claimed", "1 日分しか無い");
    assert.deepEqual(daysOf(one), [today], "見つからなかった日付を残す");
    assert.equal(readCalls.filter((h) => h === tx("6")).length, 2, "読み直しで RPC が落ちたので確定しない");
    // 3
    const c = await rowOf(oldMalformed.id);
    assert.equal(c.status, "settle_claim_refuted");
    assert.match(c.settlementVerifyReason ?? "", /^seller_named_tx_not_found: the receipt's transaction id "first-can" is not a transaction hash, checked through /);
    assert.equal((await corrections(oldMalformed.id)).length, 1);
    assert.ok(!readCalls.includes("first-can"), "ハッシュの形でない tx はチェーンに読みに行かない");
    assert.equal((await rowOf(malformedAuthUnknown.id)).status, "settle_claimed_unverifiable", "認可が読めなければ触らない");
    assert.equal((await rowOf(freshMalformed.id)).status, "settle_claimed_unverifiable", "期限前は触らない");
    // 4
    for (const r of [lateLinked, promoted]) {
      const x = await rowOf(r.id);
      assert.equal(x.status, "settle_claimed", "期限でも取り消し・戻しへ進めない");
      assert.equal(x.settlementVerified, null);
      assert.equal(x.settlementVerifyReason, "tx_not_found");
      assert.ok(!JSON.stringify(x.rawResponseMeta).includes("rejectedTxHashes"));
    }
    assert.equal(summary.sellerNamedTxExpired, 2);
    assert.equal(summary.refuted, 0);
    assert.equal(summary.lateLinksWithdrawn, 0);
    assert.equal(summary.sellerDeclaredUnsettled, 0);
    assert.equal(summary.rowErrors, 0);

    // 2 回目: 確定した行はもう拾わない。同じ日の「見つからない」は数え直さない。
    const again = await runSettlementVerification({
      deps: {
        verify: async () => ({ ok: false, reason: "tx_not_found" }),
        authorizationState: async () => null,
        registryHooks: { l1: async () => {}, l2: async () => {} },
      },
    });
    assert.equal(again.sellerNamedTxExpired, 0);
    assert.equal((await corrections(ready.id)).length, 1);
    assert.deepEqual(daysOf(await rowOf(oneDay.id)), [today]);

    // 5
    const undelivered = await readEndpointsWithUndeliveredL1(db);
    assert.ok(!undelivered.has(delivered.endpointId), "settled かつ 2xx だけの出品は外さない");
    for (const r of [ready, freshClaim, oldMalformed, lateLinked, promoted]) assert.ok(undelivered.has(r.endpointId));
    const nullHttp = await seed({ status: "settled", txHash: tx("a"), attemptedAt: fresh, httpStatusPaid: null });
    assert.ok((await readEndpointsWithUndeliveredL1(db)).has(nullHttp.endpointId), "HTTP が NULL の settled は届いていない側");
  });
}
