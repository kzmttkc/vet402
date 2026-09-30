// The canonical Stock Token list (SPEC patch 018): a frozen snapshot of
// Robinhood's asset list, checked on chain when it was taken.
//
// Run from the repo root: npx tsx --test packages/rwa/test/registry.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { getAddress } from "viem";
import { NVDA } from "../config";
import { STOCK_TOKEN_BEACON, STOCK_TOKEN_CODE_HASH, STOCK_TOKEN_FACTORY, TOKEN_DEPLOYED_TOPIC0 } from "../identity";
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

test("no feed is paired with two tokens", () => {
  const feeds = CANONICAL_TOKENS.filter((t) => t.feed).map((t) => t.feed!.toLowerCase());
  assert.equal(new Set(feeds).size, feeds.length);
});

// SPEC patch 021: the list and the chain agree on every token.
test("second root: all 195 share the reference code hash, the beacon, and a factory deployment event", () => {
  assert.equal(REGISTRY.identity.reference_code_hash, STOCK_TOKEN_CODE_HASH);
  assert.equal(REGISTRY.identity.beacon, STOCK_TOKEN_BEACON);
  assert.equal(REGISTRY.identity.factory, STOCK_TOKEN_FACTORY);
  assert.equal(REGISTRY.identity.factory_event_topic0, TOKEN_DEPLOYED_TOPIC0);
  assert.equal(REGISTRY.counts.code_hash_matches, 195);
  assert.equal(REGISTRY.counts.factory_deployed, 195);
  assert.equal(REGISTRY.counts.needs_review, 0);
  for (const t of CANONICAL_TOKENS) {
    assert.equal(t.code_hash, STOCK_TOKEN_CODE_HASH, `${t.symbol} code hash`);
    assert.equal(t.beacon, STOCK_TOKEN_BEACON, `${t.symbol} beacon`);
    assert.ok(t.factory_log, `${t.symbol} factory event`);
    assert.match(t.factory_log!.tx, /^0x[0-9a-f]{64}$/, t.symbol);
    assert.ok(t.factory_log!.block <= REGISTRY.identity.read_at_block, t.symbol);
    assert.deepEqual(t.needs_review, [], t.symbol);
  }
});

test("the factory made more tokens than the list names, so the factory alone is not the list", () => {
  // 204 deployment events were read at block 76057945 (2026-09-30), 9 more than the 195 in Robinhood's
  // active list. The list decides membership. The chain confirms identity.
  assert.ok(REGISTRY.identity.factory_events > CANONICAL_TOKENS.length);
  assert.equal(new Set(CANONICAL_TOKENS.map((t) => t.factory_log!.tx + ":" + t.factory_log!.log_index)).size, 195, "one event per token");
});

test("identity constants are EIP-55", () => {
  assert.equal(STOCK_TOKEN_BEACON, getAddress(STOCK_TOKEN_BEACON));
  assert.equal(STOCK_TOKEN_FACTORY, getAddress(STOCK_TOKEN_FACTORY));
  assert.equal(REGISTRY.identity.beacon_implementation, getAddress(REGISTRY.identity.beacon_implementation));
  assert.match(STOCK_TOKEN_CODE_HASH, /^0x[0-9a-f]{64}$/);
});
