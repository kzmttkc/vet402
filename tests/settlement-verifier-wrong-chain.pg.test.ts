// ============================================================
// 照合ジョブ — wrong_chain はそのチェーンだけ飛ばし、他のチェーンは歩き続ける（2026-09-17 レビュー 4）。
//
// 以前は wrong_chain を 1 件見たらバッチごと break していた。Arc レーンが入ると、
// ARC_RPC_URL の誤設定（別チェーンを指す）で Arc の行が wrong_chain を出し、その後ろに
// 並ぶ Base の行まで毎日照合されなくなる。守ること:
//   1. wrong_chain を出したチェーンの残りの行は読みに行かず（verify を呼ばず）、
//      wrong_chain として deferred に積む（status は倒さない）。
//   2. 他のチェーンの行は従来どおり照合され、settled になる。
//   3. summary.instrumentFailure と wrongChainNetworks に出て、外から気づける。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/settlement-verifier-wrong-chain.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";
import { randomUUID } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("settlement verifier wrong_chain (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const PAY_TO = "0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea";
  const PAYER = "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670";
  const ARC = "eip155:5042";
  const BASE = "eip155:8453";

  test("wrong_chain skips only that chain", async (t) => {
    const { runSettlementVerification } = await import("@/lib/observatory/settlement-verifier");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql, eq } = await import("drizzle-orm");
    const db = getDb()!;

    const seedEndpoint = async (network: string) => {
      const id = randomUUID();
      await db.insert(schema.x402Endpoints).values({
        id,
        resourceKey: `GET https://seller.example/api/${id}`,
        resourceUrl: `https://seller.example/api/${id}`,
        method: "GET",
        payTo: PAY_TO,
        network,
        status: "active",
        lastSeenAt: new Date(),
      });
      return id;
    };
    const seedPurchase = async (endpointId: string, network: string, txHash: string, attemptedAt: Date) => {
      const [row] = await db
        .insert(schema.x402L1Purchases)
        .values({
          endpointId,
          status: "settle_claimed",
          network,
          payTo: PAY_TO,
          payer: PAYER,
          amountUnits: "1000",
          spentUnits: "1000",
          txHash,
          authNonce: `0x${"7f".repeat(32)}`,
          httpStatusPaid: 200,
          payloadNonEmpty: true,
          l2Schema: "no_declaration",
          attemptedAt,
        })
        .returning();
      return row.id;
    };
    const rowOf = async (id: string) => {
      const [r] = await db.select().from(schema.x402L1Purchases).where(eq(schema.x402L1Purchases.id, id));
      return r;
    };

    await db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases, observed_purchases, settlements, correction_log`);
    const t0 = new Date("2026-09-17T00:00:00Z");
    // 並び順は attempted_at ASC。Arc の行を先頭と中間に置き、Base の行がその後ろに来る形にする。
    const arcA = await seedPurchase(await seedEndpoint(ARC), ARC, `0x${"c1".repeat(32)}`, new Date(t0.getTime() + 1000));
    const baseA = await seedPurchase(await seedEndpoint(BASE), BASE, `0x${"a1".repeat(32)}`, new Date(t0.getTime() + 2000));
    const arcB = await seedPurchase(await seedEndpoint(ARC), ARC, `0x${"c2".repeat(32)}`, new Date(t0.getTime() + 3000));
    const baseB = await seedPurchase(await seedEndpoint(BASE), BASE, `0x${"a2".repeat(32)}`, new Date(t0.getTime() + 4000));

    const verified: string[] = [];
    const summary = await runSettlementVerification({
      deps: {
        verify: async (input) => {
          verified.push(input.network);
          if (input.network === ARC) return { ok: false, reason: "wrong_chain", detail: "rpc reports chainId 8453, purchase is on eip155:5042" };
          return { ok: true, blockTimestamp: null, confirmations: 99n, blockNumber: 1n };
        },
        registryHooks: { l1: async () => {}, l2: async () => {} },
      },
    });

    await t.test("Arc の 2 行目は verify を呼ばれず、Base の行は両方照合される", () => {
      assert.deepEqual(verified, [ARC, BASE, BASE], "wrong_chain の後も Base は歩き、Arc は読みに行かない");
    });
    await t.test("Base の行は settled、Arc の行は status を倒さず wrong_chain で deferred", async () => {
      assert.equal((await rowOf(baseA)).status, "settled");
      assert.equal((await rowOf(baseB)).status, "settled");
      for (const id of [arcA, arcB]) {
        const r = await rowOf(id);
        assert.equal(r.status, "settle_claimed", "wrong_chain は所見ではない");
        assert.equal(r.settlementVerified, null);
        assert.equal(r.settlementVerifyReason, "wrong_chain");
      }
    });
    await t.test("summary が fail-loud で、スキップしたチェーンを名指しする", () => {
      assert.equal(summary.scanned, 4);
      assert.equal(summary.verified, 2);
      assert.equal(summary.deferred, 2);
      assert.equal(summary.instrumentFailure, "wrong_chain");
      assert.deepEqual(summary.wrongChainNetworks, [ARC]);
    });
  });
}
