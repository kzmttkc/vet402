// Feed staleness (SPEC §6): equity feed is stale after 26h without an update or
// while the token's oracle is paused; UTC Saturday/Sunday is flagged weekend.
// A stale feed refuses the USD mark (2026-09-17 owner instruction, SPEC patch 009).
//
// Run from the repo root: npx tsx --test packages/rwa/test/staleness.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { EQUITY_STALE_AFTER_SEC, feedStatus, isWeekendUtc } from "../feed";

const T0 = 1789596123; // fixture A block timestamp, Wednesday 2026-09-16 22:02:03 UTC

test("a feed updated within 26h and not paused is fresh", () => {
  const s = feedStatus({ updatedAt: T0 - 8_422, oraclePaused: false, asOf: T0 });
  assert.equal(s.stale, false);
  assert.equal(s.ageSec, 8_422);
});

test("a feed older than 26h is stale", () => {
  assert.equal(EQUITY_STALE_AFTER_SEC, 26 * 3600);
  assert.equal(feedStatus({ updatedAt: T0 - 26 * 3600, oraclePaused: false, asOf: T0 }).stale, false);
  assert.equal(feedStatus({ updatedAt: T0 - 26 * 3600 - 1, oraclePaused: false, asOf: T0 }).stale, true);
});

test("a paused oracle is stale even when the round is fresh", () => {
  assert.equal(feedStatus({ updatedAt: T0 - 1, oraclePaused: true, asOf: T0 }).stale, true);
});

test("an updatedAt in the future is not fresh by accident", () => {
  const s = feedStatus({ updatedAt: T0 + 3600, oraclePaused: false, asOf: T0 });
  assert.equal(s.ageSec, 0);
  assert.equal(s.stale, false);
});

test("weekend is UTC Saturday or Sunday", () => {
  assert.equal(isWeekendUtc(T0), false); // Wed
  assert.equal(isWeekendUtc(Date.UTC(2026, 8, 19, 12) / 1000), true); // Sat 2026-09-19
  assert.equal(isWeekendUtc(Date.UTC(2026, 8, 20, 23, 59) / 1000), true); // Sun
  assert.equal(isWeekendUtc(Date.UTC(2026, 8, 21, 0, 0) / 1000), false); // Mon
});
