/**
 * 集計。**生ログから毎回計算する。集計値を別に保存して食い違わせない**（厳守2）。
 *
 * ここには「除く」経路が無い。エラーも unparseable も**分母に入る**。
 * 20 件そろっていなければ集計そのものを拒否する——間引いた集計を作れる道具にしない。
 */
import { TRIALS_PER_CONDITION, CONDITIONS } from "./harness.mjs";

const EXPECTED_TOTAL = TRIALS_PER_CONDITION * CONDITIONS.length;

function median(values) {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function tally(trials) {
  const n = trials.length;
  const count = (fn) => trials.filter(fn).length;
  const success = count((t) => t.grade.success === true);
  return {
    trials: n,
    verdictMatch: count((t) => t.grade.verdictMatch === true),
    reasonSubset: count((t) => t.grade.reasonSubset === true),
    success,
    // **分母は必ず n**（エラーを除いた分母を作らない）。
    successRate: n === 0 ? 0 : success / n,
    errors: count((t) => t.error !== null && t.error !== undefined),
    // **errors と排他**にする。同じ試行を2列で二重に数えると、読む側が分母を作れない。
    unparseable: count((t) => (t.error === null || t.error === undefined) && t.answer?.unparseable === true),
    fabricatedReasonTrials: count((t) => (t.grade.fabricatedReasonCodes ?? []).length > 0),
    // 非採点の可視化（§16 は空集合を除外していない。grade.js の注記を参照）。
    successWithEmptyReasonCodes: count((t) => t.grade.success === true && t.grade.reasonCodesEmpty === true),
    medianDurationMs: median(trials.map((t) => t.durationMs ?? 0)),
    totalDurationMs: trials.reduce((a, t) => a + (t.durationMs ?? 0), 0),
  };
}

/**
 * @param {{meta: object, trials: object[]}} run 生ログそのもの
 */
export function aggregate(run) {
  const trials = run?.trials;
  if (!Array.isArray(trials)) throw new Error("aggregate: run.trials is not an array");
  if (trials.length !== EXPECTED_TOTAL) {
    throw new Error(
      `aggregate: expected ${EXPECTED_TOTAL} trials (pre-registered), got ${trials.length}. ` +
        "A run with fewer trials is not the pre-registered experiment.",
    );
  }
  if (run?.meta?.totalTrials !== undefined && run.meta.totalTrials !== trials.length) {
    throw new Error(`aggregate: meta.totalTrials (${run.meta.totalTrials}) disagrees with the raw log (${trials.length})`);
  }
  for (const t of trials) {
    if (!t || typeof t.grade !== "object" || t.grade === null) {
      throw new Error(`aggregate: trial ${t?.trialIndex} has no grade — every trial must be graded, including errors`);
    }
  }

  const perCondition = {};
  const perConditionFixture = {};
  for (const c of CONDITIONS) {
    const ofC = trials.filter((t) => t.condition === c);
    perCondition[c] = tally(ofC);
    perConditionFixture[c] = {};
    for (const id of [...new Set(ofC.map((t) => t.fixtureId))]) {
      perConditionFixture[c][id] = tally(ofC.filter((t) => t.fixtureId === id));
    }
  }

  const [a, b] = CONDITIONS;
  return {
    computedAt: new Date().toISOString(),
    // 集計は**この関数がそのつど生ログから**出す。保存済みの値は読まない。
    derivedFrom: "trials[] only",
    overall: tally(trials),
    perCondition,
    perConditionFixture,
    delta: {
      of: `${b} − ${a}`,
      success: perCondition[b].success - perCondition[a].success,
      successRate: perCondition[b].successRate - perCondition[a].successRate,
      verdictMatch: perCondition[b].verdictMatch - perCondition[a].verdictMatch,
      reasonSubset: perCondition[b].reasonSubset - perCondition[a].reasonSubset,
    },
  };
}
