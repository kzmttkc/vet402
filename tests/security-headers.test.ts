// CSP は src/proxy.ts（要求ごとの nonce）、HSTS は next.config.ts の headers()。
// next を GHSA-p3m5-59mp-jv5r の修正版へ上げたあと、この2つが残っていることを見る。
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import nextConfig from "../next.config";

const HSTS = "max-age=63072000; includeSubDomains; preload";

test("next.config headers() still sets HSTS on the catch-all rule", async () => {
  assert.equal(typeof nextConfig.headers, "function");
  const rules = await nextConfig.headers!();
  const catchAll = rules.find((rule) => rule.source === "/:path*");
  assert.ok(catchAll, "catch-all header rule is missing");
  const hsts = catchAll.headers.find((header) => header.key === "Strict-Transport-Security");
  assert.ok(hsts, "Strict-Transport-Security is missing");
  assert.equal(hsts.value, HSTS);
});

test("proxy still sets a per-request CSP on the home page and signup", async () => {
  const { proxy } = await import("@/proxy");
  const home = await proxy(new NextRequest("http://localhost/"));
  const signup = await proxy(new NextRequest("http://localhost/signup"));
  const homeCsp = home.headers.get("content-security-policy");
  const signupCsp = signup.headers.get("content-security-policy");
  assert.ok(homeCsp);
  assert.ok(signupCsp);
  for (const csp of [homeCsp, signupCsp]) {
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self' 'nonce-[A-Za-z0-9+/]+={0,2}' 'strict-dynamic'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /base-uri 'self'/);
    assert.match(csp, /form-action 'self'/);
  }
  assert.notEqual(homeCsp, signupCsp);
});
