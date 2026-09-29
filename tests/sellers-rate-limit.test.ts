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
  // 2026-09-29 監査 5 周目（WCAG 2.2）: 人が開く頁なので HTML（lang・title・viewport・待ち時間・戻る導線）。
  assert.match(over.headers.get("content-type") ?? "", /^text\/html/);
  const html = await over.text();
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<title>Too many requests · vet402<\/title>/);
  assert.match(html, /name="viewport"/);
  assert.match(html, new RegExp(`about <strong>${over.headers.get("retry-after")} second`));
  assert.match(html, /href="\/sellers">Try this page again/);
  assert.match(html, /href="\/">Back to vet402 home/);
  assert.doesNotMatch(html, /<script/i);
  const other = await proxy(req("/observatory"));
  assert.notEqual(other.status, 429, "the limit is only on /sellers");
});

test("429 の頁: 戻る導線は /sellers の下だけ・パスはエスケープする・判定不能は別の文言", async () => {
  const { rateLimitPageHtml } = await import("@/lib/sellers/page-limit");
  const evil = rateLimitPageHtml({ waitSeconds: 5, path: "//evil.example/x" });
  assert.match(evil, /href="\/sellers">Try this page again/);
  const quoted = rateLimitPageHtml({ waitSeconds: 1, path: '/sellers/"><b>x' });
  assert.ok(!quoted.includes('"><b>'), "the path is escaped");
  assert.match(quoted, /about <strong>1 second<\/strong>/);
  const down = rateLimitPageHtml({ waitSeconds: 30, unavailable: true });
  assert.match(down, /<title>Temporarily unavailable · vet402<\/title>/);
});
