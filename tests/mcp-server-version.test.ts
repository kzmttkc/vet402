import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mcpServerVersion } from "@/lib/listings/generate-from-openapi";
import { loadOpenApiFromRepo } from "@/lib/listings/load-openapi";
import { MCP_SERVER_INFO } from "@/lib/mcp/server-info";

test("MCP server version matches openapi x-vet402-listings.mcp.serverVersion", () => {
  const spec = loadOpenApiFromRepo();
  const expected = mcpServerVersion(spec);
  assert.equal(MCP_SERVER_INFO.version, expected);
  assert.match(readFileSync("docs/openapi.yaml", "utf8"), /serverVersion:\s*1\.0\.2/);
});