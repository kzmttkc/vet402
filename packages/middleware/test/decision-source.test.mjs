// 製品定義書 §9.3 売り手モード（2026-09-02）: decisionSource "decision"。
//   - 決済確認後の payer を /resources/{rid}/decision?role=payee&payer=… で判定する
//   - role は固定 payee。この gate が role=payer を送る経路は無い（買い手モードは 9/4 以降）
//   - facts の無い応答は BLOCK。タイムアウトは BLOCK（fail-closed）。サイレント通過は無い
//   - Idempotency-Key を渡せる
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTrustGate, VouchGateError } from "../dist/index.js";

const ADDR = "0x2222222222222222222222222222222222222222";
const RID = "a".repeat(64);
const CFG = { apiUrl: "https://vouch.test/api/v1", apiKey: "vk_test", decisionSource: "decision", resourceId: RID };

function capture(body, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return { ok, status, json: async () => body };
  };
  return { calls, fetchFn };
}
const fresh = () => ({ scoredAt: new Date().toISOString(), cacheExpiresAt: new Date(Date.now() + 60_000).toISOString() });

test("decisionSource decision は resourceId（sha256）が必須", () => {
  assert.throws(() => createTrustGate({ apiUrl: CFG.apiUrl, apiKey: CFG.apiKey, decisionSource: "decision" }), (e) => e instanceof VouchGateError && e.code === "missing_resource_id");
  assert.throws(() => createTrustGate({ ...CFG, resourceId: "nope" }), (e) => e instanceof VouchGateError && e.code === "missing_resource_id");
});

test("役割は payee 固定で /decision を叩く。role=payer は送らない", async () => {
  const { calls, fetchFn } = capture({ recommendation: "ALLOW", facts: { settled_count_30d: 5 }, ...fresh() });
  const gate = createTrustGate({ ...CFG, fetch: fetchFn, idempotencyKey: (a) => `order-${a.slice(-4)}` });
  const d = await gate.evaluate(ADDR);
  assert.equal(d.action, "allow");
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, `/api/v1/resources/${RID}/decision`);
  assert.equal(url.searchParams.get("role"), "payee");
  assert.equal(url.searchParams.get("payer"), ADDR);
  assert.notEqual(url.searchParams.get("role"), "payer");
  assert.equal(calls[0].init.headers["Idempotency-Key"], "order-2222");
  assert.equal(gate.config.decisionSource, "decision");
  assert.equal(gate.config.resourceId, RID);
});

test("facts の無い応答は BLOCK（スコアだけの応答を信じない）", async () => {
  const { fetchFn } = capture({ recommendation: "ALLOW", ...fresh() });
  const d = await createTrustGate({ ...CFG, fetch: fetchFn }).evaluate(ADDR);
  assert.equal(d.action, "block");
  assert.equal(d.reason, "facts_missing");
  assert.equal(d.degraded, true);
});

test("allow-only 既定: WARN も BLOCK も通さない。degraded は BLOCK", async () => {
  for (const rec of ["WARN", "BLOCK"]) {
    const { fetchFn } = capture({ recommendation: rec, facts: {}, ...fresh() });
    const d = await createTrustGate({ ...CFG, fetch: fetchFn }).evaluate(ADDR);
    assert.equal(d.action, "block", rec);
  }
  const { fetchFn } = capture({ recommendation: "ALLOW", facts: {}, degraded: true, ...fresh() });
  const d = await createTrustGate({ ...CFG, fetch: fetchFn }).evaluate(ADDR);
  assert.equal(d.action, "block");
  assert.equal(d.reason, "decision_degraded");
});

test("タイムアウト／到達不能は BLOCK（fail-closed）。failMode open のときだけ通る", async () => {
  const down = async () => {
    throw new Error("down");
  };
  const closed = await createTrustGate({ ...CFG, fetch: down }).evaluate(ADDR);
  assert.equal(closed.action, "block");
  assert.equal(closed.degraded, true);
  const open = await createTrustGate({ ...CFG, fetch: down, failMode: "open" }).evaluate(ADDR);
  assert.equal(open.action, "allow");
  assert.equal(open.degraded, true);
});

test("古い判定（cacheExpiresAt 超過）は BLOCK", async () => {
  const { fetchFn } = capture({ recommendation: "ALLOW", facts: {}, scoredAt: new Date(Date.now() - 3_600_000).toISOString(), cacheExpiresAt: new Date(Date.now() - 1_000).toISOString() });
  const d = await createTrustGate({ ...CFG, fetch: fetchFn }).evaluate(ADDR);
  assert.equal(d.action, "block");
  assert.equal(d.reason, "decision_stale");
});

test("policy evidence は /score の signals を読む前提なので decision とは組めない", () => {
  assert.throws(
    () => createTrustGate({ ...CFG, policy: "evidence", scoreSource: "payee", requireEvidence: { minL1Deliveries: 1 } }),
    (e) => e instanceof VouchGateError && e.code === "invalid_policy_combination",
  );
});

test("既定（decisionSource 省略）は従来どおり /score を叩く——後方互換", async () => {
  const { calls, fetchFn } = capture({ trustScore: 80, recommendation: "ALLOW", ...fresh() });
  const gate = createTrustGate({ apiUrl: CFG.apiUrl, apiKey: CFG.apiKey, fetch: fetchFn });
  await gate.evaluate(ADDR);
  assert.match(calls[0].url, /\/wallets\/0x2222.*\/score$/);
  assert.equal(gate.config.decisionSource, "score");
  assert.equal(gate.config.resourceId, null);
});
