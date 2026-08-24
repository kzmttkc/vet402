// ============================================================
// createTrustGate — `policy: "evidence"`, kept symmetric with
// @vet402/sdk's SpendGuard `trustPolicy: "evidence"`.
//
// The two have been required to move together since H-4 (2026-08-13): the
// gate and the guard answering differently about the same body is exactly the
// class of bug that audit found. So the evidence opt-out lands on both, with
// the same rules — a WARN passes only on measured receiving evidence, and no
// data-quality gate is given up to get it.
//
// The evidence counters live in the /payees body only, so this policy requires
// `scoreSource: "payee"`. The /wallets beacon carries no such signals, and a
// gate that silently found none there would deny everything.
// ============================================================
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTrustGate, VouchGateError } from "../dist/index.js";

const ADDR = "0x1111111111111111111111111111111111111111";
const CFG = { apiUrl: "https://vouch.test/api/v1", apiKey: "vk_test" };

/** Production shape of a thin-but-delivering payee: WARN at the 69 ceiling. */
function payeeBody(overrides = {}) {
  const { receiving, ...rest } = overrides;
  return {
    score: 69,
    recommendation: "WARN",
    degraded: false,
    signalsUnavailable: [],
    scoredAt: new Date().toISOString(),
    cacheExpiresAt: new Date(Date.now() + 300000).toISOString(),
    signals: {
      receiving: {
        paymentCount: 0,
        distinctPayers: 0,
        l1DeliveryCount: 48,
        l1DistinctBuyers: 1,
        ...receiving,
      },
    },
    ...rest,
  };
}

function scoreFetch(body) {
  return async () => ({ ok: true, status: 200, json: async () => body });
}

const evidenceCfg = (requireEvidence, body) => ({
  ...CFG,
  scoreSource: "payee",
  policy: "evidence",
  requireEvidence,
  fetch: scoreFetch(body),
});

test("evidence: 配達実績が下限を満たす WARN は、フラグ付きで下流へ通す", async () => {
  // block-only と同じ banding: 通るが "warn" として記録される。実績で説明が
  // ついた WARN を「無かったこと」にはしない——通すことと、黙ることは別。
  const gate = createTrustGate(evidenceCfg({ minL1Deliveries: 3 }, payeeBody()));
  const d = await gate.evaluate(ADDR);
  assert.notEqual(d.action, "block", `blocked: ${d.reason}`);
  assert.equal(d.action, "warn");
  assert.equal(d.reason, "recommendation_warn");
});

test("evidence: 実績が下限に届かない WARN は insufficient_evidence で止める", async () => {
  const gate = createTrustGate(evidenceCfg({ minL1Deliveries: 100 }, payeeBody()));
  const d = await gate.evaluate(ADDR);
  assert.equal(d.action, "block");
  assert.equal(d.reason, "insufficient_evidence");
});

test("evidence: BLOCK は実績がいくらあっても通さない", async () => {
  const gate = createTrustGate(
    evidenceCfg(
      { minL1Deliveries: 1 },
      payeeBody({
        recommendation: "BLOCK",
        score: 12,
        receiving: { l1DeliveryCount: 9999, l1DistinctBuyers: 500 },
      }),
    ),
  );
  const d = await gate.evaluate(ADDR);
  assert.equal(d.action, "block");
  assert.equal(d.reason, "recommendation_block");
});

test("evidence: 実活動ゼロの自己申告ビルドは通らない", async () => {
  const gate = createTrustGate(
    evidenceCfg(
      { minL1Deliveries: 3 },
      payeeBody({
        receiving: { l1DeliveryCount: 0, l1DistinctBuyers: 0, paymentCount: 0, distinctPayers: 0 },
      }),
    ),
  );
  const d = await gate.evaluate(ADDR);
  assert.equal(d.action, "block");
  assert.equal(d.reason, "insufficient_evidence");
});

