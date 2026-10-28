// ============================================================
// GET /api/v1/delivery/sellers.json の route（DB なし・#5–#7）。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { __setDbForTests } from "@/lib/db/client";
import { ipRateLimits } from "@/lib/db/schema";

delete process.env.DATABASE_URL;
process.env.PROXY_HEADER_SOURCE = "generic";

let ipSeq = 0;
const freshIp = () => `203.0.113.${++ipSeq % 250}`;

async function get(query = "", ip = freshIp()) {
  const { GET } = await import("@/app/api/v1/delivery/sellers.json/route");
  const { NextRequest } = await import("next/server");
  const res = await GET(new NextRequest(`http://localhost:3000/api/v1/delivery/sellers.json${query}`, { headers: { "x-real-ip": ip } }));
  const text = await res.text();
  return { res, text, json: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

test("#5 invalid query → 400", async () => {
  for (const q of [
    "?min_delivered=-1",
    "?network=foo",
    "?listed_in=x",
    "?cb=1",
    "?network=eip155:8453&network=eip155:1",
    "?min_delivered=100001",
    "?cursor=not-base64url",
    "?cursor=",
    "?listed_in=bazaar%27DROP",
  ]) {
    const { res, json } = await get(q);
    assert.equal(res.status, 400, q);
    assert.equal(json?.error, "invalid_query", q);
  }
});

test("#6 rate limit → 429", async () => {
  const ip = "198.51.100.44";
  const { DELIVERY_FEED_RATE_PER_MIN } = await import("@/lib/delivery/sellers-feed");
  for (let i = 0; i < DELIVERY_FEED_RATE_PER_MIN; i++) {
    const { res } = await get("", ip);
    assert.notEqual(res.status, 429, `${i + 1}本目`);
  }
  const last = await get("", ip);
  assert.equal(last.res.status, 429);
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
  };
}

test("#7 response headers on success path shape", async () => {
  const { DELIVERY_FEED_LICENSE, DELIVERY_FEED_WINDOW_DAYS, DELIVERY_FEED_METHOD_URL } = await import("@/lib/delivery/sellers-feed");
  const { setDeliveryFeedCachedForTest } = await import("@/lib/delivery/cached");
  __setDbForTests(rateLimitFakeDb());
  setDeliveryFeedCachedForTest(async () => ({
    as_of: "2026-10-01T00:00:00.000Z",
    window_days: DELIVERY_FEED_WINDOW_DAYS,
    method_url: DELIVERY_FEED_METHOD_URL,
    license: DELIVERY_FEED_LICENSE,
    license_url: "https://creativecommons.org/licenses/by/4.0/",
    row_count: 0,
    total_rows: 0,
    next_cursor: null,
    rows: [],
  }));
  try {
    const { res } = await get("");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-robots-tag"), "noindex");
    assert.equal(res.headers.get("x-vet402-license"), DELIVERY_FEED_LICENSE);
    assert.match(res.headers.get("cache-control") ?? "", /s-maxage=300/);
    assert.match(res.headers.get("cache-control") ?? "", /stale-while-revalidate=600/);
  } finally {
    setDeliveryFeedCachedForTest(null);
    __setDbForTests(null);
  }
});
