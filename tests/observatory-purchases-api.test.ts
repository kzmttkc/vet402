// ============================================================
// vet402 Observatory — public purchases API (要件定義v2 2026-08-14 §2.1-1).
//
// The moat is the receipt time-series: n-of-m settle-through per endpoint,
// each settled row carrying its on-chain tx hash. The /observatory/e/[id]
// page already renders this — these tests drive the same facts through a
// key-less machine-readable JSON API so a counterparty can pull the evidence
// without trusting our HTML.
//
// Two layers under test:
//  1. reader: getEndpointPurchases() — aggregation lives in the reader, not
//     the route, so the page and the API can never disagree.
//  2. route: GET /api/v1/observatory/endpoints/[id]/purchases — key-less,
//     IP-rate-limited like the other public paths, facts only (every row
//     including settle_failed — the record is the point, not the wins).
//
// DB-backed parts skip without TEST_DATABASE_URL (same convention as
// observatory-reader.test.ts).
// ============================================================
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

const TEST_DB = process.env.TEST_DATABASE_URL;

// ---- Route-level input validation (no DB required) ----

test("purchases API rejects a non-uuid id with 400 (never touches the DB)", async () => {
  const { GET } = await import("@/app/api/v1/observatory/endpoints/[id]/purchases/route");
  const res = await GET(
    new NextRequest("http://localhost/api/v1/observatory/endpoints/not-a-uuid/purchases"),
    { params: Promise.resolve({ id: "not-a-uuid" }) },
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, "invalid_endpoint_id");
});

test("purchases API rejects a path-traversal id with 400", async () => {
  const { GET } = await import("@/app/api/v1/observatory/endpoints/[id]/purchases/route");
  const res = await GET(
    new NextRequest("http://localhost/api/v1/observatory/endpoints/x/purchases"),
    { params: Promise.resolve({ id: "../../etc/passwd" }) },
  );
  assert.equal(res.status, 400);
});

test("purchases API responses carry RateLimit headers (key-less public path contract)", async () => {
  const { GET } = await import("@/app/api/v1/observatory/endpoints/[id]/purchases/route");
  const res = await GET(
    new NextRequest("http://localhost/api/v1/observatory/endpoints/x/purchases"),
    { params: Promise.resolve({ id: "not-a-uuid" }) },
  );
  assert.ok(res.headers.get("RateLimit-Limit"), "RateLimit-Limit must be present");
});

// ---- Reader + route against a real Postgres ----

