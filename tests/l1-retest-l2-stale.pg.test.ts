// ============================================================
// Re-buy of a listing whose latest delivery missed declared keys and whose last attempt is older than 30 days.
//
// What this pins:
//  1. Picks: active listing, latest delivery is a mismatch with named keys, last attempt of any kind older than 30 days.
//  2. Does not pick: a recent attempt (delivered or not), a later clean delivery, a mismatch with no named key,
//     a listing no longer active, one with no declared schema. A later 2xx with an empty body is not a delivery, so the
//     mismatch stays the latest delivery and the listing is picked.
//  3. The purchase goes through the ordinary path, with selection = retest, and the row is the failed listing itself,
//     never another listing of the same seller.
//  4. The next batch does not buy it again (the new row makes the last attempt recent).
//  5. On a census flag off day this lane marks no row. A cooldown listing stays out.
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_census_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-retest-l2-stale.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const FUNDED_PAYER = async () => 1_000_000_000n;
const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 retest l2 stale (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const DAY = 86_400_000;
  const ago = (days: number) => new Date(Date.now() - days * DAY);

  test("L1 retest of a stale named-key mismatch", async (t) => {
    const { runL1Batch, readRetestL2StaleListings } = await import("@/lib/observatory/l1-runner");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { BASE_USDC } = await import("@/lib/observatory/x402-payer");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");

    const db = getDb()!;
    const rowsOf = (raw: unknown) => (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];

    const KEYS = [
      "OBSERVATORY_L1_ENABLED",
      "OBSERVATORY_WALLET_PRIVATE_KEY",
      "OBSERVATORY_SOLANA_L1_ENABLED",
      "OBSERVATORY_ARC_L1_ENABLED",
      "OBSERVATORY_TEMPO_L1_ENABLED",
      "L1_LANE_FLOOR_PER_RUN",
      "OBSERVATORY_L1_CENSUS",
      "OBSERVATORY_L1_CENSUS_MIN_PER_RUN",
      "OBSERVATORY_L1_RETEST_LISTINGS",
    ] as const;
    const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    t.after(() => {
      for (const k of KEYS) {
        const v = saved[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
    const arm = (on: boolean) => {
      process.env.OBSERVATORY_L1_ENABLED = "true";
      process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
      delete process.env.OBSERVATORY_SOLANA_L1_ENABLED;
      delete process.env.OBSERVATORY_ARC_L1_ENABLED;
      delete process.env.OBSERVATORY_TEMPO_L1_ENABLED;
      delete process.env.L1_LANE_FLOOR_PER_RUN;
      delete process.env.OBSERVATORY_L1_CENSUS_MIN_PER_RUN;
      delete process.env.OBSERVATORY_L1_RETEST_LISTINGS;
      if (on) process.env.OBSERVATORY_L1_CENSUS = "on";
      else delete process.env.OBSERVATORY_L1_CENSUS;
    };

    type Past = { status: string; http: number | null; days: number; l2?: "mismatch" | "match" | "not_checked"; missing?: string[]; reason?: string | null; emptyBody?: boolean };
    type Listing = { url: string; amount: string; payTo: string; declares: boolean; past: Past[]; status?: string };
    const listings: Listing[] = [];
    let n = 0;
    const add = (url: string, amount: string, past: Past[], opts: Partial<Listing> = {}) => {
      n++;
      listings.push({ url, amount, payTo: `0x${(n % 15 + 1).toString(16).repeat(40)}`, declares: true, past, ...opts });
    };
    const STALE: Past = { status: "settled", http: 200, days: 40, l2: "mismatch", missing: ["b"], reason: "missing_keys" };

    add("https://picked.example/dear", "5000", [STALE]);
    add("https://picked.example/cheap", "100", [{ status: "settled", http: 200, days: 3 }], { declares: false });
    add("https://recent.example/api", "1000", [{ ...STALE, days: 20 }]);
    add("https://recent-fail.example/api", "1000", [STALE, { status: "settle_failed", http: 500, days: 5 }]);
    add("https://later-clean.example/api", "1000", [STALE, { status: "settled", http: 200, days: 35, l2: "match" }]);
    add("https://nokey.example/api", "1000", [{ ...STALE, missing: [], reason: "unparseable" }]);
    add("https://gone.example/api", "1000", [STALE], { status: "delisted" });
    add("https://nodecl.example/api", "1000", [STALE], { declares: false });
    add("https://cooldown.example/api", "1000", [
      STALE,
      { status: "settle_failed", http: 500, days: 39 },
      { status: "settle_failed", http: 500, days: 38 },
      { status: "settle_failed", http: 500, days: 37 },
    ]);
    add("https://afterfail.example/api", "2000", [STALE, { status: "settle_failed", http: 500, days: 39 }]);
    add("https://emptybody.example/api", "3000", [STALE, { status: "settled", http: 200, days: 39, emptyBody: true }]);

    const byUrl = new Map(listings.map((l) => [l.url, l]));
    const challengeFor = (url: string) => {
      const l = byUrl.get(url)!;
      return JSON.stringify({
        x402Version: 2,
        accepts: [{ scheme: "exact", network: "eip155:8453", amount: l.amount, asset: BASE_USDC, payTo: l.payTo, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }],
      });
    };
    let txSeq = 0;
    const wall = () => {
      const seen: { url: string; paid: boolean }[] = [];
      const fetchImpl = async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const paid = headers.has("PAYMENT-SIGNATURE") || headers.has("X-PAYMENT");
        seen.push({ url, paid });
        if (!paid) return new Response(challengeFor(url), { status: 402, headers: { "content-type": "application/json" } });
        txSeq++;
        return new Response(JSON.stringify({ a: 1, b: 2 }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "PAYMENT-RESPONSE": Buffer.from(
              JSON.stringify({ success: true, transaction: `0x${(0xcafe0000 + txSeq).toString(16).padStart(64, "0")}`, network: "eip155:8453", payer: "0x0000000000000000000000000000000000000001" }),
            ).toString("base64"),
          },
        });
      };
      return { seen, fetchImpl, paidUrls: () => seen.filter((s) => s.paid).map((s) => s.url) };
    };
    const idOf = async (url: string) => String(rowsOf(await db.execute(sql`SELECT id FROM x402_endpoints WHERE resource_url = ${url}`))[0].id);

    async function seed() {
      await db.execute(sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases, observed_purchases`);
      const items = listings.map((l) =>
        parseCatalogItem({
          resource: l.url,
          accepts: [{ amount: l.amount, asset: BASE_USDC, network: "eip155:8453", payTo: l.payTo }],
          extensions: {
            bazaar: {
              info: { input: { method: "GET" } },
              ...(l.declares
                ? { schema: { type: "object", properties: { output: { type: "object", properties: { example: { type: "object", required: ["a", "b"], properties: { a: { type: "number" }, b: { type: "number" } } } } } } } }
                : {}),
            },
          },
          quality: { l30DaysTotalCalls: 10, l30DaysUniquePayers: 1 },
        }),
      );
      await syncCatalog({ fetchResult: { items, totalCount: items.length, fetchedCount: items.length, complete: true }, today: new Date().toISOString().slice(0, 10) });
      await runL0ProbeBatch({
        limit: 200,
        concurrency: 4,
        fetchImpl: async (url: string) => new Response(challengeFor(url), { status: 402, headers: { "content-type": "application/json" } }),
      });
      for (const l of listings) {
        const id = await idOf(l.url);
        if (l.status) await db.execute(sql`UPDATE x402_endpoints SET status = ${l.status} WHERE id = ${id}::uuid`);
        for (const p of l.past) {
          await db.insert(schema.x402L1Purchases).values({
            endpointId: id,
            status: p.status,
            payer: "0x0000000000000000000000000000000000000001",
            network: "eip155:8453",
            asset: BASE_USDC,
            payTo: l.payTo,
            amountUnits: l.amount,
            spentUnits: "0",
            httpStatusPaid: p.http,
            payloadNonEmpty: p.http === 200 && p.emptyBody !== true,
            l2Schema: p.l2 ?? null,
            attemptedAt: ago(p.days),
            rawResponseMeta: {
              phase: "paid",
              contentType: "application/json",
              bodyHead: '{"a":1}',
              ...(p.l2 ? { l2: { missing: p.missing ?? [], responseHash: "h".repeat(64), declarationHash: "d".repeat(64), reason: p.reason ?? null } } : {}),
            },
          });
        }
      }
    }

    const run = (w: ReturnType<typeof wall>) => runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER, limit: 10, fetchImpl: w.fetchImpl });

    await t.test("the read returns only the stale named-key mismatches, by listing", async () => {
      arm(true);
      await seed();
      const r = await readRetestL2StaleListings(db);
      assert.ok(r);
      assert.deepEqual(
        (JSON.parse(r.preferredIdsJson) as string[]).sort(),
        [
          await idOf("https://picked.example/dear"),
          await idOf("https://cooldown.example/api"),
          await idOf("https://afterfail.example/api"),
          await idOf("https://emptybody.example/api"),
        ].sort(),
      );
      assert.deepEqual(JSON.parse(r.sellerHostsJson!), [], "no seller-wide pick: another listing of the seller is never bought through this");
      assert.equal(r.hostCount, 4);
    });

    await t.test("the batch buys the failed listing itself with selection retest, not the seller's cheaper listing, and not twice", async () => {
      arm(true);
      await seed();
      const w = wall();
      await run(w);
      const paid = w.paidUrls();
      const retested = rowsOf(await db.execute(sql`
        SELECT e.resource_url FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id
        WHERE pu.raw_response_meta->>'selection' = 'retest' ORDER BY 1`)).map((r) => String(r.resource_url));
      // Other listings can still be bought by the ordinary sweep. What this lane chose is what carries selection = retest.
      assert.deepEqual(retested, ["https://afterfail.example/api", "https://emptybody.example/api", "https://picked.example/dear"]);
      assert.ok(paid.includes("https://picked.example/dear"), paid.join(","));
      assert.ok(!paid.includes("https://picked.example/cheap"), "another listing of the seller is not bought");
      assert.ok(!paid.includes("https://cooldown.example/api"), "the cooldown still holds");
      assert.ok(!paid.includes("https://gone.example/api"));
      const rows = rowsOf(await db.execute(sql`
        SELECT pu.raw_response_meta->>'selection' AS selection, pu.status, pu.l2_schema
        FROM x402_l1_purchases pu WHERE pu.endpoint_id = ${await idOf("https://picked.example/dear")}::uuid ORDER BY pu.attempted_at DESC LIMIT 1`));
      assert.equal(rows[0].selection, "retest");
      assert.equal(rows[0].l2_schema, "match", "the seller fixed it: the new delivery clears the mismatch");

      const after = await readRetestL2StaleListings(db);
      assert.deepEqual(JSON.parse(after!.preferredIdsJson), [await idOf("https://cooldown.example/api")], "a new row takes the listing out of the set");
      const w2 = wall();
      await run(w2);
      assert.ok(!w2.paidUrls().includes("https://picked.example/dear"), "the next batch does not buy it again");
    });

    await t.test("the census flag off: no retest candidate and no row marked retest", async () => {
      arm(false);
      await seed();
      const w = wall();
      const summary = await run(w);
      assert.equal(summary.retestCandidates, 0);
      const marked = rowsOf(await db.execute(sql`SELECT count(*)::int AS n FROM x402_l1_purchases WHERE raw_response_meta->>'selection' = 'retest'`));
      assert.equal(marked[0].n, 0);
    });
  });
}
