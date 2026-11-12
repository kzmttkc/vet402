// B1: 照合済みの決済を読み直して tx が消えていたら、行は残し、
// raw_response_meta.purchaseLifecycle.reorgRevokedAt だけを足す。
// status / tx / settlement_verified は変えない。訂正ログには載せない。
// state の lifecycle と /sellers の段階が reorg_revoked になる。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test_b1abs \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/purchase-lifecycle-reorg.pg.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("purchase lifecycle reorg (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const PAY_TO = "0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea";
  const PAYER = "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670";
  const HOST = "b1-reorg.example";
  const REVOKED_TX = `0x${"a1".repeat(32)}`;
  const KEPT_TX = `0x${"b2".repeat(32)}`;
  const TRANSIENT_TX = `0x${"c3".repeat(32)}`;
  const MISMATCH_TX = `0x${"d4".repeat(32)}`;
  const UNVERIFIED_TX = `0x${"e5".repeat(32)}`;

  test("B1: a confirmed settlement that a re-read cannot find moves to reorg_revoked without changing status", async () => {
    const { runSettlementVerification } = await import("@/lib/observatory/settlement-verifier");
    const { readPurchaseLifecycleCounts } = await import("@/lib/observatory/purchase-lifecycle-read");
    const { readSellerDetail } = await import("@/lib/sellers/reader");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql, eq } = await import("drizzle-orm");
    const db = getDb()!;
    await db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases, observed_purchases, settlements, correction_log`);

    const calls: string[] = [];
    const verify = async (input: { txHash: string }) => {
      calls.push(input.txHash);
      if (input.txHash === REVOKED_TX) return { ok: false as const, reason: "tx_not_found" as const };
      if (input.txHash === TRANSIENT_TX) return { ok: false as const, reason: "rpc_unavailable" as const };
      if (input.txHash === MISMATCH_TX) return { ok: false as const, reason: "no_matching_transfer" as const };
      if (input.txHash === UNVERIFIED_TX) return { ok: false as const, reason: "tx_not_found" as const };
      return { ok: true as const, blockTimestamp: null, confirmations: 40n, blockNumber: 10n };
    };

    const seedEndpoint = async (path: string) => {
      const id = randomUUID();
      await db.insert(schema.x402Endpoints).values({
        id,
        resourceKey: `${HOST}/${path}`,
        resourceUrl: `https://${HOST}/${path}`,
        method: "GET",
        payTo: PAY_TO,
        network: "eip155:8453",
        status: "active",
        lastSeenAt: new Date(),
      });
      return id;
    };
    const seed = async (over: {
      path: string;
      txHash: string;
      status: string;
      verified: boolean;
    }) => {
      const [row] = await db
        .insert(schema.x402L1Purchases)
        .values({
          endpointId: await seedEndpoint(over.path),
          status: over.status,
          network: "eip155:8453",
          payTo: PAY_TO,
          payer: PAYER,
          amountUnits: "1000",
          spentUnits: "1000",
          txHash: over.txHash,
          httpStatusPaid: 200,
          payloadNonEmpty: true,
          authNonce: `0x${"11".repeat(32)}`,
          settlementVerified: over.verified ? true : null,
          settlementVerifiedAt: over.verified ? new Date("2026-11-01T00:00:00Z") : null,
          rawResponseMeta: { selection: "census", requestBody: "declared" },
        })
        .returning();
      return row!.id;
    };
    const idOfTx = async (tx: string) => {
      const [row] = await db
        .select({ id: schema.x402L1Purchases.id })
        .from(schema.x402L1Purchases)
        .where(eq(schema.x402L1Purchases.txHash, tx));
      return row!.id;
    };

    const revokedId = await seed({ path: "revoked", txHash: REVOKED_TX, status: "settled", verified: true });
    const keptId = await seed({ path: "kept", txHash: KEPT_TX, status: "settled", verified: true });
    await seed({ path: "transient", txHash: TRANSIENT_TX, status: "settled", verified: true });
    await seed({ path: "mismatch", txHash: MISMATCH_TX, status: "settled", verified: true });
    await seed({ path: "unverified", txHash: UNVERIFIED_TX, status: "settle_claimed", verified: false });

    const correctionsBefore = await db.execute(sql`SELECT count(*)::int AS n FROM correction_log`);
    const beforeN = Number((Array.isArray(correctionsBefore) ? correctionsBefore[0] : (correctionsBefore as { rows?: { n?: number }[] }).rows?.[0])?.n ?? 0);

    const summary = await runSettlementVerification({
      limit: 50,
      budgetMs: 60_000,
      deps: { verify: verify as never },
    });

    const load = async (id: string) => {
      const [row] = await db
        .select({
          status: schema.x402L1Purchases.status,
          txHash: schema.x402L1Purchases.txHash,
          settlementVerified: schema.x402L1Purchases.settlementVerified,
          settlementVerifyReason: schema.x402L1Purchases.settlementVerifyReason,
          rawResponseMeta: schema.x402L1Purchases.rawResponseMeta,
        })
        .from(schema.x402L1Purchases)
        .where(eq(schema.x402L1Purchases.id, id));
      return row!;
    };
    const lifeOf = (meta: unknown) => {
      const raw = meta && typeof meta === "object" ? (meta as { purchaseLifecycle?: { reorgRevokedAt?: unknown; chainRereadAt?: unknown } }).purchaseLifecycle : null;
      return raw && typeof raw === "object" ? raw : null;
    };

    const revoked = await load(revokedId);
    const revokedLife = lifeOf(revoked.rawResponseMeta);
    assert.equal(revoked.status, "settled");
    assert.equal(revoked.txHash, REVOKED_TX);
    assert.equal(revoked.settlementVerified, true);
    assert.equal(revoked.settlementVerifyReason, null);
    assert.equal(typeof revokedLife?.reorgRevokedAt, "string");
    assert.match(String(revokedLife?.reorgRevokedAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const meta = revoked.rawResponseMeta as { selection?: string; requestBody?: string };
    assert.equal(meta.selection, "census");
    assert.equal(meta.requestBody, "declared");
    assert.equal(summary.reorgRevoked, 1);
    assert.equal(calls.filter((tx) => tx === REVOKED_TX).length, 2);

    const kept = await load(keptId);
    const keptLife = lifeOf(kept.rawResponseMeta);
    assert.equal(kept.status, "settled");
    assert.equal(kept.settlementVerified, true);
    assert.equal(keptLife?.reorgRevokedAt ?? null, null);
    assert.match(String(keptLife?.chainRereadAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(calls.filter((tx) => tx === KEPT_TX).length, 1);

    const transient = lifeOf((await load(await idOfTx(TRANSIENT_TX))).rawResponseMeta);
    assert.equal(transient?.reorgRevokedAt ?? null, null);
    const mismatchRow = await load(await idOfTx(MISMATCH_TX));
    assert.equal(mismatchRow.status, "settled");
    assert.equal(mismatchRow.settlementVerified, true);
    assert.equal(lifeOf(mismatchRow.rawResponseMeta)?.reorgRevokedAt ?? null, null);
    const unverified = await load(await idOfTx(UNVERIFIED_TX));
    assert.equal(unverified.status, "settle_claimed");
    assert.equal(lifeOf(unverified.rawResponseMeta)?.reorgRevokedAt ?? null, null);

    const counts = await readPurchaseLifecycleCounts();
    assert.equal(counts.total, 5);
    assert.equal(counts.stages.reorg_revoked, 1);
    assert.equal(counts.stages.delivered, 3);
    assert.equal(counts.stages.settlement_claimed, 1);

    const detail = await readSellerDetail(db, HOST);
    assert.ok(detail);
    const stageOf = (tx: string) => detail!.listings.find((l) => l.latest?.facts.txHash === tx)?.latest?.lifecycleStage;
    assert.equal(stageOf(REVOKED_TX), "reorg_revoked");
    assert.equal(detail!.listings.find((l) => l.latest?.facts.txHash === REVOKED_TX)?.latest?.facts.status, "settled");
    assert.equal(detail!.listings.find((l) => l.latest?.facts.txHash === REVOKED_TX)?.latest?.lifecycleAt, revokedLife?.reorgRevokedAt);
    assert.equal(stageOf(KEPT_TX), "delivered");
    assert.equal(stageOf(MISMATCH_TX), "delivered");

    const correctionsAfter = await db.execute(sql`SELECT count(*)::int AS n FROM correction_log`);
    const afterN = Number((Array.isArray(correctionsAfter) ? correctionsAfter[0] : (correctionsAfter as { rows?: { n?: number }[] }).rows?.[0])?.n ?? 0);
    assert.equal(afterN, beforeN);

    const stamped = String(revokedLife?.reorgRevokedAt);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await runSettlementVerification({
      limit: 50,
      budgetMs: 60_000,
      deps: { verify: verify as never },
    });
    const again = lifeOf((await load(revokedId)).rawResponseMeta);
    assert.equal(again?.reorgRevokedAt, stamped);
    assert.equal(calls.filter((tx) => tx === REVOKED_TX).length, 2);
  });
}
