// ============================================================
// L0 の理由コード（2026-09-29 監査 5 周目・名指しされた売り手の弁護士）。
//
// 1. api.strale.io の v1 出品（pep-check・serp-analyze・us-company-data）が 09-04 以降毎回
//    accepts_invalid だった原因は計器: L0 は 402 の本文を 4,000 バイトで切って読み、v1 の封筒は
//    本文にしか載らない。実測の本文は 4,290〜7,451 バイト（ヘッダ PAYMENT-REQUIRED は無し）で、
//    切った JSON は閉じずに parse できなかった。全文なら strict でも accept が 1 件読める。
// 2. 理由コードは l0-reasons.ts に定義し、記録頁は 1 行で何が不正だったかを出す。
// 3. 未払いの POST（本文 `{}`）への 400/422 は unverified(request_shape)。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BODY_OVER_CAP_REASON,
  L0_BODY_CAP_BYTES,
  probeEndpoint,
  type ProbeTarget,
} from "@/lib/observatory/l0-probe";
import { L0_REASON_CODES, l0ReasonDetail } from "@/lib/observatory/l0-reasons";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x66D7C2F952362BFB24FD7F02a9beC9c754ea83bC";

function target(overrides: Partial<ProbeTarget> = {}): ProbeTarget {
  return {
    resourceUrl: "https://api.seller.example/x402/pep-check",
    method: "GET",
    payTo: PAY_TO.toLowerCase(),
    network: "base",
    priceAmount: null,
    priceAsset: USDC,
    source: "cdp_bazaar",
    ...overrides,
  };
}

/** strale の v1 本文と同じ形（resource・長い description・outputSchema・accepts）を、指定バイト以上に膨らませる。 */
function v1Body(minBytes: number, acceptOverrides: Record<string, unknown> = {}): string {
  const accept = {
    scheme: "exact",
    network: "base",
    maxAmountRequired: "54000",
    resource: "https://api.seller.example/x402/pep-check",
    description: "Screens an individual against a PEP database.",
    mimeType: "application/json",
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    asset: USDC,
    outputSchema: { input: { type: "http", method: "GET", queryParams: {} }, output: { type: "object", properties: {} as Record<string, unknown> } },
    extra: { name: "USD Coin", version: "2" },
    ...acceptOverrides,
  };
  const body = {
    x402Version: 1,
    error: "Payment required. PEP Check costs $0.0540 USDC per call.",
    resource: { url: accept.resource, description: "x".repeat(200), mimeType: "application/json" },
    accepts: [accept],
  };
  let i = 0;
  while (Buffer.byteLength(JSON.stringify(body)) < minBytes) {
    (accept.outputSchema.output.properties as Record<string, unknown>)[`field_${i++}`] = { type: "string", description: "a returned field of the report" };
  }
  return JSON.stringify(body);
}

const respond =
  (status: number, body: string, headers: Record<string, string> = {}) =>
  async () =>
    new Response(body, { status, headers: { "content-type": "application/json", ...headers } });

test("strale の再現: 4,000 バイトを超える v1 本文（ヘッダ無し）→ pass（以前は accepts_invalid）", async () => {
  for (const size of [4_290, 4_393, 7_451, 25_189]) {
    const body = v1Body(size);
    assert.ok(Buffer.byteLength(body) >= size);
    // 旧計器の条件の確認: 先頭 4,000 バイトでは JSON が閉じない。
    assert.throws(() => JSON.parse(body.slice(0, 4_000)));
    const r = await probeEndpoint(target(), { fetchImpl: respond(402, body) });
    assert.equal(r.verdict, "pass", `size ${size}: ${r.verdict}/${r.failReason}`);
    assert.equal(r.dialect, "v1");
    assert.equal(r.rawResponseMeta?.envelopeSource, "body");
    assert.equal(r.rawResponseMeta?.bodyTruncated, undefined);
    assert.equal(typeof r.rawResponseMeta?.bodyBytes, "number");
  }
});

test("本文が上限を超えて封筒が読めない → unverified body_over_cap（売り手の fail にしない）", async () => {
  const body = v1Body(L0_BODY_CAP_BYTES + 2_000);
  const r = await probeEndpoint(target(), { fetchImpl: respond(402, body) });
  assert.equal(r.verdict, "unverified");
  assert.equal(r.failReason, BODY_OVER_CAP_REASON);
  assert.equal(r.rawResponseMeta?.bodyTruncated, true);
  assert.equal(r.rawResponseMeta?.bodyBytes, L0_BODY_CAP_BYTES);
});

