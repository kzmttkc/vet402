// Public facts of one address (SPEC §5, §7). No opinion field, ever.
//
// Today (2026-09-17, §13d row 9/17–21): classification, feed, staleness and a
// current mark. No FIFO yet, so realized_usd and mdd_usd are null and
// r1_status can only say `partial` or `reconstructed` from what is decodable.
import { fetchBlockTimestamp, fetchCanonicalTransfers, fetchHead, fetchReceipts } from "./chain";
import { classifyReceipt, summarize, type EventsSummary, type PoolResolver, type RwaEvent, type RwaReceipt } from "./classify";
import { NVDA, RWA_CHAIN_ID } from "./config";
import { feedStatus, isWeekendUtc, readTokenAndFeed, type TokenFeedRead } from "./feed";
import { runFifo, type PricedEvent } from "./fifo";
import { chainPoolResolver } from "./pools";
import { quoteForSwap } from "./quote";
import type { RpcOptions } from "./rpc";
import { markUsdCents } from "./usd";

export const METHOD_VERSION = "rwa-recon-0.1";
export const DISCLAIMER = "Reconstruction of public chain data. Not investment advice. Not an offer of Stock Tokens.";

export type R1Status = "reconstructed" | "partial" | "unverified";

export type RwaFacts = {
  address: string;
  chain_id: number;
  as_of: string;
  as_of_block: number;
  method_version: string;
  identity_binding: "unknown" | "declared" | "bound";
  r0: "present";
  r1_status: R1Status;
  r2: "no_declaration";
  tokens: {
    symbol: string;
    token: string;
    canonical: true;
    raw: string;
    shares_ui: string;
    /** null while the feed is stale: a stale oracle refuses the mark (patch 009) */
    usd: string | null;
    feed: string;
    feed_answer: string;
    feed_updated_at: string;
    stale: boolean;
    stale_reasons: string[];
    weekend: boolean;
  }[];
  events_summary: EventsSummary;
  /** raw quantity the replayed events leave the address holding; equals `tokens[].raw` unless a leg was missed */
  replayed_raw: string;
  /** null until every lot the sale consumed had a known cost (SPEC §4, Fixture B) */
  realized_usd: string | null;
  realized_status: "complete" | "partial" | "none";
  unrealized_usd: string | null;
  /** null in v0: MDD needs stored NAV snapshots, and nothing is stored yet (SPEC §4) */
  mdd_usd: null;
  gaps: string[];
  evidence: { txs: string[]; fixture_ids: string[] };
  disclaimer: string;
};

export class NoStockTokenActivity extends Error {
  constructor() {
    super("no_stock_token_activity");
    this.name = "NoStockTokenActivity";
  }
}

/** `raw * multiplier / 1e18` as a decimal string with 8 places (SPEC §2). */
export function sharesUi(raw: bigint, uiMultiplier: bigint): string {
  const scaled = (raw * uiMultiplier) / 10n ** 10n; // 18 + 18 - 10 = 26 → 8 decimals left after /1e18
  const whole = scaled / 10n ** 26n;
  const frac = (scaled % 10n ** 26n) / 10n ** 18n;
  return `${whole}.${frac.toString().padStart(8, "0")}`;
}

