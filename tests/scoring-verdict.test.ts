// ============================================================
// Vouch — the fail-closed chain, end to end.
//
// WHY THIS IS THE FIRST TEST FILE IN THE PRODUCT (2026-08-05). Every external
// read the engine makes is wrapped so that a failure becomes a `*_unavailable`
// flag rather than an exception. assessSybilRisk maps any of those to
// risk="high", and resolveRecommendation turns "high" into an unconditional
// BLOCK. That is the entire safety property of a trust API: "we could not
// check" must never leave here as "we checked and it was fine".
//
// It is also the property most likely to break without anyone noticing,
// because breaking it does not throw — it produces a confident ALLOW. A
// customer gating x402 settlement on this endpoint would keep settling
// payments while our RPC was down, and the first symptom would be their loss,
// not our alert.
//
// Run: npm test
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessSybilRisk,
  reasonCodes,
  resolveRecommendation,
  toRecommendation,
} from "@/lib/scoring/verdict";
import { SCORE_THRESHOLDS } from "@/lib/chain/config";

const UNAVAILABLE_FLAGS = [
  "owner_count_unavailable",
  "feedback_stats_unavailable",
  "reputation_summary_unavailable",
  "wallet_metrics_unavailable",
] as const;

test("every unavailable flag on its own is high risk", () => {
  for (const flag of UNAVAILABLE_FLAGS) {
    assert.equal(assessSybilRisk([flag]), "high", `${flag} must be high`);
  }
});

test("a failed or mismatched wallet verification is high risk", () => {
  assert.equal(assessSybilRisk(["wallet_mismatch"]), "high");
  assert.equal(assessSybilRisk(["wallet_verification_failed"]), "high");
});

test("no flags is low risk — the only way to reach ALLOW", () => {
  assert.equal(assessSybilRisk([]), "low");
});

test("a single soft flag is medium, not high", () => {
  assert.equal(assessSybilRisk(["new_burner_wallet"]), "medium");
  assert.equal(assessSybilRisk(["multi_agent_owner"]), "medium");
  assert.equal(assessSybilRisk(["funding_cluster"]), "medium");
  assert.equal(assessSybilRisk(["review_velocity_anomaly"]), "medium");
  assert.equal(assessSybilRisk(["no_bound_wallet"]), "medium");
});

test("主体についての所見が3本なら high（ソフトフラグは票に数えない）", () => {
  // 2026-08-24 監査で意味論を変更。このテストは以前
  //   ["new_burner_wallet", "multi_agent_owner", "no_bound_wallet"] → high
  // を固定していた。テスト名が自ら "soft flags" と呼んでいるとおり、柔らかい
  // フラグだと認識しながら無条件BLOCKの票に数えていた。
  // multi_agent_owner は3体以上を運用する**正当な運営者**にも付き、
  // sybil を示すのは funding_cluster との同時成立（下のテストが固定）。
  // 主体の行いでないものを票にすると、何も悪いことをしていない運営者が
  // スコアに関係なく BLOCK になる。
  assert.equal(
    assessSybilRisk(["new_burner_wallet", "multi_agent_owner", "no_bound_wallet"]),
    "medium",
    "正当な複数エージェント運用を票に数えてBLOCKにしている",
  );
  // 主体についての所見が3本なら従来どおり high。
  assert.equal(
    assessSybilRisk(["new_burner_wallet", "no_bound_wallet", "funding_cluster"]),
    "high",
  );
  assert.equal(assessSybilRisk(["new_burner_wallet", "multi_agent_owner"]), "medium");
});

test("the two named soft-flag pairs are high", () => {
  assert.equal(assessSybilRisk(["funding_cluster", "multi_agent_owner"]), "high");
  assert.equal(assessSybilRisk(["no_bound_wallet", "review_velocity_anomaly"]), "high");
});

