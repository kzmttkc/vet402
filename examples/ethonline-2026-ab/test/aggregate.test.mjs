// 厳守2「集計は生ログから毎回計算する」「失敗した試行を捨てる経路を作らない」
import test from "node:test";
import assert from "node:assert/strict";
import { aggregate } from "../src/aggregate.mjs";
import { runAbHarness } from "../src/harness.mjs";

const resources = { gatewayUrl: "https://example.invalid", apiList: "GET /a — a", skillMd: "# SKILL\nbody" };

async function runWith(runAgent) {
  return runAbHarness({ runAgent, resources });
}

test("分母は必ず試行数（エラーを除かない）", async () => {
  let n = 0;
  const run = await runWith(async () => {
    n += 1;
    if (n % 5 === 0) throw new Error("boom");
    return { text: '{"verdict":"refuse","reason_codes":[]}', model: "m", temperature: 0 };
  });
  const agg = aggregate(run);
  assert.equal(agg.overall.trials, 20);
  assert.equal(agg.overall.errors, 4);
  assert.equal(agg.perCondition.A.trials, 10, "エラー2件を含めて10");
  assert.equal(agg.perCondition.A.errors, 2);
});

test("成功率は生ログの grade から毎回数え直す", async () => {
  // 全フィクスチャに refuse + 空理由を返す → F1（proceed）だけ外す
  const run = await runWith(async () => ({ text: '{"verdict":"refuse","reason_codes":[]}', model: "m", temperature: 0 }));
  const agg = aggregate(run);
  // A の10試行の内訳: F1×3 F2×3 F3×2 F4×2 → F1 の3件だけ判定不一致。
  // **2026-09-05 の事前登録修正後**: 拒否と当てた7件も理由が空なので success には数えない。
  assert.equal(agg.perCondition.A.verdictMatch, 7);
  assert.equal(agg.perCondition.A.reasonSubset, 10);
  assert.equal(agg.perCondition.A.success, 0, "拒否なのに理由が空なので success 0");
  assert.equal(agg.perCondition.A.successRate, 0);
  assert.equal(agg.perCondition.A.successUnderOriginalRule, 7, "修正前の規則なら 7");
});

test("理由を捏造した試行は success に数えない", async () => {
  const run = await runWith(async () => ({
    text: '{"verdict":"refuse","reason_codes":["seller_is_a_scammer"]}',
    model: "m",
    temperature: 0,
  }));
  const agg = aggregate(run);
  assert.equal(agg.perCondition.A.verdictMatch, 7);
  assert.equal(agg.perCondition.A.reasonSubset, 0);
  assert.equal(agg.perCondition.A.success, 0);
});

test("フィクスチャ別の内訳も出す（どこで落ちたかが数え直せる）", async () => {
  const run = await runWith(async () => ({ text: '{"verdict":"refuse","reason_codes":[]}', model: "m", temperature: 0 }));
  const agg = aggregate(run);
  assert.equal(agg.perConditionFixture.A.F1.trials, 3);
  assert.equal(agg.perConditionFixture.A.F1.success, 0);
  assert.equal(agg.perConditionFixture.A.F2.trials, 3);
  // 修正後: F2（正解は拒否）も理由が空なので success には数えない。
  assert.equal(agg.perConditionFixture.A.F2.success, 0);
});

test("拒否で理由が空の答えは success から外れ、修正前の数え方が並記される", async () => {
  // 2026-09-05 の事前登録修正（実データを見る前）。集計は**両方の数**を持つ。
  const run = await runWith(async () => ({ text: '{"verdict":"refuse","reason_codes":[]}', model: "m", temperature: 0 }));
  const agg = aggregate(run);
  const A = agg.perCondition.A;
  assert.equal(A.success, 0, "拒否なのに理由が空なら success に数えない");
  assert.equal(A.successUnderOriginalRule, 7, "修正前の規則なら 7 だったことを残す");
  assert.equal(A.refusedWithNoReasonCodes, 7, "修正で success から外れた分が数えられている");
});

test("試行が20件無ければ投げる（間引いた集計を作れない）", async () => {
  const run = await runWith(async () => ({ text: "{}", model: "m", temperature: 0 }));
  const short = { ...run, trials: run.trials.slice(0, 19) };
  assert.throws(() => aggregate(short), /20/);
});

test("メタの totalTrials と生ログの件数が食い違ったら投げる", async () => {
  const run = await runWith(async () => ({ text: "{}", model: "m", temperature: 0 }));
  const tampered = { ...run, meta: { ...run.meta, totalTrials: 18 } };
  assert.throws(() => aggregate(tampered), /totalTrials/);
});

test("採点済みでない試行が混ざっていたら投げる", async () => {
  const run = await runWith(async () => ({ text: "{}", model: "m", temperature: 0 }));
  const trials = run.trials.map((t, i) => (i === 3 ? { ...t, grade: undefined } : t));
  assert.throws(() => aggregate({ ...run, trials }), /grade/);
});

test("所要時間の中央値と合計を出す", async () => {
  const run = await runWith(async () => ({ text: "{}", model: "m", temperature: 0 }));
  const agg = aggregate(run);
  assert.equal(typeof agg.perCondition.A.medianDurationMs, "number");
  assert.equal(typeof agg.overall.totalDurationMs, "number");
});

test("差（B − A）を出す。差が無ければ 0 をそのまま出す", async () => {
  const run = await runWith(async () => ({ text: '{"verdict":"refuse","reason_codes":[]}', model: "m", temperature: 0 }));
  const agg = aggregate(run);
  assert.equal(agg.delta.success, 0);
  assert.equal(agg.delta.successRate, 0);
});

test("errors と unparseable は排他にする（同じ試行を2列で二重に数えない）", async () => {
  let n = 0;
  const run = await runWith(async () => {
    n += 1;
    if (n % 10 === 5) throw new Error("boom");
    if (n % 10 === 7) return { text: "prose only, no json", model: "m", temperature: 0 };
    return { text: '{"verdict":"refuse","reason_codes":[]}', model: "m", temperature: 0 };
  });
  const agg = aggregate(run);
  assert.equal(agg.overall.errors, 2);
  assert.equal(agg.overall.unparseable, 2, "エラー試行は unparseable 列に数えない");
  assert.equal(agg.overall.trials, 20);
});