test("本文が上限を超えても PAYMENT-REQUIRED ヘッダが読めれば判定できる", async () => {
  const header = Buffer.from(
    JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", amount: "54000", asset: USDC, payTo: PAY_TO }] }),
  ).toString("base64");
  const r = await probeEndpoint(target(), { fetchImpl: respond(402, "y".repeat(L0_BODY_CAP_BYTES + 10), { "payment-required": header }) });
  assert.equal(r.verdict, "pass");
  assert.equal(r.dialect, "v2");
});

test("本文が上限ちょうどなら切れていない（境界）", async () => {
  const body = v1Body(1_000);
  const padded = body + " ".repeat(L0_BODY_CAP_BYTES - Buffer.byteLength(body));
  assert.equal(Buffer.byteLength(padded), L0_BODY_CAP_BYTES);
  const r = await probeEndpoint(target(), { fetchImpl: respond(402, padded) });
  assert.equal(r.verdict, "pass", `${r.verdict}/${r.failReason}`);
  assert.equal(r.rawResponseMeta?.bodyTruncated, undefined);
});

test("accepts_invalid は何が欠けていたかを記録し、記録頁の 1 行に出る", async () => {
  const body = v1Body(500, { payTo: undefined, asset: undefined });
  const r = await probeEndpoint(target(), { fetchImpl: respond(402, body) });
  assert.equal(r.verdict, "fail");
  assert.equal(r.failReason, "accepts_invalid");
  assert.deepEqual(r.rawResponseMeta?.envelope, { header: "absent", body: "accepts_unusable", missing: ["payTo", "asset"] });
  const line = l0ReasonDetail({
    verdict: r.verdict,
    failReason: r.failReason,
    httpStatus: r.httpStatus,
    method: r.method,
    probedAt: new Date(),
    envelope: r.rawResponseMeta?.envelope as { header: string; body: string; missing: string[] },
    legacyProbe: false,
  });
  assert.equal(line, "402 without a payable accept: no PAYMENT-REQUIRED header; body's accept is incomplete; the first accept lacks payTo, asset.");

  const notJson = await probeEndpoint(target(), { fetchImpl: respond(402, "Payment Required") });
  assert.deepEqual(notJson.rawResponseMeta?.envelope, { header: "absent", body: "not_json" });
  const empty = await probeEndpoint(target(), { fetchImpl: respond(402, JSON.stringify({ x402Version: 1, accepts: [] })) });
  assert.deepEqual(empty.rawResponseMeta?.envelope, { header: "absent", body: "accepts_empty" });
});

test("price_mismatch / metadata_mismatch は宣言と 402 の値を並べて残す", async () => {
  const body = v1Body(500, { maxAmountRequired: "99000" });
  const r = await probeEndpoint(target({ priceAmount: "54000" }), { fetchImpl: respond(402, body) });
  assert.equal(r.failReason, "price_mismatch");
  assert.deepEqual(r.rawResponseMeta?.declared, { amount: "54000", asset: USDC, network: "eip155:8453", payTo: PAY_TO.toLowerCase() });
  assert.deepEqual(r.rawResponseMeta?.offered, [{ amount: "99000", asset: USDC, network: "eip155:8453", payTo: PAY_TO }]);
  const line = l0ReasonDetail({
    verdict: "fail",
    failReason: "price_mismatch",
    httpStatus: 402,
    method: "GET",
    probedAt: new Date(),
    declared: r.rawResponseMeta?.declared as never,
    offered: r.rawResponseMeta?.offered as never,
  });
  assert.equal(line, "Declared 54000 of 0x8335…2913; the 402 offered 99000 of 0x8335…2913.");

  const m = await probeEndpoint(target({ payTo: "0x1111111111111111111111111111111111111111" }), { fetchImpl: respond(402, v1Body(500)) });
  assert.equal(m.failReason, "metadata_mismatch");
  const mLine = l0ReasonDetail({
    verdict: "fail",
    failReason: "metadata_mismatch",
    httpStatus: 402,
    method: "GET",
    probedAt: new Date(),
    declared: m.rawResponseMeta?.declared as never,
    offered: m.rawResponseMeta?.offered as never,
  });
  assert.equal(mLine, "Declared payTo 0x1111…1111 on eip155:8453; the 402 offered 0x66D7…83bC on eip155:8453.");
});

