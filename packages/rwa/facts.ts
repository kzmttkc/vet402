// Public facts of one address (SPEC §5, §7). No opinion field, ever.
//
// rwa-recon-0.2 (SPEC patch 018): every canonical Stock Token in Robinhood's
// asset list (packages/rwa/registry.ts), not only NVDA. Scope, stated in the
// record itself: the tokens the address holds at `as_of`, NVDA, and any
// canonical token those tokens' transactions moved for the address. A position
// opened and fully closed in some other token is not scanned yet, and the
// record says so (`exited_positions_not_scanned`) instead of implying it was.
import { fetchBlockTimestamp, fetchCanonicalTransfers, fetchHead, fetchReceipts } from "./chain";
import { classifyReceipt, summarize, type EventsSummary, type PoolResolver, type RwaEvent, type RwaReceipt } from "./classify";
import { NVDA, RWA_CHAIN_ID } from "./config";
import { TOPICS, topicToAddress } from "./events";
import { feedStatus, isWeekendUtc, readBalances, readTokenState, type TokenState } from "./feed";
import { runFifo, type FifoResult, type PricedEvent, type RealizedStatus } from "./fifo";
import { chainPoolResolver } from "./pools";
import { quoteForSwap } from "./quote";
import { CANONICAL_SET, CANONICAL_TOKENS, REGISTRY, tokenByAddress } from "./registry";
import type { RpcOptions } from "./rpc";
import { markUsdCents } from "./usd";

export const METHOD_VERSION = "rwa-recon-0.2";
export const DISCLAIMER = "Reconstruction of public chain data. Not investment advice. Not an offer of Stock Tokens.";

export type R1Status = "reconstructed" | "partial" | "unverified";

export type TokenFacts = {
  symbol: string;
  name: string;
  token: string;
  canonical: true;
  raw: string;
  shares_ui: string;
  /** null while the feed is stale (patch 009) or when the token has no Chainlink feed */
  usd: string | null;
  /** why `usd` is null: the feed is stale, or Chainlink lists no feed for this token */
  usd_reason: "feed_stale" | "no_feed" | null;
  feed: string | null;
  feed_answer: string | null;
  feed_updated_at: string | null;
  stale: boolean | null;
  stale_reasons: string[];
  weekend: boolean;
  /** raw quantity the replayed events leave the address holding; equals `raw` unless a leg was missed */
  replayed_raw: string;
  realized_usd: string | null;
  realized_status: RealizedStatus;
  events_summary: EventsSummary;
};

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
  /** which tokens were read, and from which list */
  scope: {
    registry_taken_at: string;
    registry_tokens: number;
    registry_source: string;
    scanned: string[];
    rule: string;
  };
  tokens: TokenFacts[];
  events_summary: EventsSummary;
  /** sum over tokens; null until some sale could be priced against a known cost (SPEC §4, Fixture B) */
  realized_usd: string | null;
  realized_status: RealizedStatus;
  /** USD mark of everything held; null unless every held token has a fresh feed */
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

export type TokenPricedEvent = PricedEvent & { token: string };

/**
 * One priced event per (transaction, token): the legs of a transaction are netted
 * before pricing, so a route that moves the canonical token twice inside one
 * transaction cannot be charged the quote twice. The quote itself comes from the
 * transaction's own USDG/WETH legs (packages/rwa/quote.ts). A transaction that
 * moves two canonical tokens for the address (a Stock-for-Stock route) is left
 * unpriced: its one USDG leg cannot be split between them without a guess.
 */
