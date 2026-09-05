import test from "node:test";
import assert from "node:assert/strict";
import { createMockAgent, MOCK_MODEL } from "../src/agents/mock.mjs";
import { buildRequestParams, extractText, DEFAULT_MODEL } from "../src/agents/anthropic.mjs";
import { buildPrompt } from "../src/prompt.mjs";
import { FIXTURES } from "../src/fixtures.mjs";

const resources = { gatewayUrl: "https://example.invalid", apiList: "GET /a — a", skillMd: "# SKILL\nl1_not_attempted" };

test("モックはプロンプトだけを見る（正解表もフィクスチャも覗かない）", async () => {
  const agent = createMockAgent();
  const p = buildPrompt({ condition: "B", fixture: FIXTURES[2], resources });
  const withCtx = await agent(p, { condition: "B", fixture: FIXTURES[2], trialIndex: 0 });
  const withoutCtx = await agent(p);
  assert.deepEqual(withCtx, withoutCtx, "ctx を渡しても渡さなくても同じ答え＝ctx を見ていない");
});

test("モックはモックだと名乗る", async () => {
  const out = await createMockAgent()(buildPrompt({ condition: "A", fixture: FIXTURES[0], resources }));
  assert.equal(out.model, MOCK_MODEL);
  assert.match(MOCK_MODEL, /mock/);
});

test("モックは Recipe の有無で答えを変える（それがこのハーネスが測る当のもの）", async () => {
  const agent = createMockAgent();
  const f = FIXTURES[2];
  const a = await agent(buildPrompt({ condition: "A", fixture: f, resources }));
  const b = await agent(buildPrompt({ condition: "B", fixture: f, resources }));
  assert.notEqual(a.text, b.text);
});

test("flaky モックは決まった回数で投げ、決まった回数で JSON を返さない", async () => {
  const agent = createMockAgent({ flaky: true });
  const p = buildPrompt({ condition: "A", fixture: FIXTURES[0], resources });
  const outcomes = [];
  for (let i = 0; i < 10; i += 1) {
    try {
      outcomes.push((await agent(p)).text.startsWith("{") ? "json" : "prose");
    } catch {
      outcomes.push("throw");
    }
  }
  assert.equal(outcomes.filter((o) => o === "throw").length, 1);
  assert.equal(outcomes.filter((o) => o === "prose").length, 1);
});

test("Anthropic アダプタの既定モデルは claude-opus-5", () => {
  assert.equal(DEFAULT_MODEL, "claude-opus-5");
});

test("temperature を送らない（現行モデルは 400 を返す）", () => {
  const params = buildRequestParams({ prompt: "hello" });
  assert.equal("temperature" in params, false);
  assert.equal("top_p" in params, false);
  assert.equal(params.model, "claude-opus-5");
  assert.deepEqual(params.messages, [{ role: "user", content: "hello" }]);
  assert.equal(params.output_config.effort, "high");
  assert.ok(params.max_tokens >= 4096);
});

test("effort は指定できる（同一設定を全試行で使うため引数に出す）", () => {
  assert.equal(buildRequestParams({ prompt: "x", effort: "max" }).output_config.effort, "max");
});

test("extractText は text ブロックだけを連結する（thinking を混ぜない）", () => {
  const msg = {
    content: [
      { type: "thinking", thinking: "secret reasoning" },
      { type: "text", text: '{"verdict":"refuse"' },
      { type: "text", text: ',"reason_codes":[]}' },
    ],
  };
  assert.equal(extractText(msg), '{"verdict":"refuse","reason_codes":[]}');
});

test("refusal で止まったら空文字ではなく分かる形で返す", () => {
  assert.equal(extractText({ stop_reason: "refusal", content: [] }), "");
});

test("モックは Target ブロックだけを見て相手を見分ける（Recipe 本文の URL に釣られない）", async () => {
  // SKILL.md は本文中に gateway.thegraph.com と kronossignals を書いている。
  // プロンプト全体を検索すると、条件 B のときだけ相手を取り違える。
  const agent = createMockAgent();
  const skillMd = "# SKILL\nsee https://gateway.thegraph.com/api/x402/... and agent.api.0x.org\namount: $99";
  const res = { ...resources, skillMd };
  for (const f of FIXTURES) {
    const a = JSON.parse((await agent(buildPrompt({ condition: "A", fixture: f, resources: res }))).text);
    const b = JSON.parse((await agent(buildPrompt({ condition: "B", fixture: f, resources: res }))).text);
    assert.equal(a.verdict !== undefined, true);
    assert.equal(
      b.explanation.split(" for ")[1].split(" ")[0],
      a.explanation.split(" for ")[1].split(" ")[0],
      `${f.id}: A と B で見分けた相手が違う`,
    );
  }
});