test("an unknown future flag counts toward the >=3 rule but never clears risk", () => {
  assert.equal(assessSybilRisk(["something_new"]), "medium");
  assert.equal(assessSybilRisk(["a", "b", "c"]), "high");
  // An unavailable flag stays decisive no matter what else is present.
  assert.equal(assessSybilRisk(["a", "feedback_stats_unavailable"]), "high");
});

// ---- the gate itself -------------------------------------------------------

test("high risk BLOCKs at every score, including a perfect one", () => {
  for (const score of [0, 39, 40, 69, 70, 99, 100]) {
    assert.equal(
      resolveRecommendation(score, "none", "high"),
      "BLOCK",
      `score ${score} must BLOCK when sybil risk is high`,
    );
  }
});

test("a whitelist cannot rescue a high-risk agent", () => {
  assert.equal(resolveRecommendation(100, "whitelist", "high"), "BLOCK");
  assert.equal(resolveRecommendation(85, "whitelist", "high"), "BLOCK");
});

test("every unavailable flag ends in BLOCK through the real chain", () => {
  for (const flag of UNAVAILABLE_FLAGS) {
    const risk = assessSybilRisk([flag]);
    assert.equal(
      resolveRecommendation(100, "whitelist", risk),
      "BLOCK",
      `${flag} must not clear an x402 gate`,
    );
  }
});

test("thresholds: ALLOW at 70, WARN at 40, BLOCK below", () => {
  assert.equal(resolveRecommendation(SCORE_THRESHOLDS.allow, "none", "low"), "ALLOW");
  assert.equal(resolveRecommendation(SCORE_THRESHOLDS.allow - 1, "none", "low"), "WARN");
  assert.equal(resolveRecommendation(SCORE_THRESHOLDS.warn, "none", "low"), "WARN");
  assert.equal(resolveRecommendation(SCORE_THRESHOLDS.warn - 1, "none", "low"), "BLOCK");
  assert.equal(resolveRecommendation(0, "none", "low"), "BLOCK");
});

test("a whitelist promotes WARN to ALLOW only when risk is low", () => {
  assert.equal(resolveRecommendation(50, "whitelist", "low"), "ALLOW");
  assert.equal(resolveRecommendation(50, "whitelist", "medium"), "WARN");
  assert.equal(resolveRecommendation(50, "none", "low"), "WARN");
});

test("a whitelist never promotes a BLOCK score to ALLOW", () => {
  assert.equal(resolveRecommendation(10, "whitelist", "low"), "BLOCK");
  assert.equal(resolveRecommendation(SCORE_THRESHOLDS.warn - 1, "whitelist", "low"), "BLOCK");
});

test("a blacklist override wins over everything, including a perfect score", () => {
  assert.equal(resolveRecommendation(100, "blacklist", "low", "BLOCK"), "BLOCK");
});

test("an explicit override short-circuits the whole gate", () => {
  // Operator policy is decided upstream; the gate must not re-litigate it.
  assert.equal(resolveRecommendation(0, "none", "high", "ALLOW"), "ALLOW");
  assert.equal(resolveRecommendation(100, "none", "low", "BLOCK"), "BLOCK");
});

test("medium risk does not block on its own — it is a warning, not a verdict", () => {
  assert.equal(resolveRecommendation(90, "none", "medium"), "ALLOW");
  assert.equal(resolveRecommendation(50, "none", "medium"), "WARN");
});

// ---- toRecommendation, the raw threshold function --------------------------

test("toRecommendation: blacklist forces BLOCK regardless of score", () => {
  assert.equal(toRecommendation(100, true), "BLOCK");
  assert.equal(toRecommendation(0, false), "BLOCK");
  assert.equal(toRecommendation(100, false), "ALLOW");
});

test("toRecommendation boundaries are inclusive at the named thresholds", () => {
  assert.equal(toRecommendation(70, false), "ALLOW");
  assert.equal(toRecommendation(69.999, false), "WARN");
  assert.equal(toRecommendation(40, false), "WARN");
  assert.equal(toRecommendation(39.999, false), "BLOCK");
});

