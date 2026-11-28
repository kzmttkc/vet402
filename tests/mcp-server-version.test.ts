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

test("MCP server version is the generated server.json version, not a literal in the route", () => {
  const server = JSON.parse(readFileSync("data/listings/mcp/server.json", "utf8")) as { version: string };
  assert.equal(MCP_SERVER_INFO.version, server.version);
  assert.doesNotMatch(readFileSync("src/app/api/mcp/route.ts", "utf8"), /version:\s*"\d+\.\d+\.\d+"/);
  assert.doesNotMatch(readFileSync("src/lib/mcp/server-info.ts", "utf8"), /readFileSync|loadOpenApiFromRepo/);
});
