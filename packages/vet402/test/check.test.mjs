// check(url) contract (node:test, run with `npm test` after `npm run build`).
// The fake fetch answers the two real routes: /resolve?q= and
// /resources/{id}/decision?role=payer. Shapes copied from production on 2026-11-08.
import assert from "node:assert/strict";
import { test } from "node:test";
import { check, DEFAULT_API_URL } from "../dist/index.js";

const RID = "2010c0dbeaef18783a6e109501414defed56cae350d28e901d1a8a93a878e8a1";
const OID = "f20d881f-0763-4a97-888b-e83236d6196a";
const URL_ = "https://seller.example/api/data";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    for (const [match, reply] of routes) if (String(url).includes(match)) return reply();
    throw new Error(`unexpected url ${url}`);
  };
  fn.calls = calls;
  return fn;
}

const RESOLVED = {
  query: { kind: "url", value: URL_ },
  resource: {
    endpoint_id: "e".repeat(64),
    resource_id: RID,
    observatory_id: OID,
    canonical_url: URL_,
    method: "GET",
    payee_id: "eip155:8453:0x2b6d4988db4723e6908db86ab2b8dfbc51fc32c5",
    catalog_status: "listed",
    first_seen: null,
    last_seen: null,
  },
  endpoints: [],
  disclaimer: "x",
};

// Shape of src/lib/decision/types.ts VerifiedTerms (purchase_id is `<CAIP-2>:<tx>`).
const TERMS = {
  purchase_id: "eip155:8453:0x" + "ab".repeat(32),
  pay_to: "0x2b6d4988db4723e6908db86ab2b8dfbc51fc32c5",
  asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  amount: "2500",
  decimals: 6,
  network: "eip155:8453",
  scheme: "exact",
  protocol: "x402",
  verified_at: "2026-11-07T10:00:00.000Z",
};

test("(a) a resolved URL with ALLOW returns the decision, terms and the public record", async () => {
  const f = fakeFetch([
    ["/resolve?q=", () => json(RESOLVED)],
    [`/resources/${RID}/decision?role=payer`, () => json({ recommendation: "ALLOW", reason_codes: ["l0_pass", "l1_delivered"], verified_terms: TERMS, scoredAt: "2026-11-08T00:00:00.000Z" })],
  ]);
  const before = Date.now();
  const r = await check(URL_, { fetch: f });
  assert.equal(r.recommendation, "ALLOW");
  assert.deepEqual(r.reasonCodes, ["l0_pass", "l1_delivered"]);
  assert.deepEqual(r.verifiedTerms, TERMS);
  assert.equal(r.resourceId, RID);
  assert.equal(r.evidenceUrl, `https://vet402.com/observatory/e/${OID}`);
  // retrievedAt is when check() read the decision. scoredAt is when vet402 scored it.
  assert.ok(Date.parse(r.retrievedAt) >= before - 1 && Date.parse(r.retrievedAt) <= Date.now() + 1, r.retrievedAt);
  assert.equal(r.scoredAt, "2026-11-08T00:00:00.000Z");
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].url, `${DEFAULT_API_URL}/resolve?q=${encodeURIComponent(URL_)}`);
  assert.equal(f.calls[1].url, `${DEFAULT_API_URL}/resources/${RID}/decision?role=payer`);
});

test("no apiKey sends no Authorization header; apiKey sends Bearer like @vet402/sdk", async () => {
  const routes = [
    ["/resolve?q=", () => json(RESOLVED)],
    ["/decision", () => json({ recommendation: "WARN", reason_codes: ["l1_stale"], verified_terms: null, scoredAt: "2026-11-08T00:00:00.000Z" })],
  ];
  const a = fakeFetch(routes);
  await check(URL_, { fetch: a });
  for (const c of a.calls) assert.equal(new Headers(c.init?.headers).get("authorization"), null);
  const b = fakeFetch(routes);
  const r = await check(URL_, { fetch: b, apiKey: "vouch_live_test" });
  assert.equal(r.recommendation, "WARN");
  assert.equal(r.verifiedTerms, null);
  for (const c of b.calls) assert.equal(new Headers(c.init?.headers).get("authorization"), "Bearer vouch_live_test");
});

