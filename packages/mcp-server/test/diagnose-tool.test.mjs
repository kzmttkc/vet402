// diagnose_x402_url と、カタログ外 REFUSE に付ける diagnose_at。
// 直す前の dist では fetchDiagnose が無く、このファイルは import で落ちる。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resourceDecision, uncatalogued } from "../dist/resource-decision.js";
import { fetchDiagnose } from "../dist/vouch-client.js";
import { sanitizeToolError } from "../dist/tool-errors.js";
import { VouchApiError } from "../dist/vouch-client.js";

const SELLER = "https://seller.example/paid";

test("a missing catalog URL stays REFUSE and names diagnose_x402_url", () => {
  const body = uncatalogued({ resourceId: null, url: SELLER, canonicalUrl: null });
  assert.equal(body.decision, "REFUSE");
  assert.equal(body.safe_to_pay, false);
  assert.deepEqual(body.refuse_reasons, ["resource_uncatalogued"]);
  assert.equal(body.diagnose_at.tool, "diagnose_x402_url");
  assert.equal(
    body.diagnose_at.url,
    `https://vet402.com/api/v1/diagnose?url=${encodeURIComponent(SELLER)}&method=GET`,
  );
  assert.match(body.summary, /not in vet402's catalog/);
  assert.match(body.summary, /diagnose_x402_url/);
});

test("diagnose_at uses POST when the caller names POST", () => {
  const body = uncatalogued({ resourceId: null, url: SELLER, canonicalUrl: null }, [], "POST");
  assert.equal(body.decision, "REFUSE");
  assert.equal(body.safe_to_pay, false);
  assert.deepEqual(body.refuse_reasons, ["resource_uncatalogued"]);
  assert.equal(
    body.diagnose_at.url,
    `https://vet402.com/api/v1/diagnose?url=${encodeURIComponent(SELLER)}&method=POST`,
  );
});

test("resourceDecision forwards POST into resolve and diagnose_at", async () => {
  const realFetch = globalThis.fetch;
  const saved = process.env.VOUCH_API_URL;
  const calls = [];
  process.env.VOUCH_API_URL = "https://vet402.test/api/v1";
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ query: { kind: "url", value: SELLER }, endpoints: [] }), { status: 200 });
  };
  try {
    const out = await resourceDecision({ url: SELLER }, {}, "POST");
    assert.equal(out.kind, "uncatalogued");
    assert.equal(out.body.decision, "REFUSE");
    assert.match(calls[0], /method=POST/);
    assert.match(out.body.diagnose_at.url, /method=POST/);
  } finally {
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.VOUCH_API_URL;
    else process.env.VOUCH_API_URL = saved;
  }
});

test("check_resource_decision accepts method and passes it through", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const start = src.indexOf('"check_resource_decision"');
  const end = src.indexOf('"diagnose_x402_url"');
  const block = src.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(block, /method:\s*z\.enum\(\["GET", "POST"\]\)/);
  assert.match(block, /resourceDecision\([\s\S]*\bmethod\b/);
});

test("a missing catalog id stays REFUSE and does not invent a diagnose URL", () => {
  const body = uncatalogued({ resourceId: "a".repeat(64), url: null, canonicalUrl: null });
  assert.equal(body.decision, "REFUSE");
  assert.equal(body.safe_to_pay, false);
  assert.deepEqual(body.refuse_reasons, ["resource_uncatalogued"]);
  assert.equal(body.diagnose_at.url, null);
  assert.match(body.diagnose_at.note, /402/);
});

test("fetchDiagnose reads GET /diagnose and does not invent a verdict on failure", async () => {
  const realFetch = globalThis.fetch;
  const saved = process.env.VOUCH_API_URL;
  const calls = [];
  process.env.VOUCH_API_URL = "https://vet402.test/api/v1";
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes("unsafe.example")) {
      return new Response(JSON.stringify({ error: "unsafe_target" }), { status: 400 });
    }
    return new Response(JSON.stringify({ verdict: "BLOCK", recommended_accept: null }), { status: 200 });
  };
  try {
    const body = await fetchDiagnose(SELLER, "POST");
    assert.equal(body.verdict, "BLOCK");
    assert.match(calls[0], /\/diagnose\?/);
    assert.match(calls[0], /method=POST/);
    await assert.rejects(() => fetchDiagnose("https://unsafe.example/x"), (error) => error instanceof VouchApiError && error.message === "unsafe_target");
    assert.equal(sanitizeToolError(new VouchApiError("unsafe_target")).startsWith("unsafe_target"), true);
    assert.equal(sanitizeToolError(new VouchApiError("unsafe_target")).includes("ALLOW"), false);
  } finally {
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.VOUCH_API_URL;
    else process.env.VOUCH_API_URL = saved;
  }
});