test("the published thresholds are the ones the docs quote", () => {
  assert.equal(SCORE_THRESHOLDS.allow, 70);
  assert.equal(SCORE_THRESHOLDS.warn, 40);
});

test("owner_index_stale alone is medium — disclosure, not a verdict", () => {
  assert.equal(assessSybilRisk(["owner_index_stale"]), "medium");
  // …and a stale index during an otherwise-clean score must not BLOCK.
  assert.equal(resolveRecommendation(90, "none", assessSybilRisk(["owner_index_stale"])), "ALLOW");
});

test("N-18: reason codes cannot disagree with the verdict they explain", () => {
  const base = {
    identity: { registered: true, hasMetadataUri: true },
    reputation: { feedbackCount: 5 },
    wallet: { ageDays: 100, isBurner: false },
    x402: { paymentCount: 3 },
    sybil: { risk: "low" as const, flags: [] },
    manual: { list: "none" as const },
  };
  assert.ok(reasonCodes(base, 85, "ALLOW").includes("score:above_allow_threshold:85"));
  assert.ok(
    reasonCodes({ ...base, sybil: { risk: "high", flags: ["wallet_mismatch"] } }, 85, "BLOCK")
      .includes("sybil:high_risk_block"),
  );
  assert.ok(
    reasonCodes({ ...base, sybil: { risk: "high", flags: ["wallet_mismatch"] } }, 85, "BLOCK")
      .includes("sybil:wallet_mismatch"),
  );
  assert.ok(reasonCodes({ ...base, manual: { list: "blacklist" } }, 0, "BLOCK").includes("manual:blacklisted"));
  assert.ok(
    reasonCodes({ ...base, identity: { registered: false, hasMetadataUri: false } }, 20, "BLOCK")
      .includes("identity:not_registered"),
  );
  assert.ok(
    reasonCodes({ ...base, wallet: { ageDays: 1, isBurner: true }, x402: { paymentCount: 0 } }, 45, "WARN")
      .includes("wallet:burner"),
  );
});

// ============================================================
// 2026-08-12 — the `*_unavailable` class must fail CLOSED as a class.
//
// assessSybilRisk used to enumerate the unavailable-flags one by one. Every
// new one had to remember to be added, and a forgotten one fails OPEN: it
// arrives as a single flag, scores "medium", and can still clear an ALLOW
// gate — a lookup that checked nothing reported as "checked, looks fine".
// That is the exact inversion the fail-closed design exists to prevent.
// ============================================================

test("a newly introduced *_unavailable flag is high risk without being enumerated", () => {
  // Not named anywhere in assessSybilRisk — the class match must catch it.
  assert.equal(assessSybilRisk(["sybil_checks_unavailable"]), "high");
  assert.equal(assessSybilRisk(["some_future_source_unavailable"]), "high");
});

test("an unavailable read can never clear an ALLOW gate, even whitelisted", () => {
  const risk = assessSybilRisk(["sybil_checks_unavailable"]);
  assert.equal(resolveRecommendation(99, "whitelist", risk), "BLOCK");
});

test("the previously enumerated flags keep their exact verdicts", () => {
  for (const flag of [
    "owner_count_unavailable",
    "feedback_stats_unavailable",
    "reputation_summary_unavailable",
    "wallet_metrics_unavailable",
  ]) {
    assert.equal(assessSybilRisk([flag]), "high", flag);
    assert.equal(resolveRecommendation(100, "none", assessSybilRisk([flag])), "BLOCK", flag);
  }
});

test("flags that are not availability failures keep their old, milder handling", () => {
  // A single ordinary flag is still "medium" — the class match must key on the
  // _unavailable suffix, not broaden everything into a BLOCK.
  assert.equal(assessSybilRisk(["new_burner_wallet"]), "medium");
  assert.equal(assessSybilRisk([]), "low");
});
