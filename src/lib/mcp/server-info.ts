import { mcpServerVersion } from "@/lib/listings/generate-from-openapi";
import { loadOpenApiFromRepo } from "@/lib/listings/load-openapi";

/** MCP initialize / server.json の serverInfo（版は docs/openapi.yaml の x-vet402-listings.mcp.serverVersion）。 */
export const MCP_SERVER_INFO = {
  name: "vet402",
  version: mcpServerVersion(loadOpenApiFromRepo()),
} as const;