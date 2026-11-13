// P3 運用画面（DB あり）
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  test("ops dashboard pg (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("ops dashboard buyer, seller, and webhook delivery", async (t) => {
    const { getDb } = await import("@/lib/db/client");
    const { sql, eq } = await import("drizzle-orm");
    const { createApiKey } = await import("@/lib/db/api-keys");
    const {
      createWebhook,
      setWebhookDeliveryForTests,
      isSafeWebhookUrl,
    } = await import("@/lib/webhooks");
    const { webhooks } = await import("@/lib/db/schema");
    const {
      fetchBuyerKeyUsage,
      fetchBuyerPayments,
      fetchSellerOpsFromDb,
      setDisputePurchaseLimitForTests,
    } = await import("@/lib/dashboard/ops-data");
    const { dispatchOpsDigest } = await import("@/lib/dashboard/ops-notify");
    const { buildBuyerCard } = await import("@/lib/dashboard/ops-card");
    const { memoryE6Store, setE6StoreForTests } = await import("@/lib/observatory/e6-store");
    const { mergeE6Record } = await import("@/lib/observatory/e6-record");
    const { resourceId, endpointHash, payeeId } = await import("@/lib/ids/canonical");
    const prevPepper = process.env.API_KEY_PEPPER;
    process.env.API_KEY_PEPPER = process.env.API_KEY_PEPPER ?? "ops-dashboard-test-pepper-32ch";

    const db = getDb()!;
    await db.execute(
      sql`TRUNCATE webhooks, decision_usage_daily, x402_payments, x402_l1_purchases, x402_l0_probes, x402_endpoints RESTART IDENTITY CASCADE`,
    );

    const keyA = await createApiKey({ name: "ops-buyer-a" });
    const keyB = await createApiKey({ name: "ops-buyer-b" });
    const today = new Date().toISOString().slice(0, 10);
    await db.execute(sql`
      INSERT INTO decision_usage_daily (day, api_key_id, chain, count)
      VALUES (${today}::date, ${keyA.id}::uuid, 'eip155:8453', 5),
             (${today}::date, ${keyB.id}::uuid, 'eip155:8453', 99)
    `);
    await db.execute(sql`
      INSERT INTO x402_payments (wallet, tx_hash, network, resource, payee, onchain_amount, token, amount_verified, api_key_id, ownership_verified)
      VALUES ('0x0000000000000000000000000000000000000001', ${"0x" + "a1".repeat(32)}, 'base', 'https://a', '0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea', '1000000', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', true, ${keyA.id}::uuid, true),
             ('0x0000000000000000000000000000000000000002', ${"0x" + "a2".repeat(32)}, 'base', 'https://b', '0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea', '2000000', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', false, ${keyA.id}::uuid, true),
             ('0x0000000000000000000000000000000000000003', ${"0x" + "a3".repeat(32)}, 'base', 'https://c', '0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea', '3000000', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', true, ${keyB.id}::uuid, true)
    `);

    const usageA = await fetchBuyerKeyUsage(keyA.id);
    assert.equal(usageA.total, 5);
    assert.equal(usageA.byChain[0]?.count, 5);
    const payA = await fetchBuyerPayments(keyA.id);
    assert.equal(payA.paymentCount, 2);
    assert.equal(payA.verifiedUsdcUnitsSum, "1000000");
    assert.equal(payA.unverifiedOnChainCount, 1);

    const PAY_TO = "0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea";
    const OTHER = "0x00000000000000000000000000000000000000ee";
    const URL = "https://seller-ops.example/api";
    const RID = resourceId("GET", URL);

    const insertEndpoint = async (
      resourceKey: string,
      url: string,
      payTo: string,
      status: string,
    ): Promise<string> => {
      const epRows = (await db.execute(sql`
        INSERT INTO x402_endpoints (resource_key, resource_url, method, network, pay_to, price_amount, price_asset,
                                    canonical_url, resource_id, endpoint_hash, payee_id, status)
        VALUES (${resourceKey}, ${url}, 'GET', 'eip155:8453', ${payTo}, '1000', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
                ${url}, ${resourceId("GET", url)}, ${endpointHash(url)}, ${payeeId("eip155:8453", payTo)}, ${status})
        RETURNING id::text AS id
      `)) as { rows?: { id: string }[] } | { id: string }[];
      return (Array.isArray(epRows) ? epRows[0] : epRows.rows?.[0])!.id;
    };

    const endpointMain = await insertEndpoint("seller-ops", URL, PAY_TO, "active");
    const endpointPass = await insertEndpoint("seller-ops-pass", "https://seller-ops.example/pass", PAY_TO, "active");
    const endpointFail = await insertEndpoint("seller-ops-fail", "https://seller-ops.example/fail", PAY_TO, "active");
    const endpointWithdrawn = await insertEndpoint(
      "seller-ops-wdn",
      "https://seller-ops.example/wdn",
      PAY_TO,
      "delisted",
    );
    const endpointUnverified = await insertEndpoint(
      "seller-ops-unv",
      "https://seller-ops.example/unv",
      PAY_TO,
      "active",
    );
    await insertEndpoint("seller-ops-other", "https://other.example/api", OTHER, "active");

    await db.execute(sql`
      INSERT INTO x402_l0_probes (endpoint_id, method, verdict, http_status, fail_reason, probed_at)
      VALUES (${endpointPass}::uuid, 'GET', 'pass', 200, null, '2026-01-01T00:00:00Z'),
             (${endpointFail}::uuid, 'GET', 'fail', 402, 'no_402', '2026-01-02T00:00:00Z'),
             (${endpointFail}::uuid, 'GET', 'fail', 402, 'no_402', '2026-01-01T00:00:00Z'),
             (${endpointWithdrawn}::uuid, 'GET', 'fail', 402, 'no_402', '2026-01-02T00:00:00Z'),
             (${endpointWithdrawn}::uuid, 'GET', 'fail', 402, 'no_402', '2026-01-01T00:00:00Z')
    `);

    const purchaseInsert = (await db.execute(sql`
      INSERT INTO x402_l1_purchases (endpoint_id, status, network, asset, pay_to, amount_units, spent_units, payer, tx_hash, http_status_paid, payload_non_empty)
      VALUES (${endpointMain}::uuid, 'settled', 'eip155:8453', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', ${PAY_TO}, '500000', '500000',
              '0xabc', ${"0x" + "b1".repeat(32)}, 200, true)
      RETURNING id::text AS id
    `)) as { rows?: { id: string }[] } | { id: string }[];
    const purchaseId = (Array.isArray(purchaseInsert) ? purchaseInsert[0] : purchaseInsert.rows?.[0])!.id;

    await db.execute(sql`
      INSERT INTO x402_l1_purchases (endpoint_id, status, network, pay_to, amount_units, spent_units, payer, tx_hash, http_status_paid, payload_non_empty)
      VALUES
        (${endpointMain}::uuid, 'settled', 'eip155:8453', ${PAY_TO}, '1', '1', '0xabc', ${"0x" + "b2".repeat(32)}, 404, true),
        (${endpointMain}::uuid, 'settle_claimed', 'eip155:8453', ${PAY_TO}, '1', '0', '0xabc', null, null, false),
        (${endpointMain}::uuid, 'settle_failed', 'eip155:8453', ${PAY_TO}, '1', '0', '0xabc', null, 500, false),
        (${endpointMain}::uuid, 'settle_failed', 'eip155:8453', ${OTHER}, '1', '0', '0xabc', null, 500, false)
    `);

    const rec = mergeE6Record(null, {
      purchaseId,
      payer: { paymentTx: "0x1", receivedBodyHash: null, state: "settled" },
      seller: { paymentVerified: null, deliveredBodyHash: null, deliverySignature: null },
    });
    const store = memoryE6Store({ [purchaseId]: rec });
    setE6StoreForTests(store);

    const seller = await fetchSellerOpsFromDb(PAY_TO);
    assert.equal(seller.revenue.measurementSettledCount, 2);
    assert.equal(seller.revenue.measurementSettledUnitsSum, "500001");
    assert.equal(seller.revenue.reportedVerifiedCount, 2);
    assert.equal(seller.revenue.reportedVerifiedUnitsSum, "4000000");
    assert.equal(seller.disputes.recordsPresent, 1);
    assert.equal(seller.l1.attempts, 4);
    assert.equal(seller.l1.delivered, 1);
    assert.equal(seller.l1.inconclusive, 1);
    assert.equal(seller.l1.awaitingReread, 1);
    assert.equal(seller.reputation.pass, 1);
    assert.equal(seller.reputation.fail, 1);
    assert.equal(seller.reputation.withdrawn, 1);
    assert.equal(seller.reputation.unverified, 2);
    assert.equal(seller.disputes.truncated, false);
    assert.equal(seller.disputes.purchaseIdsChecked, 4);

    const other = await fetchSellerOpsFromDb(OTHER);
    assert.equal(other.disputes.recordsPresent, 0);
    assert.equal(other.revenue.measurementSettledCount, 0);
    assert.equal(other.l1.attempts, 1);
    assert.equal(other.l1.delivered, 0);
    assert.equal(other.l1.inconclusive, 0);
    assert.equal(other.l1.awaitingReread, 0);

    setE6StoreForTests(null);

    const deliveries: { type: string; headers: Record<string, string>; host: string; ip?: string }[] = [];
    const publicUrl = "https://hooks.example.com/vet402";
    assert.equal(isSafeWebhookUrl(publicUrl), true);
    const created = await createWebhook({
      apiKeyId: keyA.id,
      url: publicUrl,
      events: ["ops.digest"],
    });
    assert.ok("id" in created);
    const badHttp = await createWebhook({
      apiKeyId: keyA.id,
      url: "http://hooks.example.com/vet402",
      events: ["ops.digest"],
    });
    assert.equal("error" in badHttp, true);
    if ("error" in badHttp) assert.equal(badHttp.error, "unsafe_url");

    const publicIp = "93.184.216.34";
    setWebhookDeliveryForTests({
      resolve: async () => [{ address: publicIp, family: 4 }],
      post: async (_url, ip, body, headers) => {
        const parsed = JSON.parse(body) as { type: string };
        deliveries.push({ type: parsed.type, headers, host: _url.hostname, ip });
        return true;
      },
    });
    const card = buildBuyerCard({
      yourKey: { total: 0, byChain: [], days: 30 },
      payments: { paymentCount: 0, verifiedUsdcUnitsSum: "0", unverifiedOnChainCount: 0 },
      measurementL1: { attempts: 0, delivered: 0, inconclusive: 0, awaitingReread: 0 },
    });
    await dispatchOpsDigest(keyA.id, card);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]?.type, "ops.digest");
    assert.equal(deliveries[0]?.ip, publicIp);
    assert.ok(deliveries[0]?.headers["Vouch-Signature"]);

    const privateHook = await createWebhook({
      apiKeyId: keyA.id,
      url: "https://private-hooks.example.com/vet402",
      events: ["ops.digest"],
    });
    assert.ok("id" in privateHook);
    const privateDeliveriesBefore = deliveries.length;
    setWebhookDeliveryForTests({
      resolve: async (hostname) =>
        hostname === "private-hooks.example.com"
          ? [{ address: "10.0.0.5", family: 4 }]
          : [{ address: publicIp, family: 4 }],
      post: async (_url, ip, body, headers) => {
        const parsed = JSON.parse(body) as { type: string };
        deliveries.push({ type: parsed.type, headers, host: _url.hostname, ip });
        return true;
      },
    });
    await dispatchOpsDigest(keyA.id, card);
    const newDeliveries = deliveries.slice(privateDeliveriesBefore);
    assert.equal(newDeliveries.some((d) => d.host === "private-hooks.example.com"), false);

    const [httpRow] = await db
      .insert(webhooks)
      .values({
        apiKeyId: keyA.id,
        url: "http://injected.example/hook",
        secret: "whsec_plaintest",
        events: ["ops.digest"],
        active: true,
      })
      .returning();
    setWebhookDeliveryForTests({
      resolve: async () => [{ address: publicIp, family: 4 }],
      post: async (url, ip, body, headers) => {
        const parsed = JSON.parse(body) as { type: string };
        deliveries.push({ type: parsed.type, headers, host: url.hostname, ip });
        return true;
      },
    });
    const beforeHttp = deliveries.length;
    await dispatchOpsDigest(keyA.id, card);
    const httpDeliveries = deliveries
      .slice(beforeHttp)
      .filter((d) => d.host === "injected.example");
    assert.equal(httpDeliveries.length, 0);
    await db.delete(webhooks).where(eq(webhooks.id, httpRow!.id));

    setWebhookDeliveryForTests(null);
    if (prevPepper === undefined) delete process.env.API_KEY_PEPPER;
    else process.env.API_KEY_PEPPER = prevPepper;
  });

  test("seller disputes count only dispute stages on this seller's purchases", async () => {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { fetchSellerOpsFromDb } = await import("@/lib/dashboard/ops-data");
    const { buildSellerCard } = await import("@/lib/dashboard/ops-card");
    const { memoryE6Store, setE6StoreForTests } = await import("@/lib/observatory/e6-store");
    const { mergeE6Record } = await import("@/lib/observatory/e6-record");
    const { resourceId, endpointHash, payeeId } = await import("@/lib/ids/canonical");

    const db = getDb()!;
    await db.execute(sql`TRUNCATE x402_l1_purchases, x402_endpoints RESTART IDENTITY CASCADE`);

    const SELLER = "0x2222222222222222222222222222222222222222";
    const OTHER = "0x3333333333333333333333333333333333333333";
    const URL = "https://dispute-stage.example/api";
    const otherUrl = "https://dispute-stage-other.example/api";

    const insertEp = async (payTo: string, url: string) => {
      const resourceKey = url.replace(/^https?:\/\//, "").replace(/\//g, "_");
      const epInsert = (await db.execute(sql`
        INSERT INTO x402_endpoints (resource_key, resource_url, method, network, pay_to, price_amount, price_asset,
                                    canonical_url, resource_id, endpoint_hash, payee_id, status)
        VALUES (${resourceKey}, ${url}, 'GET', 'eip155:8453', ${payTo}, '1000', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
                ${url}, ${resourceId("GET", url)}, ${endpointHash(url)}, ${payeeId("eip155:8453", payTo)}, 'active')
        RETURNING id::text AS id
      `)) as { rows?: { id: string }[] } | { id: string }[];
      return (Array.isArray(epInsert) ? epInsert[0] : epInsert.rows?.[0])!.id;
    };

    const sellerEp = await insertEp(SELLER, URL);
    const otherEp = await insertEp(OTHER, otherUrl);

    const insertPurchase = async (endpointId: string, payTo: string) => {
      const row = (await db.execute(sql`
        INSERT INTO x402_l1_purchases (endpoint_id, status, network, pay_to, amount_units, spent_units, payer)
        VALUES (${endpointId}::uuid, 'settled', 'eip155:8453', ${payTo}, '1', '1', '0xabc')
        RETURNING id::text AS id
      `)) as { rows?: { id: string }[] } | { id: string }[];
      return (Array.isArray(row) ? row[0] : row.rows?.[0])!.id;
    };

    const sellerPurchaseId = await insertPurchase(sellerEp, SELLER);
    const otherPurchaseId = await insertPurchase(otherEp, OTHER);

    const matchedBody = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const sellerNoStage = mergeE6Record(null, {
      purchaseId: sellerPurchaseId,
      payer: { paymentTx: "0xaa", receivedBodyHash: matchedBody, state: "settled" },
      seller: { paymentVerified: null, deliveredBodyHash: matchedBody, deliverySignature: null },
    });
    const otherDispute = mergeE6Record(null, {
      purchaseId: otherPurchaseId,
      payer: { paymentTx: "0xbb", receivedBodyHash: null, state: "settled" },
      seller: { paymentVerified: null, deliveredBodyHash: null, deliverySignature: null },
    });

    setE6StoreForTests(memoryE6Store({ [sellerPurchaseId]: sellerNoStage, [otherPurchaseId]: otherDispute }));
    try {
      let raw = await fetchSellerOpsFromDb(SELLER);
      assert.equal(raw.disputes.recordsPresent, 1);
      assert.equal(raw.disputes.disputeCount, 0);
      let card = buildSellerCard(raw);
      assert.equal(card.disputes.state, "empty");

      const disputePurchaseId = await insertPurchase(sellerEp, SELLER);
      const sellerDispute = mergeE6Record(null, {
        purchaseId: disputePurchaseId,
        payer: { paymentTx: "0xcc", receivedBodyHash: null, state: "settled" },
        seller: { paymentVerified: null, deliveredBodyHash: null, deliverySignature: null },
      });
      setE6StoreForTests(
        memoryE6Store({
          [sellerPurchaseId]: sellerNoStage,
          [otherPurchaseId]: otherDispute,
          [disputePurchaseId]: sellerDispute,
        }),
      );
      raw = await fetchSellerOpsFromDb(SELLER);
      assert.equal(raw.disputes.disputeCount, 1);
      card = buildSellerCard(raw);
      assert.equal(card.disputes.state, "has_data");
    } finally {
      setE6StoreForTests(null);
    }
  });

  test("seller dispute purchase limit counts latest purchases only", async () => {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { fetchSellerOpsFromDb, setDisputePurchaseLimitForTests } = await import(
      "@/lib/dashboard/ops-data"
    );
    const { memoryE6Store, setE6StoreForTests } = await import("@/lib/observatory/e6-store");
    const { mergeE6Record } = await import("@/lib/observatory/e6-record");
    const { resourceId, endpointHash, payeeId } = await import("@/lib/ids/canonical");

    const db = getDb()!;
    await db.execute(sql`TRUNCATE x402_l1_purchases, x402_endpoints RESTART IDENTITY CASCADE`);

    const WALLET = "0x1111111111111111111111111111111111111111";
    const URL = "https://limit-test.example/api";
    const epInsert = (await db.execute(sql`
      INSERT INTO x402_endpoints (resource_key, resource_url, method, network, pay_to, price_amount, price_asset,
                                  canonical_url, resource_id, endpoint_hash, payee_id, status)
      VALUES ('limit-test', ${URL}, 'GET', 'eip155:8453', ${WALLET}, '1000', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
              ${URL}, ${resourceId("GET", URL)}, ${endpointHash(URL)}, ${payeeId("eip155:8453", WALLET)}, 'active')
      RETURNING id::text AS id
    `)) as { rows?: { id: string }[] } | { id: string }[];
    const endpointId = (Array.isArray(epInsert) ? epInsert[0] : epInsert.rows?.[0])!.id;

    const purchaseIds: string[] = [];
    for (const at of ["2026-02-01T00:00:00Z", "2026-02-02T00:00:00Z", "2026-02-03T00:00:00Z"] as const) {
      const row = (await db.execute(sql`
        INSERT INTO x402_l1_purchases (endpoint_id, status, network, pay_to, amount_units, spent_units, payer, attempted_at)
        VALUES (${endpointId}::uuid, 'settled', 'eip155:8453', ${WALLET}, '1', '1', '0xabc', ${at}::timestamptz)
        RETURNING id::text AS id
      `)) as { rows?: { id: string }[] } | { id: string }[];
      purchaseIds.push((Array.isArray(row) ? row[0] : row.rows?.[0])!.id);
    }
    const oldestId = purchaseIds[0]!;

    setDisputePurchaseLimitForTests(2);
    try {
      let out = await fetchSellerOpsFromDb(WALLET);
      assert.equal(out.disputes.purchaseIdsChecked, 2);
      assert.equal(out.disputes.truncated, true);

      const rec = mergeE6Record(null, {
        purchaseId: oldestId,
        payer: { paymentTx: "0x1", receivedBodyHash: null, state: "settled" },
        seller: { paymentVerified: null, deliveredBodyHash: null, deliverySignature: null },
      });
      setE6StoreForTests(memoryE6Store({ [oldestId]: rec }));

      out = await fetchSellerOpsFromDb(WALLET);
      assert.equal(out.disputes.recordsPresent, 0);
      assert.equal(out.disputes.truncated, true);

      setDisputePurchaseLimitForTests(3);
      out = await fetchSellerOpsFromDb(WALLET);
      assert.equal(out.disputes.truncated, false);
      assert.equal(out.disputes.purchaseIdsChecked, 3);
      assert.equal(out.disputes.recordsPresent, 1);
    } finally {
      setDisputePurchaseLimitForTests(null);
      setE6StoreForTests(null);
    }
  });
}
