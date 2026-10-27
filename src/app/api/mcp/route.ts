// ============================================================
// MCP の入口（2026-10-28・要件書 v3 §2）。公開の URL は https://vet402.com/mcp（next.config.ts の rewrite）。
//
// 読むだけ・無料・鍵なし。tool は src/lib/mcp/tools.ts（① check_x402_seller・③ check_my_x402_endpoint・
// ② find_x402_sellers）。版は 2025-06-18（initialize あり）と 2026-07-28（ステートレス・server/discover）の 2 つを
// mcp-handler（@modelcontextprotocol/server の stateless 経路）が受ける。セッションは持たない。
//
// 守り（§2.3）:
//   - MCP_ENABLED=false なら全部の要求に 503 mcp_disabled
//   - Origin が付いていて OWN_ORIGINS に無ければ 403（MCP 仕様の MUST）。付いていない要求は通す。CORS のヘッダーは付けない
//   - GET と DELETE は 405
//   - 本文は 64KB まで（SDK の既定は 4MB で、mcp-handler からは変えられない）。JSON-RPC の batch 配列は受けない
//   - 枠: bucket mcp（MCP_RATE_PER_MIN・既定 120/分/IP）と、② だけ bucket mcp_find（MCP_FIND_RATE_PER_MIN・既定 30）。
//     超えたら HTTP 429 と JSON-RPC の -32029
//   - DB を読めなかったら 503 temporarily_unavailable・Retry-After 30
//   - 要求ごとに server と transport を作る（共有しない）。応答は全部読み切ってから返す（SSE を開けっぱなしにしない）
// 自分の HTTP API を経由しない（ライブラリの関数を直接呼ぶ）。route から外への通信は 0（読むのは DB だけ）。
// ログは logServerErrorSafe だけ。入力の URL・IP・UA の生の値は出さない。
// ============================================================
import { NextResponse, type NextRequest } from "next/server";
import { createMcpHandler } from "mcp-handler";
import { publicRateLimit } from "@/lib/api/public-route";
import { mcpClientUsageLabel, isOwnPageRequest, recordMcpUsage, type McpUsageRoute } from "@/lib/api/client-usage";
import { OWN_ORIGINS } from "@/lib/decision/lookup-caller";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { mcpDeps } from "@/lib/mcp/deps";
import { FIND_TOOL_ENABLED, registerVet402Tools, TOOL_NAMES, type McpRequestState } from "@/lib/mcp/tools";
import { SERVER_INSTRUCTIONS } from "@/lib/mcp/text";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const MCP_SERVER_INFO = { name: "vet402", version: "1.0.0" } as const;
export const MCP_MAX_BODY_BYTES = 64 * 1024;
export const MCP_RATE_LIMIT_CODE = -32029;
const DEFAULT_RATE_PER_MIN = 120;
const DEFAULT_FIND_RATE_PER_MIN = 30;
const UNAVAILABLE_RETRY_AFTER_S = 30;
const NO_STORE = { "Cache-Control": "no-store" };

const COUNTED_TOOLS: Record<string, McpUsageRoute> = {
  [TOOL_NAMES.checkSeller]: "mcp:check_x402_seller",
  [TOOL_NAMES.checkEndpoint]: "mcp:check_my_x402_endpoint",
  [TOOL_NAMES.findSellers]: "mcp:find_x402_sellers",
};

function mcpEnabled(): boolean {
  const v = (process.env.MCP_ENABLED ?? "").trim().toLowerCase();
  return !(v === "false" || v === "0" || v === "off");
}

function perMin(raw: string | undefined, fallback: number): number {
  const n = Number((raw ?? "").trim());
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function disabled(): NextResponse {
  return NextResponse.json({ error: "mcp_disabled" }, { status: 503, headers: NO_STORE });
}

/** Origin が付いていて自サイトでなければ拒否する。付いていない要求（サーバー間）は通す。 */
function originRejected(request: Request): NextResponse | null {
  const origin = request.headers.get("origin");
  if (origin === null) return null;
  if (OWN_ORIGINS.has(origin.trim())) return null;
  return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
}

function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method not allowed." } },
    { status: 405, headers: { ...NO_STORE, Allow: "POST" } },
  );
}

function jsonRpcError(status: number, id: unknown, code: number, message: string, headers: Record<string, string> = {}, data?: unknown) {
  return NextResponse.json(
    { jsonrpc: "2.0", id: id ?? null, error: data === undefined ? { code, message } : { code, message, data } },
    { status, headers: { ...NO_STORE, ...headers } },
  );
}

