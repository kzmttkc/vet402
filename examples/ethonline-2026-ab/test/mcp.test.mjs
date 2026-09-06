// Bazantic Gateway の MCP を、**エージェントが実際に呼べる道具**にする。
//
// 賞の問いは「Bazantic built MCP server **and** recipe を使って実演せよ」。
// 2026-09-06 まで、この実装はプロンプトに Gateway の URL を書いていただけで、
// **MCP は経路に入っていなかった**（`messages.create` を1発叩くだけ・ツールもネットワークも無し）。
//
// ここでは **実 MCP を呼ばない**。fetch を差し替えて、送っている JSON-RPC そのものを固定する。
import test from "node:test";
import assert from "node:assert/strict";
import { createMcpToolProvider, toAnthropicTools, MCP_PROTOCOL_VERSION } from "../src/mcp.mjs";

const TOOLS = [
  { name: "getResourceDecision", description: "decision for a resource", inputSchema: { type: "object", properties: { resourceId: { type: "string" } } } },
  { name: "getPayeeScore", description: "score for a payee" },
];

/** 実 MCP の代わり。**送られてきた要求をそのまま貯める。** */
function fakeMcp({ toolsResult = { tools: TOOLS }, callResult = { content: [{ type: "text", text: "ok" }] }, error = null, sse = false } = {}) {
  const sent = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url, headers: init.headers, body });
    if (body.method === "notifications/initialized" || body.id === undefined) {
      return new Response(null, { status: 202 });
    }
    const result =
      body.method === "initialize"
        ? { protocolVersion: MCP_PROTOCOL_VERSION, serverInfo: { name: "vet402", version: "v0.16.0" }, capabilities: { tools: {} } }
        : body.method === "tools/list"
          ? toolsResult
          : callResult;
    const payload = error === null ? { jsonrpc: "2.0", id: body.id, result } : { jsonrpc: "2.0", id: body.id, error };
    const text = JSON.stringify(payload);
    if (sse) {
      return new Response(`event: message\ndata: ${text}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream", "mcp-session-id": "sess-1" },
      });
    }
    return new Response(text, { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "sess-1" } });
  };
  return { fetchImpl, sent };
}

const URL_ = "https://2vjhqfgvw5dt5lja2zpjsjwrem.bazgateway.com/mcp";

test("listTools は initialize → initialized → tools/list の順に MCP を叩く", async () => {
  const { fetchImpl, sent } = fakeMcp();
  const p = createMcpToolProvider({ url: URL_, fetchImpl });
  const tools = await p.listTools();
  assert.deepEqual(sent.map((s) => s.body.method), ["initialize", "notifications/initialized", "tools/list"]);
  assert.equal(sent[0].url, URL_);
  assert.equal(sent[0].body.params.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.deepEqual(tools.map((t) => t.name), ["getResourceDecision", "getPayeeScore"]);
});

test("Streamable HTTP の作法を守る（Accept 2種・JSON-RPC 2.0・セッションIDの引き継ぎ）", async () => {
  const { fetchImpl, sent } = fakeMcp();
  const p = createMcpToolProvider({ url: URL_, fetchImpl });
  await p.listTools();
  assert.match(sent[0].headers.Accept, /application\/json/);
  assert.match(sent[0].headers.Accept, /text\/event-stream/);
  assert.equal(sent[0].headers["Content-Type"], "application/json");
  assert.equal(sent[0].body.jsonrpc, "2.0");
  // initialize の応答で来たセッションIDを、以後の要求に付ける。
  assert.equal(sent[0].headers["Mcp-Session-Id"], undefined);
  assert.equal(sent[2].headers["Mcp-Session-Id"], "sess-1");
});

test("SSE で返ってきても読める（text/event-stream）", async () => {
  const { fetchImpl } = fakeMcp({ sse: true });
  const p = createMcpToolProvider({ url: URL_, fetchImpl });
  assert.deepEqual((await p.listTools()).map((t) => t.name), ["getResourceDecision", "getPayeeScore"]);
});

test("callTool は tools/call を送り、結果をそのまま返す", async () => {
  const { fetchImpl, sent } = fakeMcp({ callResult: { content: [{ type: "text", text: '{"verdict":"ALLOW"}' }] } });
  const p = createMcpToolProvider({ url: URL_, fetchImpl });
  const out = await p.callTool("getResourceDecision", { resourceId: "abc" });
  const call = sent.find((s) => s.body.method === "tools/call");
  assert.deepEqual(call.body.params, { name: "getResourceDecision", arguments: { resourceId: "abc" } });
  assert.deepEqual(out.content, [{ type: "text", text: '{"verdict":"ALLOW"}' }]);
});

test("JSON-RPC のエラーは握り潰さず投げる", async () => {
  const { fetchImpl } = fakeMcp({ error: { code: -32601, message: "method not found" } });
  const p = createMcpToolProvider({ url: URL_, fetchImpl });
  await assert.rejects(() => p.listTools(), /method not found/);
});

test("HTTP エラーも投げる（本文を黙って空ツール一覧にしない）", async () => {
  const p = createMcpToolProvider({ url: URL_, fetchImpl: async () => new Response("nope", { status: 502 }) });
  await assert.rejects(() => p.listTools(), /502/);
});

test("ツール一覧は1回だけ引く（A と B に同じ一覧が渡ることを構造で保証する）", async () => {
  const { fetchImpl, sent } = fakeMcp();
  const p = createMcpToolProvider({ url: URL_, fetchImpl });
  const a = await p.listTools();
  const b = await p.listTools();
  assert.equal(sent.filter((s) => s.body.method === "tools/list").length, 1);
  assert.equal(a, b);
});

test("toAnthropicTools は MCP の定義を Anthropic の tools 形式にする", () => {
  const tools = toAnthropicTools(TOOLS);
  assert.deepEqual(tools[0], {
    name: "getResourceDecision",
    description: "decision for a resource",
    input_schema: { type: "object", properties: { resourceId: { type: "string" } } },
  });
  // スキーマの無いツールでも壊れない（空のオブジェクト型にする）。
  assert.deepEqual(tools[1].input_schema, { type: "object", properties: {} });
});

test("toAnthropicTools は名前を書き換えない（Recipe が名指ししている3本と突き合わせられる）", () => {
  assert.deepEqual(toAnthropicTools(TOOLS).map((t) => t.name), TOOLS.map((t) => t.name));
});
