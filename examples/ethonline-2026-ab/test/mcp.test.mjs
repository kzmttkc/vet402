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

// ---- 2026-09-06: $0 の x402 402 を、MCP の外（REST）で払って本物の応答に置き換える橋 ----
//
// 実測（同日）: Bazantic Gateway は全ルート 0 mcents でも、REST も MCP も未払いなら 402 を返す。
// MCP の POST に PAYMENT-SIGNATURE を載せても無視されるが、REST `GET {origin}{resource.url}` へ
// 同じヘッダで送ると 200 + `payment-response`（settled, tx）が返る。だから橋は REST に回す。
//
// ここでも**実ネットワークは呼ばない**。fetch を差し替え、MCP と REST の両方を偽物で受ける。
// 署名は偽 payer が数える（`signTypedData` が**何回**・**何に**呼ばれたかを検算する）。

const GW_ORIGIN = "https://2vjhqfgvw5dt5lja2zpjsjwrem.bazgateway.com";
const RESOURCE = "/api/v1/census/summary?window=30d";
const PAY_TO = "0x6eB43A9dbDEB6d9A4D9E9B774c8E42De6C19F138";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAYER = "0x1111111111111111111111111111111111111111";
/** 実測の決済 tx（Base の公開台帳）。秘密ではない。 */
const TX = "0x061702d45ec18884be7ada292852679861307d01c2621a504ad392328dafa932";

function baseAccept(over = {}) {
  return { scheme: "exact", network: "eip155:8453", asset: USDC, amount: "0", payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" }, ...over };
}
function challengeB64(over = {}) {
  return btoa(JSON.stringify({ x402Version: 2, resource: { url: RESOURCE }, accepts: [baseAccept()], ...over }));
}
/** 実測した `tools/call` の 402 の形（content[1] の [SERVER] 行つき）。 */
function paymentRequired({ method = "GET", x402 = challengeB64() } = {}) {
  const text = [
    `HTTP ${method} /2vjhqfgvw5dt5lja2zpjsjwrem${RESOURCE}`,
    "Error: Payment Required (HTTP 402)",
    `Details: ${JSON.stringify({ mpp: "Payment id=abc", payment_required: true, x402 })}`,
    "Suggestion: Sign the x402 challenge and retry.",
    "Operation: getCensusSummary (GET /api/v1/census/summary)",
  ].join("\n");
  return { isError: true, content: [{ type: "text", text }, { type: "text", text: "[SERVER]: Reuse conversation_id=conv-1" }] };
}

/** MCP と REST の両方を受ける偽 Gateway。REST への要求を全部貯める。 */
function fakeGateway({ callResult, restStatus = 200, restBody = '{"total_routes":57}', settle = { success: true, transaction: TX, network: "eip155:8453", payer: PAYER } } = {}) {
  const mcp = fakeMcp({ callResult });
  const rest = [];
  const fetchImpl = async (url, init) => {
    if (url === URL_) return mcp.fetchImpl(url, init);
    rest.push({ url, init });
    const headers = { "content-type": "application/json" };
    if (restStatus === 200 && settle) headers["payment-response"] = btoa(JSON.stringify(settle));
    return new Response(restBody, { status: restStatus, headers });
  };
  return { fetchImpl, sent: mcp.sent, rest };
}

function fakePayer() {
  const signed = [];
  return { address: PAYER, signed, signTypedData: async (td) => { signed.push(td); return "0x" + "ab".repeat(65); } };
}

function decodeHeader(b64) {
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

test("橋: payer が無ければ 402 のテキストがそのまま返り、fetch は MCP にしか飛ばない", async () => {
  const { fetchImpl, rest } = fakeGateway({ callResult: paymentRequired() });
  const p = createMcpToolProvider({ url: URL_, fetchImpl });
  const out = await p.callTool("getCensusSummary", {});
  assert.deepEqual(out, paymentRequired());
  assert.equal("x402Bridge" in out, false);
  assert.equal(rest.length, 0);
});

test("橋: payer 有り・amount \"0\"・GET → REST に PAYMENT-SIGNATURE 付きで1回飛び、200 本文が返る。署名はちょうど1回", async () => {
  const { fetchImpl, rest } = fakeGateway({ callResult: paymentRequired() });
  const payer = fakePayer();
  const p = createMcpToolProvider({ url: URL_, fetchImpl, payer });
  const out = await p.callTool("getCensusSummary", {});

  assert.equal(rest.length, 1);
  assert.equal(rest[0].url, GW_ORIGIN + RESOURCE);
  assert.equal(rest[0].init.method ?? "GET", "GET");
  const sig = rest[0].init.headers["PAYMENT-SIGNATURE"];
  assert.equal(typeof sig, "string");
  const body = decodeHeader(sig);
  assert.equal(body.x402Version, 2);
  assert.equal(body.resource.url, RESOURCE);
  assert.equal(body.accepted.payTo, PAY_TO);
  assert.equal(body.accepted.amount, "0");
  assert.equal(body.payload.authorization.to, PAY_TO);
  assert.equal(body.payload.authorization.value, "0");
  assert.equal(body.payload.authorization.from, PAYER);

  assert.equal(payer.signed.length, 1);
  assert.equal(payer.signed[0].message.to, PAY_TO);
  assert.equal(payer.signed[0].message.value, "0");
  assert.equal(payer.signed[0].domain.chainId, 8453);

  assert.equal(out.isError, false);
  assert.equal(out.content[0].type, "text");
  assert.equal(out.content[0].text, '{"total_routes":57}');
  assert.deepEqual(out.x402Bridge, { settled: true, txHash: TX, payTo: PAY_TO, amount: "0", resource: RESOURCE, responseStatus: 200 });

  // 呼び手が検算できるログ: 署名した nonce・宛先・額がヘッダの中身と一致する。
  const log = p.bridgeLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].nonce, body.payload.authorization.nonce);
  assert.equal(log[0].to, PAY_TO);
  assert.equal(log[0].value, "0");
  assert.equal(log[0].resource, RESOURCE);
});

