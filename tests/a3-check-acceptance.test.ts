// ============================================================
// A3 の合格の表（2026-11-08・Claude が先に固定。実装はこの表を緑にする）。
// GET /api/v1/check?url= は MCP の check_x402_seller と同じ関数（checkSeller）の答えを、
// 鍵なしで、エッジに置ける形で返す。新しい主張は作らない。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { handleCheck } from "@/lib/api/check-handler";
import { checkSeller, type McpDeps } from "@/lib/mcp/tools";

const NOW = new Date("2026-11-08T00:00:00.000Z");

function fakeDeps(found: boolean): McpDeps {
  return {
    now: () => NOW,
    resolve: (async () =>
      found
        ? { resource: { observatory_id: "00000000-0000-0000-0000-000000000001", canonical_url: "https://api.example.org/x", method: "GET" }, endpoints: [] }
        : { resource: null, endpoints: [] }) as unknown as McpDeps["resolve"],
    decide: (async () => null) as unknown as McpDeps["decide"],
    l1Purchases: async () => [],
    sellerPage: {} as McpDeps["sellerPage"],
    hostExtras: async () => ({}) as never,
  } as unknown as McpDeps;
}

function req(qs: string): Request {
  return new Request(`https://vet402.com/api/v1/check${qs}`);
}

test("A3: the answer is the same document check_x402_seller returns", async () => {
  const deps = fakeDeps(false);
  const res = await handleCheck(req("?url=https%3A%2F%2Fapi.example.org%2Fx"), deps);
  assert.equal(res.status, 200);
  const body = await res.json();
  const mcp = await checkSeller(deps, { url: "https://api.example.org/x" });
  assert.deepEqual(body, JSON.parse(JSON.stringify(mcp)));
});

test("A3: missing or bad url answers 400 with a documented error", async () => {
  for (const qs of ["", "?url=", "?url=not-a-url", "?url=ftp%3A%2F%2Fx", "?url=http%3A%2F%2Fapi.example.org%2Fx"]) {
    const res = await handleCheck(req(qs), fakeDeps(false));
    assert.equal(res.status, 400, qs);
    const body = await res.json();
    assert.equal(typeof body.error, "string", qs);
  }
});

test("A3: unknown or repeated query parameters answer 400 (no cache busting)", async () => {
  for (const qs of ["?url=https%3A%2F%2Fa.example%2F&cb=1", "?url=https%3A%2F%2Fa.example%2F&url=https%3A%2F%2Fb.example%2F"]) {
    const res = await handleCheck(req(qs), fakeDeps(false));
    assert.equal(res.status, 400, qs);
  }
});

test("A3: method is optional and only an HTTP method name", async () => {
  assert.equal((await handleCheck(req("?url=https%3A%2F%2Fa.example%2F&method=POST"), fakeDeps(false))).status, 200);
  assert.equal((await handleCheck(req("?url=https%3A%2F%2Fa.example%2F&method=DROP%20TABLE"), fakeDeps(false))).status, 400);
});

test("A3: a 200 answer is cacheable at the edge and says when it was read", async () => {
  const res = await handleCheck(req("?url=https%3A%2F%2Fapi.example.org%2Fx"), fakeDeps(false));
  const cc = res.headers.get("cache-control") ?? "";
  assert.match(cc, /public/);
  assert.match(cc, /s-maxage=\d+/);
  assert.match(cc, /stale-while-revalidate=\d+/);
  assert.ok(res.headers.get("x-vet402-retrieved-at"), "x-vet402-retrieved-at header");
  const body = await res.json();
  assert.equal(body.as_of, NOW.toISOString());
});

test("A3: the route uses the handler with the MCP readers, and the docs name it", () => {
  const route = "src/app/api/v1/check/route.ts";
  assert.ok(existsSync(route), route);
  const src = readFileSync(route, "utf8");
  assert.ok(src.includes("handleCheck"));
  assert.ok(src.includes("mcpDeps"));
  assert.ok(readFileSync("public/llms.txt", "utf8").includes("/api/v1/check"));
  assert.ok(readFileSync("docs/openapi.yaml", "utf8").includes("/api/v1/check"));
  assert.ok(readFileSync("src/app/docs/api/page.tsx", "utf8").includes("/api/v1/check"));
});

test("A3: a reader failure answers 503 and is not cached", async () => {
  const deps = fakeDeps(false);
  (deps as { resolve: unknown }).resolve = async () => { throw new Error("db down"); };
  const res = await handleCheck(req("?url=https%3A%2F%2Fapi.example.org%2Fx"), deps);
  assert.equal(res.status, 503);
  assert.match(res.headers.get("cache-control") ?? "", /no-store/);
});

test("A3: the cached 200 carries only shared rate-limit headers, and the measurement is not in this change", () => {
  const route = readFileSync("src/app/api/v1/check/route.ts", "utf8");
  assert.ok(route.includes("cacheHeaders"), "a cacheable 200 must use the shared-cache rate-limit headers, not the per-IP ones");
  assert.equal(existsSync("src/lib/mcp/check-latency.ts"), false, "latency measurement comes in a later change with its own table");
  assert.equal(readFileSync("src/app/api/v1/observatory/state/route.ts", "utf8").includes("checkLatency"), false);
  assert.equal(readFileSync("src/app/api/cron/index-feedback/route.ts", "utf8").includes("atency"), false);
});
