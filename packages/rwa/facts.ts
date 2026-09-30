// Public facts of one address (SPEC §5, §7). No opinion field, ever.
//
// rwa-recon-0.2 (SPEC patch 018): every canonical Stock Token in Robinhood's
// asset list (packages/rwa/registry.ts), not only NVDA. Scope, stated in the
// record itself: the tokens the address holds at `as_of`, NVDA, and any
// canonical token those tokens' transactions moved for the address. A position
// opened and fully closed in some other token is not scanned on the public
// path, and the record says so (`exited_positions_not_scanned`) instead of
// implying it was.
//
// rwa-recon-0.3 (SPEC patches 020 to 023): with Alchemy, every canonical token
// the address ever moved is in scope and that gap drops; the record lists the
// look-alikes the wallet met (`lookalikes`, never counted) and the corporate
// actions of each token (`corporate_actions`); the anchor hash binds the whole
// record (hash material v2).
import { AlchemyError, alchemyRefused, getAddressTransferPages, getAddressTransfers, type AlchemyPrefetch, type AssetTransfer } from "./alchemy";
import { fetchBlockTimestamp, fetchCanonicalTransfers, fetchHead, fetchReceipts, fetchTransfersIn, fetchTransfersOut, readAccount } from "./chain";
import { classifyReceipt, summarize, type EventsSummary, type PoolResolver, type RwaEvent, type RwaReceipt } from "./classify";
import { NVDA, RWA_CHAIN_ID, rwaAlchemyUrl } from "./config";
import { corporateActionsFor, expectedMultiplier, readMultiplierUpdates, type CorporateAction, type TimedMultiplierUpdate } from "./corporate";
import { TOPICS, topicToAddress } from "./events";
import { feedStatus, isWeekendUtc, readBalances, readTokenState, type TokenState } from "./feed";
import { fixtureFor, LOOKALIKE_BUDGET_MS, notScanned, scanLookalikes, type LookalikeFact, type Lookalikes, type LookalikesScope } from "./lookalike-scan";
import { runFifo, type FifoResult, type PricedEvent, type RealizedStatus } from "./fifo";
import { chainPoolResolver } from "./pools";
import { quoteForSwap } from "./quote";
import { CANONICAL_SET, CANONICAL_TOKENS, REGISTRY, tokenByAddress } from "./registry";
import type { RpcOptions } from "./rpc";
import { markUsdCents } from "./usd";

export const METHOD_VERSION = "rwa-recon-0.3";
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
  /**
   * SPEC patch 022: every UIMultiplierUpdated the token emitted up to as_of_block,
   * read from genesis, with what this wallet held at each one (held:false kept).
   * Absent only in a record assembled without multiplier logs (the frozen fixture A).
   */
  corporate_actions?: CorporateAction[];
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
    /** tokens whose own transfer history was walked */
    scanned: string[];
    /** tokens met in the walked transactions whose own history was not walked (state read, events from those receipts only) */
    history_not_walked: string[];
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
  /**
   * Tokens that copy a Stock Token or USDG, met in the wallet's transfers (SPEC patch 021).
   * Never counted: not in `tokens`, not in any USD figure, not in `evidence`.
   */
  lookalikes: LookalikeFact[];
  /** how far the look-alike search went, and what it did not search */
  lookalikes_scope: LookalikesScope;
  evidence: { txs: string[]; fixture_ids: string[] };
  disclaimer: string;
};

/**
 * What /rwa says about an address that holds no canonical Stock Token (SPEC patch 020).
 * Same shape and wording every time for the same block, so a judge who pastes a
 * fresh wallet twice reads the same answer. It states what was checked and what was not.
 */
export type NoActivityAnswer = {
  error: "no_stock_token_activity";
  address: string;
  chain_id: number;
  as_of: string;
  as_of_block: number;
  method_version: string;
  registry_tokens: number;
  held_tokens: 0;
  /** "every_canonical_token": every canonical token's transfers to and from the address were read
   *  (alchemy_getAssetTransfers). "nvda_only": today's balances of all of them, and NVDA's transfers in. */
  history_checked: "every_canonical_token" | "nvda_only";
  /** transactions this address has sent on Robinhood Chain (its nonce), null for a contract */
  sent_tx_count: number | null;
  is_contract: boolean;
  gaps: string[];
  detail: string;
};

export class NoStockTokenActivity extends Error {
  constructor(readonly answer?: NoActivityAnswer) {
    super("no_stock_token_activity");
    this.name = "NoStockTokenActivity";
  }
}

