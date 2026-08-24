// ============================================================
// SpendGuard — `trustPolicy: "evidence"`: the safe middle between
// "allow-only denies literally everyone" and "custom silently switches the
// data-quality gates off".
//
// WHY THIS FILE EXISTS (2026-08-25). Measured on production the same day:
//
//   - /accuracy operator benchmark, known-good set: 0 of 17 ALLOW, 17 WARN,
//     0 BLOCK. Not a scoring bug — the wallet engine caps an unregistered
//     bare wallet at computeWeightedScore(30, 30, 100, 50) = 62, and the ALLOW
//     line is 70. Vitalik, the Ethereum Foundation and Coinbase all land in
//     the WARN band by construction.
//   - the payee engine caps a payee with no independent receiving record at
//     PAYEE_THIN_SCORE_CEILING = 69 (2026-08-13 score-manipulation ruling).
//     Production has 0 rows in x402_payments and every L1-settled payee has
//     exactly 1 distinct buyer, so EVERY payee is thin: 0x36038e1d… has 48
//     delivery-verified L1 receipts and 0 failures and still scores WARN.
//
// So under the shipped default (`trustPolicy: "allow-only"`) the guard denies
// every counterparty that exists. The default is deliberate and stays — see
// docs/ethonline-2026/fixtures.md §1, "既定は allow-only のまま". What was
// missing is a DISCLOSED way to accept a WARN without giving up the
// data-quality gates:
//
//   - "block-only" accepts every WARN, including a 41-score thin payee that
//     merely missed BLOCK;
//   - "custom" is worse than it looks — it turns OFF the staleness (H-2) and
//     degraded/partial-measurement gates entirely.
//
// "evidence" accepts a WARN only when the payee carries verifiable economic
// evidence the caller named a floor for, and keeps every data-quality gate
// that allow-only applies. Absence of evidence is never a pass.
// ============================================================
import assert from "node:assert/strict";
import { test } from "node:test";
import { SpendGuard } from "../dist/index.js";

const PAYEE = "0x1111111111111111111111111111111111111111";

/** Mirrors the production shape of 0x36038e1d… (48 settled / 0 failed, WARN). */
function payeeScore(overrides = {}) {
  const { receiving: receivingOverrides, ...rest } = overrides;
  return {
    payee: PAYEE,
    score: 69,
    recommendation: "WARN",
    dataDepth: "thin",
    degraded: false,
    signalsUnavailable: [],
    signals: {
      receiving: {
        paymentCount: 0,
        uniqueDays: 0,
        distinctPayers: 0,
        score: 40,
        l1DeliveryCount: 48,
        l1DistinctBuyers: 1,
        ...receivingOverrides,
      },
      walletHealth: { ageDays: 200, txCount: 400, isBurner: false, score: 85 },
      drainPattern: {
        detected: false,
        drainRatio: 0.1,
        outgoingCount: 3,
        incomingCount: 8,
        score: 85,
      },
      outcomeHistory: { types: [], adjustment: 0 },
      flags: [],
    },
    scoredAt: new Date().toISOString(),
    cacheExpiresAt: new Date(Date.now() + 300000).toISOString(),
    disclaimer: "test",
    ...rest,
  };
}

const fetcher = (overrides) => async () => payeeScore(overrides);

// ------------------------------------------------------------
// Characterization: the defect this feature answers. These pin the SHIPPED
// default and must keep passing — the fix does not touch it.
// ------------------------------------------------------------

test("CHARACTERIZATION: 既定(allow-only)は、配達実績48件の実在payeeでも拒否する", async () => {
  const guard = new SpendGuard({ maxPerTxUsd: 10 }, fetcher());
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 1 });

  assert.equal(decision.allow, false);
  assert.deepEqual(decision.reasons, ["payee_recommendation_not_allow"]);
});

// ------------------------------------------------------------
// The new policy.
// ------------------------------------------------------------

