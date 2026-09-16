// Fixture A — SPEC §2 and §11: the USD mark of a canonical Stock Token balance.
//
//   usd_cents = raw * feed_answer * 100 / 1e8 / 1e18   (integer, floor)
//
// The equity feed already carries the split multiplier. An implementation that
// multiplies uiMultiplier in again must fail this fixture, and the fixture must
// be able to tell the two apart (uiMultiplier != 1e18 and a gap of at least 1 cent).
//
// Run from the repo root: npx tsx --test packages/rwa/test/fixture-a.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { markUsdCents } from "../usd";

type FixtureA = {
  fixture_id: string;
  chain_id: number;
  block: number;
  token: { address: string; decimals: number };
  feed: { address: string; decimals: number };
  raw: string;
  ui_multiplier: string;
  oracle_paused: boolean;
  feed_round: { answer: string; updated_at: string };
  expected: { usd_cents: string };
};

const A = JSON.parse(
  readFileSync(join(process.cwd(), "fixtures/rwa/A.json"), "utf8"),
) as FixtureA;

const ONE = 10n ** 18n;
const raw = BigInt(A.raw);
const answer = BigInt(A.feed_round.answer);
const uiMultiplier = BigInt(A.ui_multiplier);
const expected = BigInt(A.expected.usd_cents);

type MarkImpl = (raw: bigint, feedAnswer: bigint, uiMultiplier: bigint) => bigint;
const matchesFixtureA = (impl: MarkImpl) => impl(raw, answer, uiMultiplier) === expected;

test("fixture A is NVDA on Robinhood Chain with an 18-decimal token and an 8-decimal feed", () => {
  assert.equal(A.fixture_id, "A");
  assert.equal(A.chain_id, 4663);
  assert.equal(A.token.address, "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC");
  assert.equal(A.feed.address, "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15");
  assert.equal(A.token.decimals, 18);
  assert.equal(A.feed.decimals, 8);
  assert.equal(A.oracle_paused, false);
  assert.ok(raw > 0n, "raw balance must be positive");
  assert.ok(answer > 0n, "feed answer must be positive");
});

test("fixture A can tell a double-counted uiMultiplier apart", () => {
  assert.notEqual(uiMultiplier, ONE, "uiMultiplier == 1e18 would make the double-count test vacuous");
  const doubled = (expected * uiMultiplier) / ONE;
  assert.notEqual(doubled, expected, "raw is too small for the multiplier to move the mark by 1 cent");
});

test("the official USD formula matches fixture A", () => {
  assert.ok(matchesFixtureA((r, a) => markUsdCents(r, a)));
});

test("an implementation that multiplies uiMultiplier into the price fails fixture A", () => {
  // SPEC §11: an implementation whose expected value is usd * uiMultiplier / 1e18.
  const doubleCounted: MarkImpl = (r, a, u) => (((r * a * 100n) / 10n ** 8n / ONE) * u) / ONE;
  assert.equal(matchesFixtureA(doubleCounted), false);
});
