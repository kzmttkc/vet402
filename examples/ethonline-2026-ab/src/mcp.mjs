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
 * @param {{url: string, fetchImpl?: typeof fetch, headers?: Record<string,string>}} args
 * @returns {{url: string, listTools: () => Promise<object[]>, callTool: (name: string, input: object) => Promise<object>}}
 */
export function createMcpToolProvider({ url, fetchImpl = fetch, headers = {}, clientInfo = MCP_CLIENT_INFO } = {}) {
  if (typeof url !== "string" || url.length === 0) throw new Error("mcp: url is required");

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
      return rpc("tools/call", { name, arguments: input ?? {} });
    },
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
