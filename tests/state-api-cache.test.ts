// ============================================================
// vet402 — the state API reads the pages' shared data cache (2026-11-08).
//
// A CDN miss used to recompute every aggregate live: 4.15 s on the first call,
// 0.05 s from the CDN (measured 2026-11-08). Pins that the route goes through
// state-reads.ts, that only the "no data cache" invariant falls back to a live
// read, and that the spending halt is still read live on every call.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isNoDataCacheError } from "@/lib/observatory/state-reads";

test("state route reads through the shared data cache, halt stays live", () => {
  const src = readFileSync("src/app/api/v1/observatory/state/route.ts", "utf8");
  assert.match(src, /readStateAggregates\(\)/);
  assert.match(src, /isSpendingHalted\(\)/);
  assert.doesNotMatch(src, /getObservatoryStats\(\)/);
  const reads = readFileSync("src/lib/observatory/state-reads.ts", "utf8");
  assert.match(reads, /getObservatoryStatsCached\(\)/);
  assert.doesNotMatch(reads, /isSpendingHalted/);
});

test("only the incrementalCache invariant falls back to a live read", () => {
  assert.equal(isNoDataCacheError(new Error("Invariant: incrementalCache missing in unstable_cache async () => 1")), true);
  assert.equal(isNoDataCacheError(new Error("connection terminated")), false);
  assert.equal(isNoDataCacheError("incrementalCache missing"), false);
});

test("uptime-cron times the state API with the pages", () => {
  const src = readFileSync("scripts/uptime-cron.sh", "utf8");
  assert.match(src, /for path in [^\n]*\/api\/v1\/observatory\/state/);
});
