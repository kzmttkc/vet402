// Cost basis and realization (SPEC §4). FIFO only — no moving average, ever.
//
// A lot opens when the address receives the canonical token and closes, oldest
// first, when it sends it away. What separates a realization from a mere
// movement is the venue: a swap has a priced other side, a plain transfer does
// not. A lot whose cost could not be priced (received by transfer, or a swap
// whose quote has no USD) stays in the queue with `cost_usd_cents: null`; a
// sale that reaches such a lot yields no number for that leg and marks the
// whole reconstruction `partial`. That is the honest answer, and it is why this
// engine never invents a cost.

export type PricedEventType = "transfer" | "univ3_swap" | "univ4_swap" | "other_unparsed";

export type PricedEvent = {
  tx: string;
  log_index: number;
  block_number: number;
  type: PricedEventType;
  /** signed raw amount from the address's point of view */
  raw_delta: bigint;
  /** USD cents of the other side of the swap, or null when there is none / it could not be priced */
  quote_usd_cents: bigint | null;
};

export type Lot = {
  raw_qty: bigint;
  /** null = cost unknown (SPEC §4: received by transfer, or an unpriced quote) */
  cost_usd_cents: bigint | null;
  opened_block: number;
  opened_tx: string;
};

export type RealizedStatus = "complete" | "partial" | "none";

export type FifoResult = {
  /** null when nothing could be realized at all */
  realized_usd_cents: bigint | null;
  realized_status: RealizedStatus;
  open_lots: Lot[];
  remaining_raw: bigint;
  /** raw quantity still held whose cost is unknown */
  unknown_cost_raw: bigint;
  /** raw quantity sold that no lot covered (an incomplete history, not an error) */
  oversold_raw: bigint;
};

const inChainOrder = (a: PricedEvent, b: PricedEvent) =>
  a.block_number - b.block_number || a.log_index - b.log_index;

export function runFifo(events: PricedEvent[]): FifoResult {
  const lots: Lot[] = [];
  let realized: bigint | null = null;
  let sawUnknown = false;
  let oversold = 0n;

  for (const e of [...events].sort(inChainOrder)) {
    if (e.raw_delta === 0n) continue;

    if (e.raw_delta > 0n) {
      const isSwap = e.type === "univ3_swap" || e.type === "univ4_swap";
      const cost = isSwap ? e.quote_usd_cents : null;
      if (cost === null) sawUnknown = true;
      lots.push({ raw_qty: e.raw_delta, cost_usd_cents: cost, opened_block: e.block_number, opened_tx: e.tx });
      continue;
    }

    // An exit. Only a swap realizes; a transfer out just removes quantity.
    let remaining = -e.raw_delta;
    const sold = remaining;
    const realizes = e.type === "univ3_swap" || e.type === "univ4_swap";
    const proceeds = realizes ? e.quote_usd_cents : null;
    if (realizes && proceeds === null) sawUnknown = true;

    let costOfSold = 0n;
    let qtyWithKnownCost = 0n;
    while (remaining > 0n && lots.length > 0) {
      const lot = lots[0];
      const take = lot.raw_qty <= remaining ? lot.raw_qty : remaining;
      if (lot.cost_usd_cents === null) {
        sawUnknown = true;
      } else {
        // Prorate by quantity; the lot keeps the remainder so cents do not leak.
        const takenCost = (lot.cost_usd_cents * take) / lot.raw_qty;
        costOfSold += takenCost;
        qtyWithKnownCost += take;
        lot.cost_usd_cents -= takenCost;
      }
      lot.raw_qty -= take;
      remaining -= take;
      if (lot.raw_qty === 0n) lots.shift();
    }
    if (remaining > 0n) {
      oversold += remaining;
      sawUnknown = true;
    }

    // Realize only the share of the sale whose cost is known.
    if (proceeds !== null && qtyWithKnownCost > 0n) {
      const proceedsOfKnown = (proceeds * qtyWithKnownCost) / sold;
      realized = (realized ?? 0n) + proceedsOfKnown - costOfSold;
    }
    if (qtyWithKnownCost < sold) sawUnknown = true;
  }

  const remaining_raw = lots.reduce((sum, l) => sum + l.raw_qty, 0n);
  const unknown_cost_raw = lots.reduce((sum, l) => (l.cost_usd_cents === null ? sum + l.raw_qty : sum), 0n);
  const realized_status: RealizedStatus =
    realized === null ? (sawUnknown || unknown_cost_raw > 0n ? "partial" : "none") : sawUnknown || unknown_cost_raw > 0n ? "partial" : "complete";

  return { realized_usd_cents: realized, realized_status, open_lots: lots, remaining_raw, unknown_cost_raw, oversold_raw: oversold };
}
