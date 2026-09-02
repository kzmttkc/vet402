import { test } from "node:test";
import assert from "node:assert/strict";
import { parseObservatorySearchParams, observatoryHref } from "@/lib/observatory/query";

test("defaults are page 1, pageSize 40, no filters", () => {
  assert.deepEqual(parseObservatorySearchParams({}), {
    page: 1,
    pageSize: 40,
    q: null,
    verdict: null,
    network: null,
    l1: false,
  });
});

test("page is clamped to a positive integer", () => {
  assert.equal(parseObservatorySearchParams({ page: "0" }).page, 1);
  assert.equal(parseObservatorySearchParams({ page: "-3" }).page, 1);
  assert.equal(parseObservatorySearchParams({ page: "2.9" }).page, 2);
  assert.equal(parseObservatorySearchParams({ page: "nope" }).page, 1);
});

test("q is trimmed, wildcard-stripped, and dropped when empty", () => {
  assert.equal(parseObservatorySearchParams({ q: "  foo.example/api  " }).q, "foo.example/api");
  assert.equal(parseObservatorySearchParams({ q: "%_" }).q, null);
  assert.equal(parseObservatorySearchParams({ q: "   " }).q, null);
});

test("verdict only accepts the closed vocabulary", () => {
  assert.equal(parseObservatorySearchParams({ verdict: "pass" }).verdict, "pass");
  assert.equal(parseObservatorySearchParams({ verdict: "fail" }).verdict, "fail");
  assert.equal(parseObservatorySearchParams({ verdict: "unverified" }).verdict, "unverified");
  assert.equal(parseObservatorySearchParams({ verdict: "ALLOW" }).verdict, null);
});

test("network is a short token, not a query fragment", () => {
  assert.equal(parseObservatorySearchParams({ network: "eip155:8453" }).network, "eip155:8453");
  assert.equal(parseObservatorySearchParams({ network: "base'; drop" }).network, null);
});

// 2026-09-02 導線監査 F2: 受領証あり（L1 settled ≥ 1）に絞る ?l1=1。
test("l1 defaults to false and only `1` turns it on", () => {
  assert.equal(parseObservatorySearchParams({}).l1, false);
  assert.equal(parseObservatorySearchParams({ l1: "1" }).l1, true);
  assert.equal(parseObservatorySearchParams({ l1: "0" }).l1, false);
  assert.equal(parseObservatorySearchParams({ l1: "true" }).l1, false);
});

test("observatoryHref round-trips every filter and omits defaults", () => {
  const base = parseObservatorySearchParams({});
  assert.equal(observatoryHref(base, 1), "/observatory");
  assert.equal(observatoryHref(base, 3), "/observatory?page=3");
  assert.equal(
    observatoryHref({ ...base, q: "exa", verdict: "pass", network: "eip155:8453", l1: true }, 2),
    "/observatory?page=2&q=exa&verdict=pass&network=eip155%3A8453&l1=1",
  );
  assert.equal(observatoryHref({ ...base, l1: false }, 1), "/observatory");
});
