// ============================================================
// /sellers の IP ごとの上限（src/lib/sellers/page-limit.ts・src/proxy.ts）。上限を超えたら頁を描かずに
// HTTP 429 と Retry-After を返す（独立レビュー 2026-09-28: 200 で「混んでいます」を返していた）。
// DB 無し・非本番なので consumeIpRateLimit はメモリの桶を使う。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

delete process.env.DATABASE_URL;

test("/sellers: 上限までは通し、超えたら 429 と Retry-After（他の頁には掛けない）", async () => {
  const { proxy } = await import("@/proxy");
  const { SELLERS_RL_LIMIT, isSellersPath } = await import("@/lib/sellers/page-limit");
  assert.equal(isSellersPath("/sellers"), true);
  assert.equal(isSellersPath("/sellers/api.example.com"), true);
  assert.equal(isSellersPath("/sellers-foo"), false);
  const req = (path: string) => new NextRequest(`http://localhost${path}`);
  for (let i = 0; i < SELLERS_RL_LIMIT; i++) {
    const res = await proxy(req(i % 2 ? "/sellers/fix-first" : "/sellers/api.example.com"));
    assert.notEqual(res.status, 429, `request ${i + 1} is within the limit`);
    assert.ok(res.headers.get("content-security-policy"), "the normal path still sets the CSP");
  }
  const over = await proxy(req("/sellers"));
  assert.equal(over.status, 429);
  assert.ok(Number(over.headers.get("retry-after")) >= 1);
  assert.equal(over.headers.get("ratelimit-limit"), String(SELLERS_RL_LIMIT));
  const other = await proxy(req("/observatory"));
  assert.notEqual(other.status, 429, "the limit is only on /sellers");
});
