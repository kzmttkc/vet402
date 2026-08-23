// ============================================================
// 2026-08-23 監査: MCP の fail-closed を「説明文の約束」から「型とフィールド」へ
// 移したことを固定する。
//
// SDK の SpendGuard は同じ規律を型と分岐で強制していたのに、エージェント統合の
// 主経路である MCP だけがモデルの読解に依存していた。散文はモデルが無視できるが、
// フィールドは無視できない。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideFromScore, decideFromFailure } from "../dist/decision.js";

const FUTURE = new Date(Date.now() + 60_000).toISOString();
const PAST = new Date(Date.now() - 60_000).toISOString();

const clean = () => ({
  recommendation: "ALLOW",
  degraded: false,
  signalsUnavailable: [],
  cacheExpiresAt: FUTURE,
  score: 88,
});

test("不変条件: safe_to_pay は decision と常に一致する", () => {
  const cases = [
    clean(),
    { ...clean(), degraded: true },
    { ...clean(), recommendation: "BLOCK" },
    { ...clean(), signalsUnavailable: ["wallet_metrics"] },
    { ...clean(), cacheExpiresAt: PAST },
    null,
    "not an object",
    {},
  ];
  for (const c of cases) {
    const d = decideFromScore(c);
    assert.equal(d.safe_to_pay, d.decision === "ALLOW_PAY", `不一致: ${JSON.stringify(c)}`);
  }
  const f = decideFromFailure("timeout");
  assert.equal(f.safe_to_pay, f.decision === "ALLOW_PAY");
});

test("degraded=true は recommendation が ALLOW でも必ず REFUSE", () => {
  const d = decideFromScore({ ...clean(), degraded: true });
  assert.equal(d.decision, "REFUSE");
  assert.equal(d.safe_to_pay, false);
  assert.ok(d.refuse_reasons.includes("degraded_measurement"));
});

test("signalsUnavailable が非空なら ALLOW でも必ず REFUSE", () => {
  const d = decideFromScore({ ...clean(), signalsUnavailable: ["usdc_drain", "outcome_history"] });
  assert.equal(d.decision, "REFUSE");
  assert.equal(d.safe_to_pay, false);
  assert.ok(d.refuse_reasons.includes("partial_measurement"));
  assert.match(d.summary, /usdc_drain/, "何が測れなかったかを言っていない");
});

test("recommendation が ALLOW 以外なら REFUSE", () => {
  for (const r of ["WARN", "BLOCK", "UNKNOWN", undefined, null]) {
    const d = decideFromScore({ ...clean(), recommendation: r });
    assert.equal(d.decision, "REFUSE", `recommendation=${r} が通った`);
  }
});

test("期限切れ・解釈不能な日付は fail-closed 側へ倒す", () => {
  assert.equal(decideFromScore({ ...clean(), cacheExpiresAt: PAST }).decision, "REFUSE");
  assert.equal(decideFromScore({ ...clean(), cacheExpiresAt: "not-a-date" }).decision, "REFUSE");
  // 鮮度フィールドが無い応答は、それだけを理由に落とさない（後方互換）
  const noField = { recommendation: "ALLOW", degraded: false, signalsUnavailable: [] };
  assert.equal(decideFromScore(noField).decision, "ALLOW_PAY");
});

test("答えが無いのは ALLOW ではない", () => {
  const d = decideFromFailure("lookup_timeout");
  assert.equal(d.decision, "REFUSE");
  assert.equal(d.safe_to_pay, false);
  assert.deepEqual(d.refuse_reasons, ["lookup_failed"]);
  assert.match(d.summary, /No answer is not an ALLOW/);
});

test("壊れた応答を ALLOW にしない", () => {
  for (const bad of [null, undefined, "ok", 42, []]) {
    const d = decideFromScore(bad);
    assert.equal(d.safe_to_pay, false, `${JSON.stringify(bad)} が通った`);
  }
});

test("完全に測れて現行で ALLOW のときだけ ALLOW_PAY", () => {
  const d = decideFromScore(clean());
  assert.equal(d.decision, "ALLOW_PAY");
  assert.equal(d.safe_to_pay, true);
  assert.deepEqual(d.refuse_reasons, []);
});

test("複数の理由は全部列挙する（1つに丸めない）", () => {
  const d = decideFromScore({
    recommendation: "BLOCK",
    degraded: true,
    signalsUnavailable: ["wallet_metrics"],
    cacheExpiresAt: PAST,
  });
  assert.deepEqual(d.refuse_reasons.sort(), [
    "degraded_measurement",
    "partial_measurement",
    "recommendation_not_allow",
    "score_stale",
  ]);
});
