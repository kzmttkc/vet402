// Public facts of one address (SPEC §5, §7). No opinion field, ever.
//
// Today (2026-09-17, §13d row 9/17–21): classification, feed, staleness and a
// current mark. No FIFO yet, so realized_usd and mdd_usd are null and
// r1_status can only say `partial` or `reconstructed` from what is decodable.
import { fetchBlockTimestamp, fetchCanonicalTransfers, fetchHead, fetchReceipts } from "./chain";
import { classifyReceipt, summarize, type EventsSummary, type PoolResolver, type RwaEvent, type RwaReceipt } from "./classify";
import { NVDA, RWA_CHAIN_ID } from "./config";
import { feedStatus, isWeekendUtc, readTokenAndFeed, type TokenFeedRead } from "./feed";
import { chainPoolResolver } from "./pools";
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
  realized_usd: null;
  unrealized_usd: string | null;
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

export function r1Status(events: RwaEvent[], summary: EventsSummary, raw: bigint): R1Status {
  if (summary.other_unparsed > 0) return "partial";
  // SPEC §5: reconstructed needs no cost-unknown lot left. Until FIFO lands
  // (09-22) a positive balance with any inbound transfer is treated as such a lot.
  const inboundTransfer = events.some((e) => e.type === "transfer" && e.raw_delta > 0n);
  if (inboundTransfer && raw > 0n) return "partial";
  return "reconstructed";
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

  const { read } = input;
  const status = feedStatus({ updatedAt: read.round.updatedAt, oraclePaused: read.oraclePaused, asOf: input.blockTimestamp });
  const usdCents = status.stale ? null : markUsdCents(read.raw, read.round.answer);
  const gaps: string[] = [];
  if (summary.other_unparsed > 0) gaps.push("other_unparsed");
  if (status.stale) gaps.push("feed_stale");
  gaps.push("fifo_pending"); // realized / mdd wait for Fixture B and the FIFO engine (SPEC §4, §11)

  return {
    address,
    chain_id: RWA_CHAIN_ID,
    as_of: new Date(input.blockTimestamp * 1000).toISOString(),
    as_of_block: input.block,
    method_version: METHOD_VERSION,
    identity_binding: "unknown",
    r0: "present",
    r1_status: r1Status(events, summary, read.raw),
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
    realized_usd: null,
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
