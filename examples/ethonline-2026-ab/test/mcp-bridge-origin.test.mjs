// ============================================================
// 橋の再送先は **Gateway と同じ origin** でなければならない（2026-09-07 第三者監査 A5）。
//
// 監査（HEAD 0ebec74・src/mcp.mjs :108, :120）: 再送先は `gatewayOrigin + resource.url` の文字列連結。
// 402 の `resource.url` が `@evil.com/x` なら `https://<gw>@evil.com/x` になり、URL のホストは
// evil.com（`<gw>` はユーザ情報に化ける）。署名した PAYMENT-SIGNATURE（EIP-3009 の生きた認可）が
// 別ホストへ飛ぶ。
//
// 規則: `new URL(resource.url, gatewayOrigin)` で組み、`.origin === gatewayOrigin` でなければ
// **署名の前に** throw（fail-closed）。URL として解決すると `@evil.com/x` は Gateway の相対パスになるが、
// 今度は `//evil.com/x`・絶対 URL・`\\evil.com/x`（特殊スキームでは `\` が `/`）が別 origin に解決する
// ので、origin の照合が要る。ここでも実ネットワークは呼ばない。
// ============================================================
import test from "node:test";
import assert from "node:assert/strict";
import { createMcpToolProvider } from "../src/mcp.mjs";

const URL_ = "https://2vjhqfgvw5dt5lja2zpjsjwrem.bazgateway.com/mcp";
const GW_ORIGIN = "https://2vjhqfgvw5dt5lja2zpjsjwrem.bazgateway.com";
const PAY_TO = "0x6eB43A9dbDEB6d9A4D9E9B774c8E42De6C19F138";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAYER = "0x1111111111111111111111111111111111111111";

const accept = { scheme: "exact", network: "eip155:8453", asset: USDC, amount: "0", payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } };
const challengeB64 = (resourceUrl) => btoa(JSON.stringify({ x402Version: 2, resource: { url: resourceUrl }, accepts: [accept] }));
const paymentRequired = (resourceUrl) => ({
  isError: true,
  content: [{ type: "text", text: [`HTTP GET /2vjhqfgvw5dt5lja2zpjsjwrem/api/v1/census/summary`, "Error: Payment Required (HTTP 402)", `Details: ${JSON.stringify({ payment_required: true, x402: challengeB64(resourceUrl) })}`].join("\n") }],
});

/** MCP は 402 を返し、それ以外（REST）への要求を全部貯める偽 Gateway。 */
function fakeGateway(resourceUrl) {
  const rest = [];
  const fetchImpl = async (url, init) => {
    if (url === URL_) {
      const body = JSON.parse(init.body);
      if (body.id === undefined) return new Response(null, { status: 202 });
      const result = body.method === "initialize" ? { protocolVersion: "2025-06-18", serverInfo: { name: "gw", version: "1" }, capabilities: { tools: {} } } : body.method === "tools/list" ? { tools: [{ name: "getCensusSummary" }] } : paymentRequired(resourceUrl);
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

test("橋: 監査の実物 resource.url \"@evil.com/x\" は文字列連結だと host が evil.com になる——URL として解決すれば Gateway の /@evil.com/x（署名は Gateway にしか飛ばない）", async () => {
  // 実測（2026-09-07）: new URL(GW + "@evil.com/x").host === "evil.com"、new URL("@evil.com/x", GW).host === GW の host。
  assert.equal(new URL(GW_ORIGIN + "@evil.com/x").host, "evil.com", "文字列連結の穴そのもの（監査 A5 の再現）");
  const { fetchImpl, rest } = fakeGateway("@evil.com/x");
  const payer = fakePayer();
  const p = createMcpToolProvider({ url: URL_, fetchImpl, payer });
  await p.callTool("getCensusSummary", {});
  assert.equal(rest.length, 1);
  assert.equal(new URL(rest[0].url).origin, GW_ORIGIN);
  assert.notEqual(new URL(rest[0].url).host, "evil.com");
  assert.equal(rest[0].url, `${GW_ORIGIN}/@evil.com/x`);
});

for (const resourceUrl of ["//evil.com/x", "https://evil.com/x", "http://2vjhqfgvw5dt5lja2zpjsjwrem.bazgateway.com/x", "https://2vjhqfgvw5dt5lja2zpjsjwrem.bazgateway.com.evil.com/x", "\\\\evil.com/x"]) {
  test(`橋: resource.url ${JSON.stringify(resourceUrl)} は Gateway の origin に解決しない → 署名せず throw・REST に 0 回`, async () => {
    const { fetchImpl, rest } = fakeGateway(resourceUrl);
    const payer = fakePayer();
    const p = createMcpToolProvider({ url: URL_, fetchImpl, payer });
    await assert.rejects(() => p.callTool("getCensusSummary", {}), (e) => {
      assert.match(e.message, /origin/);
      assert.match(e.message, new RegExp(GW_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    });
    assert.equal(payer.signed.length, 0, "署名の前に止まる");
    assert.equal(rest.length, 0, "別ホストへ飛んでいない");
    assert.equal(p.bridgeLog().length, 0);
  });
}

test("橋: 相対パスの resource.url は Gateway の origin に解決し、再送先のホストは Gateway（ネガティブコントロール）", async () => {
  const { fetchImpl, rest } = fakeGateway("/api/v1/census/summary?window=30d");
  const payer = fakePayer();
  const p = createMcpToolProvider({ url: URL_, fetchImpl, payer });
  await p.callTool("getCensusSummary", {});
  assert.equal(rest.length, 1);
  assert.equal(new URL(rest[0].url).origin, GW_ORIGIN);
  assert.equal(rest[0].url, `${GW_ORIGIN}/api/v1/census/summary?window=30d`);
  assert.equal(payer.signed.length, 1);
});
