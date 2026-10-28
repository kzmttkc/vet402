import { test } from "node:test";
import assert from "node:assert/strict";
import { MCP_DOCS_FEED_INTRO } from "@/lib/docs/mcp-page-text";
import { DELIVERY_FEED_PAGE_SIZE } from "@/lib/delivery/sellers-feed";
import { readFileSync } from "node:fs";

const size = DELIVERY_FEED_PAGE_SIZE.toLocaleString("en-US");

test("/docs/mcp states the page size the feed serves", () => {
  assert.match(MCP_DOCS_FEED_INTRO, new RegExp(`at most ${size} rows`));
});

test("openapi states the page size the feed serves", () => {
  const yaml = readFileSync("docs/openapi.yaml", "utf8");
  assert.match(yaml, new RegExp(`Up to ${size} rows`));
  assert.doesNotMatch(yaml, /Up to 200 rows/);
});
