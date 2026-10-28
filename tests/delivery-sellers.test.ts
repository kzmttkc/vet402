// ============================================================
// GET /api/v1/delivery/sellers.json の route（DB なし・#5・#6）。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

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
  for (const q of ["?min_delivered=-1", "?network=foo", "?listed_in=x", "?cb=1"]) {
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
