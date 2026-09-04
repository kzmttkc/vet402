// ============================================================
// §7.2 決済索引（DB）: L1 購入は test・confirmed で入り、冪等。payments_api 行は
// 封筒と突き合わせて confirmed / probable。センサスは生値と実需を両方返す。
// §7.3: L1 の受取先が payee に結びつき、tx から resource が逆引きできる。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  test("settlements ingest (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = TEST_DB;

  test("settlements ingest", async (t) => {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { ingestL1 } = await import("@/lib/settlements/ingest-l1");
    const { ingestPayments } = await import("@/lib/settlements/ingest-payments");
    const { getCensusSummary, getSettlementCounts } = await import("@/lib/settlements/census");
    const { resourceId, endpointHash, payeeId } = await import("@/lib/ids/canonical");
    const db = getDb()!;
    await db.execute(sql`TRUNCATE settlements, settlement_daily, x402_l1_purchases, x402_payments, x402_endpoints, funder_wallets, indexer_checkpoints`);

    const URL = "https://seller.example/api/quote";
    const PAY_TO = "0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea";
    const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const OUR_PAYER = "0x0000000000000000000000000000000000000abc";
    const RID = resourceId("GET", URL);
    const [ep] = (await db.execute(sql`
      INSERT INTO x402_endpoints (resource_key, resource_url, method, network, pay_to, price_amount, price_asset,
                                  canonical_url, resource_id, endpoint_hash, payee_id)
      VALUES ('seller.example/api/quote', ${URL}, 'GET', 'eip155:8453', ${PAY_TO}, '3000', ${USDC},
              ${URL}, ${RID}, ${endpointHash(URL)}, ${payeeId("eip155:8453", PAY_TO)})
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const endpointId = (Array.isArray(ep) ? (ep as unknown as { id: string }[])[0] : ep).id;

    await db.execute(sql`
      INSERT INTO x402_l1_purchases (endpoint_id, status, network, asset, pay_to, amount_units, spent_units, payer, tx_hash, http_status_paid, payload_non_empty)
      VALUES (${endpointId}::uuid, 'settled', 'eip155:8453', ${USDC}, ${PAY_TO}, '3000', '3000', ${OUR_PAYER}, ${"0x" + "1".repeat(64)}, 200, true)
    `);

    await t.test("L1 購入は confirmed / test で入り、再実行は冪等", async () => {
      const r1 = await ingestL1();
      assert.equal(r1.inserted, 1);
      const r2 = await ingestL1();
      assert.equal(r2.inserted, 0);
      assert.equal(r2.updated, 1);
      const rows = (await db.execute(sql`SELECT purchase_id, attribution, wash_flag, payee_id, resource_id, endpoint_id::text AS endpoint_id FROM settlements`)) as unknown as Record<string, string>[];
      const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows as Record<string, string>[]);
      assert.equal(list.length, 1);
      assert.equal(list[0].purchase_id, `eip155:8453:0x${"1".repeat(64)}`);
      assert.equal(list[0].attribution, "confirmed");
      assert.equal(list[0].wash_flag, "test");
      assert.equal(list[0].payee_id, payeeId("eip155:8453", PAY_TO));
      assert.equal(list[0].resource_id, RID);
      assert.equal(list[0].endpoint_id, endpointId);
    });

    await t.test("payments_api: 封筒一致は confirmed、amount 不一致は probable、第三者なので wash none", async () => {
      const buyer = "0x00000000000000000000000000000000000000b1";
      await db.execute(sql`
        INSERT INTO x402_payments (wallet, tx_hash, network, resource, payee, onchain_amount, token, ownership_verified, block_timestamp)
        VALUES (${buyer}, ${"0x" + "2".repeat(64)}, 'base', ${URL}, ${PAY_TO}, '3000', ${USDC}, true, now()),
               (${buyer}, ${"0x" + "3".repeat(64)}, 'base', NULL, ${PAY_TO}, '2999', ${USDC}, true, now())
      `);
      const r = await ingestPayments();
      assert.equal(r.inserted, 2);
      assert.equal(r.attribution.confirmed, 1);
      assert.equal(r.attribution.probable, 1);
      const rows = (await db.execute(sql`SELECT tx_hash, attribution, wash_flag, endpoint_id::text AS endpoint_id FROM settlements WHERE source = 'payments_api' ORDER BY tx_hash`)) as unknown;
      const list = (Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows) as Record<string, string>[];
      assert.equal(list[0].attribution, "confirmed");
      assert.equal(list[0].wash_flag, "none");
      assert.equal(list[0].endpoint_id, endpointId);
      assert.equal(list[1].attribution, "probable"); // payee から逆引きで endpoint が 1 件に定まる
      assert.equal(list[1].endpoint_id, endpointId);
    });

    await t.test("同一 funder の買い手は self_deal（実需から外れる）", async () => {
      const buyer2 = "0x00000000000000000000000000000000000000b2";
      await db.execute(sql`INSERT INTO funder_wallets (funder, wallet) VALUES ('0xf00d', ${buyer2}), ('0xf00d', ${PAY_TO})`);
      await db.execute(sql`
        INSERT INTO x402_payments (wallet, tx_hash, network, resource, payee, onchain_amount, token, ownership_verified, block_timestamp)
        VALUES (${buyer2}, ${"0x" + "4".repeat(64)}, 'base', ${URL}, ${PAY_TO}, '3000', ${USDC}, true, now())
      `);
      await ingestPayments();
      const rows = (await db.execute(sql`SELECT wash_flag FROM settlements WHERE tx_hash = ${"0x" + "4".repeat(64)}`)) as unknown;
      const list = (Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows) as { wash_flag: string }[];
      assert.equal(list[0].wash_flag, "self_deal");
    });

    await t.test("knownPurchaseIds: 索引済みの purchase_id を 1 文でまとめて引ける（配列パラメータ）", async () => {
      const { knownPurchaseIds } = await import("@/lib/settlements/upsert");
      const known = await knownPurchaseIds([`eip155:8453:0x${"1".repeat(64)}`, "eip155:8453:0xnope"]);
      assert.equal(known.size, 1);
      assert.equal((await knownPurchaseIds([])).size, 0);
    });

    await t.test("束ね upsert: 同一 purchase_id が 1 バッチに 2 回あっても落ちない（同一 tx 複数 Transfer）", async () => {
      const { upsertSettlementsBatch, buildRow } = await import("@/lib/settlements/upsert");
      const mk = (amount: string) =>
        buildRow(
          { chain: "eip155:8453", txHash: "0x" + "7".repeat(64), asset: "0xusdc", amount, payer: "0xp", payee: PAY_TO, blockTime: new Date(), source: "chain_index" },
          { attribution: "probable", washFlag: "none", resourceId: null, endpointId: null },
        );
      const r = await upsertSettlementsBatch([mk("1"), mk("2")]);
      assert.equal(r.inserted, 1);
      assert.equal(r.updated, 0);
    });

    await t.test("センサス: 生値 4・実需 2（test 1・self_deal 1 を除外）が同じ応答に両方出る", async () => {
      const c = await getCensusSummary(null, "30d");
      assert.equal(c.settlements_raw, 5);
      assert.equal(c.settlements_real, 3);
      assert.equal(c.wash.test, 1);
      assert.equal(c.wash.self_deal, 1);
      assert.equal(c.unique_payers_real, 2); // b1 と 0xp（束ね upsert テストの chain_index 行）
      assert.equal(c.by_source.l1_purchase, 1);
      assert.equal(c.by_source.payments_api, 3);
      assert.equal(c.by_source.chain_index, 1);
      const per = await getSettlementCounts({ endpointId });
      assert.deepEqual(per, { raw: 4, real: 2, test: 1, uniquePayersReal: 1 }); // endpoint 紐付きの行だけ（chain_index 行は endpoint null）
    });
  });
}
