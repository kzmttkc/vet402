// ============================================================
// **A/B 橋（`src/mcp.mjs`）が読む 402 × 壊れた形の表 — どの行でも署名は「Gateway 宛・$0・Base USDC・0x 宛先」以外に存在しない。**
//
// 橋は Bazantic Gateway の `tools/call` が返す 402 文（`Details: {"x402":"<base64>"}`）を読み、
// `resource.url`・`accepts[]`（amount / payTo / asset / network / scheme / maxTimeoutSeconds / extra）を
// 信じて署名する。表は SDK と共有（`packages/sdk/test/_shapes.mjs`）。同じ 1 つの配列を橋が読む
// 全欄に差し込み、各行で **(a) 署名しない**（元の結果を返す・または署名前に throw）か、
// **(b) 署名するなら value "0"・to は正規の 0x 宛先・verifyingContract は Base USDC・再送先は Gateway origin**
// のどちらかであることを assert する。橋の契約は「ツール呼び出しで金を動かさない」なので、
// 壊れた欄で署名だけが焼ける形（宛先 null・トークン不明の $0 認可）も欠陥として扱う。
//
// 実ネットワークなし。MCP も REST も偽物、payer は署名内容を数える。
// ============================================================
import test from "node:test";
import assert from "node:assert/strict";
import { createMcpToolProvider } from "../src/mcp.mjs";
import { BROKEN_SHAPES, REQUIRED_SHAPE_IDS, withShape, showShape } from "../../../packages/sdk/test/_shapes.mjs";

const URL_ = "https://2vjhqfgvw5dt5lja2zpjsjwrem.bazgateway.com/mcp";
const GW_ORIGIN = "https://2vjhqfgvw5dt5lja2zpjsjwrem.bazgateway.com";
const RESOURCE = "/api/v1/census/summary?window=30d";
const PAY_TO = "0x6eB43A9dbDEB6d9A4D9E9B774c8E42De6C19F138";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAYER = "0x1111111111111111111111111111111111111111";

const JSON_ROWS = BROKEN_SHAPES.filter((r) => r.from === "json");

const okAccept = () => ({ scheme: "exact", network: "eip155:8453", asset: USDC, amount: "0", payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } });
const okChallenge = () => ({ x402Version: 2, resource: { url: RESOURCE }, accepts: [okAccept()] });
const b64 = (o) => btoa(JSON.stringify(o));

/** 実測した `tools/call` の 402 の形。`x402` には base64 文字列か、壊した値そのものを入れる。 */
function paymentRequired(x402) {
  const text = [
    `HTTP GET /2vjhqfgvw5dt5lja2zpjsjwrem${RESOURCE}`,
    "Error: Payment Required (HTTP 402)",
    `Details: ${JSON.stringify({ payment_required: true, x402 })}`,
  ].join("\n");
  return { isError: true, content: [{ type: "text", text }] };
}

function fakeGateway(callResult) {
  const rest = [];
  const fetchImpl = async (url, init) => {
    if (url === URL_) {
      const body = JSON.parse(init.body);
      if (body.id === undefined) return new Response(null, { status: 202 });
      const result = body.method === "initialize" ? { protocolVersion: "2025-06-18", serverInfo: { name: "gw", version: "1" }, capabilities: { tools: {} } } : body.method === "tools/list" ? { tools: [{ name: "getCensusSummary" }] } : callResult;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers: { "content-type": "application/json" } });
    }
    rest.push({ url, init });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, rest };
}

function fakePayer() {
  const signed = [];
  return { address: PAYER, signed, signTypedData: async (td) => { signed.push(td); return "0x" + "ab".repeat(65); } };
}

async function callWith(callResult) {
  const { fetchImpl, rest } = fakeGateway(callResult);
  const payer = fakePayer();
  const p = createMcpToolProvider({ url: URL_, fetchImpl, payer });
  try {
    const out = await p.callTool("getCensusSummary", {});
    return { kind: "returned", out, rest, payer };
  } catch (error) {
    return { kind: "throw", error, rest, payer };
  }
}

