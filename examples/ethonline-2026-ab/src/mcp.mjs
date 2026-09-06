/**
 * **Bazantic Gateway の MCP を、エージェントが実際に呼べる道具として渡すための薄い橋。**
 *
 * 2026-09-06 まで、このハーネスは `messages.create` を1発叩くだけで、**ツールもネットワークも
 * 与えていなかった**。Gateway の URL はプロンプトに文字列として書いてあるだけで、
 * **MCP は経路に入っていなかった**——賞の問い（"Show us it can be done using Bazantic built
 * MCP server and recipe"）の中核を実演していない状態だった。
 *
 * 公式 SDK を使わないのは、`examples/` に依存を増やさないため。使うのは MCP の Streamable HTTP
 * のうち**この用途に要る3手だけ**（`initialize` → `notifications/initialized` → `tools/list` /
 * `tools/call`）で、それ以上を実装しない。
 *
 * **`fetch` は引数で差し替えられる。** 鍵もネットワークも無い環境で、送っている JSON-RPC
 * そのものをテストで固定するため（`test/mcp.test.mjs`）。**このセッションは実 MCP を呼んでいない。**
 */

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_CLIENT_INFO = Object.freeze({ name: "vet402-ethonline-ab", version: "0.1.0" });

/** Base メインネット。橋はこのチェーンの `exact` 以外を選ばない。 */
export const BRIDGE_NETWORK = "eip155:8453";
export const BRIDGE_CHAIN_ID = 8453;
/** 橋が払ってよい唯一の額。**それ以外は例外**（ツール呼び出しで金を動かさない）。 */
export const BRIDGE_ONLY_AMOUNT = "0";

/**
 * **$0 の x402 402 を、MCP の外で払って本物の応答に置き換える橋**（2026-09-06）。
 *
 * 実測: Bazantic Gateway は全 57 ルートが 0 mcents でも、REST も MCP も未払いなら 402 を返す
 * （既定仕様・設定で外せない）。MCP の `tools/call` は HTTP 200 の JSON-RPC で `isError: true`、
 * `content[0].text` に `Details: {"x402":"<base64>"}` が載る。**MCP の POST に PAYMENT-SIGNATURE を
 * 載せても無視される**が、REST `GET {origin}{resource.url}` へ同じヘッダで送ると
 * 200 + `payment-response`（settled, tx）が返る。だから橋は REST に回す。
 *
 * 金の規則（テストと変異で固定）:
 *   - `payer` が無ければ橋は無い（402 の文がそのまま返る）
 *   - accepts から **Base / exact** を探す（先頭固定にしない）
 *   - `amount !== "0"` なら**署名せず**例外（額と宛先をメッセージに含める）
 *   - `HTTP <METHOD> <path>` の METHOD が GET 以外なら払わない（本文を持たない）
 *   - `x402` が壊れていれば橋を使わず元の結果を返す
 * 署名部品は `packages/sdk/dist/x402-pay.js`。**橋が発火するときだけ動的 import** するので、
 * payer の無い実行では署名モジュールが評価すらされない。
 */

/** `content[0].text` の 402 文から、橋に要る部品を取り出す。取り出せなければ null。 */
export function parsePaymentRequired(result) {
  if (result?.isError !== true) return null;
  const first = Array.isArray(result.content) ? result.content[0] : null;
  if (first?.type !== "text" || typeof first.text !== "string") return null;
  const lines = first.text.split(/\r?\n/);
  const http = /^HTTP\s+([A-Z]+)\s+(\S+)/.exec(lines[0] ?? "");
  if (http === null) return null;
  const detailsLine = lines.find((l) => l.startsWith("Details:"));
  if (detailsLine === undefined) return null;
  let challenge;
  try {
    const details = JSON.parse(detailsLine.slice("Details:".length).trim());
    if (typeof details?.x402 !== "string") return null;
    challenge = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(details.x402), (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
  if (typeof challenge?.resource?.url !== "string" || !Array.isArray(challenge.accepts)) return null;
  return { method: http[1], path: http[2], challenge };
}

/** accepts から Base / exact を選ぶ。**先頭固定にしない。** 無ければ null。 */
export function selectBridgeAccept(accepts) {
  if (!Array.isArray(accepts)) return null;
  return accepts.find((a) => a?.network === BRIDGE_NETWORK && a?.scheme === "exact") ?? null;
}

/** SSE でも素の JSON でも、JSON-RPC の1メッセージを取り出す。 */
function parseRpcBody(contentType, text) {
  if (typeof contentType === "string" && contentType.includes("text/event-stream")) {
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("data:")) return JSON.parse(line.slice(5).trim());
    }
    throw new Error("mcp: event-stream carried no data frame");
  }
  return JSON.parse(text);
}

/**
 * @param {{url: string, fetchImpl?: typeof fetch, headers?: Record<string,string>, clientInfo?: object,
 *   payer?: {address: string, signTypedData: (td: object) => Promise<string>} | null}} args
 *   `payer` は SDK の `PayerAccount` と同形。**無ければ 402 はそのままエラー文として返る。**
 * @returns {{url: string, listTools: () => Promise<object[]>, callTool: (name: string, input: object) => Promise<object>, bridgeLog: () => object[]}}
 */
