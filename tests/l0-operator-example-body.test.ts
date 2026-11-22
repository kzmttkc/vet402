// ============================================================
// L0: vet402 が自分で足した行（source = 'operator'）の POST だけ、一覧の例の本文を送る
// （2026-11-22 オーナー承認 22:10）。
//
// 守ること:
//  1. operator の POST で一覧に exampleBody があれば、無払いの要求の本文はその例。402 なら pass。
//  2. operator 以外の行（同じ URL の cdp_bazaar でも）は今までどおり `{}`。
//  3. exampleBody の無い operator の行（一覧に無い URL）も `{}`。
//  4. 例の本文に 400 が返っても、今までどおり unverified（request_shape）で、売り手の fail にしない。
// 売り手の役は usebuy の実測（2026-11-22）と同じ: `{}` に 400、username のある本文に 402。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { probeEndpoint, type ProbeTarget } from "@/lib/observatory/l0-probe";
import { OPERATOR_LISTINGS, OPERATOR_SOURCE, operatorExampleBody } from "@/lib/observatory/operator-listings";

const IG = OPERATOR_LISTINGS[0];
const IG_EXAMPLE = operatorExampleBody(IG.url)!;

const ENVELOPE = Buffer.from(
  JSON.stringify({
    x402Version: 2,
    error: "",
    resource: { url: IG.url },
    accepts: [{ scheme: "exact", network: IG.network, amount: IG.amount, asset: IG.asset, payTo: IG.payTo, maxTimeoutSeconds: 300, extra: IG.extra }],
  }),
).toString("base64");

function target(overrides: Partial<ProbeTarget> = {}): ProbeTarget {
  return {
    resourceUrl: IG.url,
    method: "POST",
    payTo: IG.payTo.toLowerCase(),
    network: IG.network,
    priceAmount: IG.amount,
    priceAsset: IG.asset,
    source: OPERATOR_SOURCE,
    ...overrides,
  };
}

/** usebuy と同じ: username の無い本文は 400、ある本文は 402。送られた本文を残す。 */
function usebuyLike(sent: (string | null)[]) {
  return async (_url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : null;
    sent.push(body);
    let username: unknown;
    try {
      username = (JSON.parse(body ?? "{}") as { username?: unknown }).username;
    } catch {
      username = undefined;
    }
    if (typeof username !== "string") {
      return new Response(JSON.stringify({ error: "invalid_request", reason: "username is required" }), { status: 400, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 402, headers: { "content-type": "application/json", "payment-required": ENVELOPE } });
  };
}

test("operator の POST は例の本文を送り、402 なら pass", async () => {
  const sent: (string | null)[] = [];
  const r = await probeEndpoint(target(), { fetchImpl: usebuyLike(sent) });
  assert.deepEqual(sent, [IG_EXAMPLE]);
  assert.equal(r.verdict, "pass", `期待 pass、実際 ${r.verdict}/${r.failReason}`);
  assert.equal(r.rawResponseMeta?.requestBody, "operator_example");
});

test("operator 以外の行は今までどおり {}（同じ URL の cdp_bazaar でも）・400 は unverified", async () => {
  for (const source of ["cdp_bazaar", "circle_discovery", null, undefined]) {
    const sent: (string | null)[] = [];
    const r = await probeEndpoint(target({ source }), { fetchImpl: usebuyLike(sent) });
    assert.deepEqual(sent, ["{}"], `source=${String(source)}`);
    assert.equal(r.verdict, "unverified");
    assert.equal(r.failReason, "request_shape");
    assert.equal(r.rawResponseMeta?.requestBody, undefined);
  }
});

test("exampleBody の無い operator の行（一覧に無い URL）も {}", async () => {
  const sent: (string | null)[] = [];
  const r = await probeEndpoint(target({ resourceUrl: "https://gateway.usebuy.ai/v1/social/not-in-list" }), { fetchImpl: usebuyLike(sent) });
  assert.deepEqual(sent, ["{}"]);
  assert.equal(r.verdict, "unverified");
});

test("operator の GET 行には本文を付けない", async () => {
  const sent: (string | null)[] = [];
  await probeEndpoint(target({ method: "GET" }), { fetchImpl: usebuyLike(sent) });
  assert.deepEqual(sent, [null]);
});

test("例の本文に 400 が返っても売り手の fail にしない（unverified・request_shape）", async () => {
  const sent: (string | null)[] = [];
  const r = await probeEndpoint(target(), {
    fetchImpl: async (_u: string, init?: RequestInit) => {
      sent.push(typeof init?.body === "string" ? init.body : null);
      return new Response(JSON.stringify({ error: "bad input" }), { status: 400, headers: { "content-type": "application/json" } });
    },
  });
  assert.deepEqual(sent, [IG_EXAMPLE]);
  assert.equal(r.verdict, "unverified");
  assert.equal(r.failReason, "request_shape");
  assert.match(String(r.rawResponseMeta?.detail), /example body from vet402's own list/);
});
