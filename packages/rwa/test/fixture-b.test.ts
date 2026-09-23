// Fixture B (SPEC §11): the round trip in fixtures/rwa/B.md, replayed through
// the quote pricer and the FIFO engine. The realized figure must land within
// $0.01 of the hand calculation in that file, or no surface may publish
// realized_usd at all.
//
// Run from the repo root: npx tsx --test packages/rwa/test/fixture-b.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runFifo, type PricedEvent } from "../fifo";
import { usdgToCents } from "../quote";

const B = readFileSync(join(process.cwd(), "fixtures/rwa/B.md"), "utf8");

/** The numbers below are read out of B.md so the file and the test cannot drift apart. */
function field(label: string): string {
  const row = B.split("\n").find((l) => l.startsWith(`| ${label} |`));
  assert.ok(row, `B.md has no row for ${label}`);
  return row.split("|")[2].trim().replace(/`/g, "").replace(/ .*$/, "");
}

const ENTRY_NVDA = BigInt(field("raw in (NVDA received)"));
const ENTRY_USDG = BigInt(field("raw out (USDG paid)"));
const EXIT_NVDA = BigInt(field("raw out (NVDA sold)"));
const EXIT_USDG = BigInt(field("raw in (USDG received)"));

const events: PricedEvent[] = [
  { tx: "0xa8431b20", log_index: 71, block_number: 52211835, type: "univ3_swap", raw_delta: ENTRY_NVDA, quote_usd_cents: usdgToCents(ENTRY_USDG) },
  { tx: "0x9255af25", log_index: 28, block_number: 61819228, type: "univ3_swap", raw_delta: -EXIT_NVDA, quote_usd_cents: usdgToCents(EXIT_USDG) },
];

test("B.md states the round trip the test replays", () => {
  assert.equal(ENTRY_NVDA, 10n * 10n ** 18n);
  assert.equal(EXIT_NVDA, 10n * 10n ** 18n);
  assert.equal(ENTRY_USDG, 2173349387n);
  assert.equal(EXIT_USDG, 2163726193n);
  assert.match(B, /realized = 216372 - 217334 = -962 cents/);
});

test("USDG is priced at 1 USD with 6 decimals, floored to cents", () => {
  assert.equal(usdgToCents(ENTRY_USDG), 217334n);
  assert.equal(usdgToCents(EXIT_USDG), 216372n);
  assert.equal(usdgToCents(1n), 0n);
  assert.equal(usdgToCents(10_000n), 1n);
});

test("the FIFO engine lands within $0.01 of the hand calculation", () => {
  const r = runFifo(events);
  assert.ok(r.realized_usd_cents !== null, "realized must not be null for a fully priced round trip");
  const diffCents = r.realized_usd_cents - -962n;
  assert.ok(diffCents <= 1n && diffCents >= -1n, `off by ${diffCents} cents`);
  assert.equal(r.realized_status, "complete");
  assert.equal(r.remaining_raw, 0n);
});