/** 橋の契約: 署名しない（元の結果か署名前の throw）、または署名は Gateway 宛・$0・USDC・0x 宛先。 */
function assertBridgeContract(r, label) {
  if (r.payer.signed.length === 0) {
    assert.equal(r.rest.length, 0, `${label}: 署名していないのに REST へ飛んだ`);
    // 橋自身の拒否か、署名部品（x402-pay.js）が署名の前に投げる EIP-712 ドメイン矛盾のどちらか。
    if (r.kind === "throw") assert.match(String(r.error.message), /^mcp x402 bridge: refusing to pay|^x402: accept contradicts/, `${label}: 橋の拒否以外の throw: ${r.error.message}`);
    return;
  }
  assert.equal(r.payer.signed.length, 1, `${label}: 署名回数が 1 でない`);
  const td = r.payer.signed[0];
  assert.equal(td.message.value, "0", `${label}: $0 以外に署名した`);
  assert.equal(String(td.message.to).toLowerCase(), PAY_TO.toLowerCase(), `${label}: 宛先が署名に漏れた`);
  assert.equal(String(td.domain.verifyingContract).toLowerCase(), USDC.toLowerCase(), `${label}: トークンが署名に漏れた`);
  assert.equal(td.domain.chainId, 8453);
  const window = Number(td.message.validBefore) - Number(td.message.validAfter);
  assert.ok(Number.isInteger(window) && window > 0 && window <= 180, `${label}: 認可の窓が上限外`);
  assert.equal(r.kind, "returned", `${label}: 署名した後で throw した: ${r.error?.message}`);
  assert.equal(r.rest.length, 1);
  assert.equal(new URL(r.rest[0].url).origin, GW_ORIGIN, `${label}: 再送先が Gateway でない`);
}

test("表: SDK と同じ表を読んでいる（必須の形が全部居る）", () => {
  const ids = new Set(BROKEN_SHAPES.map((r) => r.id));
  for (const id of REQUIRED_SHAPE_IDS) assert.ok(ids.has(id), `表に ${id} が無い`);
});

test("基準値: 壊す前の 402 は橋が $0 で払う（ネガティブコントロール）", async () => {
  const r = await callWith(paymentRequired(b64(okChallenge())));
  assert.equal(r.payer.signed.length, 1);
  assertBridgeContract(r, "baseline");
});

const FIELDS = [
  "resource", "resource.url", "accepts", "accepts.0",
  "accepts.0.amount", "accepts.0.payTo", "accepts.0.asset", "accepts.0.network", "accepts.0.scheme",
  "accepts.0.maxTimeoutSeconds", "accepts.0.extra", "accepts.0.extra.name", "accepts.0.extra.version",
  "accepts.0.__unexpected_key", "x402Version", "__unexpected_key",
];

for (const path of FIELDS) {
  for (const row of JSON_ROWS) {
    // amount の "0"（zero 行は数値 0 なので壊れた形のまま）。amount は "0" と厳密一致しない限り署名しない契約。
    const label = `橋 402.${path}=${showShape(row)}`;
    test(`${label} → 署名しないか、署名は Gateway 宛・$0・USDC・0x 宛先`, async () => {
      const r = await callWith(paymentRequired(b64(withShape(okChallenge(), path, row.value))));
      assertBridgeContract(r, label);
    });
  }
}

// `x402` そのもの（base64 文字列であるべき欄）に表を差し込む。
for (const row of JSON_ROWS) {
  const label = `橋 Details.x402=${showShape(row)}`;
  test(`${label} → 署名しない`, async () => {
    const r = await callWith(paymentRequired(row.value));
    assertBridgeContract(r, label);
    assert.equal(r.payer.signed.length, 0, `${label}: 壊れた x402 で署名した`);
  });
}
