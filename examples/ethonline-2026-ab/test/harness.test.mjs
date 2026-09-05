// §16「試行と停止規則」: 1条件あたり10試行・合計20試行。
// 厳守2「失敗した試行を捨てる経路を作らない」「良い結果が出るまで回し直せない形にする」
import test from "node:test";
import assert from "node:assert/strict";
import { runAbHarness } from "../src/harness.mjs";
import { FIXTURES } from "../src/fixtures.mjs";

const resources = { gatewayUrl: "https://example.invalid", apiList: "GET /a — a", skillMd: "# SKILL\nbody" };

function agentThatAlwaysSays(text, { model = "test-model", temperature = 0 } = {}) {
  return async () => ({ text, model, temperature });
}

test("合計20試行・1条件あたり10試行", async () => {
  const run = await runAbHarness({ runAgent: agentThatAlwaysSays('{"verdict":"refuse","reason_codes":[]}'), resources });
  assert.equal(run.trials.length, 20);
  assert.equal(run.trials.filter((t) => t.condition === "A").length, 10);
  assert.equal(run.trials.filter((t) => t.condition === "B").length, 10);
});

test("試行数の指定は §16 の値から動かせない（設定で薄められない）", async () => {
  await assert.rejects(
    () => runAbHarness({ runAgent: agentThatAlwaysSays("{}"), resources, trialsPerCondition: 3 }),
    /pre-registered/i,
  );
});

test("4フィクスチャを決まった順で回す（2〜3周）", async () => {
  const run = await runAbHarness({ runAgent: agentThatAlwaysSays("{}"), resources });
  const a = run.trials.filter((t) => t.condition === "A").map((t) => t.fixtureId);
  assert.deepEqual(a, ["F1", "F2", "F3", "F4", "F1", "F2", "F3", "F4", "F1", "F2"]);
  const b = run.trials.filter((t) => t.condition === "B").map((t) => t.fixtureId);
  assert.deepEqual(b, a, "A と B は同じ順序で同じフィクスチャを見る");
});

test("各試行に プロンプト全文・生応答・判定・理由コード・所要時間 が残る（§16 の記録項目）", async () => {
  const run = await runAbHarness({
    runAgent: agentThatAlwaysSays('{"verdict":"refuse","reason_codes":["l1_not_attempted"]}'),
    resources,
  });
  for (const t of run.trials) {
    assert.equal(typeof t.prompt, "string");
    assert.ok(t.prompt.length > 100);
    assert.equal(typeof t.rawResponse, "string");
    assert.ok(["proceed", "refuse", null].includes(t.answer.verdict));
    assert.ok(Array.isArray(t.answer.reasonCodes));
    assert.equal(typeof t.durationMs, "number");
    assert.ok(t.durationMs >= 0);
    assert.equal(typeof t.grade.success, "boolean");
    assert.ok(t.oracle.reasonCodes);
  }
});

test("メタにモデル名・temperature・事前登録の参照が残る", async () => {
  const run = await runAbHarness({ runAgent: agentThatAlwaysSays("{}", { model: "m1", temperature: 0.3 }), resources });
  assert.equal(run.meta.model, "m1");
  assert.equal(run.meta.temperature, 0.3);
  assert.match(run.meta.preRegistration, /WINDOW_PLAN.*§16/);
  assert.equal(run.meta.trialsPerCondition, 10);
});

test("エージェントが投げても1試行として記録し、失敗として数える（捨てない）", async () => {
  let n = 0;
  const runAgent = async () => {
    n += 1;
    if (n % 5 === 0) throw new Error("upstream 500");
    return { text: '{"verdict":"refuse","reason_codes":[]}', model: "m1", temperature: 0 };
  };
  const run = await runAbHarness({ runAgent, resources });
  assert.equal(run.trials.length, 20, "エラーでも20試行");
  const errored = run.trials.filter((t) => t.error !== null);
  assert.equal(errored.length, 4);
  for (const t of errored) {
    assert.equal(t.grade.success, false);
    assert.equal(t.error.message, "upstream 500");
    assert.equal(t.answer.unparseable, true);
  }
});

test("モデルや temperature が試行ごとに変わったら、メタに残して黙らない", async () => {
  let n = 0;
  const runAgent = async () => {
    n += 1;
    return { text: "{}", model: n > 10 ? "m2" : "m1", temperature: 0 };
  };
  const run = await runAbHarness({ runAgent, resources });
  assert.equal(run.meta.singleModel, false);
  assert.deepEqual(run.meta.modelsSeen.sort(), ["m1", "m2"]);
});

test("フィクスチャの未確定（liveReady false）がメタに載る", async () => {
  const run = await runAbHarness({ runAgent: agentThatAlwaysSays("{}"), resources });
  assert.equal(run.meta.fixtureReadiness.liveReady, false);
  assert.ok(run.meta.fixtureReadiness.blockers.length > 0);
});

test("A と B のプロンプトは Recipe 以外が同一（同じフィクスチャの試行で照合）", async () => {
  const { stripRecipe } = await import("../src/prompt.mjs");
  const run = await runAbHarness({ runAgent: agentThatAlwaysSays("{}"), resources });
  const a = run.trials.find((t) => t.condition === "A" && t.fixtureId === "F1");
  const b = run.trials.find((t) => t.condition === "B" && t.fixtureId === "F1");
  assert.equal(stripRecipe(b.prompt), a.prompt);
});

test("oracle は fixtures.mjs の値をそのまま持ち込む（試行中に書き換えない）", async () => {
  const run = await runAbHarness({ runAgent: agentThatAlwaysSays("{}"), resources });
  for (const t of run.trials) {
    const f = FIXTURES.find((x) => x.id === t.fixtureId);
    assert.deepEqual(t.oracle.reasonCodes, [...f.oracle.reasonCodes]);
    assert.equal(t.oracle.verdict, f.oracle.verdict);
  }
});

test("temperature を指定できないモデル（null）でも『揃っている』と読む", async () => {
  // 現行モデル（Claude Opus 5 等）は temperature を受け付けない（400）。
  // アダプタは null を返す。全試行 null なら「同一 temperature」は満たされている。
  const run = await runAbHarness({
    runAgent: async () => ({ text: "{}", model: "claude-opus-5", temperature: null }),
    resources,
  });
  assert.equal(run.meta.singleTemperature, true);
  assert.equal(run.meta.temperature, null);
  assert.deepEqual(run.meta.temperaturesSeen, [null]);
});

test("エラーになった試行のモデル未報告を『モデルが変わった』と読まない", async () => {
  let n = 0;
  const run = await runAbHarness({
    runAgent: async () => {
      n += 1;
      if (n % 5 === 0) throw new Error("boom");
      return { text: "{}", model: "m1", temperature: 0 };
    },
    resources,
  });
  assert.equal(run.meta.singleModel, true);
  assert.deepEqual(run.meta.modelsSeen, ["m1"]);
});
