import serverJson from "../../../data/listings/mcp/server.json";

/**
 * MCP initialize の serverInfo。版の正典は docs/openapi.yaml の x-vet402-listings.mcp.serverVersion で、
 * data/listings/mcp/server.json はそこから生成される（npm run listings:generate）。実行時に 390KB の YAML を
 * 読んで解析しないよう、生成済みの JSON を取り込む（ビルドに同梱され、ファイルの読み出しが要らない）。
 * tests/mcp-server-version.test.ts が openapi の serverVersion との一致を固定する。
 */
export const MCP_SERVER_INFO = {
  name: "vet402",
  version: (serverJson as { version: string }).version,
} as const;
