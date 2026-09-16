// ============================================================
// L1 の POST 本文（Issue #29・2026-09-17）。
//
// 無払いの 402 応答（PAYMENT-REQUIRED ヘッダの base64 JSON、または本文の JSON）に
// extensions.bazaar.info.input.body があり、それが JSON の object / array で、
// JSON 文字列にして 16KB 以下なら、支払い付き POST はその本文をそのまま送る。
// それ以外（宣言なし・壊れた宣言・スカラー・16KB 超）は従来どおり `{}`。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { DECLARED_BODY_MAX_BYTES, declaredRequestBody } from "@/lib/observatory/declared-input";
import { BASE_USDC } from "@/lib/observatory/x402-payer";

const accepts = [
  { scheme: "exact", network: "eip155:8453", amount: "3000", asset: BASE_USDC, payTo: `0x${"1".repeat(40)}`, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } },
];
/** Douglas（api.insumermodel.com /v1/attest）の宣言と同じ形。 */
const insumerBody = {
  wallet: "0x0000000000000000000000000000000000000001",
  conditions: [{ type: "token_balance", chainId: 8453, contractAddress: BASE_USDC, threshold: 1 }],
};
const doc = (body: unknown) => ({
  x402Version: 2,
  accepts,
  extensions: { bazaar: { info: { input: { type: "http", method: "POST", body } }, schema: { properties: { input: {} } } } },
});
const header = (v: unknown) => new Headers({ "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(v)).toString("base64") });

test("ヘッダの宣言（object）はそのまま本文になる", () => {
  const r = declaredRequestBody({ bodyText: "", headers: header(doc(insumerBody)) });
  assert.equal(r.source, "declared");
  assert.deepEqual(JSON.parse(r.body), insumerBody);
  assert.equal(r.body, JSON.stringify(insumerBody), "中身を書き換えない");
});

test("本文の JSON に載った宣言も読む（ヘッダが無い売り手）", () => {
  const r = declaredRequestBody({ bodyText: JSON.stringify(doc([1, 2, 3])), headers: new Headers() });
  assert.equal(r.source, "declared");
  assert.equal(r.body, "[1,2,3]");
});

test("宣言が無ければ {}（extensions なし・input なし・body なし）", () => {
  const cases = [
    { x402Version: 2, accepts },
    { x402Version: 2, accepts, extensions: { bazaar: { info: { input: { method: "POST" } } } } },
    { x402Version: 2, accepts, extensions: {} },
  ];
  for (const c of cases) {
    const r = declaredRequestBody({ bodyText: "", headers: header(c) });
    assert.deepEqual(r, { body: "{}", source: "empty" }, JSON.stringify(c));
  }
});

test("壊れた宣言は {}（スカラー・null・文字列・壊れた base64/JSON）", () => {
  for (const bad of [null, "wallet=0x1", 42, true]) {
    assert.deepEqual(declaredRequestBody({ bodyText: "", headers: header(doc(bad)) }), { body: "{}", source: "empty" }, String(bad));
  }
  assert.deepEqual(
    declaredRequestBody({ bodyText: "not json", headers: new Headers({ "PAYMENT-REQUIRED": "%%%not-base64-json" }) }),
    { body: "{}", source: "empty" },
  );
});

test("16KB を超える宣言は送らない（{}）。ちょうど上限は送る", () => {
  const pad = (n: number) => ({ p: "x".repeat(n) });
  const overhead = JSON.stringify(pad(0)).length;
  const exact = pad(DECLARED_BODY_MAX_BYTES - overhead);
  assert.equal(Buffer.byteLength(JSON.stringify(exact)), DECLARED_BODY_MAX_BYTES);
  assert.equal(declaredRequestBody({ bodyText: "", headers: header(doc(exact)) }).source, "declared");
  const over = pad(DECLARED_BODY_MAX_BYTES - overhead + 1);
  assert.deepEqual(declaredRequestBody({ bodyText: "", headers: header(doc(over)) }), { body: "{}", source: "empty" });
});

test("16KB はバイトで数える（マルチバイト文字で上限を越えさせない）", () => {
  const overhead = JSON.stringify({ p: "" }).length;
  const chars = Math.floor((DECLARED_BODY_MAX_BYTES - overhead) / 3) + 1; // 3 bytes each
  const r = declaredRequestBody({ bodyText: "", headers: header(doc({ p: "あ".repeat(chars) })) });
  assert.equal(r.source, "empty");
});

test("支払い条件が読めない文書の宣言は使わない（parseChallenge が使う文書と同じものだけを読む）", () => {
  const noAccepts = { x402Version: 2, extensions: doc(insumerBody).extensions };
  assert.deepEqual(declaredRequestBody({ bodyText: "", headers: header(noAccepts) }), { body: "{}", source: "empty" });
  // ヘッダが accepts を持てばヘッダの文書を使う（本文の別宣言は見ない）
  const r = declaredRequestBody({ bodyText: JSON.stringify(doc({ other: 1 })), headers: header(doc(insumerBody)) });
  assert.deepEqual(JSON.parse(r.body), insumerBody);
});
