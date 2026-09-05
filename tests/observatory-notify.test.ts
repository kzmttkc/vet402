// ============================================================
// vet402 Observatory L0 — delisting notifications (design §6).
//
// Claim-join and double-send guard under test:
//  - a delisting event reaches exactly the api keys whose watcher row binds
//    a wallet equal to the endpoint's payTo (signature-proved binding at
//    registration — reusing the Verified Payee proof-of-control pattern);
//  - notified=true after processing, so a re-run delivers nothing;
//  - events with no watcher are still marked processed (the queue stays
//    bounded; notifications are about fresh events, not backfill).
// Delivery machinery itself (HMAC, SSRF, auto-disable) is the existing
// webhook stack, already unit-tested — here dispatch is a spy.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

// ---- canonical message (pure) ----------------------------------------------

test("observatoryWatchMessage binds wallet and api key in fixed lines", async () => {
  const { observatoryWatchMessage } = await import("@/lib/verify-message");
  const msg = observatoryWatchMessage("0xABCDEF0000000000000000000000000000000001", "key_123");
  assert.equal(
    msg,
    [
      // 2026-09-05 (S-6): 名乗りを `vet402.com — …` へ統一し domain 行を必須化。
      "vet402.com — observatory watch registration",
      "domain: vet402.com",
      "wallet: 0xabcdef0000000000000000000000000000000001",
      "apiKey: key_123",
      "This signature authorizes delisting notifications for endpoints paying the wallet above. It moves no funds.",
    ].join("\n"),
  );
});

// ---- notifier (DB integration) ---------------------------------------------

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("observatory notify integration (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = TEST_DB;

  test("delisting events notify claiming watchers exactly once", async (t) => {
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { notifyDelistedEvents } = await import("@/lib/observatory/notify");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");

    const db = getDb()!;
    await db.execute(
      sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers`,
    );

    const mk = (n: number) =>
      parseCatalogItem({
        resource: `https://svc${n}.example/api`,
        accepts: [
          { amount: "1000", asset: "0xUSDC", network: "eip155:8453", payTo: `0xPAY${n}` },
        ],
        extensions: { bazaar: { info: { input: { method: "GET" } } } },
      });

    // day 1: both listed; day 2: both vanish → two delisted events.
    await syncCatalog({
      fetchResult: { items: [mk(1), mk(2)], totalCount: 2, fetchedCount: 2, complete: true },
      today: "2026-08-14",
    });
    // Watcher claims svc1's payTo only (note: parseCatalogItem lowercases).
    await db
      .insert(schema.x402PayeeWatchers)
      .values({ wallet: "0xpay1", apiKeyId: "11111111-1111-4111-8111-111111111111" });
    await syncCatalog({
      fetchResult: { items: [], totalCount: 0, fetchedCount: 0, complete: true },
      today: "2026-08-15",
    });

    const dispatched: { apiKeyId: string; event: string; payload: unknown }[] = [];
    const spy = async (apiKeyId: string | null, event: string, payload: unknown) => {
      dispatched.push({ apiKeyId: String(apiKeyId), event, payload });
    };

    await t.test("first run: claimed event dispatched, all events marked notified", async () => {
      const summary = await notifyDelistedEvents({ dispatch: spy });
      assert.equal(summary.processed, 2);
      assert.equal(summary.dispatched, 1);
      assert.equal(dispatched.length, 1);
      assert.equal(dispatched[0].apiKeyId, "11111111-1111-4111-8111-111111111111");
      assert.equal(dispatched[0].event, "endpoint.delisted");
      const p = dispatched[0].payload as Record<string, unknown>;
      assert.equal(p.resourceKey, "svc1.example/api");
      assert.equal(p.payTo, "0xpay1");
      assert.equal(p.detectedOn, "2026-08-15");

      const events = await db.select().from(schema.x402DelistingEvents);
      assert.equal(events.every((e) => e.notified), true);
    });

    await t.test("second run: nothing left to deliver", async () => {
      const summary = await notifyDelistedEvents({ dispatch: spy });
      assert.equal(summary.processed, 0);
      assert.equal(dispatched.length, 1);
    });
  });
}