/**
 * A wallet too large for one request to rebuild (SPEC patch 020). The public RPC needs
 * 16 log queries per token, and a request has under a minute, so a wallet holding many
 * tokens would only ever time out. It gets this stable answer instead, with its holdings.
 */
export type TooLargeAnswer = {
  error: "wallet_too_large";
  address: string;
  chain_id: number;
  as_of_block: number;
  method_version: string;
  held_tokens: number;
  held: string[];
  /** what exceeded the budget: tokens to walk on the public RPC, or transactions to replay */
  limit: { kind: "tokens"; max: number; found: number } | { kind: "transactions"; max: number; found: number };
  detail: string;
};

/** Tokens a public-RPC request walks at most (16 log queries each); measured 2026-09-30: 2 tokens ~40 s, 8 tokens ~140 s. */
export const MAX_TOKENS_PUBLIC = 6;
/** Transactions an Alchemy-backed request replays at most (receipts, 25 per batch). */
export const MAX_TXS_ALCHEMY = 600;

export class WalletTooLarge extends Error {
  constructor(readonly answer: TooLargeAnswer) {
    super("wallet_too_large");
    this.name = "WalletTooLarge";
  }
}

function tooLarge(address: string, block: number, held: string[], limit: TooLargeAnswer["limit"]): WalletTooLarge {
  const symbols = held.map((t) => tokenByAddress(t)!.symbol).sort();
  const why =
    limit.kind === "tokens"
      ? `Rebuilding it means walking the history of ${limit.found} tokens, and one request can walk ${limit.max}.`
      : `Rebuilding it means replaying ${limit.found} transactions, and one request can replay ${limit.max}.`;
  return new WalletTooLarge({
    error: "wallet_too_large",
    address,
    chain_id: RWA_CHAIN_ID,
    as_of_block: block,
    method_version: METHOD_VERSION,
    held_tokens: symbols.length,
    held: symbols,
    limit,
    detail: `Holds ${symbols.length} of the ${CANONICAL_TOKENS.length} canonical Stock Tokens at block ${block}. ${why} It is not rebuilt.`,
  });
}

