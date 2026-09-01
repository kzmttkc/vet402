// 製品定義書 §9.1（2026-09-02）: getDecision / resolve の読み取り契約。
// 買い手側で「署名前に止める」配線（SpendGuard の /decision 切替）は 9/4 以降。
// ここは「正しい URL とヘッダで読みに行く」ことだけを固定する。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createVouchClient } from "../dist/index.js";

const RID = "a".repeat(64);

function captureFetch(body = { recommendation: "ALLOW", facts: {} }) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchFn };
}

test("getDecision: role=payer が既定、caller_dialect / allow_without_l1 はクエリに載る", async () => {
  const { calls, fetchFn } = captureFetch();
  const vouch = createVouchClient({ apiKey: "vouch_live_test", fetch: fetchFn });
  await vouch.getDecision(RID, { callerDialect: "v2", allowWithoutL1: true });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, `/api/v1/resources/${RID}/decision`);
  assert.equal(url.searchParams.get("role"), "payer");
  assert.equal(url.searchParams.get("caller_dialect"), "v2");
  assert.equal(url.searchParams.get("allow_without_l1"), "true");
});

test("getDecision: role=payee は payer 必須、Idempotency-Key ヘッダが付く", async () => {
  const { calls, fetchFn } = captureFetch();
  const vouch = createVouchClient({ apiKey: "vouch_live_test", fetch: fetchFn });
  assert.throws(() => vouch.getDecision(RID, { role: "payee" }), /payer_required/);
  await vouch.getDecision(RID, { role: "payee", payer: "eip155:8453:0xabc", idempotencyKey: "req-1" });
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("role"), "payee");
  assert.equal(url.searchParams.get("payer"), "eip155:8453:0xabc");
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("idempotency-key"), "req-1");
  assert.match(headers.get("authorization"), /^Bearer /);
});

test("getDecision: resource_id の形が違えば送らない", () => {
  const { calls, fetchFn } = captureFetch();
  const vouch = createVouchClient({ apiKey: "vouch_live_test", fetch: fetchFn });
  assert.throws(() => vouch.getDecision("not-a-sha"), /invalid_resource_id/);
  assert.equal(calls.length, 0);
});

test("resolve: q を URL エンコードして送る", async () => {
  const { calls, fetchFn } = captureFetch({ query: { kind: "url", value: "x" }, disclaimer: "" });
  const vouch = createVouchClient({ apiKey: "vouch_live_test", fetch: fetchFn });
  await vouch.resolve("https://e.com/api/x?b=2&a=1");
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/api/v1/resolve");
  assert.equal(url.searchParams.get("q"), "https://e.com/api/x?b=2&a=1");
  assert.throws(() => vouch.resolve("  "), /invalid_query/);
});
