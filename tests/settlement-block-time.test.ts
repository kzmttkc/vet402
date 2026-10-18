// 公開の block_time は台帳時刻。照合の完了時刻は使わない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { chainBlockTime } from "@/lib/settlements/ingest-l1";
import { blockTimeSourceFromRaw } from "@/lib/resolve/lookup";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

test("chainBlockTime keeps a real instant and drops garbage", () => {
  assert.equal(chainBlockTime("2026-10-11T02:30:47.000Z")?.toISOString(), "2026-10-11T02:30:47.000Z");
  assert.equal(chainBlockTime(null), null);
  assert.equal(chainBlockTime(undefined), null);
  assert.equal(chainBlockTime(""), null);
  assert.equal(chainBlockTime("not-a-time"), null);
});

test("blockTimeSourceFromRaw names the clock, and the old verification label stays verified_at", () => {
  assert.equal(blockTimeSourceFromRaw({ blockTimeSource: "chain" }), "chain");
  assert.equal(blockTimeSourceFromRaw({ blockTimeSource: "attempted_at", kept: 1 }), "attempted_at");
  assert.equal(blockTimeSourceFromRaw({ blockTimeSource: "settlement_verified_at" }), "verified_at");
  assert.equal(blockTimeSourceFromRaw({}), null);
  assert.equal(blockTimeSourceFromRaw(null), null);
  assert.equal(blockTimeSourceFromRaw('{"blockTimeSource":"chain"}'), "chain");
  assert.equal(blockTimeSourceFromRaw("not-json"), null);
});

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  test("settlement block time (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const PAY_TO = "0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea";
  const PAYER = "0x1111111111111111111111111111111111111111";
  const EVM_TX = `0x${"11".repeat(32)}`;
  const STELLAR_TX = `0x${"22".repeat(32)}`;
  const NULL_TX = `0x${"33".repeat(32)}`;
  const EVM_ISO = "2026-10-11T02:30:47.000Z";
  const STELLAR_ISO = "2026-10-11T03:04:05.000Z";

  function rowsOf<T>(raw: unknown): T[] {
    return (Array.isArray(raw) ? raw : ((raw as { rows?: T[] }).rows ?? [])) as T[];
  }

  function asObject(value: unknown): Record<string, unknown> {
    if (typeof value === "string") return JSON.parse(value) as Record<string, unknown>;
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    return {};
  }

  test("settlement block time is the ledger clock", async (t) => {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const schema = await import("@/lib/db/schema");
    const { randomUUID } = await import("node:crypto");
    const { runSettlementVerification } = await import("@/lib/observatory/settlement-verifier");
    const { resolve, settlementByTx } = await import("@/lib/resolve/lookup");
    const { ingestL1 } = await import("@/lib/settlements/ingest-l1");
    const { buildRow, upsertSettlement } = await import("@/lib/settlements/upsert");
    const { purchaseId } = await import("@/lib/ids/canonical");
    const { resourceId, endpointHash, payeeId } = await import("@/lib/ids/canonical");
    const db = getDb()!;

    async function reset() {
      await db.execute(sql`
        TRUNCATE settlements, settlement_daily, x402_l1_purchases, x402_endpoints, observed_purchases, correction_log
      `);
    }

    await t.test("EVM and Stellar success store settlementBlockTime, a null timestamp does not", async () => {
      await reset();
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
      await db.insert(schema.x402L1Purchases).values([
        {
          endpointId,
          status: "settle_claimed",
          network: "eip155:8453",
          payTo: PAY_TO,
          payer: PAYER,
          amountUnits: "1000",
          spentUnits: "1000",
          txHash: EVM_TX,
          rawResponseMeta: { kept: "evm" },
        },
        {
          endpointId,
          status: "settle_claimed",
          network: "stellar:pubnet",
          payTo: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
          payer: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
          amountUnits: "10000000",
          spentUnits: "10000000",
          txHash: STELLAR_TX,
          rawResponseMeta: { kept: "stellar" },
        },
        {
          endpointId,
          status: "settle_claimed",
          network: "eip155:8453",
          payTo: PAY_TO,
          payer: PAYER,
          amountUnits: "1000",
          spentUnits: "1000",
          txHash: NULL_TX,
          rawResponseMeta: { kept: "nil" },
        },
      ]);

      const summary = await runSettlementVerification({
        limit: 10,
        deps: {
          registryHooks: { l1: async () => {}, l2: async () => {} },
          verify: async (input) => {
            if (input.txHash === NULL_TX) {
              return { ok: true, blockTimestamp: null, confirmations: 1n, blockNumber: 3n };
            }
            const iso = input.txHash === STELLAR_TX ? STELLAR_ISO : EVM_ISO;
            return { ok: true, blockTimestamp: new Date(iso), confirmations: 40n, blockNumber: 79785089n };
          },
        },
      });
      assert.equal(summary.verified, 3);

      const stored = rowsOf<{ tx_hash: string; raw_response_meta: unknown }>(
        await db.execute(sql`SELECT tx_hash, raw_response_meta FROM x402_l1_purchases`),
      );
      const byTx = new Map(stored.map((row) => [row.tx_hash, asObject(row.raw_response_meta)]));
      assert.equal(byTx.get(EVM_TX)?.kept, "evm");
      assert.equal(byTx.get(EVM_TX)?.settlementBlockTime, EVM_ISO);
      assert.equal(byTx.get(STELLAR_TX)?.kept, "stellar");
      assert.equal(byTx.get(STELLAR_TX)?.settlementBlockTime, STELLAR_ISO);
      assert.equal(byTx.get(NULL_TX)?.kept, "nil");
      assert.equal(Object.hasOwn(byTx.get(NULL_TX) ?? {}, "settlementBlockTime"), false);

      const evm = await resolve(EVM_TX);
      assert.equal(evm.settlement?.block_time_source, "chain");
      assert.equal(new Date(evm.settlement?.block_time ?? "").toISOString(), EVM_ISO);
      assert.equal("raw" in (evm.settlement ?? {}), false);

      const stellar = await settlementByTx(STELLAR_TX);
      assert.equal(stellar?.block_time_source, "chain");
      assert.equal(new Date(stellar?.block_time ?? "").toISOString(), STELLAR_ISO);

      const missing = await settlementByTx(NULL_TX);
      assert.equal(missing?.block_time_source, "attempted_at");
      assert.notEqual(new Date(missing?.block_time ?? "").toISOString(), EVM_ISO);
    });

    await t.test("ingest prefers the ledger time, falls back to attempted_at, and overwrites an old block_time", async () => {
      await reset();
      const url = "https://seller.example/api/block-time";
      const rid = resourceId("GET", url);
      const inserted = rowsOf<{ id: string }>(
        await db.execute(sql`
          INSERT INTO x402_endpoints (resource_key, resource_url, method, network, pay_to, price_amount, price_asset,
                                      canonical_url, resource_id, endpoint_hash, payee_id)
          VALUES ('seller.example/api/block-time', ${url}, 'GET', 'eip155:8453', ${PAY_TO}, '3000', '0xusdc',
                  ${url}, ${rid}, ${endpointHash(url)}, ${payeeId("eip155:8453", PAY_TO)})
          RETURNING id::text AS id
        `),
      );
      const endpointId = inserted[0].id;
      const chainTx = `0x${"55".repeat(32)}`;
      const attemptTx = `0x${"44".repeat(32)}`;
      const garbageTx = `0x${"77".repeat(32)}`;
      const chainIso = "2026-10-11T02:30:47.000Z";
      const attemptIso = "2026-10-11T02:30:47.000Z";
      const verifiedIso = "2026-10-11T05:45:07.000Z";
      const garbageAttempt = "2026-10-11T04:00:00.000Z";

      await db.execute(sql`
        INSERT INTO x402_l1_purchases
          (endpoint_id, status, network, asset, pay_to, amount_units, spent_units, payer, tx_hash,
           attempted_at, settlement_verified_at, raw_response_meta)
        VALUES
          (${endpointId}::uuid, 'settled', 'eip155:8453', '0xusdc', ${PAY_TO}, '3000', '3000', ${PAYER}, ${chainTx},
           ${"2026-10-11T01:00:00.000Z"}::timestamptz, ${verifiedIso}::timestamptz,
           ${JSON.stringify({ settlementBlockTime: chainIso, kept: "meta" })}::jsonb),
          (${endpointId}::uuid, 'settled', 'eip155:8453', '0xusdc', ${PAY_TO}, '3000', '3000', ${PAYER}, ${attemptTx},
           ${attemptIso}::timestamptz, ${verifiedIso}::timestamptz, ${JSON.stringify({ kept: "row" })}::jsonb),
          (${endpointId}::uuid, 'settled', 'eip155:8453', '0xusdc', ${PAY_TO}, '3000', '3000', ${PAYER}, ${garbageTx},
           ${garbageAttempt}::timestamptz, ${verifiedIso}::timestamptz,
           ${JSON.stringify({ settlementBlockTime: "not-a-time" })}::jsonb)
      `);
      await db.execute(sql`
        INSERT INTO settlements
          (chain, tx_hash, purchase_id, attribution, wash_flag, source, block_time, raw)
        VALUES
          ('eip155:8453', ${attemptTx}, ${purchaseId("eip155:8453", attemptTx)}, 'confirmed', 'test', 'l1_purchase',
           ${verifiedIso}::timestamptz, ${JSON.stringify({ blockTimeSource: "settlement_verified_at", kept: "idx" })}::jsonb)
      `);

      const outcome = await ingestL1();
      assert.equal(outcome.scanned, 3);
      assert.equal(outcome.inserted, 2);
      assert.equal(outcome.updated, 1);

      const chain = await resolve(chainTx);
      assert.equal(chain.settlement?.block_time_source, "chain");
      assert.equal(new Date(chain.settlement?.block_time ?? "").toISOString(), chainIso);

      const attempt = await resolve(attemptTx);
      assert.equal(attempt.settlement?.block_time_source, "attempted_at");
      assert.equal(new Date(attempt.settlement?.block_time ?? "").toISOString(), attemptIso);
      const attemptRaw = rowsOf<{ raw: unknown }>(
        await db.execute(sql`SELECT raw FROM settlements WHERE tx_hash = ${attemptTx}`),
      );
      assert.equal(asObject(attemptRaw[0].raw).kept, "idx");
      assert.equal(asObject(attemptRaw[0].raw).blockTimeSource, "attempted_at");

      const garbage = await resolve(garbageTx);
      assert.equal(garbage.settlement?.block_time_source, "attempted_at");
      assert.equal(new Date(garbage.settlement?.block_time ?? "").toISOString(), garbageAttempt);

      const oldTx = `0x${"66".repeat(32)}`;
      await db.execute(sql`
        INSERT INTO settlements
          (chain, tx_hash, purchase_id, attribution, wash_flag, source, block_time, raw)
        VALUES
          ('eip155:8453', ${oldTx}, ${purchaseId("eip155:8453", oldTx)}, 'confirmed', 'test', 'l1_purchase',
           ${verifiedIso}::timestamptz, ${JSON.stringify({ blockTimeSource: "settlement_verified_at" })}::jsonb)
      `);
      const old = await resolve(oldTx);
      assert.equal(old.settlement?.block_time_source, "verified_at");
      assert.equal(new Date(old.settlement?.block_time ?? "").toISOString(), verifiedIso);

      const payTx = `0x${"88".repeat(32)}`;
      const pay = (raw: unknown, when: string) =>
        buildRow(
          {
            chain: "eip155:8453",
            txHash: payTx,
            asset: "0xusdc",
            amount: "1",
            payer: PAYER,
            payee: PAY_TO,
            blockTime: new Date(when),
            source: "payments_api",
            raw,
          },
          { attribution: "probable", washFlag: "none", resourceId: null, endpointId: null },
        );
      await upsertSettlement(pay({ paymentRowId: "old", keep: true }, "2026-10-01T00:00:00.000Z"));
      await upsertSettlement(pay({ paymentRowId: "new" }, "2026-10-02T00:00:00.000Z"));
      const payRaw = rowsOf<{ raw: unknown }>(
        await db.execute(sql`SELECT raw FROM settlements WHERE tx_hash = ${payTx}`),
      );
      assert.equal(asObject(payRaw[0].raw).paymentRowId, "old");
      assert.equal(asObject(payRaw[0].raw).keep, true);
    });

    await t.test("a verified row without settlementBlockTime becomes chain from observed_purchases", async () => {
      await reset();
      const url = "https://seller.example/api/observed-block-time";
      const rid = resourceId("GET", url);
      const inserted = rowsOf<{ id: string }>(
        await db.execute(sql`
          INSERT INTO x402_endpoints (resource_key, resource_url, method, network, pay_to, price_amount, price_asset,
                                      canonical_url, resource_id, endpoint_hash, payee_id)
          VALUES ('seller.example/api/observed-block-time', ${url}, 'GET', 'eip155:8453', ${PAY_TO}, '3000', '0xusdc',
                  ${url}, ${rid}, ${endpointHash(url)}, ${payeeId("eip155:8453", PAY_TO)})
          RETURNING id::text AS id
        `),
      );
      const endpointId = inserted[0].id;
      const observedTx = `0x${"a1".repeat(32)}`;
      const bothTx = `0x${"a2".repeat(32)}`;
      const garbageObservedTx = `0x${"a3".repeat(32)}`;
      const observedIso = "2026-10-11T08:15:09.000Z";
      const storedIso = "2026-10-11T02:30:47.000Z";
      const laterIso = "2026-10-11T09:00:00.000Z";
      const attemptIso = "2026-10-11T01:00:00.000Z";

      const purchases = rowsOf<{ id: string; tx_hash: string }>(
        await db.execute(sql`
          INSERT INTO x402_l1_purchases
            (endpoint_id, status, network, asset, pay_to, amount_units, spent_units, payer, tx_hash,
             attempted_at, raw_response_meta)
          VALUES
            (${endpointId}::uuid, 'settled', 'eip155:8453', '0xusdc', ${PAY_TO}, '3000', '3000', ${PAYER}, ${observedTx},
             ${attemptIso}::timestamptz, ${JSON.stringify({ kept: "observed" })}::jsonb),
            (${endpointId}::uuid, 'settled', 'eip155:8453', '0xusdc', ${PAY_TO}, '3000', '3000', ${PAYER}, ${bothTx},
             ${attemptIso}::timestamptz, ${JSON.stringify({ settlementBlockTime: storedIso })}::jsonb),
            (${endpointId}::uuid, 'settled', 'eip155:8453', '0xusdc', ${PAY_TO}, '3000', '3000', ${PAYER}, ${garbageObservedTx},
             ${attemptIso}::timestamptz, ${JSON.stringify({ settlementBlockTime: "not-a-time" })}::jsonb)
          RETURNING id::text AS id, tx_hash
        `),
      );
      const idOf = (tx: string) => purchases.find((row) => row.tx_hash === tx)!.id;
      await db.execute(sql`
        INSERT INTO observed_purchases (wallet, tx_hash, block_timestamp, observed_by)
        VALUES
          (${PAYER}, ${observedTx}, ${observedIso}::timestamptz, ${"observatory-l1-verified:" + idOf(observedTx)}),
          (${PAYER}, ${bothTx}, ${laterIso}::timestamptz, ${"observatory-l1-verified:" + idOf(bothTx)}),
          (${PAYER}, ${garbageObservedTx}, ${observedIso}::timestamptz, ${"observatory-l1-verified:" + idOf(garbageObservedTx)})
      `);

      const outcome = await ingestL1();
      assert.equal(outcome.scanned, 3);

      const observed = await resolve(observedTx);
      assert.equal(observed.settlement?.block_time_source, "chain");
      assert.equal(new Date(observed.settlement?.block_time ?? "").toISOString(), observedIso);

      const both = await resolve(bothTx);
      assert.equal(both.settlement?.block_time_source, "chain");
      assert.equal(new Date(both.settlement?.block_time ?? "").toISOString(), storedIso);

      const garbage = await resolve(garbageObservedTx);
      assert.equal(garbage.settlement?.block_time_source, "chain");
      assert.equal(new Date(garbage.settlement?.block_time ?? "").toISOString(), observedIso);
    });

    function settled(tx: string, when: string, source: "l1_purchase" | "chain_index" | "payments_api", raw: unknown) {
      return buildRow(
        {
          chain: "eip155:8453",
          txHash: tx,
          asset: "0xusdc",
          amount: "1",
          payer: PAYER,
          payee: PAY_TO,
          blockTime: new Date(when),
          source,
          raw,
        },
        { attribution: "confirmed", washFlag: "test", resourceId: null, endpointId: null },
      );
    }

    await t.test("l1 attempted_at does not overwrite another source's block_time", async () => {
      await reset();
      const tx = `0x${"b1".repeat(32)}`;
      const chainIso = "2026-10-11T02:30:47.000Z";
      const attemptIso = "2026-10-11T01:00:00.000Z";
      await upsertSettlement(
        settled(tx, chainIso, "chain_index", { blockNumber: "79785089", blockTimeSource: "interpolated", kept: "idx" }),
      );
      await upsertSettlement(
        settled(tx, attemptIso, "l1_purchase", { purchaseRowId: "p-fallback", blockTimeSource: "attempted_at" }),
      );

      const row = rowsOf<{ block_time: string; raw: unknown }>(
        await db.execute(sql`SELECT block_time::text AS block_time, raw FROM settlements WHERE tx_hash = ${tx}`),
      );
      assert.equal(new Date(row[0].block_time).toISOString(), chainIso);
      assert.equal(asObject(row[0].raw).blockTimeSource, "interpolated");
      assert.equal(asObject(row[0].raw).kept, "idx");
      assert.equal(Object.hasOwn(asObject(row[0].raw), "purchaseRowId"), false);
      const published = await settlementByTx(tx);
      assert.equal(published?.block_time_source, null);
      assert.equal(new Date(published?.block_time ?? "").toISOString(), chainIso);
    });

    await t.test("another source that rewrites an l1 block_time updates raw.blockTimeSource", async () => {
      await reset();
      const indexedTx = `0x${"c1".repeat(32)}`;
      const paidTx = `0x${"c2".repeat(32)}`;
      const l1Iso = "2026-10-11T01:00:00.000Z";
      const indexedIso = "2026-10-11T02:30:47.000Z";
      const paidIso = "2026-10-11T03:04:05.000Z";
      const laterAttempt = "2026-10-11T04:00:00.000Z";

      await upsertSettlement(
        settled(indexedTx, l1Iso, "l1_purchase", { purchaseRowId: "p-l1", blockTimeSource: "attempted_at", kept: "row" }),
      );
      await upsertSettlement(
        settled(indexedTx, indexedIso, "chain_index", { blockNumber: "9", blockTimeSource: "interpolated" }),
      );
      await upsertSettlement(
        settled(indexedTx, laterAttempt, "l1_purchase", { purchaseRowId: "p-later", blockTimeSource: "attempted_at" }),
      );

      const indexed = rowsOf<{ block_time: string; raw: unknown }>(
        await db.execute(sql`SELECT block_time::text AS block_time, raw FROM settlements WHERE tx_hash = ${indexedTx}`),
      );
      assert.equal(new Date(indexed[0].block_time).toISOString(), indexedIso);
      assert.equal(asObject(indexed[0].raw).blockTimeSource, "interpolated");
      assert.equal(asObject(indexed[0].raw).purchaseRowId, "p-l1");
      assert.equal(asObject(indexed[0].raw).kept, "row");
      assert.equal((await settlementByTx(indexedTx))?.block_time_source, null);

      await upsertSettlement(
        settled(paidTx, l1Iso, "l1_purchase", { purchaseRowId: "p-pay", blockTimeSource: "chain" }),
      );
      await upsertSettlement(settled(paidTx, paidIso, "payments_api", { paymentRowId: "pay-1" }));
      await upsertSettlement(
        settled(paidTx, laterAttempt, "l1_purchase", { purchaseRowId: "p-pay-later", blockTimeSource: "attempted_at" }),
      );
      const paid = rowsOf<{ block_time: string; raw: unknown }>(
        await db.execute(sql`SELECT block_time::text AS block_time, raw FROM settlements WHERE tx_hash = ${paidTx}`),
      );
      assert.equal(new Date(paid[0].block_time).toISOString(), paidIso);
      assert.equal(asObject(paid[0].raw).blockTimeSource, "payments_api");
      assert.equal(asObject(paid[0].raw).purchaseRowId, "p-pay");
      assert.equal((await settlementByTx(paidTx))?.block_time_source, null);
    });
  });
}