test("未払いの POST（本文 {}）への 400/422 → unverified request_shape、1 要求だけ", async () => {
  for (const status of [400, 422]) {
    const calls: { method?: string; body?: unknown }[] = [];
    const r = await probeEndpoint(target({ method: "POST" }), {
      fetchImpl: async (_u, init) => {
        calls.push({ method: init?.method, body: init?.body });
        return new Response('{"error":"name is required"}', { status });
      },
    });
    assert.equal(r.verdict, "unverified", `status ${status}`);
    assert.equal(r.failReason, "request_shape");
    assert.equal(r.httpStatus, status);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body, "{}");
    assert.match(String(r.rawResponseMeta?.detail), /empty JSON body/);
  }
  // GET への 400、POST への 401/404/500、支払いを名乗る 400 は従来どおり no_402 の fail。
  const get400 = await probeEndpoint(target({ method: "GET" }), { fetchImpl: respond(400, "{}") });
  assert.equal(get400.failReason, "no_402");
  for (const status of [401, 404, 500]) {
    const r = await probeEndpoint(target({ method: "POST" }), { fetchImpl: respond(status, "{}") });
    assert.equal(r.failReason, "no_402", `status ${status}`);
  }
  const withEnvelope = await probeEndpoint(target({ method: "POST" }), { fetchImpl: respond(400, "{}", { "payment-required": "e30=" }) });
  assert.equal(withEnvelope.failReason, "no_402");
});

test("l0-probe が返しうる理由語は全部、方法論の表（L0_REASON_CODES）に定義がある", () => {
  const src = readFileSync("src/lib/observatory/l0-probe.ts", "utf8");
  const emitted = new Set<string>();
  for (const line of src.split("\n").filter((l) => /^\s*failReason: /.test(l))) {
    for (const m of line.matchAll(/"([a-z0-9_]+)"/g)) emitted.add(m[1]);
  }
  // classifyNetworkError の戻り値の型（"dns" | "tls" | …）から読む。
  const sig = src.match(/function classifyNetworkError\([^)]*\):\s*([^{]+)\{/);
  assert.ok(sig, "classifyNetworkError の戻り値の型が読めない");
  for (const m of sig[1].matchAll(/"([a-z_]+)"/g)) emitted.add(m[1]);
  for (const c of ["path_template", "request_shape", "body_over_cap"]) emitted.add(c); // 定数で返す語
  assert.ok(emitted.has("dns") && emitted.has("redirect_limit") && emitted.has("accepts_invalid"), [...emitted].join(","));
  const defined = new Set(L0_REASON_CODES.map((r) => r.code));
  for (const code of emitted) assert.ok(defined.has(code), `理由語 ${code} に定義が無い`);
  for (const r of L0_REASON_CODES) {
    assert.ok(r.meaning.length > 20 && /\.$/.test(r.meaning), `${r.code} の定義は 1 文で終わる`);
  }
});

test("旧い行の説明: 4,000 バイトで読んでいた頃の accepts_invalid と、空の本文の POST への 400", () => {
  const legacyLong = l0ReasonDetail({ verdict: "fail", failReason: "accepts_invalid", httpStatus: 402, method: "GET", probedAt: "2026-09-27T10:31:04Z", legacyProbe: true, legacyLongEnvelope: true });
  assert.match(String(legacyLong), /first 4,000 bytes/);
  assert.match(String(legacyLong), /vet402's measuring error/);
  const legacyShort = l0ReasonDetail({ verdict: "fail", failReason: "accepts_invalid", httpStatus: 402, method: "GET", probedAt: "2026-09-27T10:31:04Z", legacyProbe: true, legacyLongEnvelope: false });
  assert.match(String(legacyShort), /was not recorded before/);
  const post400 = l0ReasonDetail({ verdict: "fail", failReason: "no_402", httpStatus: 400, method: "POST", probedAt: "2026-09-27T10:31:04Z", legacyProbe: true });
  assert.match(String(post400), /recorded as request_shape \(unverified\)/);
  const newPost404 = l0ReasonDetail({ verdict: "fail", failReason: "no_402", httpStatus: 404, method: "POST", probedAt: new Date(), legacyProbe: false });
  assert.equal(newPost404, "HTTP 404 instead of 402 to an unpaid POST.");
  assert.equal(l0ReasonDetail({ verdict: "pass", failReason: null, httpStatus: 402, method: "GET", probedAt: new Date() }), null);
  assert.match(String(l0ReasonDetail({ verdict: "fail", failReason: "dns", httpStatus: null, method: "GET", probedAt: new Date() })), /did not resolve/);
});