test("(b) a URL that is not on record returns UNKNOWN with the reason, and asks no decision", async () => {
  const f = fakeFetch([
    ["/resolve?q=", () => json({ query: { kind: "url", value: URL_ }, endpoints: [], not_found: { reason: "not_in_catalog", note: "n" }, disclaimer: "x" })],
  ]);
  const r = await check(URL_, { fetch: f });
  assert.equal(r.recommendation, "UNKNOWN");
  assert.equal(r.reason, "not_in_catalog");
  assert.equal(f.calls.length, 1);
});

test("(b) a 404 from resolve is UNKNOWN, never a throw", async () => {
  const f = fakeFetch([["/resolve?q=", () => json({ error: "not_found" }, 404)]]);
  const r = await check(URL_, { fetch: f });
  assert.equal(r.recommendation, "UNKNOWN");
  assert.equal(r.reason, "not_found");
});

test("(b) a URL off record on a listed host is UNKNOWN with url_not_on_record (the API sets no not_found then)", async () => {
  const f = fakeFetch([["/resolve?q=", () => json({ query: { kind: "url", value: URL_ }, endpoints: [RESOLVED.resource], disclaimer: "x" })]]);
  const r = await check(URL_, { fetch: f });
  assert.equal(r.recommendation, "UNKNOWN");
  assert.equal(r.reason, "url_not_on_record");
});

test("a caller error from the SDK (invalid_*) passes through as itself, not as could not reach", async () => {
  const f = fakeFetch([["/resolve?q=", () => json({ ...RESOLVED, resource: { ...RESOLVED.resource, resource_id: "not-hex" } })]]);
  await assert.rejects(() => check(URL_, { fetch: f }), (err) => {
    assert.equal(err.message, "invalid_resource_id");
    return true;
  });
});

test("(b) a resource without a resource_id is UNKNOWN", async () => {
  const f = fakeFetch([["/resolve?q=", () => json({ ...RESOLVED, resource: { ...RESOLVED.resource, resource_id: null } })]]);
  const r = await check(URL_, { fetch: f });
  assert.equal(r.recommendation, "UNKNOWN");
});

test("(c) a network error throws with a clear message that names vet402 and the API URL", async () => {
  const f = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(() => check(URL_, { fetch: f }), (err) => {
    assert.match(err.message, /vet402/);
    assert.match(err.message, /could not reach/);
    assert.match(err.message, /https:\/\/vet402\.com\/api\/v1/);
    assert.match(err.message, /fetch failed/);
    return true;
  });
});

test("a 404 from decision is UNKNOWN too, the same as a 404 from resolve", async () => {
  const f = fakeFetch([
    ["/resolve?q=", () => json(RESOLVED)],
    ["/decision", () => json({ error: "not_found" }, 404)],
  ]);
  const r = await check(URL_, { fetch: f });
  assert.equal(r.recommendation, "UNKNOWN");
  assert.equal(r.reason, "not_found");
});

test("public text in the package carries no dash and no assertive words", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["../README.md", "../src/index.ts", "../src/check.ts", "../src/buyer.ts", "../src/seller.ts"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.doesNotMatch(src, /[\u2013\u2014]/, `${f}: dash`);
    assert.doesNotMatch(src, /\b(only|every|always|never|daily|all)\b/i, `${f}: assertive word`);
    assert.doesNotMatch(src, /\b(we|our|us)\b/i, `${f}: we`);
  }
});

test("a non-404 API error from decision is passed through as the server's code", async () => {
  const f = fakeFetch([
    ["/resolve?q=", () => json(RESOLVED)],
    ["/decision", () => json({ error: "rate_limited" }, 429)],
  ]);
  await assert.rejects(() => check(URL_, { fetch: f }), (err) => {
    assert.equal(err.message, "rate_limited");
    assert.equal(err.status, 429);
    return true;
  });
});

test("an empty url is a caller error before any request", async () => {
  const f = fakeFetch([]);
  await assert.rejects(() => check("  ", { fetch: f }), /invalid_query/);
  assert.equal(f.calls.length, 0);
});
