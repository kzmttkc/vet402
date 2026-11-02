// ============================================================
// demo/verify の l1_busy の枝は購入を始めないので、日次デモ予算と呼び手の 1 日 1 回を返す（2026-11-02 監査 L9）。
// 変えるのはこの枝だけ。
// DB は偽物。枠の表とリースの文だけに答える（リースは他者が保持中＝行が返らない）。
// ============================================================
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { __setDbForTests } from "@/lib/db/client";

const ENDPOINT_ID = "5f0c9c5e-2c3a-4b1e-9a4d-8f6b2e1c7d0a";
const buckets = new Map<string, number>();
const statements: string[] = [];

function textOf(q: unknown): { text: string; params: unknown[] } {
  const chunks = (q as { queryChunks?: unknown[] }).queryChunks ?? [];
  const text: string[] = [];
  const params: unknown[] = [];
  for (const c of chunks) {
    const v = (c as { value?: unknown }).value;
    if (Array.isArray(v)) text.push(v.join(""));
    else params.push(c);
  }
  return { text: text.join(" "), params };
}

const fakeDb = {
  insert: () => ({
    values: (v: { bucketKey: string; resetAt: Date }) => ({
      onConflictDoUpdate: () => ({
        returning: async () => {
          const count = (buckets.get(v.bucketKey) ?? 0) + 1;
          buckets.set(v.bucketKey, count);
          return [{ bucketKey: v.bucketKey, count, resetAt: v.resetAt }];
        },
      }),
    }),
  }),
  execute: async (q: unknown) => {
    const { text, params } = textOf(q);
    statements.push(text);
    if (/UPDATE ip_rate_limits/.test(text)) {
      const key = params.find((p): p is string => typeof p === "string" && buckets.has(p));
      if (key) buckets.set(key, Math.max(0, (buckets.get(key) ?? 0) - 1));
    }
    return { rows: [] };
  },
};

const post = (ip: string) =>
  new NextRequest("http://localhost/api/v1/demo/verify", {
    method: "POST",
    headers: { "content-type": "application/json", "x-vercel-forwarded-for": ip },
    body: JSON.stringify({ endpointId: ENDPOINT_ID, level: "l1" }),
  });

after(() => {
  __setDbForTests(null);
  delete process.env.DEMO_L1_ENABLED;
  delete process.env.DEMO_L1_DAILY_MAX;
  delete process.env.PROXY_HEADER_SOURCE;
});

test("l1_busy は日次デモ予算を 1 回分だけ返す（3 で始めて 3 で終わる）", async () => {
  process.env.DEMO_L1_ENABLED = "true";
  process.env.DEMO_L1_DAILY_MAX = "5";
  process.env.PROXY_HEADER_SOURCE = "vercel";
  __setDbForTests(fakeDb);
  buckets.clear();
  const dayKey = `demo-l1-day:${new Date().toISOString().slice(0, 10)}`;
  buckets.set(dayKey, 3);
  const { POST } = await import("@/app/api/v1/demo/verify/route");
  const res = await POST(post("203.0.113.20"));
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { error: string }).error, "l1_busy");
  assert.equal(buckets.get(dayKey), 3);
  assert.ok(statements.some((s) => /INSERT INTO job_leases/.test(s)), "リースの文を通っていない");
});

test("l1_busy は呼び手の 1 日 1 回も返す（unverified の枝と同じ。try again shortly が本当になる）", async () => {
  process.env.DEMO_L1_ENABLED = "true";
  process.env.DEMO_L1_DAILY_MAX = "1";
  process.env.PROXY_HEADER_SOURCE = "vercel";
  __setDbForTests(fakeDb);
  buckets.clear();
  const { POST } = await import("@/app/api/v1/demo/verify/route");
  for (const ip of ["203.0.113.10", "203.0.113.11", "203.0.113.10"]) {
    const res = await POST(post(ip));
    assert.equal(res.status, 409, ip);
    assert.equal(((await res.json()) as { error: string }).error, "l1_busy", ip);
  }
  assert.equal(buckets.get("demo-l1:203.0.113.10"), 0);
  assert.equal(buckets.get(`demo-l1-day:${new Date().toISOString().slice(0, 10)}`), 0);
});
