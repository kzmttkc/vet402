// ============================================================
// Bazaar delivery field and routes (no DB).
// Run: env -u DATABASE_URL npx tsx --test tests/bazaar-delivery.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

import { __setDbForTests } from "@/lib/db/client";
import { ipRateLimits } from "@/lib/db/schema";
import { canonicalUrl } from "@/lib/ids/canonical";
import {
  BAZAAR_DELIVERY_FIELD_KEYS,
  BAZAAR_DELIVERY_MAX_ITEMS,
  bazaarCatalogProbeMethod,
  bazaarDeliveryFieldFromFeedPublicRow,
  bazaarItemMethod,
  canonicalResourceLookupKey,
} from "@/lib/delivery/bazaar-field";
import { buildBazaarFeedRowIndex, lookupBazaarDeliveryInSnapshot } from "@/lib/delivery/bazaar-read";
import { resetDeliveryFeedCacheForTest, seedDeliveryFeedCacheForTest } from "@/lib/delivery/sellers-feed-cache";
import { deliveryFeedPublicRow, type DeliveryFeedRow } from "@/lib/delivery/sellers-feed";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

function mockFeedRow(partial: Partial<DeliveryFeedRow> & Pick<DeliveryFeedRow, "url" | "method" | "endpoint_id">): DeliveryFeedRow {
  return {
    network: "eip155:8453",
    price_usd: 0.01,
    listed_in: "bazaar",
    bazaar_payers_30d: 3,
    paid_attempts_30d: 4,
    delivered_30d: 2,
    settled_not_delivered_30d: 1,
    last_attempt_at_30d: "2026-11-20T14:02:11Z",
    last_delivered_at_30d: "2026-11-19T10:00:00Z",
    record_url: `https://vet402.com/observatory/e/${partial.endpoint_id}`,
    window_purchase_networks: ["eip155:8453"],
    ...partial,
  };
}

test("スナップショット行から delivery 欄は deliveryFeedPublicRow と全欄一致", () => {
  const row = mockFeedRow({
    endpoint_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    url: "https://api.example.com/v1/data",
    method: "GET",
    paid_attempts_30d: 12,
    delivered_30d: 8,
    settled_not_delivered_30d: 2,
  });
  const pub = deliveryFeedPublicRow(row);
  const delivery = bazaarDeliveryFieldFromFeedPublicRow(pub);
  assert.deepEqual(Object.keys(delivery).sort(), [...BAZAAR_DELIVERY_FIELD_KEYS].sort());
  assert.equal(delivery.paidAttempts30d, pub.paid_attempts_30d);
  assert.equal(delivery.delivered30d, pub.delivered_30d);
  assert.equal(delivery.settledNotDelivered30d, pub.settled_not_delivered_30d);
  assert.equal(delivery.deliveryRateLowerBps30d, pub.delivery_rate_lower_bps_30d);
  assert.equal(delivery.deliveryRateBand30d, pub.delivery_rate_band_30d);
  assert.equal(delivery.lastAttemptAt30d, pub.last_attempt_at_30d);
  assert.equal(delivery.lastDeliveredAt30d, pub.last_delivered_at_30d);
  assert.equal(delivery.recordUrl, pub.record_url);
  assert.equal(delivery.network, pub.network);

  const snap = { as_of: "2026-11-25T00:00:00.000Z", rows: [row] };
  const byUrl = lookupBazaarDeliveryInSnapshot(snap, row.url, row.method);
  assert.ok(byUrl);
  assert.deepEqual(byUrl!.delivery, delivery);
});

test("行が無い URL は delivery null", () => {
  const snap = { as_of: "2026-11-25T00:00:00.000Z", rows: [] as DeliveryFeedRow[] };
  const hit = lookupBazaarDeliveryInSnapshot(snap, "https://missing.example/none", "GET");
  assert.ok(hit);
  assert.equal(hit!.delivery, null);
});

test("宣言外 HTTP method は GET で引く（catalog と同じ）", () => {
  assert.equal(bazaarCatalogProbeMethod("PATCH"), "GET");
  const item = { resource: "https://api.example/x", extensions: { bazaar: { info: { input: { method: "OPTIONS" } } } } };
  assert.equal(bazaarItemMethod(item), "GET");
  const keyPatch = canonicalResourceLookupKey("https://api.example/x", bazaarCatalogProbeMethod("PATCH"));
  const keyGet = canonicalResourceLookupKey("https://api.example/x", "GET");
  assert.deepEqual(keyPatch, keyGet);
});

test("canonicalUrl: 末尾スラッシュとホスト大文字", () => {
  const a = "https://API.exa.ai/search/";
  const b = "https://api.exa.ai/search";
  assert.equal(canonicalUrl(a)?.url, canonicalUrl(b)?.url);
  const row = mockFeedRow({
    endpoint_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    url: b,
    method: "POST",
  });
  const snap = { as_of: "2026-11-25T00:00:00.000Z", rows: [row] };
  const hit = lookupBazaarDeliveryInSnapshot(snap, a, "POST");
  assert.ok(hit);
  assert.ok(hit!.delivery);
  assert.equal(hit!.canonicalUrl, b);
});