export function usdString(cents: bigint): string {
  const sign = cents < 0n ? "-" : "";
  const abs = cents < 0n ? -cents : cents;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

/** SPEC §5: reconstructed needs a decodable history AND no cost-unknown lot left. */
export function r1Status(summary: EventsSummary, unknownCostRaw: bigint): R1Status {
  if (summary.other_unparsed > 0) return "partial";
  if (unknownCostRaw > 0n) return "partial";
  return "reconstructed";
}

/**
 * One priced event per (transaction, token): the legs of a transaction are netted
 * before pricing, so a route that moves the canonical token twice inside one
 * transaction cannot be charged the quote twice. The quote itself comes from the
 * transaction's own USDG/WETH legs (packages/rwa/quote.ts).
 */
export function priceEvents(receipts: RwaReceipt[], events: RwaEvent[], address: string): PricedEvent[] {
  const byTx = new Map<string, RwaReceipt>(receipts.map((r) => [r.transactionHash, r]));
  const grouped = new Map<string, PricedEvent>();
  for (const e of events) {
    const key = `${e.tx}:${e.token}`;
    const seen = grouped.get(key);
    if (seen) {
      seen.raw_delta += e.raw_delta;
      seen.log_index = Math.min(seen.log_index, e.log_index);
      // A transaction that both swaps and transfers the token is not a clean swap.
      if (seen.type !== e.type) seen.type = "other_unparsed";
      continue;
    }
    grouped.set(key, { tx: e.tx, log_index: e.log_index, block_number: e.block_number, type: e.type, raw_delta: e.raw_delta, quote_usd_cents: null });
  }
  for (const priced of grouped.values()) {
    if (priced.type !== "univ3_swap" && priced.type !== "univ4_swap") continue;
    const receipt = byTx.get(priced.tx);
    if (!receipt) continue;
    priced.quote_usd_cents = quoteForSwap(receipt.logs, address, priced.raw_delta > 0n)?.usd_cents ?? null;
  }
  return [...grouped.values()];
}

export type FactsInputs = {
  address: string;
  block: number;
  blockTimestamp: number;
  receipts: RwaReceipt[];
  read: TokenFeedRead;
  resolver: PoolResolver;
  fixtureIds?: string[];
};

/** Pure assembly of the facts document from already-fetched inputs. */
export async function assembleFacts(input: FactsInputs): Promise<RwaFacts> {
  const address = input.address.toLowerCase();
  const canonical = new Set([NVDA.token.toLowerCase()]);
  const events: RwaEvent[] = [];
  for (const r of input.receipts) events.push(...(await classifyReceipt(r, address, canonical, input.resolver)));
  if (events.length === 0) throw new NoStockTokenActivity();
  events.sort((a, b) => a.block_number - b.block_number || a.log_index - b.log_index);
  const summary = summarize(events);
  const fifo = runFifo(priceEvents(input.receipts, events, address));

  const { read } = input;
  const status = feedStatus({ updatedAt: read.round.updatedAt, oraclePaused: read.oraclePaused, asOf: input.blockTimestamp });
  const usdCents = status.stale ? null : markUsdCents(read.raw, read.round.answer);
  const gaps: string[] = [];
  if (summary.other_unparsed > 0) gaps.push("other_unparsed");
  if (status.stale) gaps.push("feed_stale");
  if (fifo.unknown_cost_raw > 0n) gaps.push("unknown_cost_lots");
  if (fifo.oversold_raw > 0n) gaps.push("incomplete_history");
  // The one invariant that proves no leg was dropped: replaying every classified
  // event must land on the balance the chain reports. Measured 2026-09-24 on the
  // demo address: both said 41012742373747910457. A mismatch means the decoder
  // missed a movement, so it is published rather than smoothed over.
  if (fifo.remaining_raw !== read.raw) gaps.push("balance_mismatch");
  gaps.push("mdd_pending"); // MDD needs stored NAV snapshots (SPEC §4); nothing is stored in v0

  return {
    address,
    chain_id: RWA_CHAIN_ID,
    as_of: new Date(input.blockTimestamp * 1000).toISOString(),
    as_of_block: input.block,
    method_version: METHOD_VERSION,
    identity_binding: "unknown",
    r0: "present",
    r1_status: r1Status(summary, fifo.unknown_cost_raw),
    r2: "no_declaration",
    tokens: [
      {
        symbol: NVDA.symbol,
        token: NVDA.token,
        canonical: true,
        raw: read.raw.toString(),
        shares_ui: sharesUi(read.raw, read.uiMultiplier),
        usd: usdCents === null ? null : usdString(usdCents),
        feed: NVDA.feed,
        feed_answer: read.round.answer.toString(),
        feed_updated_at: new Date(read.round.updatedAt * 1000).toISOString(),
        stale: status.stale,
        stale_reasons: status.reasons,
        weekend: isWeekendUtc(input.blockTimestamp),
      },
    ],
    events_summary: summary,
    replayed_raw: fifo.remaining_raw.toString(),
    realized_usd: fifo.realized_usd_cents === null ? null : usdString(fifo.realized_usd_cents),
    realized_status: fifo.realized_status,
    unrealized_usd: usdCents === null ? null : usdString(usdCents),
    mdd_usd: null,
    gaps,
    evidence: { txs: [...new Set(events.map((e) => e.tx))], fixture_ids: input.fixtureIds ?? ["A"] },
    disclaimer: DISCLAIMER,
  };
}

/** Live reconstruction: address-scoped log reads from genesis to `block` (default head). */
export async function reconstructFacts(address: string, opts: RpcOptions & { block?: number } = {}): Promise<RwaFacts> {
  const block = opts.block ?? (await fetchHead(opts));
  const logs = await fetchCanonicalTransfers(NVDA.token, address, block, opts);
  if (logs.length === 0) throw new NoStockTokenActivity();
  const txs = [...new Set(logs.map((l) => l.transactionHash))];
  // One read at a time, with longer retries: the public RPC answers 429 to bursts, and
  // three parallel reads after the log walk failed the whole request (measured 2026-09-18).
  const patient: RpcOptions = { retries: 5, ...opts };
  const receipts = await fetchReceipts(txs, patient);
  const read = await readTokenAndFeed(NVDA.token, NVDA.feed, address, block, patient);
  const blockTimestamp = await fetchBlockTimestamp(block, patient);
  return assembleFacts({ address, block, blockTimestamp, receipts, read, resolver: chainPoolResolver(patient), fixtureIds: ["A"] });
}
