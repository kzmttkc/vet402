// FIFO cost basis and realization (SPEC §4). No other cost method exists here.
//
// Run from the repo root: npx tsx --test packages/rwa/test/fifo.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { runFifo, type PricedEvent } from "../fifo";

const ONE = 10n ** 18n;
let seq = 0;
const ev = (over: Partial<PricedEvent>): PricedEvent => ({
  tx: `0x${(++seq).toString(16).padStart(64, "0")}`,
  log_index: 0,
  block_number: 1000 + seq,
  type: "univ3_swap",
  raw_delta: ONE,
  quote_usd_cents: 100n,
  ...over,
});

test("a swap in opens a lot with the quote's USD as its cost; a swap out realizes against it", () => {
  const r = runFifo([
    ev({ raw_delta: 10n * ONE, quote_usd_cents: 217334n }),
    ev({ raw_delta: -10n * ONE, quote_usd_cents: 216372n }),
  ]);
  assert.equal(r.realized_usd_cents, -962n);
  assert.equal(r.realized_status, "complete");
  assert.equal(r.open_lots.length, 0);
  assert.equal(r.remaining_raw, 0n);
});

test("lots are consumed oldest first, not cheapest first", () => {
  const r = runFifo([
    ev({ raw_delta: ONE, quote_usd_cents: 100_00n }),
    ev({ raw_delta: ONE, quote_usd_cents: 300_00n }),
    ev({ raw_delta: -ONE, quote_usd_cents: 200_00n }),
  ]);
  // FIFO sells the $100 lot: +$100. Average cost would say 0, LIFO would say -$100.
  assert.equal(r.realized_usd_cents, 100_00n);
  assert.equal(r.open_lots.length, 1);
  assert.equal(r.open_lots[0].cost_usd_cents, 300_00n);
});

test("a partial sale splits the lot and prorates its cost", () => {
  const r = runFifo([
    ev({ raw_delta: 4n * ONE, quote_usd_cents: 400_00n }),
    ev({ raw_delta: -ONE, quote_usd_cents: 120_00n }),
  ]);
  assert.equal(r.realized_usd_cents, 20_00n); // sold 1 of 4 → cost 100.00
  assert.equal(r.open_lots.length, 1);
  assert.equal(r.open_lots[0].raw_qty, 3n * ONE);
  assert.equal(r.open_lots[0].cost_usd_cents, 300_00n);
});

test("a lot received by plain transfer has unknown cost, and selling it yields no realization", () => {
  const r = runFifo([
    ev({ type: "transfer", raw_delta: ONE, quote_usd_cents: null }),
    ev({ raw_delta: -ONE, quote_usd_cents: 250_00n }),
  ]);
  assert.equal(r.realized_usd_cents, null);
  assert.equal(r.realized_status, "partial");
  // The unknown lot is gone from the book, so nothing unknown is still held;
  // what remains is the refusal to put a number on that sale.
  assert.equal(r.remaining_raw, 0n);
  assert.equal(r.unknown_cost_raw, 0n);
});

test("a known lot still realizes when a later sale hits an unknown lot", () => {
  const r = runFifo([
    ev({ raw_delta: ONE, quote_usd_cents: 100_00n }),
    ev({ type: "transfer", raw_delta: ONE, quote_usd_cents: null }),
    ev({ raw_delta: -ONE, quote_usd_cents: 150_00n }), // against the known lot
    ev({ raw_delta: -ONE, quote_usd_cents: 150_00n }), // against the unknown lot
  ]);
  assert.equal(r.realized_usd_cents, 50_00n);
  assert.equal(r.realized_status, "partial");
});

test("sending the token out by plain transfer removes quantity and realizes nothing", () => {
  const r = runFifo([
    ev({ raw_delta: 2n * ONE, quote_usd_cents: 200_00n }),
    ev({ type: "transfer", raw_delta: -ONE, quote_usd_cents: null }),
  ]);
  assert.equal(r.realized_usd_cents, null);
  assert.equal(r.remaining_raw, ONE);
  assert.equal(r.open_lots[0].cost_usd_cents, 100_00n);
  assert.equal(r.realized_status, "none");
});

test("a swap whose quote could not be priced leaves the lot unknown", () => {
  const r = runFifo([
    ev({ raw_delta: ONE, quote_usd_cents: null }),
    ev({ raw_delta: -ONE, quote_usd_cents: 100_00n }),
  ]);
  assert.equal(r.realized_usd_cents, null);
  assert.equal(r.realized_status, "partial");
});

test("an other_unparsed leg is counted, never silently dropped", () => {
  const r = runFifo([
    ev({ raw_delta: ONE, quote_usd_cents: 100_00n }),
    ev({ type: "other_unparsed", raw_delta: ONE, quote_usd_cents: null }),
    ev({ raw_delta: -ONE, quote_usd_cents: 150_00n }),
  ]);
  assert.equal(r.remaining_raw, ONE);
  assert.equal(r.realized_usd_cents, 50_00n);
  assert.equal(r.realized_status, "partial");
  assert.equal(r.unknown_cost_raw, ONE);
});

test("selling more than the lots hold is reported, not crashed on", () => {
  const r = runFifo([
    ev({ raw_delta: ONE, quote_usd_cents: 100_00n }),
    ev({ raw_delta: -2n * ONE, quote_usd_cents: 300_00n }),
  ]);
  assert.equal(r.remaining_raw, 0n);
  assert.equal(r.realized_status, "partial");
  assert.equal(r.oversold_raw, ONE);
});

test("events are processed in chain order regardless of the order given", () => {
  const a = ev({ block_number: 2, raw_delta: -ONE, quote_usd_cents: 150_00n });
  const b = ev({ block_number: 1, raw_delta: ONE, quote_usd_cents: 100_00n });
  assert.equal(runFifo([a, b]).realized_usd_cents, 50_00n);
});