test("bazaar item から method を読む", () => {
  const item = {
    resource: "https://api.exa.ai/search",
    extensions: { bazaar: { info: { input: { method: "POST" } } } },
  };
  assert.equal(bazaarItemMethod(item), "POST");
});

test("同一 URL・method で network が複数あるとき annotate 用の index", () => {
  const url = "https://multi-net.example/api";
  const base = "11111111-1111-1111-1111-111111111111";
  const rows = [
    mockFeedRow({ endpoint_id: `${base}1`, url, method: "GET", network: "eip155:8453", paid_attempts_30d: 3 }),
    mockFeedRow({ endpoint_id: `${base}2`, url, method: "GET", network: "eip155:42161", paid_attempts_30d: 5 }),
  ];
  const index = buildBazaarFeedRowIndex(rows);
  assert.equal(index.get(`${canonicalUrl(url)!.url}\0GET`)?.length, 2);
});

test("by-resource: url 無しは 400 invalid_url", async () => {
  delete process.env.DATABASE_URL;
  const { GET } = await import("@/app/api/v1/delivery/by-resource/route");
  const res = await GET(new NextRequest("http://localhost/api/v1/delivery/by-resource"));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "invalid_url" });
});

test("annotate: 101 件は 400 invalid_request", async () => {
  delete process.env.DATABASE_URL;
  const { POST } = await import("@/app/api/v1/delivery/annotate/route");
  const items = Array.from({ length: BAZAAR_DELIVERY_MAX_ITEMS + 1 }, (_, i) => ({
    resource: `https://example.com/${i}`,
  }));
  const res = await POST(
    new NextRequest("http://localhost/api/v1/delivery/annotate", {
      method: "POST",
      body: JSON.stringify({ items }),
      headers: { "content-type": "application/json" },
    }),
  );
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "invalid_request" });
});

function rateLimitFakeDb() {
  const buckets = new Map<string, { count: number; resetAt: Date }>();
  return {
    insert: (table: unknown) => ({
      values: (v: { bucketKey: string; count: number; resetAt: Date }) => ({
        onConflictDoUpdate: () => ({
          returning: async () => {
            assert.equal(table, ipRateLimits);
            const now = Date.now();
            const cur = buckets.get(v.bucketKey);
            const next =
              !cur || cur.resetAt.getTime() <= now ? { count: 1, resetAt: v.resetAt } : { count: cur.count + 1, resetAt: cur.resetAt };
            buckets.set(v.bucketKey, next);
            return [{ bucketKey: v.bucketKey, count: next.count, resetAt: next.resetAt }];
          },
        }),
      }),
    }),
    execute: async () => ({ rows: [] }),
  };
}

test("annotate: 記録なし URL は delivery null", async () => {
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  __setDbForTests(rateLimitFakeDb() as never);
  resetDeliveryFeedCacheForTest();
  seedDeliveryFeedCacheForTest({ as_of: "2026-11-25T12:00:00.000Z", rows: [] }, 0);
  try {
    const { POST } = await import("@/app/api/v1/delivery/annotate/route");
    const res = await POST(
      new NextRequest("http://localhost/api/v1/delivery/annotate", {
        method: "POST",
        body: JSON.stringify({
          items: [{ resource: "https://no-record.example/api", extensions: { bazaar: { info: { input: { method: "GET" } } } } }],
        }),
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.50" },
      }),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: { delivery: null }[]; rate_formula: string; rules_version: string; as_of: string };
    assert.equal(body.items[0]?.delivery, null);
    assert.equal(body.rate_formula, "v1.0-wilson95");
    assert.ok(body.rules_version);
    assert.ok(body.as_of);
  } finally {
    __setDbForTests(null);
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
  }
});

test("src に payment_payload と challenge_402 の綴りが無い", () => {
  const routes = [
    "src/lib/delivery/bazaar-field.ts",
    "src/lib/delivery/bazaar-read.ts",
    "src/app/api/v1/delivery/by-resource/route.ts",
    "src/app/api/v1/delivery/annotate/route.ts",
  ];
  for (const f of routes) {
    const src = read(f);
    assert.doesNotMatch(src, /payment_payload/);
    assert.doesNotMatch(src, /challenge_402/);
  }
});

test("openapi に by-resource と annotate がある", () => {
  const o = read("docs/openapi.yaml");
  assert.ok(o.includes("/api/v1/delivery/by-resource:"));
  assert.ok(o.includes("/api/v1/delivery/annotate:"));
  assert.ok(o.includes("BazaarDeliveryField:"));
  assert.ok(o.includes("paidAttempts30d"));
  assert.ok(o.includes("rate_formula"));
});