export function priceEvents(receipts: RwaReceipt[], events: RwaEvent[], address: string): TokenPricedEvent[] {
  const byTx = new Map<string, RwaReceipt>(receipts.map((r) => [r.transactionHash, r]));
  const grouped = new Map<string, TokenPricedEvent>();
  const tokensInTx = new Map<string, Set<string>>();
  for (const e of events) {
    (tokensInTx.get(e.tx) ?? tokensInTx.set(e.tx, new Set()).get(e.tx)!).add(e.token);
    const key = `${e.tx}:${e.token}`;
    const seen = grouped.get(key);
    if (seen) {
      seen.raw_delta += e.raw_delta;
      seen.log_index = Math.min(seen.log_index, e.log_index);
      // A transaction that both swaps and transfers the token is not a clean swap.
      if (seen.type !== e.type) seen.type = "other_unparsed";
      continue;
    }
    grouped.set(key, { tx: e.tx, token: e.token, log_index: e.log_index, block_number: e.block_number, type: e.type, raw_delta: e.raw_delta, quote_usd_cents: null });
  }
  for (const priced of grouped.values()) {
    if (priced.type !== "univ3_swap" && priced.type !== "univ4_swap") continue;
    if ((tokensInTx.get(priced.tx)?.size ?? 0) > 1) continue;
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
  /** one state per scanned token (every token an event touches must be here) */
  states: TokenState[];
  resolver: PoolResolver;
  fixtureIds?: string[];
  /** limit which canonical tokens are classified (a fixture recorded for one token); default: the whole registry */
  canonical?: ReadonlySet<string>;
};

const SCOPE_RULE = "held at as_of, plus NVDA, plus canonical tokens moved for the address in those tokens' transactions";

function aggregateStatus(statuses: RealizedStatus[]): RealizedStatus {
  if (statuses.some((s) => s === "partial")) return "partial";
  if (statuses.some((s) => s === "complete")) return "complete";
  return "none";
}

/** Pure assembly of the facts document from already-fetched inputs. */
export async function assembleFacts(input: FactsInputs): Promise<RwaFacts> {
  const address = input.address.toLowerCase();
  const events: RwaEvent[] = [];
  const canonical = (input.canonical ?? CANONICAL_SET) as Set<string>;
  for (const r of input.receipts) events.push(...(await classifyReceipt(r, address, canonical, input.resolver)));
  const states = new Map(input.states.map((s) => [s.token.toLowerCase(), s]));
  const held = [...states.values()].filter((s) => s.raw > 0n);
  if (events.length === 0 && held.length === 0) throw new NoStockTokenActivity();
  events.sort((a, b) => a.block_number - b.block_number || a.log_index - b.log_index);

  const priced = priceEvents(input.receipts, events, address);
  const tokenAddrs = [...new Set([...events.map((e) => e.token), ...held.map((s) => s.token.toLowerCase())])];
  for (const t of tokenAddrs) if (!states.has(t)) throw new Error(`no on-chain state read for ${t}`);

  const weekend = isWeekendUtc(input.blockTimestamp);
  const gaps = new Set<string>();
  const perToken: { facts: TokenFacts; fifo: FifoResult; usdCents: bigint | null }[] = [];
  for (const t of tokenAddrs) {
    const info = tokenByAddress(t)!;
    const state = states.get(t)!;
    const tokenEvents = events.filter((e) => e.token === t);
    const fifo = runFifo(priced.filter((p) => p.token === t));
    const summary = summarize(tokenEvents);

    let usdCents: bigint | null = null;
    let usdReason: TokenFacts["usd_reason"] = null;
    let stale: boolean | null = null;
    let staleReasons: string[] = [];
    if (state.feed && info.feed) {
      const status = feedStatus({ updatedAt: state.feed.round.updatedAt, oraclePaused: state.oraclePaused, asOf: input.blockTimestamp });
      stale = status.stale;
      staleReasons = status.reasons;
      if (status.stale) {
        usdReason = "feed_stale";
        if (state.raw > 0n) gaps.add("feed_stale");
      } else {
        usdCents = markUsdCents(state.raw, state.feed.round.answer);
      }
    } else {
      usdReason = "no_feed";
      if (state.raw > 0n) gaps.add("no_feed");
    }
    if (summary.other_unparsed > 0) gaps.add("other_unparsed");
    if (fifo.unknown_cost_raw > 0n) gaps.add("unknown_cost_lots");
    if (fifo.oversold_raw > 0n) gaps.add("incomplete_history");
    // The one invariant that proves no leg was dropped: replaying every classified
    // event must land on the balance the chain reports. Measured 2026-09-24 on the
    // demo address for NVDA: both said 41012742373747910457. A mismatch means the
    // decoder missed a movement, so it is published rather than smoothed over.
    if (fifo.remaining_raw !== state.raw) gaps.add("balance_mismatch");

    perToken.push({
      fifo,
      usdCents,
      facts: {
        symbol: info.symbol,
        name: info.name,
        token: info.token,
        canonical: true,
        raw: state.raw.toString(),
        shares_ui: sharesUi(state.raw, state.uiMultiplier),
        usd: usdCents === null ? null : usdString(usdCents),
        usd_reason: usdReason,
        feed: info.feed,
        feed_answer: state.feed ? state.feed.round.answer.toString() : null,
        feed_updated_at: state.feed ? new Date(state.feed.round.updatedAt * 1000).toISOString() : null,
        stale,
        stale_reasons: staleReasons,
        weekend,
        replayed_raw: fifo.remaining_raw.toString(),
        realized_usd: fifo.realized_usd_cents === null ? null : usdString(fifo.realized_usd_cents),
        realized_status: fifo.realized_status,
        events_summary: summary,
      },
    });
  }
  gaps.add("exited_positions_not_scanned");
  gaps.add("mdd_pending"); // MDD needs stored NAV snapshots (SPEC §4); nothing is stored in v0

  // Held first, then the largest USD mark (unpriced after priced), then by symbol. NVDA's place is earned like any other.
  const heldRank = (p: (typeof perToken)[number]) => (BigInt(p.facts.raw) > 0n ? 0 : 1);
  perToken.sort((a, b) => {
    if (heldRank(a) !== heldRank(b)) return heldRank(a) - heldRank(b);
    if (a.usdCents !== b.usdCents) {
      if (a.usdCents === null) return 1;
      if (b.usdCents === null) return -1;
      return a.usdCents > b.usdCents ? -1 : 1;
    }
    return a.facts.symbol.localeCompare(b.facts.symbol);
  });

  const summary = summarize(events);
  const realizedParts = perToken.map((p) => p.fifo.realized_usd_cents).filter((c): c is bigint => c !== null);
  const realized = realizedParts.length === 0 ? null : realizedParts.reduce((s, c) => s + c, 0n);
  const heldParts = perToken.filter((p) => BigInt(p.facts.raw) > 0n);
  const unrealized = heldParts.length > 0 && heldParts.every((p) => p.usdCents !== null) ? heldParts.reduce((s, p) => s + p.usdCents!, 0n) : null;
  const unknownCost = perToken.reduce((s, p) => s + p.fifo.unknown_cost_raw, 0n);

  return {
    address,
    chain_id: RWA_CHAIN_ID,
    as_of: new Date(input.blockTimestamp * 1000).toISOString(),
    as_of_block: input.block,
    method_version: METHOD_VERSION,
    identity_binding: "unknown",
    r0: "present",
    r1_status: r1Status(summary, unknownCost),
    r2: "no_declaration",
    scope: {
      registry_taken_at: REGISTRY.taken_at,
      registry_tokens: CANONICAL_TOKENS.length,
      registry_source: REGISTRY.sources.tokens_page,
      scanned: [...states.values()].map((s) => tokenByAddress(s.token)!.symbol).sort(),
      rule: SCOPE_RULE,
    },
    tokens: perToken.map((p) => p.facts),
    events_summary: summary,
    realized_usd: realized === null ? null : usdString(realized),
    realized_status: aggregateStatus(perToken.map((p) => p.fifo.realized_status)),
    unrealized_usd: unrealized === null ? null : usdString(unrealized),
    mdd_usd: null,
    gaps: [...gaps],
    evidence: { txs: [...new Set(events.map((e) => e.tx))], fixture_ids: input.fixtureIds ?? ["A"] },
    disclaimer: DISCLAIMER,
  };
}

/** Canonical tokens that `receipts` moved to or from `address`. */
function canonicalTokensMoved(receipts: RwaReceipt[], address: string): Set<string> {
  const me = address.toLowerCase();
  const out = new Set<string>();
  for (const r of receipts) {
    for (const log of r.logs) {
      const token = log.address.toLowerCase();
      if (!CANONICAL_SET.has(token) || log.topics[0] !== TOPICS.transfer || log.topics.length < 3) continue;
      if (topicToAddress(log.topics[1]) === me || topicToAddress(log.topics[2]) === me) out.add(token);
    }
  }
  return out;
}

/**
 * Live reconstruction at `block` (default head). Reads every canonical balance,
 * then walks the history of each token in scope, one token after another (the
 * public RPC refuses multi-address log filters and throttles bursts).
 */
export async function reconstructFacts(address: string, opts: RpcOptions & { block?: number } = {}): Promise<RwaFacts> {
  const block = opts.block ?? (await fetchHead(opts));
  // One read at a time, with longer retries: the public RPC answers 429 to bursts (measured 2026-09-18).
  const patient: RpcOptions = { retries: 5, ...opts };
  const balances = await readBalances(CANONICAL_TOKENS.map((t) => t.token), address, block, patient);
  const scope = new Set<string>([NVDA.token.toLowerCase(), ...[...balances].filter(([, raw]) => raw > 0n).map(([t]) => t)]);

  const scanned = new Set<string>();
  const txs = new Set<string>();
  const receiptsByTx = new Map<string, RwaReceipt>();
  // Two rounds: tokens in scope, then any canonical token their transactions moved for the address.
  for (let round = 0; round < 2; round++) {
    const toScan = [...scope].filter((t) => !scanned.has(t));
    if (toScan.length === 0) break;
    for (const token of toScan) {
      // One token at a time with a pause: bursts of log batches drew 429s and ~48 s of backoff (measured 2026-09-29).
      if (scanned.size > 0) await (opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(1_000);
      scanned.add(token);
      for (const l of await fetchCanonicalTransfers(token, address, block, patient)) txs.add(l.transactionHash);
    }
    const missing = [...txs].filter((h) => !receiptsByTx.has(h));
    for (const r of await fetchReceipts(missing, patient, 25)) receiptsByTx.set(r.transactionHash, r);
    for (const t of canonicalTokensMoved([...receiptsByTx.values()], address)) scope.add(t);
  }
  // A token found only in the last round is read for its state but its own history was not walked;
  // its events come from the receipts already fetched, and the replay check will say if that was not enough.
  for (const t of scope) scanned.add(t);

  const receipts = [...receiptsByTx.values()];
  if (receipts.length === 0 && ![...balances.values()].some((raw) => raw > 0n)) throw new NoStockTokenActivity();

  const states: TokenState[] = [];
  for (const t of scanned) {
    const info = tokenByAddress(t)!;
    states.push(await readTokenState(info.token, info.feed, address, block, patient));
  }
  const blockTimestamp = await fetchBlockTimestamp(block, patient);
  return assembleFacts({ address, block, blockTimestamp, receipts, states, resolver: chainPoolResolver(patient), fixtureIds: ["A", "B"] });
}