export function noActivityAnswer(input: {
  address: string;
  block: number;
  blockTimestamp: number;
  historyChecked: NoActivityAnswer["history_checked"];
  sentTxCount: number;
  isContract: boolean;
}): NoActivityAnswer {
  const n = CANONICAL_TOKENS.length;
  const full = input.historyChecked === "every_canonical_token";
  return {
    error: "no_stock_token_activity",
    address: input.address.toLowerCase(),
    chain_id: RWA_CHAIN_ID,
    as_of: new Date(input.blockTimestamp * 1000).toISOString(),
    as_of_block: input.block,
    method_version: METHOD_VERSION,
    registry_tokens: n,
    held_tokens: 0,
    history_checked: input.historyChecked,
    sent_tx_count: input.isContract ? null : input.sentTxCount,
    is_contract: input.isContract,
    gaps: full ? [] : ["exited_positions_not_scanned"],
    detail: full
      ? `Holds none of the ${n} canonical Stock Tokens at block ${input.block}. None of them moved to or from this address up to that block.`
      : `Holds none of the ${n} canonical Stock Tokens at block ${input.block}. NVDA was never transferred to this address. ` +
        `Positions in the other tokens that were opened and fully closed are not scanned.`,
  };
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

/**
 * SPEC §5: reconstructed needs a decodable history AND no cost-unknown lot left.
 * A balance the replayed events cannot explain is `unverified` (R1: the main
 * cause of the balance change is not explained); a sale no lot covered is `partial`.
 */
export function r1Status(summary: EventsSummary, unknownCostRaw: bigint, flags: { balanceMismatch?: boolean; oversold?: boolean } = {}): R1Status {
  if (flags.balanceMismatch) return "unverified";
  if (summary.other_unparsed > 0) return "partial";
  if (unknownCostRaw > 0n) return "partial";
  if (flags.oversold) return "partial";
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
  /** lower-cased tokens read for state but whose own history was not walked */
  historyNotWalked?: ReadonlySet<string>;
  /** the scope rule to state in the record (a fixture states its own) */
  scopeRule?: string;
  /** true when every canonical token that ever moved for the address was found (patch 020), so no exited position is left out */
  exitedScanned?: boolean;
  /** UIMultiplierUpdated logs of the tokens in scope, from genesis to `block`. Omitted: no corporate_actions field */
  multiplierUpdates?: TimedMultiplierUpdate[];
  /** the live read of those logs failed: the record carries no corporate_actions and says so in gaps */
  multiplierUpdatesFailed?: boolean;
  /** the look-alike search (packages/rwa/lookalike-scan.ts); default: none ran */
  lookalikes?: Lookalikes;
};

/** What an offline replay says about look-alikes: nothing was searched. */
export const NO_LOOKALIKE_SEARCH = "no look-alike search ran for this record (offline replay)";

const SCOPE_RULE = "held at as_of, plus NVDA, plus canonical tokens moved for the address in those tokens' transactions";
/** Patch 020: with RWA_ALCHEMY_URL set, the scope is every canonical token that ever moved for the address. */
export const SCOPE_RULE_ALL = "every canonical token moved to or from the address up to as_of (alchemy_getAssetTransfers), plus tokens held at as_of";
/** The look-alike search ends by this long after a live reconstruction starts, inside the 45 s deadline in cache.ts. */
export const LOOKALIKE_DEADLINE_MS = 38_000;
/** Discovery rounds before stopping; tokens still unwalked are listed in scope.history_not_walked. */
export const MAX_DISCOVERY_ROUNDS = 3;

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

    // SPEC patch 022. Display only: FIFO above ran on raw and USD and never sees these.
    let corporateActions: CorporateAction[] | undefined;
    if (input.multiplierUpdates) {
      const mine = input.multiplierUpdates.filter((u) => u.token === t);
      corporateActions = corporateActionsFor(mine, tokenEvents, !(input.historyNotWalked ?? new Set()).has(t));
      // The logs must explain the multiplier the token reports now; if not, an update was missed.
      const expected = expectedMultiplier(mine, input.blockTimestamp);
      if (expected !== null && expected !== state.uiMultiplier) gaps.add("multiplier_history_mismatch");
    }

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
        ...(corporateActions ? { corporate_actions: corporateActions } : {}),
      },
    });
  }
  if (!input.exitedScanned) gaps.add("exited_positions_not_scanned");
  if (input.multiplierUpdatesFailed) gaps.add("corporate_actions_not_read");
  const notWalked = [...(input.historyNotWalked ?? [])].filter((t) => states.has(t));
  if (notWalked.length > 0) gaps.add("history_not_walked");
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
  // SPEC §4 (line "realized_usd を公開してよい条件"): R1 must be reconstructed or partial. A balance
  // the replay cannot explain means a leg was missed, so FIFO may be matching the wrong lots: no
  // realized figure is published for the wallet, per token or in total.
  const unverified = gaps.has("balance_mismatch");
  if (unverified)
    for (const p of perToken) {
      p.facts.realized_usd = null;
      p.facts.realized_status = "partial";
    }
  const oversold = perToken.some((p) => p.fifo.oversold_raw > 0n);

  return {
    address,
    chain_id: RWA_CHAIN_ID,
    as_of: new Date(input.blockTimestamp * 1000).toISOString(),
    as_of_block: input.block,
    method_version: METHOD_VERSION,
    identity_binding: "unknown",
    r0: "present",
    r1_status: r1Status(summary, unknownCost, { balanceMismatch: gaps.has("balance_mismatch"), oversold }),
    r2: "no_declaration",
    scope: {
      registry_taken_at: REGISTRY.taken_at,
      registry_tokens: CANONICAL_TOKENS.length,
      registry_source: REGISTRY.sources.tokens_page,
      scanned: [...states.keys()].filter((t) => !notWalked.includes(t)).map((t) => tokenByAddress(t)!.symbol).sort(),
      history_not_walked: notWalked.map((t) => tokenByAddress(t)!.symbol).sort(),
      rule: input.scopeRule ?? SCOPE_RULE,
    },
    tokens: perToken.map((p) => p.facts),
    events_summary: summary,
    realized_usd: unverified || realized === null ? null : usdString(realized),
    realized_status: unverified ? "partial" : aggregateStatus(perToken.map((p) => p.fifo.realized_status)),
    unrealized_usd: unrealized === null ? null : usdString(unrealized),
    mdd_usd: null,
    gaps: [...gaps],
    lookalikes: (input.lookalikes ?? notScanned(NO_LOOKALIKE_SEARCH)).lookalikes,
    lookalikes_scope: (input.lookalikes ?? notScanned(NO_LOOKALIKE_SEARCH)).lookalikes_scope,
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

export type ReconstructOptions = RpcOptions & {
  block?: number;
  /** test seam: the Alchemy URL. Default rwaAlchemyUrl(); null forces the public-RPC path. */
  alchemyUrl?: string | null;
  /** Epoch ms by which the look-alike search must end, on top of LOOKALIKE_DEADLINE_MS. The paid
   *  lane counts it from the request's start, so a slow search cannot push settle past its own limit. */
  lookalikeEndBy?: number;
};

type Discovery = { txs: Set<string>; tokens: Set<string> };

/** Patch 020: every canonical token that moved to or from `address` up to `block`, and the transactions that moved it. */
async function discoverWithAlchemy(address: string, block: number, url: string, opts: RpcOptions): Promise<Discovery> {
  const transfers = await getAddressTransfers(address, { contractAddresses: CANONICAL_TOKENS.map((t) => t.token), toBlock: block, category: ["erc20"] }, { ...opts, url });
  return discoveryFrom(transfers);
}

/** The canonical tokens in `transfers` and the transactions that moved them. */
function discoveryFrom(transfers: AssetTransfer[]): Discovery {
  const txs = new Set<string>();
  const tokens = new Set<string>();
  for (const t of transfers) {
    const token = t.rawContract?.address?.toLowerCase();
    if (!token || !CANONICAL_SET.has(token) || !t.hash) continue;
    txs.add(t.hash.toLowerCase());
    tokens.add(token);
  }
  return { txs, tokens };
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Live reconstruction at `block` (default head). Reads every canonical balance in
 * one Multicall3 call, then finds the transactions to replay:
 *
 * - with RWA_ALCHEMY_URL (patch 020): alchemy_getAssetTransfers over all canonical
 *   tokens, both sides, so tokens the address sold out of are in scope too;
 * - without it: the history of each token in scope, one token after another (the
 *   public RPC refuses multi-address log filters and throttles bursts).
 *
 * An address that holds none of them gets NoStockTokenActivity with an answer that
 * says what was checked. On the public path that costs NVDA's receiving side only.
 */
export async function reconstructFacts(address: string, opts: ReconstructOptions = {}): Promise<RwaFacts> {
  const started = Date.now();
  const me = address.toLowerCase();
  const block = opts.block ?? (await fetchHead(opts));
  // One read at a time, with longer retries: the public RPC answers 429 to bursts (measured 2026-09-18).
  const patient: RpcOptions = { retries: 5, ...opts };
  const pause = opts.sleep ?? defaultSleep;
  const balances = await readBalances(CANONICAL_TOKENS.map((t) => t.token), me, block, patient);
  const held = [...balances].filter(([, raw]) => raw > 0n).map(([t]) => t);

  const empty = async (historyChecked: NoActivityAnswer["history_checked"]) => {
    const acct = await readAccount(me, block, patient);
    return new NoStockTokenActivity(
      noActivityAnswer({ address: me, block, blockTimestamp: acct.blockTimestamp, historyChecked, sentTxCount: acct.sentTxCount, isContract: acct.isContract }),
    );
  };

  const alchemyUrl = opts.alchemyUrl === undefined ? (alchemyRefused() ? null : rwaAlchemyUrl()) : opts.alchemyUrl;
  let found: Discovery | null = null;
  let shared: AlchemyPrefetch | null = null;
  if (alchemyUrl) {
    try {
      // One read of every ERC-20 transfer to and from the address serves both the discovery here
      // and the look-alike search at the end. Past its page cap, discovery asks again with the
      // canonical contracts as a filter.
      const all = await getAddressTransferPages(me, { toBlock: block, category: ["erc20"] }, { ...opts, url: alchemyUrl });
      shared = { transfers: all.transfers, complete: all.complete };
      found = all.complete ? discoveryFrom(all.transfers) : await discoverWithAlchemy(me, block, alchemyUrl, opts);
    } catch (err) {
      // The log walk below still answers, and the record states its narrower scope and the gap.
      // A refused key (401/403, network not enabled) is remembered, so the next records skip Alchemy.
      if (shared === null) shared = { failed: err instanceof AlchemyError ? err.message : "alchemy error" };
      found = null;
    }
  }

  const scanned = new Set<string>();
  const receiptsByTx = new Map<string, RwaReceipt>();
  let notWalked = new Set<string>();
  if (found) {
    if (held.length === 0 && found.txs.size === 0) throw await empty("every_canonical_token");
    if (found.txs.size > MAX_TXS_ALCHEMY) throw tooLarge(me, block, held, { kind: "transactions", max: MAX_TXS_ALCHEMY, found: found.txs.size });
    for (const t of [...found.tokens, ...held]) scanned.add(t);
    for (const r of await fetchReceipts([...found.txs], patient, 25)) receiptsByTx.set(r.transactionHash, r);
  } else {
    const nvda = NVDA.token.toLowerCase();
    // Holding none of them: first ask only whether NVDA was ever paid to this address (8 log ranges, not 16).
    let nvdaIn: { transactionHash: string }[] | null = null;
    if (held.length === 0) {
      nvdaIn = await fetchTransfersIn(nvda, me, block, patient);
      if (nvdaIn.length === 0) throw await empty("nvda_only");
    }
    const scope = new Set<string>([nvda, ...held]);
    if (scope.size > MAX_TOKENS_PUBLIC) throw tooLarge(me, block, held, { kind: "tokens", max: MAX_TOKENS_PUBLIC, found: scope.size });
    const txs = new Set<string>();
    // Walk tokens in scope, then any canonical token their transactions moved for the address, until
    // nothing new turns up or the round cap is reached (each round costs a full history walk per token).
    for (let round = 0; round < MAX_DISCOVERY_ROUNDS; round++) {
      const toScan = [...scope].filter((t) => !scanned.has(t));
      if (toScan.length === 0) break;
      for (const token of toScan) {
        // One token at a time with a pause: bursts of log batches drew 429s and ~48 s of backoff (measured 2026-09-29).
        if (scanned.size > 0) await pause(1_000);
        scanned.add(token);
        const logs =
          token === nvda && nvdaIn
            ? [...nvdaIn, ...(await fetchTransfersOut(token, me, block, patient))]
            : await fetchCanonicalTransfers(token, me, block, patient);
        for (const l of logs) txs.add(l.transactionHash);
      }
      const missing = [...txs].filter((h) => !receiptsByTx.has(h));
      for (const r of await fetchReceipts(missing, patient, 25)) receiptsByTx.set(r.transactionHash, r);
      for (const t of canonicalTokensMoved([...receiptsByTx.values()], me)) scope.add(t);
    }
    // A token still unwalked after the cap is read for its state and named in scope.history_not_walked
    // (gap `history_not_walked`); its events come only from the receipts already fetched.
    notWalked = new Set([...scope].filter((t) => !scanned.has(t)));
  }

  const receipts = [...receiptsByTx.values()];
  if (receipts.length === 0 && held.length === 0) throw await empty(found ? "every_canonical_token" : "nvda_only");

  const states: TokenState[] = [];
  for (const t of [...scanned, ...notWalked]) {
    const info = tokenByAddress(t)!;
    states.push(await readTokenState(info.token, info.feed, me, block, patient));
  }
  const blockTimestamp = await fetchBlockTimestamp(block, patient);
  // Corporate actions of every token in the record (SPEC patch 022): the frozen walk plus one tail read per token.
  // They are display only, so a failed read costs the section, not the record: it is named in gaps instead.
  let multiplierUpdates: TimedMultiplierUpdate[] | undefined;
  try {
    multiplierUpdates = await readMultiplierUpdates([...scanned, ...notWalked], block, patient);
  } catch {
    multiplierUpdates = undefined;
  }
  const facts = await assembleFacts({
    address: me,
    block,
    blockTimestamp,
    receipts,
    states,
    resolver: chainPoolResolver(patient),
    fixtureIds: ["A", "B"],
    historyNotWalked: notWalked,
    scopeRule: found ? SCOPE_RULE_ALL : undefined,
    exitedScanned: !!found,
    multiplierUpdates,
    multiplierUpdatesFailed: multiplierUpdates === undefined,
  });
  // The look-alike search runs last, after every read the record needs (pool lookups included), so it
  // never competes with them for the public RPC's rate limit. Its budget shrinks when those reads were
  // slow, so it ends by LOOKALIKE_DEADLINE_MS after the start, or by opts.lookalikeEndBy if that is sooner.
  // It never fails the record. A search cut short says so in lookalikes_scope.not_scanned.
  // With Alchemy it reuses the transfer list the discovery above already read (one pair of calls, not two).
  const now = Date.now();
  const budgetMs = Math.max(0, Math.min(LOOKALIKE_BUDGET_MS, LOOKALIKE_DEADLINE_MS - (now - started), (opts.lookalikeEndBy ?? Infinity) - now));
  const lookalikes = await scanLookalikes(me, block, receipts, {
    ...opts,
    fixture: fixtureFor(me),
    budgetMs,
    alchemy: alchemyUrl ? { url: alchemyUrl, fetchImpl: opts.fetchImpl, prefetched: shared ?? undefined } : null,
  }).catch(() => notScanned("the look-alike search failed, so nothing was searched"));
  // Overwriting the two keys keeps their place in the document (before `evidence`).
  return { ...facts, lookalikes: lookalikes.lookalikes, lookalikes_scope: lookalikes.lookalikes_scope };
}