/** 本文を上限まで読む。超えたら null。 */
async function readBodyCapped(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MCP_MAX_BODY_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MCP_MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

type Rpc = { id?: unknown; method?: unknown; params?: { name?: unknown; clientInfo?: { name?: unknown; version?: unknown } } };

function parseRpc(text: string): Rpc | Rpc[] | null {
  try {
    const v = JSON.parse(text) as unknown;
    if (Array.isArray(v)) return v as Rpc[];
    return v && typeof v === "object" ? (v as Rpc) : null;
  } catch {
    return null;
  }
}

/** 応答の本文（JSON か SSE の data 行）に JSON-RPC の result があるか。 */
function hasRpcResult(contentType: string, text: string): boolean {
  const bodies = contentType.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
    : [text];
  for (const b of bodies) {
    try {
      const v = JSON.parse(b) as { result?: unknown };
      if (v && typeof v === "object" && "result" in v) return true;
    } catch {
      // 読めない行は数えない
    }
  }
  return false;
}

/** 数える（§2.4）: HTTP 200・result のある応答だけ。initialize は clientInfo、tools/call は UA から client を決める。 */
function countUsage(request: Request, rpc: Rpc, contentType: string, text: string): void {
  if (!hasRpcResult(contentType, text)) return;
  if (rpc.method === "initialize") {
    const info = rpc.params?.clientInfo;
    const name = typeof info?.name === "string" ? info.name.slice(0, 200) : "";
    const version = typeof info?.version === "string" ? info.version.slice(0, 40) : "";
    recordMcpUsage(mcpClientUsageLabel(name ? (version ? `${name}/${version}` : name) : null), "mcp:initialize");
    return;
  }
  if (rpc.method === "tools/call" && typeof rpc.params?.name === "string") {
    const route = COUNTED_TOOLS[rpc.params.name];
    if (!route) return;
    recordMcpUsage(mcpClientUsageLabel(request.headers.get("user-agent"), isOwnPageRequest(request.headers)), route);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!mcpEnabled()) return disabled();
  const rejected = originRejected(request);
  if (rejected) return rejected;

  const text = await readBodyCapped(request);
  if (text === null) return jsonRpcError(413, null, -32600, "request_too_large");
  const rpc = parseRpc(text);
  // 2025-06-18 から JSON-RPC の batch は無い。配列を受けると、1 回の要求で枠を越えて tool を呼べてしまう。
  if (Array.isArray(rpc)) return jsonRpcError(400, null, -32600, "batch_not_supported");
  const id = rpc?.id ?? null;

  const gate = await publicRateLimit(request, "mcp", perMin(process.env.MCP_RATE_PER_MIN, DEFAULT_RATE_PER_MIN), 60_000);
  if (!gate.ok) return rateLimitedOrUnavailable(gate.response, id);
  if (FIND_TOOL_ENABLED && rpc?.method === "tools/call" && rpc.params?.name === TOOL_NAMES.findSellers) {
    const find = await publicRateLimit(request, "mcp_find", perMin(process.env.MCP_FIND_RATE_PER_MIN, DEFAULT_FIND_RATE_PER_MIN), 60_000);
    if (!find.ok) return rateLimitedOrUnavailable(find.response, id);
  }

  const state: McpRequestState = { unavailable: false };
  const deps = mcpDeps();
  // 要求ごとに作る（server・transport を要求の間で共有しない）。
  const handler = createMcpHandler((server) => registerVet402Tools(server, deps, state), {
    serverInfo: { ...MCP_SERVER_INFO },
    instructions: SERVER_INSTRUCTIONS,
    maxSubscriptions: 0,
  });
  let res: Response;
  let body: string;
  try {
    const forward = new Headers(request.headers);
    forward.delete("content-length");
    res = await handler(new Request(request.url, { method: "POST", headers: forward, body: text }));
    body = await res.text();
  } catch (error) {
    logServerErrorSafe("mcp.handler", error);
    return unavailable();
  }
  if (state.unavailable) return unavailable();

  const headers = new Headers(NO_STORE);
  const ct = res.headers.get("content-type");
  if (ct) headers.set("Content-Type", ct);
  for (const [k, v] of Object.entries(gate.headers)) headers.set(k, v);
  if (res.status === 200 && rpc && !Array.isArray(rpc)) countUsage(request, rpc, ct ?? "", body);
  return new Response(body, { status: res.status, headers });
}

function unavailable(): NextResponse {
  return NextResponse.json(
    { error: "temporarily_unavailable" },
    { status: 503, headers: { ...NO_STORE, "Retry-After": String(UNAVAILABLE_RETRY_AFTER_S) } },
  );
}

/** publicRateLimit の素の JSON を、MCP の形に包み直す。429 は JSON-RPC の -32029、枠ストアの不通（503）はそのまま。 */
async function rateLimitedOrUnavailable(response: NextResponse, id: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  response.headers.forEach((v, k) => {
    if (k.toLowerCase().startsWith("ratelimit-") || k.toLowerCase() === "retry-after") headers[k] = v;
  });
  if (response.status !== 429) {
    return NextResponse.json({ error: "temporarily_unavailable" }, { status: 503, headers: { ...NO_STORE, ...headers } });
  }
  const retry = Number(headers["retry-after"] ?? headers["Retry-After"] ?? "60");
  return jsonRpcError(429, id, MCP_RATE_LIMIT_CODE, "rate_limited", headers, { retry_after_s: Number.isFinite(retry) ? retry : 60 });
}

export async function GET(): Promise<Response> {
  if (!mcpEnabled()) return disabled();
  return methodNotAllowed();
}

export async function DELETE(): Promise<Response> {
  if (!mcpEnabled()) return disabled();
  return methodNotAllowed();
}
