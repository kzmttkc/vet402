// ============================================================
// check_resource_decision の入口（2026-09-29 敵対的監査・初見の開発者）。
//
// 固定すること:
//   1. URL を渡せば /resolve で resource_id を引いてから /decision を呼ぶ
//   2. カタログに無い URL（/resolve が resource を返さない）と、存在しない id
//      （/decision が 404 not_found）は、request_failed ではなく
//      not_in_catalog / resource_uncatalogued の REFUSE になる
//   3. 入力の誤り（両方・どちらも無し・形が違う）は invalid_target: の語で返り、
//      サニタイザがその語を潰さない
//   4. 404 以外の失敗は throw のまま（カタログに無いと偽らない）
// ============================================================
import assert from "node:assert/strict";
import { test } from "node:test";
import { resourceDecision, assertTarget, INVALID_TARGET_PREFIX } from "../dist/resource-decision.js";
import { sanitizeToolError } from "../dist/tool-errors.js";
import { VouchApiError } from "../dist/vouch-client.js";

const API = "https://vet402.test/api/v1";
const RID = "a".repeat(64);
const URL_IN = "https://seller.example/api/paid";

function withRoutes(routes, body) {
  const realFetch = globalThis.fetch;
  const saved = { ...process.env };
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    const path = String(url).slice(API.length);
    for (const [prefix, [status, json]] of Object.entries(routes)) {
      if (path.startsWith(prefix)) {
        return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
      }
    }
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
  };
  process.env.VOUCH_API_URL = API;
  delete process.env.VOUCH_API_KEY;
  return (async () => {
    try {
      return await body(calls);
    } finally {
      globalThis.fetch = realFetch;
      for (const k of ["VOUCH_API_URL", "VOUCH_API_KEY"]) {
        if (k in saved) process.env[k] = saved[k];
        else delete process.env[k];
      }
    }
  })();
}

const DECISION = {
  recommendation: "ALLOW",
  reason_codes: ["l1_delivered"],
  rules_version: "test",
  degraded: false,
};

test("url: /resolve の resource_id で /decision を呼ぶ", async () => {
  await withRoutes(
    {
      "/resolve": [200, { query: { kind: "url", value: URL_IN }, resource: { endpoint_id: "e", resource_id: RID, canonical_url: URL_IN, method: "GET" }, endpoints: [] }],
      [`/resources/${RID}/decision`]: [200, DECISION],
    },
    async (calls) => {
      const out = await resourceDecision({ url: URL_IN }, {});
      assert.equal(out.kind, "decision");
      assert.equal(out.resourceId, RID);
      assert.equal(out.resolvedFrom, URL_IN);
      assert.equal(out.result.recommendation, "ALLOW");
      assert.ok(calls[0].includes(`/resolve?q=${encodeURIComponent(URL_IN)}`), calls[0]);
      assert.ok(calls[1].includes(`/resources/${RID}/decision?role=payer`), calls[1]);
    },
  );
});

test("カタログに無い URL は REFUSE・not_in_catalog（request_failed ではない）", async () => {
  const other = { endpoint_id: "e2", resource_id: "b".repeat(64), canonical_url: "https://seller.example/api/other", method: "POST" };
  await withRoutes(
    { "/resolve": [200, { query: { kind: "url", value: URL_IN }, endpoints: [other] }] },
    async (calls) => {
      const out = await resourceDecision({ url: URL_IN }, {});
      assert.equal(out.kind, "uncatalogued");
      assert.equal(out.body.decision, "REFUSE");
      assert.equal(out.body.safe_to_pay, false);
      assert.equal(out.body.not_in_catalog, true);
      assert.deepEqual(out.body.refuse_reasons, ["resource_uncatalogued"]);
      assert.match(out.body.summary, /not in vet402's catalog/);
      assert.deepEqual(out.body.lookup.same_host_candidates, [
        { resource_id: other.resource_id, canonical_url: other.canonical_url, method: "POST" },
      ]);
      assert.equal(calls.length, 1, "カタログに無いなら /decision は呼ばない");
    },
  );
});

test("存在しない resourceId（/decision が 404 not_found）も not_in_catalog", async () => {
  await withRoutes({ [`/resources/${RID}/decision`]: [404, { error: "not_found" }] }, async () => {
    const out = await resourceDecision({ resourceId: RID }, {});
    assert.equal(out.kind, "uncatalogued");
    assert.equal(out.body.lookup.resourceId, RID);
    assert.equal(out.body.safe_to_pay, false);
  });
});

test("404 以外の失敗はカタログに無いと偽らず throw する", async () => {
  await withRoutes({ [`/resources/${RID}/decision`]: [503, { error: "scoring_unavailable" }] }, async () => {
    await assert.rejects(() => resourceDecision({ resourceId: RID }, {}), (e) => e instanceof VouchApiError && e.message === "scoring_unavailable");
  });
});

test("入力の誤りは invalid_target: の語で返り、サニタイザが潰さない", () => {
  const cases = [{}, { resourceId: RID, url: URL_IN }, { resourceId: "not-a-sha" }, { url: "ftp://x/y" }, { url: "seller.example" }];
  for (const c of cases) {
    let err;
    try {
      assertTarget(c);
    } catch (e) {
      err = e;
    }
    assert.ok(err, `${JSON.stringify(c)} が通ってしまった`);
    assert.ok(err.message.startsWith(INVALID_TARGET_PREFIX), err.message);
    assert.equal(sanitizeToolError(err), err.message);
  }
});