test("evidence: signals が欠落した応答はゼロ扱いで止める(不在は合格ではない)", async () => {
  const body = payeeBody();
  delete body.signals;
  const gate = createTrustGate(evidenceCfg({ minL1Deliveries: 1 }, body));
  const d = await gate.evaluate(ADDR);
  assert.equal(d.action, "block");
  assert.equal(d.reason, "insufficient_evidence");
});

test("evidence: degraded は実績が十分でも止める", async () => {
  const gate = createTrustGate(evidenceCfg({ minL1Deliveries: 1 }, payeeBody({ degraded: true })));
  const d = await gate.evaluate(ADDR);
  assert.equal(d.action, "block");
  assert.equal(d.reason, "score_degraded");
});

test("evidence: 古いスコアは止める(H-2/H-4 の鮮度関門を落とさない)", async () => {
  const gate = createTrustGate(
    evidenceCfg(
      { minL1Deliveries: 1 },
      payeeBody({
        scoredAt: new Date(Date.now() - 3600000).toISOString(),
        cacheExpiresAt: new Date(Date.now() - 3300000).toISOString(),
      }),
    ),
  );
  const d = await gate.evaluate(ADDR);
  assert.equal(d.action, "block");
  assert.equal(d.reason, "score_stale");
});

test("evidence: 一部が測れていない応答は止める", async () => {
  const gate = createTrustGate(
    evidenceCfg({ minL1Deliveries: 1 }, payeeBody({ signalsUnavailable: ["usdc_drain"] })),
  );
  const d = await gate.evaluate(ADDR);
  assert.equal(d.action, "block");
  assert.equal(d.reason, "partial_measurement");
});

test("evidence: minScore も従来どおり重ねられる", async () => {
  const gate = createTrustGate({
    ...evidenceCfg({ minL1Deliveries: 1 }, payeeBody()),
    minScore: 80,
  });
  const d = await gate.evaluate(ADDR);
  assert.equal(d.action, "block");
  assert.equal(d.reason, "below_min_score");
});

test("evidence: ALLOW はそのまま通る", async () => {
  const gate = createTrustGate(
    evidenceCfg(
      { minL1Deliveries: 99999 },
      payeeBody({ recommendation: "ALLOW", score: 88 }),
    ),
  );
  const d = await gate.evaluate(ADDR);
  assert.equal(d.action, "allow");
});

// --- configuration must be explicit -------------------------------------

test("evidence: requireEvidence 無しの evidence は設定エラー", () => {
  assert.throws(
    () => createTrustGate({ ...CFG, scoreSource: "payee", policy: "evidence" }),
    VouchGateError,
  );
});

test("evidence: 下限が全部ゼロの requireEvidence は受け付けない", () => {
  assert.throws(
    () =>
      createTrustGate({
        ...CFG,
        scoreSource: "payee",
        policy: "evidence",
        requireEvidence: { minL1Deliveries: 0 },
      }),
    VouchGateError,
  );
});

test("evidence: wallet ビーコンには実績信号が無いので、evidence policy を許さない", () => {
  assert.throws(
    () =>
      createTrustGate({
        ...CFG,
        scoreSource: "wallet",
        policy: "evidence",
        requireEvidence: { minL1Deliveries: 3 },
      }),
    VouchGateError,
  );
});

test("evidence: requireEvidence は evidence policy 以外では受け付けない", () => {
  assert.throws(
    () =>
      createTrustGate({
        ...CFG,
        scoreSource: "payee",
        policy: "block-only",
        requireEvidence: { minL1Deliveries: 3 },
      }),
    VouchGateError,
  );
});

test("evidence: 構築後に呼び手が下限オブジェクトを書き換えても、関門は緩まない", async () => {
  const floors = { minL1Deliveries: 100 };
  const gate = createTrustGate({
    ...CFG,
    scoreSource: "payee",
    policy: "evidence",
    requireEvidence: floors,
    fetch: scoreFetch(payeeBody()), // l1DeliveryCount: 48
  });

  floors.minL1Deliveries = 0;

  const d = await gate.evaluate(ADDR);
  assert.equal(d.action, "block", "構築後の書き換えで関門が消えた");
  assert.equal(d.reason, "insufficient_evidence");
});