test("evidence: 実測された配達実績が下限を満たす WARN は通す", async () => {
  const guard = new SpendGuard(
    { trustPolicy: "evidence", requireEvidence: { minL1Deliveries: 3 } },
    fetcher(),
  );
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 1 });

  assert.equal(decision.allow, true, `denied: ${decision.reasons.join(",")}`);
  assert.deepEqual(decision.reasons, []);
});

test("evidence: 実績が下限に届かない WARN は payee_insufficient_evidence で拒否", async () => {
  const guard = new SpendGuard(
    { trustPolicy: "evidence", requireEvidence: { minL1Deliveries: 100 } },
    fetcher(),
  );
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 1 });

  assert.equal(decision.allow, false);
  assert.deepEqual(decision.reasons, ["payee_insufficient_evidence"]);
});

test("evidence: BLOCK は、どれだけ実績が積まれていても絶対に通さない", async () => {
  const guard = new SpendGuard(
    { trustPolicy: "evidence", requireEvidence: { minL1Deliveries: 1 } },
    fetcher({
      recommendation: "BLOCK",
      score: 12,
      receiving: { l1DeliveryCount: 9999, l1DistinctBuyers: 500 },
    }),
  );
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 1 });

  assert.equal(decision.allow, false);
  assert.deepEqual(decision.reasons, ["payee_recommendation_block"]);
});

test("evidence: 攻撃ビルド(自己申告のみ・実活動ゼロ)は ALLOW を取れない", async () => {
  // 2026-08-13 のスコア操作対策と同じ絵。登録と評判サマリだけがあり、
  // 受領実績も配達実績も無い相手。evidence policy でも素通りしてはならない。
  const guard = new SpendGuard(
    { trustPolicy: "evidence", requireEvidence: { minL1Deliveries: 3 } },
    fetcher({
      receiving: {
        paymentCount: 0,
        distinctPayers: 0,
        l1DeliveryCount: 0,
        l1DistinctBuyers: 0,
      },
    }),
  );
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 1 });

  assert.equal(decision.allow, false);
  assert.deepEqual(decision.reasons, ["payee_insufficient_evidence"]);
});

test("evidence: 実績フィールドが欠落している応答は、ゼロ扱いで拒否する(不在は合格ではない)", async () => {
  // l1DeliveryCount / l1DistinctBuyers は後方互換のため optional。
  // 「載っていない」を「条件を満たした」と読むと、古いサーバや細工された
  // 応答が無条件で通る。
  const guard = new SpendGuard(
    { trustPolicy: "evidence", requireEvidence: { minL1Deliveries: 1 } },
    fetcher({
      receiving: {
        paymentCount: 0,
        distinctPayers: 0,
        l1DeliveryCount: undefined,
        l1DistinctBuyers: undefined,
      },
    }),
  );
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 1 });

  assert.equal(decision.allow, false);
  assert.deepEqual(decision.reasons, ["payee_insufficient_evidence"]);
});

test("evidence: 独立した買い手の下限も効く", async () => {
  const guard = new SpendGuard(
    {
      trustPolicy: "evidence",
      requireEvidence: { minL1Deliveries: 3, minL1DistinctBuyers: 2 },
    },
    fetcher(), // l1DistinctBuyers: 1
  );
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 1 });

  assert.equal(decision.allow, false);
  assert.deepEqual(decision.reasons, ["payee_insufficient_evidence"]);
});

test("evidence: x402 の決済実績と独立payer数でも下限を書ける", async () => {
  const guard = new SpendGuard(
    {
      trustPolicy: "evidence",
      requireEvidence: { minX402Payments: 3, minDistinctPayers: 2 },
    },
    fetcher({
      receiving: {
        paymentCount: 5,
        distinctPayers: 3,
        l1DeliveryCount: 0,
        l1DistinctBuyers: 0,
      },
    }),
  );
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 1 });

  assert.equal(decision.allow, true, `denied: ${decision.reasons.join(",")}`);
});

// ------------------------------------------------------------
// The gates "custom" gives up — evidence keeps all of them.
// ------------------------------------------------------------

