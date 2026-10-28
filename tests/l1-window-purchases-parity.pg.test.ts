// ============================================================
// fetchL1WindowPurchaseRows が loadSellerFacts 内の旧 SELECT と同じ assembleSellerFacts 結果を返す（2026-10-28 点検残り 1）。
//
// Run: TEST_DATABASE_URL=postgres://takeshi@localhost:5432/vet402_test_feed \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-window-purchases-parity.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 window purchases parity (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("fetchL1WindowPurchaseRows matches legacy SELECT and loadSellerFacts facts", async () => {
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const { L1_WINDOW_DAYS } = await import("@/lib/decision/rules");
    const { fetchL1WindowPurchaseRows, purchaseInputFromL1WindowRow } = await import("@/lib/decision/l1-window-purchases");
    const { assembleSellerFacts, loadSellerFacts, SIGNED_STATUSES } = await import("@/lib/decision/seller-facts");
    const { DELIVERED_HTTP_MIN, DELIVERED_HTTP_MAX, ACCEPTED_NOT_DONE_HTTP } = await import("@/lib/observatory/delivery");
    const { readRecordSides } = await import("@/lib/sellers/reader");
    const db = getDb()!;
    const rowsOf = <T>(raw: unknown) => (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];

    await db.execute(sql`TRUNCATE x402_endpoints, x402_l0_probes, x402_l1_purchases`);

    const [ep] = await db
      .insert(schema.x402Endpoints)
      .values({
        resourceKey: "parity-window.example/api",
        resourceUrl: "https://parity-window.example/api",
        canonicalUrl: "https://parity-window.example/api",
        network: "eip155:8453",
        method: "POST",
        payTo: "0x1111111111111111111111111111111111111111",
        payeeId: "eip155:8453:0x1111111111111111111111111111111111111111",
        declaredSchema: { properties: { input: { properties: { body: { type: "object" } } } } },
      })
      .returning();

    let txSeq = 0;
    const tx = () => `0x${(++txSeq).toString(16).padStart(64, "0")}`;
    const day = (d: number) => new Date(Date.now() - d * 86_400_000);

    await db.insert(schema.x402L1Purchases).values([
      {
        endpointId: ep.id,
        attemptedAt: day(5),
        status: "settled",
        network: "eip155:8453",
        httpStatusPaid: 200,
        payloadNonEmpty: true,
        txHash: tx(),
        amountUnits: "1000",
        spentUnits: "1000",
        rawResponseMeta: { requestBody: "declared-body", requestQuery: { q: "1" }, contentType: "application/json" },
      },
      {
        endpointId: ep.id,
        attemptedAt: day(4),
        status: "settled",
        network: "eip155:8453",
        httpStatusPaid: 422,
        payloadNonEmpty: false,
        txHash: tx(),
        amountUnits: "1000",
        spentUnits: "1000",
      },
      {
        endpointId: ep.id,
        attemptedAt: day(3),
        status: "settle_failed",
        network: "eip155:8453",
        httpStatusPaid: 502,
        txHash: tx(),
        amountUnits: "1000",
        spentUnits: "1000",
        settlementVerified: true,
      },
      {
        endpointId: ep.id,
        attemptedAt: day(2),
        status: "no_402",
        network: "eip155:8453",
        spentUnits: "0",
        amountUnits: "1000",
      },
      {
        endpointId: ep.id,
        attemptedAt: day(40),
        status: "settled",
        network: "eip155:8453",
        httpStatusPaid: 200,
        payloadNonEmpty: true,
        txHash: tx(),
        amountUnits: "1000",
        spentUnits: "1000",
      },
    ]);

    const legacyRows = rowsOf<Record<string, unknown>>(
      await db.execute(sql`
        SELECT attempted_at::text AS attempted_at, status, latency_ms, http_status_paid, payload_non_empty, l2_schema, tx_hash, network,
               to_char(attempted_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS attempted_at_utc,
               CASE WHEN jsonb_typeof(raw_response_meta) = 'object' THEN left(raw_response_meta->>'contentType', 60) END AS content_type,
               raw_response_meta->'l2' AS l2_detail,
               CASE WHEN l2_schema = 'mismatch' AND jsonb_typeof(raw_response_meta) = 'object' THEN left(raw_response_meta->>'bodyHead', 500) END AS body_head,
               CASE WHEN jsonb_typeof(raw_response_meta) = 'object' THEN jsonb_strip_nulls(jsonb_build_object(
                 'requestBody', CASE WHEN raw_response_meta ? 'requestBody' THEN
                   CASE WHEN jsonb_typeof(raw_response_meta->'requestBody') = 'string' THEN to_jsonb(left(raw_response_meta->>'requestBody', 16)) ELSE 'true'::jsonb END END,
                 'requestQuery', raw_response_meta->'requestQuery')) END AS request_meta,
               amount_units, payer, left(auth_nonce, 80) AS auth_nonce,
               CASE WHEN status = 'settle_failed' AND tx_hash IS NOT NULL THEN
                 (settlement_verified IS TRUE OR EXISTS (SELECT 1 FROM settlements s WHERE s.tx_hash IN (p.tx_hash, lower(p.tx_hash))))
               END AS settlement_confirmed
        FROM x402_l1_purchases p WHERE endpoint_id = ${ep.id}::uuid AND attempted_at > now() - (${L1_WINDOW_DAYS} * interval '1 day')
        ORDER BY attempted_at DESC LIMIT 200
      `),
    );
    const modernRows = await fetchL1WindowPurchaseRows(db, ep.id);
    assert.equal(legacyRows.length, modernRows.length);
    assert.deepEqual(modernRows, legacyRows);

    const sides = await readRecordSides(db, ep.id);
    const purchasesLegacy = legacyRows.map((r) => purchaseInputFromL1WindowRow(r, sides));
    const purchasesModern = modernRows.map((r) => purchaseInputFromL1WindowRow(r, sides));
    assert.deepEqual(purchasesModern, purchasesLegacy);

    const loaded = await loadSellerFacts(ep.id);
    assert.ok(loaded);

    const probes = rowsOf<Record<string, unknown>>(
      await db.execute(sql`
        SELECT probed_at::text AS probed_at, verdict, dialect, fail_reason, price_consistent, metadata_consistent
        FROM x402_l0_probes WHERE endpoint_id = ${ep.id}::uuid AND probed_at > now() - interval '30 days'
        ORDER BY probed_at DESC LIMIT 200
      `),
    );
    const { getSettlementCounts } = await import("@/lib/settlements/census");
    const { toIsoUtc } = await import("@/lib/util/iso-utc");
    const signedList = [...SIGNED_STATUSES].map((v) => `'${v.replace(/[^a-z_]/g, "")}'`).join(",");
    const deliveredRowSql = `status = 'settled' AND http_status_paid BETWEEN ${DELIVERED_HTTP_MIN} AND ${DELIVERED_HTTP_MAX} AND http_status_paid <> ${ACCEPTED_NOT_DONE_HTTP} AND payload_non_empty IS NOT FALSE`;
    const settlements30d = await getSettlementCounts({ endpointId: ep.id });
    const lastAttemptRows = rowsOf<{ attempted_at: string | null; status: string | null }>(
      await db.execute(sql`
        SELECT attempted_at::text AS attempted_at, status FROM x402_l1_purchases WHERE endpoint_id = ${ep.id}::uuid
        ORDER BY attempted_at DESC LIMIT 1
      `),
    );
    const lastSignedRows = rowsOf<{ last_signed: string | null; last_delivered: string | null }>(
      await db.execute(sql`
        SELECT max(attempted_at) FILTER (WHERE status IN (${sql.raw(signedList)}))::text AS last_signed,
               max(attempted_at) FILTER (WHERE ${sql.raw(deliveredRowSql)})::text AS last_delivered
        FROM x402_l1_purchases WHERE endpoint_id = ${ep.id}::uuid
      `),
    );
    const factsInput = {
      probes: probes.map((r) => ({
        probedAt: String(r.probed_at),
        verdict: String(r.verdict),
        dialect: r.dialect === null ? null : String(r.dialect),
        failReason: r.fail_reason === null ? null : String(r.fail_reason),
        priceAmount: r.price_consistent === false ? "changed" : "declared",
        priceAsset: null,
        payTo: r.metadata_consistent === false ? "changed" : "declared",
      })),
      purchases: purchasesLegacy,
      settlements30d,
      payees: ep.payeeId ? [ep.payeeId] : [],
      declaredSchema: ep.declaredSchema ?? null,
      method: ep.method,
      declaredInput: ep.declaredInput ?? null,
      lastAttemptAt: toIsoUtc(lastAttemptRows[0]?.attempted_at ?? null),
      lastSignedAttemptAt: toIsoUtc(lastSignedRows[0]?.last_signed ?? null),
      lastDeliveredAt: toIsoUtc(lastSignedRows[0]?.last_delivered ?? null),
    };
    const factsFromLegacyPurchases = assembleSellerFacts(factsInput);
    assert.deepEqual(loaded!.facts, factsFromLegacyPurchases);
  });
}