test("橋: amount が \"0\" 以外なら払わない（例外・署名 0 回・REST に飛ばない・額と宛先をメッセージに含む）", async () => {
  const x402 = challengeB64({ accepts: [baseAccept({ amount: "1000" })] });
  const { fetchImpl, rest } = fakeGateway({ callResult: paymentRequired({ x402 }) });
  const payer = fakePayer();
  const p = createMcpToolProvider({ url: URL_, fetchImpl, payer });
  await assert.rejects(() => p.callTool("getCensusSummary", {}), (e) => {
    assert.match(e.message, /1000/);
    assert.match(e.message, new RegExp(PAY_TO));
    return true;
  });
  assert.equal(payer.signed.length, 0);
  assert.equal(rest.length, 0);
  assert.equal(p.bridgeLog().length, 0);
});

test("橋: METHOD が POST なら払わず元の結果を返す（本文を持たない）", async () => {
  const { fetchImpl, rest } = fakeGateway({ callResult: paymentRequired({ method: "POST" }) });
  const payer = fakePayer();
  const p = createMcpToolProvider({ url: URL_, fetchImpl, payer });
  const out = await p.callTool("getCensusSummary", {});
  assert.deepEqual(out, paymentRequired({ method: "POST" }));
  assert.equal(payer.signed.length, 0);
  assert.equal(rest.length, 0);
});

test("橋: accepts に Base/exact が無ければ払わず元の結果を返す", async () => {
  const x402 = challengeB64({ accepts: [baseAccept({ network: "eip155:1" }), baseAccept({ scheme: "upto" })] });
  const { fetchImpl, rest } = fakeGateway({ callResult: paymentRequired({ x402 }) });
  const payer = fakePayer();
  const p = createMcpToolProvider({ url: URL_, fetchImpl, payer });
  const out = await p.callTool("getCensusSummary", {});
  assert.deepEqual(out, paymentRequired({ x402 }));
  assert.equal(payer.signed.length, 0);
  assert.equal(rest.length, 0);
});

test("橋: accept は先頭固定ではなく Base/exact を探す（先頭が別チェーンの有料でも $0 の Base を選ぶ）", async () => {
  const x402 = challengeB64({ accepts: [baseAccept({ network: "eip155:1", amount: "5000" }), baseAccept()] });
  const { fetchImpl, rest } = fakeGateway({ callResult: paymentRequired({ x402 }) });
  const payer = fakePayer();
  const p = createMcpToolProvider({ url: URL_, fetchImpl, payer });
  const out = await p.callTool("getCensusSummary", {});
  assert.equal(out.x402Bridge.settled, true);
  assert.equal(payer.signed.length, 1);
  assert.equal(payer.signed[0].message.value, "0");
  assert.equal(rest.length, 1);
});

test("橋: x402 が壊れた base64 なら払わず元の結果を返す", async () => {
  const { fetchImpl, rest } = fakeGateway({ callResult: paymentRequired({ x402: "%%%not-base64%%%" }) });
  const payer = fakePayer();
  const p = createMcpToolProvider({ url: URL_, fetchImpl, payer });
  const out = await p.callTool("getCensusSummary", {});
  assert.deepEqual(out, paymentRequired({ x402: "%%%not-base64%%%" }));
  assert.equal(payer.signed.length, 0);
  assert.equal(rest.length, 0);
});

test("橋: REST が 402 を返し続けたら元の結果 + x402Bridge.settled === false", async () => {
  const { fetchImpl, rest } = fakeGateway({ callResult: paymentRequired(), restStatus: 402, restBody: "{}" });
  const payer = fakePayer();
  const p = createMcpToolProvider({ url: URL_, fetchImpl, payer });
  const out = await p.callTool("getCensusSummary", {});
  assert.equal(out.isError, true);
  assert.deepEqual(out.content, paymentRequired().content);
  assert.equal(out.x402Bridge.settled, false);
  assert.equal(out.x402Bridge.responseStatus, 402);
  assert.equal(out.x402Bridge.txHash, null);
  assert.equal(rest.length, 1);
  // 署名はした（その事実は隠さない）。
  assert.equal(payer.signed.length, 1);
  assert.equal(p.bridgeLog().length, 1);
});

test("橋: 402 でない結果は payer があっても触らない（署名 0 回・REST 0 回）", async () => {
  const ok = { content: [{ type: "text", text: '{"verdict":"ALLOW"}' }] };
  const { fetchImpl, rest } = fakeGateway({ callResult: ok });
  const payer = fakePayer();
  const p = createMcpToolProvider({ url: URL_, fetchImpl, payer });
  const out = await p.callTool("getResourceDecision", { resourceId: "abc" });
  assert.deepEqual(out, ok);
  assert.equal(payer.signed.length, 0);
  assert.equal(rest.length, 0);
});