export function createMcpToolProvider({ url, fetchImpl = fetch, headers = {}, clientInfo = MCP_CLIENT_INFO, payer = null } = {}) {
  if (typeof url !== "string" || url.length === 0) throw new Error("mcp: url is required");
  const gatewayOrigin = new URL(url).origin;
  /** 署名した内容（nonce・to・value・resource）。呼び手が tx と突き合わせて検算する。 */
  const bridgeLog = [];

  async function bridgeX402(result) {
    const parsed = parsePaymentRequired(result);
    if (parsed === null) return result;
    if (parsed.method !== "GET") return result;
    const accept = selectBridgeAccept(parsed.challenge.accepts);
    if (accept === null) return result;
    if (accept.amount !== BRIDGE_ONLY_AMOUNT) {
      throw new Error(
        `mcp x402 bridge: refusing to pay — amount=${accept.amount} payTo=${accept.payTo} ` +
          `(this bridge settles only amount="${BRIDGE_ONLY_AMOUNT}" challenges; a tool call must never move money)`,
      );
    }
    const resource = parsed.challenge.resource.url;
    const x402 = await import("../../../packages/sdk/dist/x402-pay.js");
    const authorization = x402.buildAuthorization({
      from: payer.address,
      to: accept.payTo,
      value: accept.amount,
      nowSec: Math.floor(Date.now() / 1000),
      maxTimeoutSeconds: accept.maxTimeoutSeconds,
    });
    const { signature } = await x402.signX402Payment({ account: payer, accept, authorization, chainId: BRIDGE_CHAIN_ID });
    bridgeLog.push({ nonce: authorization.nonce, to: authorization.to, value: authorization.value, resource, signedAt: new Date().toISOString() });
    const header = x402.encodePaymentHeader({ x402Version: 2, accept, payload: { signature, authorization }, resourceUrl: resource });
    const res = await fetchImpl(gatewayOrigin + resource, {
      method: "GET",
      headers: { accept: "application/json", [header.headerName]: header.headerValue },
    });
    const base = { payTo: accept.payTo, amount: accept.amount, resource, responseStatus: res.status };
    if (res.status !== 200) {
      return { ...result, x402Bridge: { settled: false, txHash: null, ...base } };
    }
    const settlement = x402.parseSettlementResponse(res.headers);
    const text = await res.text();
    return {
      // 本物の応答を先頭に。`[SERVER]: …` などサーバの添え書き（content[1] 以降）は残す。
      content: [{ type: "text", text }, ...(Array.isArray(result.content) ? result.content.slice(1) : [])],
      isError: false,
      x402Bridge: { settled: settlement?.success === true, txHash: settlement?.transaction ?? null, ...base },
    };
  }

  let sessionId = null;
  let nextId = 0;
  let handshake = null;
  /** **一覧は1回だけ引く。** A と B に同じツールが渡ることを、規律ではなく構造で保証する。 */
  let toolsPromise = null;

  async function rpc(method, params, { notification = false } = {}) {
    const id = notification ? undefined : (nextId += 1);
    const h = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      ...headers,
    };
    if (sessionId !== null) h["Mcp-Session-Id"] = sessionId;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: h,
      body: JSON.stringify(notification ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params }),
    });
    const gotSession = res.headers?.get?.("mcp-session-id");
    if (typeof gotSession === "string" && gotSession.length > 0) sessionId = gotSession;
    if (!res.ok) {
      throw new Error(`mcp: ${method} failed with HTTP ${res.status}`);
    }
    if (notification || res.status === 202) return null;
    const body = parseRpcBody(res.headers?.get?.("content-type"), await res.text());
    if (body?.error) throw new Error(`mcp: ${method} returned an error: ${body.error.message ?? JSON.stringify(body.error)}`);
    return body?.result ?? null;
  }

  async function ensureHandshake() {
    if (handshake === null) {
      handshake = (async () => {
        const result = await rpc("initialize", {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo,
        });
        await rpc("notifications/initialized", {}, { notification: true });
        return result;
      })().catch((e) => {
        handshake = null;
        throw e;
      });
    }
    return handshake;
  }

  return {
    url,
    serverInfo: async () => (await ensureHandshake())?.serverInfo ?? null,
    listTools() {
      if (toolsPromise === null) {
        toolsPromise = (async () => {
          await ensureHandshake();
          const result = await rpc("tools/list", {});
          const tools = Array.isArray(result?.tools) ? result.tools : [];
          return Object.freeze(tools);
        })().catch((e) => {
          toolsPromise = null;
          throw e;
        });
      }
      return toolsPromise;
    },
    async callTool(name, input) {
      await ensureHandshake();
      const result = await rpc("tools/call", { name, arguments: input ?? {} });
      if (payer === null || payer === undefined) return result;
      return bridgeX402(result);
    },
    bridgeLog: () => bridgeLog.map((e) => ({ ...e })),
  };
}

/** MCP のツール定義を Anthropic Messages API の `tools` 形式へ。**名前は書き換えない。** */
export function toAnthropicTools(mcpTools) {
  return (mcpTools ?? []).map((t) => ({
    name: t.name,
    description: typeof t.description === "string" ? t.description : "",
    input_schema:
      t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object", properties: {} },
  }));
}
