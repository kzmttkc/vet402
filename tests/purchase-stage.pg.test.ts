// ============================================================
// B1 purchase lifecycle (Postgres parity and revocation).
// TEST_DATABASE_URL=postgres://postgres@localhost:55443/vet402test \
//   npx tsx --test --test-concurrency=1 --test-force-exit tests/purchase-stage.pg.test.ts
// ============================================================
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";
import { toIsoUtc } from "@/lib/util/iso-utc";
import { PAYER_UNFUNDED_WINDOWS } from "@/lib/observatory/delivery";
import {
  countPurchaseStages,
  getPurchaseLifecycleCounts,
  loadRevokedAtByPurchaseId,
  purchaseStageOf,
  purchaseStageSql,
  PURCHASE_STAGES,
  INCONCLUSIVE_STAGE,
  NOT_DELIVERED_STAGE,
  type PurchaseStageKey,
} from "@/lib/observatory/purchase-stage";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("purchase-stage pg (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  after(async () => {
    const { getDb } = await import("@/lib/db/client");
    const db = getDb() as unknown as { $client?: { end?: () => Promise<void> } } | null;
    await db?.$client?.end?.();
  });

  describe("purchase-stage postgres", { concurrency: 1 }, () => {
    test("JS and SQL lifecycle counts match", async (t) => {
      const { getDb } = await import("@/lib/db/client");
      const schema = await import("@/lib/db/schema");
      const db = getDb()!;
      await db.execute(sql`TRUNCATE correction_log, x402_l1_purchases, x402_endpoints CASCADE`);

      const [ep] = await db
        .insert(schema.x402Endpoints)
        .values({
          resourceKey: "stage.example/api",
          resourceUrl: "https://stage.example/api",
          network: "eip155:8453",
          method: "POST",
          payTo: `0x${"ab".repeat(20)}`,
        })
        .returning();

      type Seed = {
        status: string;
        http: number | null;
        tx: boolean;
        auth: string | null;
        payload?: boolean | null;
        attemptedAt?: string;
        network?: string;
        expected: PurchaseStageKey;
        revokeFromSettled?: boolean;
      };

      const defaultAttempted = "2026-09-10T00:00:00Z";
      const unfundedAt = "2026-09-14T00:00:00Z";
      assert.ok(
        PAYER_UNFUNDED_WINDOWS.some(
          (w) =>
            w.networks.includes("eip155:8453") &&
            Date.parse(unfundedAt) >= Date.parse(w.from) &&
            Date.parse(unfundedAt) < Date.parse(w.until),
        ),
        "unfundedAt must fall inside PAYER_UNFUNDED_WINDOWS for Base",
      );

      const seeds: Seed[] = [
        { status: "no_402", http: null, tx: false, auth: null, expected: "no_402" },
        { status: "halted", http: null, tx: false, auth: null, expected: "http_402" },
        {
          status: "settled",
          http: 200,
          tx: true,
          auth: "n-delivered",
          payload: true,
          expected: "delivered",
          revokeFromSettled: true,
        },
        { status: "settled", http: 200, tx: true, auth: "n-delivered-kept", payload: true, expected: "delivered" },
        { status: "settled", http: 422, tx: true, auth: "n-settled-4xx", payload: true, expected: INCONCLUSIVE_STAGE },
        { status: "settled", http: null, tx: true, auth: "n-settled-null", payload: null, expected: "settled" },
        { status: "settled", http: 202, tx: true, auth: "n-202", expected: "settled" },
        { status: "settled", http: 500, tx: true, auth: "n-500", expected: NOT_DELIVERED_STAGE },
        {
          status: "settled",
          http: 200,
          tx: true,
          auth: "n-empty-body",
          payload: false,
          expected: NOT_DELIVERED_STAGE,
        },
        { status: "settle_claimed", http: 200, tx: true, auth: "n4", expected: "settle_claimed" },
        { status: "settle_failed", http: 503, tx: false, auth: "n5", expected: "signed" },
        {
          status: "settle_failed",
          http: 422,
          tx: false,
          auth: "n-unsettled-4xx",
          expected: INCONCLUSIVE_STAGE,
        },
        {
          status: "settle_failed",
          http: 402,
          tx: false,
          auth: "n-payer-unfunded",
          attemptedAt: unfundedAt,
          network: "eip155:8453",
          expected: INCONCLUSIVE_STAGE,
        },
        { status: "request_error", http: null, tx: false, auth: null, expected: "unknown" },
        { status: "request_error", http: null, tx: false, auth: "presign:ledger-slot", expected: "unknown" },
        { status: "request_error", http: null, tx: false, auth: "", expected: "unknown" },
        { status: "request_error", http: null, tx: false, auth: "signed-nonce", expected: "signed" },
        { status: "timeout_too_long", http: null, tx: false, auth: null, expected: "http_402" },
        { status: "no_fee_payer", http: null, tx: false, auth: null, expected: "http_402" },
        { status: "in_flight", http: null, tx: false, auth: null, expected: "unknown" },
      ];

      const ids: string[] = [];
      const expectedById = new Map<string, PurchaseStageKey>();
      let txSeq = 0;
      for (const s of seeds) {
        const [row] = await db
          .insert(schema.x402L1Purchases)
          .values({
            endpointId: ep.id,
            status: s.status,
            httpStatusPaid: s.http,
            txHash: s.tx ? `0x${(++txSeq).toString(16).padStart(64, "0")}` : null,
            authNonce: s.auth,
            spentUnits: s.tx ? "1000" : "0",
            amountUnits: "1000",
            network: s.network ?? "eip155:8453",
            ...(s.payload !== undefined ? { payloadNonEmpty: s.payload } : {}),
            attemptedAt: new Date(s.attemptedAt ?? defaultAttempted),
          })
          .returning();
        ids.push(row.id);
        expectedById.set(row.id, s.revokeFromSettled ? "revoked" : s.expected);
      }

      const revokeId = ids[seeds.findIndex((s) => s.revokeFromSettled)]!;
      const { updateWithCorrection } = await import("@/lib/observatory/corrections");
      await updateWithCorrection(db, {
        update: sql`
          UPDATE x402_l1_purchases
          SET status = 'settle_claim_refuted'
          WHERE id = ${revokeId}::uuid
          RETURNING id::text AS correction_subject_id, status
        `,
        subjectType: "purchase",
        level: "l1",
        reason: "settlement_backfill",
        before: { json: { status: "settled" } },
        after: { json: { status: "settle_claim_refuted" } },
      });

      const ledger = await db
        .select({
          id: schema.x402L1Purchases.id,
          status: schema.x402L1Purchases.status,
          httpStatusPaid: schema.x402L1Purchases.httpStatusPaid,
          txHash: schema.x402L1Purchases.txHash,
          authNonce: schema.x402L1Purchases.authNonce,
          attemptedAt: schema.x402L1Purchases.attemptedAt,
          network: schema.x402L1Purchases.network,
          payloadNonEmpty: schema.x402L1Purchases.payloadNonEmpty,
        })
        .from(schema.x402L1Purchases);

      const revokedMap = await loadRevokedAtByPurchaseId(db, ids);
      const js = countPurchaseStages(
        ledger.map((r) => ({
          status: r.status,
          httpStatusPaid: r.httpStatusPaid,
          txHash: r.txHash,
          authNonce: r.authNonce,
          attemptedAt: r.attemptedAt,
          network: r.network,
          payloadNonEmpty: r.payloadNonEmpty,
        })),
        revokedMap,
        ledger.map((r) => r.id),
      );
      const sqlCounts = await getPurchaseLifecycleCounts(db);
      assert.equal(js.total, sqlCounts.total);
      assert.equal(js.total, seeds.length);
      for (const stage of PURCHASE_STAGES) {
        assert.equal(js.stages[stage], sqlCounts.stages[stage], stage);
      }
      assert.equal(js.outsideStages.no_402, sqlCounts.outsideStages.no_402);
      assert.equal(js.outsideStages.unknown, sqlCounts.outsideStages.unknown);

      const { getObservatoryStats } = await import("@/lib/observatory/reader");
      const stats = await getObservatoryStats();
      assert.equal(sqlCounts.stages.delivered, 1, "one delivered row stays delivered");
      assert.equal(stats.l1.delivered, 1);
      assert.equal(stats.lifecycle.stages.delivered, 1);
      assert.deepEqual(stats.lifecycle.stages, sqlCounts.stages);

      await t.test("per-row SQL stage matches JS", async () => {
        const stageExpr = purchaseStageSql("p");
        const raw = await db.execute(sql`
          SELECT id::text AS id, status, ${sql.raw(stageExpr)} AS stage
          FROM x402_l1_purchases p
        `);
        const rows = (Array.isArray(raw) ? raw : (raw as { rows: unknown[] }).rows) as { id: string; stage: string }[];
        for (const r of rows) {
          const src = ledger.find((l) => l.id === r.id)!;
          const seed = seeds[ids.indexOf(r.id)]!;
          const revokedAt = revokedMap.has(r.id) ? toIsoUtc(revokedMap.get(r.id)!) : null;
          const jsStage = purchaseStageOf(
            {
              status: src.status,
              httpStatusPaid: src.httpStatusPaid,
              txHash: src.txHash,
              authNonce: src.authNonce,
              attemptedAt: src.attemptedAt,
              network: src.network,
              payloadNonEmpty: src.payloadNonEmpty,
            },
            revokedAt,
          );
          const expected = expectedById.get(r.id)!;
          assert.equal(jsStage, expected, `JS ${seed.status} expected ${expected}`);
          assert.equal(r.stage, expected, `SQL ${seed.status} expected ${expected}`);
          assert.equal(r.stage, jsStage, `JS/SQL parity ${seed.status} row ${r.id}`);
        }
      });
    });

    test("revoked: settled row moved out keeps total and timestamps", async () => {
      const { getDb } = await import("@/lib/db/client");
      const schema = await import("@/lib/db/schema");
      const { updateWithCorrection } = await import("@/lib/observatory/corrections");
      const db = getDb()!;
      await db.execute(sql`TRUNCATE correction_log, x402_l1_purchases, x402_endpoints CASCADE`);

      const [ep] = await db
        .insert(schema.x402Endpoints)
        .values({
          resourceKey: "revoke.example/api",
          resourceUrl: "https://revoke.example/api",
          network: "eip155:8453",
          method: "POST",
          payTo: `0x${"cd".repeat(20)}`,
        })
        .returning();

      const [purchase] = await db
        .insert(schema.x402L1Purchases)
        .values({
          endpointId: ep.id,
          status: "settled",
          httpStatusPaid: 202,
          txHash: "0xrevoke",
          authNonce: "rev-nonce",
          spentUnits: "1000",
          amountUnits: "1000",
          network: "eip155:8453",
          attemptedAt: new Date("2026-10-01T00:00:00Z"),
        })
        .returning();

      const before = await getPurchaseLifecycleCounts(db);
      assert.equal(before.stages.settled, 1);
      assert.equal(before.stages.revoked, 0);

      const changed = await updateWithCorrection(db, {
        update: sql`
          UPDATE x402_l1_purchases
          SET status = 'settle_claim_refuted'
          WHERE id = ${purchase.id}::uuid
          RETURNING id::text AS correction_subject_id, status
        `,
        subjectType: "purchase",
        level: "l1",
        reason: "settlement_backfill",
        before: { json: { status: "settled" } },
        after: { json: { status: "settle_claim_refuted" } },
      });
      assert.equal(changed.length, 1);

      const after = await getPurchaseLifecycleCounts(db);
      assert.equal(after.total, before.total);
      assert.equal(after.stages.settled, 0);
      assert.equal(after.stages.revoked, 1);
      assert.ok(after.revokedLatestAt);
      const { rowsOf } = await import("@/lib/settlements/upsert");
      const clRows = rowsOf<{ at: string }>(
        await db.execute(sql`
      SELECT created_at::text AS at FROM correction_log
      WHERE subject_id = ${purchase.id}::text
      ORDER BY created_at DESC LIMIT 1
    `),
      );
      assert.ok(Math.abs(Date.parse(after.revokedLatestAt!) - Date.parse(clRows[0]!.at)) < 2000);

      const { getEndpointPurchases } = await import("@/lib/observatory/reader");
      const endpointPurchases = await getEndpointPurchases(ep.id);
      assert.ok(endpointPurchases);
      const row = endpointPurchases!.purchases.find((p) => p.txHash === "0xrevoke");
      assert.ok(row);
      assert.equal(row!.stage, "revoked");
      assert.ok(row!.revokedAt);
      const clIso = toIsoUtc(clRows[0]!.at);
      assert.ok(clIso);
      assert.equal(row!.revokedAt!.slice(0, 19), clIso!.slice(0, 19), "revokedAt matches correction_log to the second");
    });

    test("settled correction out and back is settled not revoked", async () => {
      const { getDb } = await import("@/lib/db/client");
      const schema = await import("@/lib/db/schema");
      const { updateWithCorrection } = await import("@/lib/observatory/corrections");
      const db = getDb()!;
      await db.execute(sql`TRUNCATE correction_log, x402_l1_purchases, x402_endpoints CASCADE`);

      const [ep] = await db
        .insert(schema.x402Endpoints)
        .values({
          resourceKey: "revert.example/api",
          resourceUrl: "https://revert.example/api",
          network: "eip155:8453",
          method: "GET",
          payTo: `0x${"ee".repeat(20)}`,
        })
        .returning();

      const [purchase] = await db
        .insert(schema.x402L1Purchases)
        .values({
          endpointId: ep.id,
          status: "settled",
          httpStatusPaid: 202,
          txHash: "0xrevert",
          authNonce: "revert-nonce",
          spentUnits: "1000",
          amountUnits: "1000",
          network: "eip155:8453",
          attemptedAt: new Date("2026-10-02T00:00:00Z"),
        })
        .returning();

      await updateWithCorrection(db, {
        update: sql`
          UPDATE x402_l1_purchases SET status = 'settle_claim_refuted' WHERE id = ${purchase.id}::uuid
          RETURNING id::text AS correction_subject_id, status
        `,
        subjectType: "purchase",
        level: "l1",
        reason: "settlement_backfill",
        before: { json: { status: "settled" } },
        after: { json: { status: "settle_claim_refuted" } },
      });
      await updateWithCorrection(db, {
        update: sql`
          UPDATE x402_l1_purchases SET status = 'settled' WHERE id = ${purchase.id}::uuid
          RETURNING id::text AS correction_subject_id, status
        `,
        subjectType: "purchase",
        level: "l1",
        reason: "settlement_backfill",
        before: { json: { status: "settle_claim_refuted" } },
        after: { json: { status: "settled" } },
      });

      const lifecycle = await getPurchaseLifecycleCounts(db);
      assert.equal(lifecycle.stages.settled, 1);
      assert.equal(lifecycle.stages.revoked, 0);
      assert.equal(lifecycle.revokedLatestAt, null);

      const revokedMap = await loadRevokedAtByPurchaseId(db, [purchase.id]);
      assert.ok(revokedMap.has(purchase.id), "correction_log still records the settled exit");
      const stage = purchaseStageOf(
        {
          status: "settled",
          httpStatusPaid: 202,
          txHash: "0xrevert",
          authNonce: "revert-nonce",
          attemptedAt: purchase.attemptedAt,
          network: "eip155:8453",
        },
        null,
      );
      assert.equal(stage, "settled");

      const { getEndpointPurchases } = await import("@/lib/observatory/reader");
      const result = await getEndpointPurchases(ep.id);
      const pub = result!.purchases[0];
      assert.equal(pub!.stage, "settled");
      assert.equal(pub!.revokedAt, null);
    });
  });
}