if (!TEST_DB) {
  test("observatory purchases reader/route (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = TEST_DB;

  // The local-postgres driver keeps a connection pool open, which would pin
  // the event loop after the tests finish (observed: 216s hang). Close it.
  after(async () => {
    const { getDb } = await import("@/lib/db/client");
    const db = getDb() as unknown as { $client?: { end?: () => Promise<void> } } | null;
    await db?.$client?.end?.();
  });

  test("purchases reader and route publish the receipt series with honest totals", async (t) => {
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const { getEndpointPurchases } = await import("@/lib/observatory/reader");
    const { GET } = await import("@/app/api/v1/observatory/endpoints/[id]/purchases/route");

    const db = getDb()!;
    await db.execute(
      sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_l1_purchases`,
    );

    const [endpoint] = await db
      .insert(schema.x402Endpoints)
      .values({
        resourceKey: "seller.example/api",
        resourceUrl: "https://seller.example/api",
        method: "GET",
        network: "eip155:8453",
        payTo: "0xaa",
        status: "active",
      })
      .returning();

    await db.insert(schema.x402L1Purchases).values([
      {
        endpointId: endpoint.id,
        status: "settled",
        amountUnits: "3000",
        spentUnits: "3000",
        txHash: "0xreceipt1",
        httpStatusPaid: 200,
        latencyMs: 420,
        payloadNonEmpty: true,
        l2Schema: "match",
      },
      {
        endpointId: endpoint.id,
        status: "settle_failed",
        amountUnits: "3000",
        spentUnits: "3000",
        latencyMs: 900,
      },
      {
        endpointId: endpoint.id,
        status: "settled",
        amountUnits: "5000",
        spentUnits: "5000",
        txHash: "0xreceipt2",
        httpStatusPaid: 200,
        latencyMs: 300,
        payloadNonEmpty: true,
        l2Schema: "no_declaration",
      },
      // Non-paid rows: our own budget throttle and a network error. Money never
      // moved on these, so they must NOT enter the seller's denominator — same
      // definition of "paid attempt" the /observatory/state API uses. Counting
      // them would publish a lower settle rate than the seller actually earned.
      {
        endpointId: endpoint.id,
        status: "budget_denied",
        amountUnits: "3000",
        // spentUnits defaults to "0" — no money moved.
      },
      {
        endpointId: endpoint.id,
        status: "request_error",
      },
    ]);

    await t.test("reader aggregates settled/attempts and keeps failed rows", async () => {
      const result = await getEndpointPurchases(endpoint.id);
      assert.ok(result);
      // 3 paid attempts (settled, settle_failed, settled) — budget_denied and
      // request_error are excluded from the denominator (no payment happened).
      assert.equal(result!.attemptCount, 3);
      assert.equal(result!.settledCount, 2);
      // 2/3 = 66.7 — one decimal, computed not stored. NOT 2/5 = 40.
      assert.equal(result!.settleRatePct, 66.7);
      assert.equal(result!.purchases.length, 3);
      // settle_failed rows are part of the record (facts, not wins).
      assert.ok(result!.purchases.some((p) => p.status === "settle_failed"));
      // Non-paid statuses never appear in the receipt series.
      assert.ok(
        !result!.purchases.some(
          (p) => p.status === "budget_denied" || p.status === "request_error",
        ),
        "budget_denied / request_error must not appear in the receipt series",
      );
      // Receipts travel with the rows.
      const hashes = result!.purchases.map((p) => p.txHash).filter(Boolean);
      assert.deepEqual(new Set(hashes), new Set(["0xreceipt1", "0xreceipt2"]));
    });

    await t.test("reader returns null for an unknown (but valid) uuid", async () => {
      assert.equal(await getEndpointPurchases("00000000-0000-4000-8000-000000000000"), null);
    });

    await t.test("route returns 200 with endpoint identity, series and aggregates", async () => {
      const res = await GET(
        new NextRequest(`http://localhost/api/v1/observatory/endpoints/${endpoint.id}/purchases`),
        { params: Promise.resolve({ id: endpoint.id }) },
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.endpointId, endpoint.id);
      assert.equal(body.resourceKey, "seller.example/api");
      assert.equal(body.attemptCount, 3);
      assert.equal(body.settledCount, 2);
      assert.equal(body.settleRatePct, 66.7);
      // 既存の列は残したまま、バッジと同じ分母の値を足す（行の分類が読めない時は null）
      assert.ok(body.vet402SideCount === null || typeof body.vet402SideCount === "number");
      assert.equal(typeof body.vet402SideNote, "string");
      if (body.vet402SideCount !== null) assert.equal(body.attemptCountExcludingVet402Side, body.attemptCount - body.vet402SideCount);
      assert.equal(body.purchases.length, 3);
      // No evaluative vocabulary anywhere in the payload (facts only).
      const raw = JSON.stringify(body).toLowerCase();
      assert.ok(!raw.includes("score"), "payload must not carry 'score'");
      assert.ok(!raw.includes("rating"), "payload must not carry 'rating'");
    });

    await t.test("route returns 404 for an unknown endpoint", async () => {
      const res = await GET(
        new NextRequest(
          "http://localhost/api/v1/observatory/endpoints/00000000-0000-4000-8000-000000000000/purchases",
        ),
        { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000000" }) },
      );
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.equal(body.error, "endpoint_not_found");
    });

    await t.test("an endpoint with zero purchases reports an empty series, not an error", async () => {
      const [bare] = await db
        .insert(schema.x402Endpoints)
        .values({
          resourceKey: "quiet.example/api",
          resourceUrl: "https://quiet.example/api",
          status: "active",
        })
        .returning();
      const result = await getEndpointPurchases(bare.id);
      assert.ok(result);
      assert.equal(result!.attemptCount, 0);
      assert.equal(result!.settledCount, 0);
      // 0/0 is not a rate — null, never a fabricated 0 or 100.
      assert.equal(result!.settleRatePct, null);
      assert.deepEqual(result!.purchases, []);
    });
  });
}
