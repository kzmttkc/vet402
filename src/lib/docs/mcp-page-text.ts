// ============================================================
// /docs/mcp の固定英文（2026-10-28）。tests/mcp-plain-english.test.ts が検査する。
// ============================================================

export const MCP_DOCS_INTRO =
  "The hosted MCP server at https://vet402.com/mcp returns what vet402 recorded when it paid x402 listings: when each attempt happened, which chain it used, whether content came back, and the transaction hash. " +
  "The endpoint is read only, needs no key, and costs nothing to call.";

export const MCP_DOCS_CONNECT_CURSOR =
  '{"mcpServers":{"vet402":{"type":"http","url":"https://vet402.com/mcp"}}}';

export const MCP_DOCS_GROK_BOT =
  "Grok Bot reads the same plugins as Cursor. It can use vet402 once the vet402 plugin is listed for it.";

export const MCP_DOCS_PRIVACY =
  "vet402 counts calls by client kind only. It does not store raw URLs, IP addresses, or User-Agent strings from MCP traffic. See the privacy policy for the same rule on other key-less reads.";

export const MCP_DOCS_DELIVERED_ONE_LINER =
  "Delivered means a purchase row where vet402 settled on chain and then received a non-empty 2xx response other than 202 Accepted, as defined at the methodology page.";

export const MCP_DOCS_CONTACT = "support@vet402.com";

/** plain-english 検査用。ページに載る固定文を全部返す。 */
export function allMcpDocsFixedText(): string[] {
  return [
    MCP_DOCS_INTRO,
    MCP_DOCS_GROK_BOT,
    MCP_DOCS_PRIVACY,
    MCP_DOCS_DELIVERED_ONE_LINER,
  ];
}
