// The canonical Stock Token list (SPEC patch 018): a frozen snapshot of
// Robinhood's asset list, checked on chain when it was taken.
//
// Run from the repo root: npx tsx --test packages/rwa/test/registry.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { getAddress } from "viem";
import { NVDA } from "../config";
import { CANONICAL_SET, CANONICAL_TOKENS, REGISTRY, tokenByAddress } from "../registry";

test("195 listed, 195 written, none rejected on chain", () => {
  assert.equal(REGISTRY.counts.listed, 195);
  assert.equal(REGISTRY.counts.written, 195);
  assert.equal(REGISTRY.counts.rejected, 0);
  assert.equal(CANONICAL_TOKENS.length, 195);
  assert.equal(CANONICAL_SET.size, 195, "addresses are unique");
});

test("addresses are EIP-55 and symbols are unique", () => {
  for (const t of CANONICAL_TOKENS) assert.equal(t.token, getAddress(t.token), t.symbol);
  assert.equal(new Set(CANONICAL_TOKENS.map((t) => t.symbol)).size, CANONICAL_TOKENS.length);
});

test("NVDA in the snapshot is the address and feed the method was built on", () => {
  const nvda = tokenByAddress(NVDA.token)!;
  assert.equal(nvda.symbol, "NVDA");
  assert.equal(nvda.token, NVDA.token);
  assert.equal(nvda.feed, NVDA.feed);
});

test("every feed is named after its token by its own description()", () => {
  const withFeed = CANONICAL_TOKENS.filter((t) => t.feed);
  assert.equal(withFeed.length, REGISTRY.counts.with_feed);
  assert.equal(withFeed.length, 33);
  for (const t of withFeed) {
    const base = t.feed_description!.split(/\s*\/\s*USD$|-USD$/)[0].trim().replace(/^Robinhood\s+/, "").replace(/^RH(?=[A-Z])/, "");
    assert.equal(base, t.symbol, `${t.symbol}: ${t.feed_description}`);
  }
});
