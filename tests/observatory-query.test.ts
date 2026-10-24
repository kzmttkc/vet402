import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseObservatorySearchParams, observatoryHref, observatoryRateFilters } from "@/lib/observatory/query";
import { searchLikePattern } from "@/lib/observatory/reader";

test("defaults are page 1, pageSize 40, no filters", () => {
  assert.deepEqual(parseObservatorySearchParams({}), {
    page: 1,
    pageSize: 40,
    q: null,
    qTruncated: false,
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

test("q is trimmed, keeps % _ and backslash, and is dropped when empty", () => {
  assert.equal(parseObservatorySearchParams({ q: "  foo.example/api  " }).q, "foo.example/api");
  assert.equal(parseObservatorySearchParams({ q: "%_" }).q, "%_");
  assert.equal(parseObservatorySearchParams({ q: "%_" }).qTruncated, false);
  assert.equal(parseObservatorySearchParams({ q: "   " }).q, null);
  assert.equal(parseObservatorySearchParams({ q: "   " }).qTruncated, false);
});

test("a resource id underscore is kept, and the LIKE pattern treats it as a literal", () => {
  const q = "mailpulse.theaslangroupllc.com/api/letters/ltr_6efe036558965c36";
  const parsed = parseObservatorySearchParams({ q });
  assert.equal(parsed.q, q);
  assert.equal(parsed.qTruncated, false);
  assert.ok(parsed.q?.includes("ltr_6efe036558965c36"));
  assert.equal(searchLikePattern(parsed.q), `%${q.replaceAll("_", "\\_")}%`);
});

test("q longer than 80 characters is cut, and the page is told", () => {
  const parsed = parseObservatorySearchParams({ q: `  ${"a".repeat(81)}  ` });
  assert.equal(parsed.q, "a".repeat(80));
  assert.equal(parsed.qTruncated, true);
  assert.equal(parseObservatorySearchParams({ q: "a".repeat(80) }).qTruncated, false);
});

test("verdict only accepts the closed vocabulary", () => {
  assert.equal(parseObservatorySearchParams({ verdict: "pass" }).verdict, "pass");
  assert.equal(parseObservatorySearchParams({ verdict: "fail" }).verdict, "fail");
  assert.equal(parseObservatorySearchParams({ verdict: "unverified" }).verdict, "unverified");
  assert.equal(parseObservatorySearchParams({ verdict: "withdrawn" }).verdict, "withdrawn");
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
  assert.equal(observatoryHref({ ...base, q: "ltr_x", qTruncated: true }, 1), "/observatory?q=ltr_x&qCut=1");
});

test("a cut query keeps the cut mark on the next page", () => {
  const first = parseObservatorySearchParams({ q: "b".repeat(81) });
  assert.equal(first.qTruncated, true);
  assert.equal(first.q?.length, 80);
  const href = observatoryHref(first, 2);
  assert.match(href, /qCut=1/);
  const next = parseObservatorySearchParams({ q: first.q ?? "", qCut: "1", page: "2" });
  assert.equal(next.qTruncated, true);
  assert.equal(next.page, 2);
  assert.equal(observatoryHref(next, 3).includes("qCut=1"), true);
  assert.equal(parseObservatorySearchParams({ q: "short", qCut: "1" }).qTruncated, true);
  const page = readFileSync("src/app/observatory/page.tsx", "utf8");
  assert.match(page, /query\.qTruncated && \([\s\S]*?The search was cut at 80 characters\./);
  assert.match(page, /query\.qTruncated && <input type="hidden" name="qCut" value="1" \/>/);
});

test("the pass rate names a filter only when that filter is on", () => {
  assert.equal(observatoryRateFilters({ q: null, network: null, l1: false }), null);
  assert.equal(observatoryRateFilters({ q: null, network: "Stellar", l1: false }), "This rate includes the network.");
  assert.equal(
    observatoryRateFilters({ q: "mailpulse.theaslangroupllc.com/api/letters/ltr_6efe036558965c36", network: null, l1: false }),
    "This rate includes the search.",
  );
  assert.equal(observatoryRateFilters({ q: null, network: null, l1: true }), "This rate includes the settled filter.");
  assert.equal(
    observatoryRateFilters({ q: "ltr_x", network: "Stellar", l1: true }),
    "This rate includes the search, the network, and the settled filter.",
  );
});
