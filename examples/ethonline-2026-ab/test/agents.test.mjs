import test from "node:test";
import assert from "node:assert/strict";
import { createMockAgent, MOCK_MODEL } from "../src/agents/mock.mjs";
import { buildRequestParams, extractText, DEFAULT_MODEL, createAnthropicAgent } from "../src/agents/anthropic.mjs";
import { buildPrompt } from "../src/prompt.mjs";
import { FIXTURES } from "../src/fixtures.mjs";

const resources = { gatewayUrl: "https://example.invalid", apiList: "GET /a — a", recipe: "Recipe: x402-payee-verification\nl1_not_attempted" };

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
  // Recipe 本文は gateway.thegraph.com や 0x のホスト名を書きうる。
  // プロンプト全体を検索すると、条件 B のときだけ相手を取り違える。
  const agent = createMockAgent();
  const recipe = "Recipe: x402-payee-verification\nsee https://gateway.thegraph.com/api/x402/... and agent.api.0x.org\namount: $99";
  const res = { ...resources, recipe };
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

// ---- 2026-09-06: エージェントに Bazantic Gateway の MCP を**道具として**渡す ----
// それまでは `messages.create` を1発叩くだけで、Gateway も MCP も経路に入っていなかった。
// **実 LLM も実 MCP も呼ばない。** client と toolProvider を差し替えて、経路そのものを固定する。

/** 台本どおりに応答を返す偽 client。**受け取った params を全部貯める。** */
function fakeClient(script) {
  const calls = [];
  let i = 0;
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
        return script[Math.min(i++, script.length - 1)];
      },
    },
  };
}

const TEXT_TURN = { id: "msg_end", model: "claude-opus-5", stop_reason: "end_turn", content: [{ type: "text", text: '{"verdict":"refuse","reason_codes":["l1_not_attempted"]}' }] };
const TOOL_TURN = {
  id: "msg_tool",
  model: "claude-opus-5",
  stop_reason: "tool_use",
  content: [
    { type: "text", text: "let me check" },
    { type: "tool_use", id: "tu_1", name: "getResourceDecision", input: { resourceId: "abc" } },
  ],
};

function fakeToolProvider({ tools = [{ name: "getResourceDecision", description: "d", inputSchema: { type: "object", properties: {} } }], result = { content: [{ type: "text", text: "WARN" }] }, fail = false } = {}) {
  const called = [];
  let listed = 0;
  return {
    called,
    listedCount: () => listed,
    url: "https://2vjhqfgvw5dt5lja2zpjsjwrem.bazgateway.com/mcp",
    async listTools() { listed += 1; return tools; },
    async callTool(name, input) {
      called.push({ name, input });
      if (fail) throw new Error("upstream 500");
      return result;
    },
  };
}

test("buildRequestParams は渡されたツールをそのまま載せる（無ければ載せない）", () => {
  assert.equal("tools" in buildRequestParams({ prompt: "x" }), false);
  const tools = [{ name: "getPayeeScore", description: "d", input_schema: { type: "object", properties: {} } }];
  assert.deepEqual(buildRequestParams({ prompt: "x", tools }).tools, tools);
});

test("エージェントは MCP のツールを呼び、結果を会話へ戻して答えを出す", async () => {
  const client = fakeClient([TOOL_TURN, TEXT_TURN]);
  const provider = fakeToolProvider();
  const agent = await createAnthropicAgent({ client, toolProvider: provider });
  const out = await agent(buildPrompt({ condition: "B", fixture: FIXTURES[2], resources }));

  assert.deepEqual(provider.called, [{ name: "getResourceDecision", input: { resourceId: "abc" } }]);
  assert.match(out.text, /"verdict":"refuse"/);
  // 2手目は tool_result を積んだ会話になっている（MCP の出力がモデルへ戻っている）。
  const second = client.calls[1].messages;
  assert.equal(second.length, 3);
  assert.equal(second[2].role, "user");
  assert.equal(second[2].content[0].type, "tool_result");
  assert.equal(second[2].content[0].tool_use_id, "tu_1");
});

test("どのツールを何回呼んだかが生ログに残る（MCP が経路に入っていた証拠）", async () => {
  const client = fakeClient([TOOL_TURN, TEXT_TURN]);
  const agent = await createAnthropicAgent({ client, toolProvider: fakeToolProvider() });
  const out = await agent(buildPrompt({ condition: "B", fixture: FIXTURES[0], resources }));
  assert.deepEqual(out.raw.toolCalls.map((c) => c.name), ["getResourceDecision"]);
  assert.deepEqual(out.raw.toolNames, ["getResourceDecision"]);
  assert.match(out.raw.mcpUrl, /bazgateway\.com\/mcp$/);
});

test("A と B に渡すツールは同一（違いは Recipe だけ・賞の要件 #5）", async () => {
  const client = fakeClient([TEXT_TURN]);
  const provider = fakeToolProvider();
  const agent = await createAnthropicAgent({ client, toolProvider: provider });
  await agent(buildPrompt({ condition: "A", fixture: FIXTURES[0], resources }), { condition: "A" });
  await agent(buildPrompt({ condition: "B", fixture: FIXTURES[0], resources }), { condition: "B" });
  assert.deepEqual(client.calls[0].tools, client.calls[1].tools);
  assert.ok(client.calls[0].tools.length > 0, "ツールが1本も渡っていない");
  assert.equal(provider.listedCount(), 1, "条件ごとに一覧を引き直している");
});

test("ツールが落ちても会話を止めず、失敗をモデルへ返す（握り潰さない）", async () => {
  const client = fakeClient([TOOL_TURN, TEXT_TURN]);
  const agent = await createAnthropicAgent({ client, toolProvider: fakeToolProvider({ fail: true }) });
  const out = await agent(buildPrompt({ condition: "B", fixture: FIXTURES[0], resources }));
  const result = client.calls[1].messages[2].content[0];
  assert.equal(result.is_error, true);
  assert.match(JSON.stringify(result.content), /upstream 500/);
  assert.equal(out.raw.toolCalls[0].ok, false);
});

test("ツール呼び出しが終わらないときは打ち切る（無限ループにしない）", async () => {
  const client = fakeClient([TOOL_TURN]); // 常に tool_use を返し続ける
  const agent = await createAnthropicAgent({ client, toolProvider: fakeToolProvider(), maxToolRounds: 3 });
  await assert.rejects(
    () => agent(buildPrompt({ condition: "B", fixture: FIXTURES[0], resources })),
    /tool rounds/,
  );
  assert.equal(client.calls.length, 4);
});
