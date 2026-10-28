import { test } from "node:test";
import assert from "node:assert/strict";
import { feedPriceUsd } from "@/lib/delivery/feed-price";

const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

test("a network with a known USDC prices 6 decimals", () => {
  assert.equal(feedPriceUsd("10000", BASE_USDC, "eip155:8453"), 0.01);
  assert.equal(feedPriceUsd("10000", BASE_USDC, "base"), 0.01);
  assert.equal(feedPriceUsd("1000", "0x3600000000000000000000000000000000000000", "eip155:5042"), 0.001);
  assert.equal(feedPriceUsd("2500", SOLANA_USDC, SOLANA), 0.0025);
});

test("a network without a known USDC is null, whatever the asset says", () => {
  assert.equal(feedPriceUsd("10", "USDC", "stellar:pubnet"), null);
  assert.equal(feedPriceUsd("10", "usdc", "xrpl:0"), null);
  assert.equal(feedPriceUsd("10", BASE_USDC, "eip155:4217"), null);
  assert.equal(feedPriceUsd("10", "USDC", null), null);
});

test("an asset that is not that network's USDC is null", () => {
  assert.equal(feedPriceUsd("10", BASE_USDC, SOLANA), null);
  assert.equal(feedPriceUsd("10", SOLANA_USDC, "eip155:8453"), null);
  assert.equal(feedPriceUsd("abc", BASE_USDC, "eip155:8453"), null);
});