test("evidence: degraded な読みは、実績が十分でも拒否する", async () => {
  const guard = new SpendGuard(
    { trustPolicy: "evidence", requireEvidence: { minL1Deliveries: 1 } },
    fetcher({ degraded: true }),
  );
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 1 });

  assert.equal(decision.allow, false);
  assert.deepEqual(decision.reasons, ["payee_score_degraded"]);
});

test("evidence: 古いスコアは拒否する(H-2 の鮮度関門を落とさない)", async () => {
  const guard = new SpendGuard(
    { trustPolicy: "evidence", requireEvidence: { minL1Deliveries: 1 } },
    fetcher({
      scoredAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      cacheExpiresAt: new Date(Date.now() - 55 * 60 * 1000).toISOString(),
    }),
  );
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 1 });

  assert.equal(decision.allow, false);
  assert.deepEqual(decision.reasons, ["payee_score_stale"]);
});

test("evidence: 一部が測れていない応答は拒否する", async () => {
  const guard = new SpendGuard(
    { trustPolicy: "evidence", requireEvidence: { minL1Deliveries: 1 } },
    fetcher({ signalsUnavailable: ["usdc_drain"] }),
  );
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 1 });

  assert.equal(decision.allow, false);
  assert.deepEqual(decision.reasons, ["payee_partial_measurement"]);
});

test("evidence: 照会そのものが失敗したら拒否する", async () => {
  const guard = new SpendGuard(
    { trustPolicy: "evidence", requireEvidence: { minL1Deliveries: 1 } },
    async () => {
      throw new Error("scoring_unavailable");
    },
  );
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 1 });

  assert.equal(decision.allow, false);
  assert.deepEqual(decision.reasons, ["payee_trust_unavailable"]);
});

test("evidence: 明示の minPayeeScore も従来どおり重ねられる", async () => {
  const guard = new SpendGuard(
    {
      trustPolicy: "evidence",
      requireEvidence: { minL1Deliveries: 1 },
      minPayeeScore: 80,
    },
    fetcher(), // score 69
  );
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 1 });

  assert.equal(decision.allow, false);
  assert.deepEqual(decision.reasons, ["payee_score_below_min"]);
});

// ------------------------------------------------------------
// The opt-out has to be spelled out. A silent "evidence" would be
// "block-only" wearing a safer-sounding name.
// ------------------------------------------------------------

test("evidence: requireEvidence を書かずに evidence を選ぶのは設定エラー", () => {
  assert.throws(
    () => new SpendGuard({ trustPolicy: "evidence" }, fetcher()),
    /invalid_policy_requireEvidence/,
  );
});

test("evidence: 下限が全部ゼロ(=無条件通過)の requireEvidence は受け付けない", () => {
  assert.throws(
    () =>
      new SpendGuard(
        { trustPolicy: "evidence", requireEvidence: { minL1Deliveries: 0 } },
        fetcher(),
      ),
    /invalid_policy_requireEvidence/,
  );
});

test("evidence: requireEvidence は evidence policy 以外では受け付けない", () => {
  assert.throws(
    () =>
      new SpendGuard(
        { trustPolicy: "block-only", requireEvidence: { minL1Deliveries: 3 } },
        fetcher(),
      ),
    /invalid_policy_requireEvidence/,
  );
});

test("evidence: 構築後に呼び手が下限オブジェクトを書き換えても、関門は緩まない", async () => {
  // 資金経路なので、設定は構築時に確定させる。共有参照のままだと
  // `floors.minL1Deliveries = 0` の一行で全 WARN が素通りする。
  const floors = { minL1Deliveries: 100 };
  const guard = new SpendGuard(
    { trustPolicy: "evidence", requireEvidence: floors },
    fetcher(), // l1DeliveryCount: 48 — 100 には届かない
  );

  floors.minL1Deliveries = 0;

  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 1 });
  assert.equal(decision.allow, false, "構築後の書き換えで関門が消えた");
  assert.deepEqual(decision.reasons, ["payee_insufficient_evidence"]);
});
