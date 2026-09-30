// Finding the look-alikes a wallet met, and saying how far the search went (SPEC patch 021).
//
// The judgement is packages/rwa/lookalike.ts. This module gathers the ERC-20
// transfers to and from the wallet that are not canonical Stock Tokens, reads
// each token's symbol, name and code hash, and keeps the ones judged to be
// look-alikes. Nothing here feeds the PnL: the record's classifier only reads
// canonical addresses, and every entry carries `counted: false`.
//
// Where the transfers come from, best first:
//   1. Alchemy's Transfers API, when RWA_ALCHEMY_URL is set: every ERC-20
//      transfer to and from the wallet up to as_of_block.
//   2. Otherwise, three partial sources, each named in `lookalikes_scope`:
//      - receipts: the transactions the record already read
//      - recent_logs: Transfer logs with the wallet as sender or recipient over
//        the last RECENT_SPANS x 30,000 blocks, one query at a time (the public RPC allows 30,000
//        blocks per query without an address filter; the whole chain took
//        about 5,000 queries and 55 minutes on 2026-09-30)
//      - fixture: a full-history search done ahead of time for one wallet
//        (fixtures/rwa/lookalikes-*.json), with its source and last block
//   Anything outside those ranges is written as not scanned.
import { decodeFunctionResult, getAddress, keccak256, parseAbi } from "viem";
import { AlchemyError, alchemyRefused, alchemyUrl, getAddressTransferPages, type AlchemyPrefetch } from "./alchemy";
import type { RwaReceipt } from "./classify";
import { USDG, WETH } from "./config";
import { TOPICS, topicToAddress } from "./events";
import { escapeVisible, judgeToken, mimickedCounterparty, sortReasons, type LookalikeReason } from "./lookalike";
import { CANONICAL_SET } from "./registry";
import { hex, padAddress, rpcBatch, type RpcOptions } from "./rpc";
import demoFixture from "../../fixtures/rwa/lookalikes-demo.json";

export type LookalikeSource = "alchemy" | "receipts" | "recent_logs" | "fixture";

export type LookalikeFact = {
  /** EIP-55 */
  token: string;
  /** the on-chain symbol with every non-ASCII code point shown as ⟨U+XXXX⟩ */
  symbol_raw: string;
  name_raw: string;
  /** the canonical ticker or "USDG" it pretends to be */
  imitates: string | null;
  reasons: LookalikeReason[];
  /** the Stock Token proxy code outside Robinhood's list: not called a fake, left for a human */
  needs_review: boolean;
  /** "received": the wallet is the recipient. "sent": a log names the wallet as sender (a fake transfer the wallet never signed looks like this) */
  direction: "received" | "sent";
  /** the other side of the first transfer seen */
  counterparty: string;
  /** the real counterparty the transfer was addressed to look like (address poisoning), or null */
  mimics: string | null;
  first_seen_block: number;
  tx: string;
  /** raw units of the first transfer seen, as the log states it */
  amount_raw: string;
  transfers_seen: number;
  counted: false;
  found_by: LookalikeSource;
};

export type LookalikesScope = {
  /** true only when every ERC-20 transfer to and from the wallet up to as_of_block was read */
  complete: boolean;
  searched: { source: LookalikeSource; from_block: number | null; to_block: number | null; detail: string }[];
  /** plain words for each part not searched; empty when complete */
  not_scanned: string[];
  /** distinct non-canonical tokens whose symbol, name and code were read and judged */
  tokens_judged: number;
  /** distinct non-canonical tokens met but not judged (over the cap, or unreadable) */
  tokens_not_judged: number;
};

export type Lookalikes = { lookalikes: LookalikeFact[]; lookalikes_scope: LookalikesScope };

/** What a record says when no search ran (an offline fixture, or a failed search). */
export function notScanned(reason: string): Lookalikes {
  return { lookalikes: [], lookalikes_scope: { complete: false, searched: [], not_scanned: [reason], tokens_judged: 0, tokens_not_judged: 0 } };
}

export type SeenTransfer = {
  token: string;
  from: string;
  to: string;
  block: number;
  tx: string;
  log_index: number;
  amount_raw: string;
  found_by: LookalikeSource;
};

export type TokenMeta = { symbol: string | null; name: string | null; codeHash: string | null };

/** Tokens never worth an RPC read here: canonical Stock Tokens, the real USDG and WETH. */
function skip(token: string): boolean {
  const t = token.toLowerCase();
  return CANONICAL_SET.has(t) || t === USDG.toLowerCase() || t === WETH.toLowerCase();
}

/** Non-canonical Transfer logs in the record's own receipts that name the wallet. */
export function transfersFromReceipts(receipts: RwaReceipt[], address: string): SeenTransfer[] {
  const me = address.toLowerCase();
  const out: SeenTransfer[] = [];
  for (const r of receipts)
    for (const l of r.logs) {
      if (l.topics[0] !== TOPICS.transfer || l.topics.length !== 3 || skip(l.address)) continue;
      const from = topicToAddress(l.topics[1]);
      const to = topicToAddress(l.topics[2]);
      if (from !== me && to !== me) continue;
      out.push({ token: l.address.toLowerCase(), from, to, block: r.blockNumber, tx: r.transactionHash, log_index: l.logIndex, amount_raw: BigInt(l.data.length > 2 ? l.data.slice(0, 66) : "0x0").toString(), found_by: "receipts" });
    }
  return out;
}

/** Addresses the wallet really paid or was paid by in USDG: what an address-poisoning transfer copies. */
export function usdgCounterparties(transfers: { token: string; from: string; to: string }[], address: string): string[] {
  const me = address.toLowerCase();
  const out = new Set<string>();
  for (const t of transfers) {
    if (t.token.toLowerCase() !== USDG.toLowerCase()) continue;
    if (t.from === me && t.to !== me) out.add(t.to);
    if (t.to === me && t.from !== me) out.add(t.from);
  }
  return [...out];
}

/** Pure: group transfers by token, judge each token, keep look-alikes and needs-review tokens. */
export function buildLookalikes(transfers: SeenTransfer[], meta: ReadonlyMap<string, TokenMeta>, address: string, counterparties: string[]): LookalikeFact[] {
  const me = address.toLowerCase();
  const byToken = new Map<string, SeenTransfer[]>();
  for (const t of transfers) {
    const k = t.token.toLowerCase();
    if (skip(k)) continue;
    (byToken.get(k) ?? byToken.set(k, []).get(k)!).push(t);
  }
  const out: LookalikeFact[] = [];
  for (const [token, list] of byToken) {
    const m = meta.get(token);
    if (!m) continue;
    const j = judgeToken({ address: token, symbol: m.symbol, name: m.name, codeHash: m.codeHash });
    if (!j.lookalike && !j.needs_review) continue;
    // One entry per (tx, log): the same log can arrive from two sources.
    const uniq = [...new Map(list.map((t) => [`${t.tx}:${t.log_index}`, t])).values()].sort((a, b) => a.block - b.block || a.log_index - b.log_index);
    const first = uniq[0];
    const direction = first.to === me ? "received" : "sent";
    const counterparty = direction === "received" ? first.from : first.to;
    let mimics: string | null = null;
    for (const t of uniq) {
      const other = t.to === me ? t.from : t.to;
      mimics = mimickedCounterparty(other, counterparties);
      if (mimics) break;
    }
    const reasons: LookalikeReason[] = mimics ? sortReasons([...j.reasons, "mimics_counterparty"]) : j.reasons;
    out.push({
      token: getAddress(token),
      symbol_raw: escapeVisible(m.symbol ?? ""),
      name_raw: escapeVisible(m.name ?? ""),
      imitates: j.imitates,
      reasons,
      needs_review: j.needs_review,
      direction,
      counterparty,
      mimics,
      first_seen_block: first.block,
      tx: first.tx,
      amount_raw: first.amount_raw,
      transfers_seen: uniq.length,
      counted: false,
      found_by: first.found_by,
    });
  }
  return out.sort((a, b) => a.first_seen_block - b.first_seen_block);
}

// ---- the demo fixture -------------------------------------------------------

export type LookalikeFixture = {
  address: string;
  source: string;
  scanned_from_block: number;
  scanned_to_block: number;
  metadata_read_at_block: number;
  /** every non-canonical token met in the search (lower-cased), look-alike or not */
  tokens_seen: string[];
  counterparties: string[];
  tokens: Record<string, TokenMeta>;
  transfers: Omit<SeenTransfer, "found_by">[];
};

/** Wallets with a full-history search frozen ahead of time (fixtures/rwa/lookalikes-*.json). */
const FIXTURES: readonly LookalikeFixture[] = [demoFixture as LookalikeFixture];

export function fixtureFor(address: string): LookalikeFixture | null {
  return FIXTURES.find((f) => f.address.toLowerCase() === address.toLowerCase()) ?? null;
}

// ---- live search ------------------------------------------------------------

/** 30,000 blocks is the public RPC's cap for a log query without an address (measured 2026-09-30). */
export const RECENT_SPAN_BLOCKS = 30_000;
/** Spans per side in the no-key search: 4 x 30,000 = 120,000 blocks, about 3.3 hours at the 2026-09-30 rate of ~1M blocks per 28 hours. */
export const RECENT_SPANS = 4;
/** Distinct tokens read and judged per record. */
export const MAX_TOKENS_JUDGED = 30;
/** Wall time the search may take before it stops and says so (the record's own deadline is 45 s). */
export const LOOKALIKE_BUDGET_MS = 8_000;

const erc20 = parseAbi(["function symbol() view returns (string)", "function name() view returns (string)"]);

function decodeText(fn: "symbol" | "name", data: string | null): string | null {
  if (!data || data === "0x") return null;
  try {
    return decodeFunctionResult({ abi: erc20, functionName: fn, data: data as `0x${string}` }) as string;
  } catch {
    // Some tokens return bytes32.
    if (data.length === 66) {
      const bytes = Buffer.from(data.slice(2), "hex");
      const s = bytes.toString("utf8").replace(/\u0000+$/, "");
      return s || null;
    }
    return null;
  }
}

export async function readTokenMeta(tokens: string[], block: number, opts: RpcOptions): Promise<Map<string, TokenMeta>> {
  const out = new Map<string, TokenMeta>();
  const tag = hex(block);
  for (let i = 0; i < tokens.length; i += 5) {
    const chunk = tokens.slice(i, i + 5);
    const calls = chunk.flatMap((t) => [
      { method: "eth_getCode", params: [t, tag] },
      { method: "eth_call", params: [{ to: t, data: "0x95d89b41" }, tag] },
      { method: "eth_call", params: [{ to: t, data: "0x06fdde03" }, tag] },
    ]);
    // eth_call can revert for a token without symbol()/name(); read each item on its own when the batch fails.
    let res: (string | null)[];
    try {
      res = await rpcBatch<string>(calls, opts);
    } catch {
      res = [];
      for (const c of calls) res.push(await rpcBatch<string>([c], opts).then((r) => r[0]).catch(() => null));
    }
    chunk.forEach((t, j) => {
      const code = res[3 * j];
      out.set(t, {
        codeHash: code && code !== "0x" ? keccak256(code as `0x${string}`) : null,
        symbol: decodeText("symbol", res[3 * j + 1]),
        name: decodeText("name", res[3 * j + 2]),
      });
    });
  }
  return out;
}

export type RawLog = { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string; logIndex: string };

export function fromRawLog(l: RawLog, found_by: LookalikeSource): SeenTransfer {
  return {
    token: l.address.toLowerCase(),
    from: topicToAddress(l.topics[1]),
    to: topicToAddress(l.topics[2]),
    block: Number(BigInt(l.blockNumber)),
    tx: l.transactionHash,
    log_index: Number(BigInt(l.logIndex)),
    amount_raw: BigInt(l.data.length > 2 ? l.data.slice(0, 66) : "0x0").toString(),
    found_by,
  };
}

export type ScanOptions = RpcOptions & {
  fixture?: LookalikeFixture | null;
  /** the Alchemy endpoint (a test seam too); `prefetched` is the transfer list the record's discovery already read */
  alchemy?: { url: string; fetchImpl?: typeof fetch; prefetched?: AlchemyPrefetch } | null;
  budgetMs?: number;
  now?: () => number;
};

/**
 * The live search for one record. Never throws: a failed step is written into the scope.
 * `receipts` are the transactions the record already read.
 */
export async function scanLookalikes(address: string, block: number, receipts: RwaReceipt[], opts: ScanOptions = {}): Promise<Lookalikes> {
  const me = address.toLowerCase();
  const now = opts.now ?? Date.now;
  const started = now();
  const budget = opts.budgetMs ?? LOOKALIKE_BUDGET_MS;
  const rpc: RpcOptions = { retries: 2, timeoutMs: 5_000, ...opts };
  // A hard stop: the record waits for this search, and the record has its own deadline.
  const withinBudget = <T,>(p: Promise<T>): Promise<T> => {
    const left = budget - (now() - started);
    if (left <= 0) return Promise.reject(new Error("budget"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("budget")), left);
    });
    return Promise.race([p, stop]).finally(() => clearTimeout(timer));
  };
  const searched: LookalikesScope["searched"] = [];
  const notes: string[] = [];
  let transfers: SeenTransfer[] = [];
  let complete = false;

  const alchemy = opts.alchemy !== undefined ? opts.alchemy : alchemyUrl() && !alchemyRefused() ? { url: alchemyUrl()! } : null;
  if (alchemy) {
    try {
      const pre = alchemy.prefetched;
      if (pre && "failed" in pre) throw new AlchemyError(pre.failed);
      const got =
        pre ??
        (await withinBudget(
          getAddressTransferPages(me, { toBlock: hex(block), category: ["erc20"], maxPages: 10 }, { url: alchemy.url, fetchImpl: alchemy.fetchImpl, retries: 1, timeoutMs: 5_000, sleep: opts.sleep }),
        ));
      for (const t of got.transfers) {
        if (!t.rawContract?.address || !t.to || !t.blockNum) continue;
        const logIndex = Number(/:log:(\d+)$/.exec(t.uniqueId)?.[1] ?? "0");
        transfers.push({ token: t.rawContract.address.toLowerCase(), from: t.from.toLowerCase(), to: t.to.toLowerCase(), block: Number(BigInt(t.blockNum)), tx: t.hash, log_index: logIndex, amount_raw: BigInt(t.rawContract.value ?? "0x0").toString(), found_by: "alchemy" });
      }
      complete = got.complete;
      searched.push({ source: "alchemy", from_block: 0, to_block: block, detail: complete ? "every ERC-20 transfer to and from the wallet (alchemy_getAssetTransfers)" : "alchemy_getAssetTransfers stopped at its page cap" });
      if (!complete) notes.push("transfers past Alchemy's page cap");
    } catch (err) {
      notes.push(`Alchemy search failed (${err instanceof AlchemyError ? err.message : "too slow"}), so the public RPC was used`);
      transfers = [];
    }
  }

  if (!complete) {
    transfers.push(...transfersFromReceipts(receipts, me));
    searched.push({ source: "receipts", from_block: null, to_block: block, detail: `the ${receipts.length} transactions this record read` });

    // Recent window, newest span first, one query at a time. The public RPC refuses a batch of these
    // queries as a whole but answers single ones spaced a few hundred ms apart (measured 2026-09-30:
    // 7 of 8 single queries answered at 0.3 s spacing, 2 of 4 batches of two). The window covers the
    // spans read without a break from the head down, and says where it stopped.
    const window = { from: block + 1, spans: 0, why: "the public RPC refused or was too slow" };
    const quick: RpcOptions = { ...rpc, retries: 2, sleep: (ms) => (opts.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t))))(Math.min(ms, 700)) };
    for (let i = 0; i < RECENT_SPANS; i++) {
      const to = block - i * RECENT_SPAN_BLOCKS;
      if (to < 0) break;
      const from = Math.max(0, to - RECENT_SPAN_BLOCKS + 1);
      try {
        const got: RawLog[] = [];
        for (const topics of [[TOPICS.transfer, padAddress(me)], [TOPICS.transfer, null, padAddress(me)]]) {
          const [logs] = await withinBudget(rpcBatch<RawLog[]>([{ method: "eth_getLogs", params: [{ topics, fromBlock: hex(from), toBlock: hex(to) }] }], quick));
          got.push(...logs);
        }
        for (const l of got) {
          if (l.topics.length !== 3) continue;
          // USDG logs are kept too: they name the wallet's real counterparties.
          if (!skip(l.address) || l.address.toLowerCase() === USDG.toLowerCase()) transfers.push(fromRawLog(l, "recent_logs"));
        }
        window.from = from;
        window.spans++;
      } catch (err) {
        if ((err as Error)?.message === "budget") window.why = "no time was left inside the record's deadline";
        break;
      }
    }
    const recentRead = window.spans > 0;
    const lo = recentRead ? window.from : block + 1;
    if (recentRead)
      searched.push({ source: "recent_logs", from_block: lo, to_block: block, detail: `Transfer logs naming the wallet, no address filter, ${window.spans} x ${RECENT_SPAN_BLOCKS} blocks` });
    const fx = opts.fixture && opts.fixture.address.toLowerCase() === me ? opts.fixture : null;
    if (fx) {
      const upTo = Math.min(fx.scanned_to_block, block);
      for (const t of fx.transfers) if (t.block <= upTo) transfers.push({ ...t, found_by: "fixture" });
      searched.push({ source: "fixture", from_block: fx.scanned_from_block, to_block: upTo, detail: fx.source });
    }
    // Full coverage without an indexer: the fixture reaches from genesis to where the recent window starts.
    const joined = !!fx && fx.scanned_from_block === 0 && fx.scanned_to_block + 1 >= lo;
    if (joined) complete = true;
    else {
      if (lo > 0) {
        const gapFrom = fx ? Math.min(fx.scanned_to_block, block) + 1 : 0;
        notes.push(`ERC-20 transfers in blocks ${gapFrom}-${lo - 1}, outside the transactions this record read`);
      }
      if (window.spans < RECENT_SPANS && block - window.spans * RECENT_SPAN_BLOCKS >= 0)
        notes.push(
          recentRead
            ? `the recent window stopped at block ${lo} after ${window.spans} of ${RECENT_SPANS} spans: ${window.why}`
            : `the recent window (the last ${RECENT_SPANS * RECENT_SPAN_BLOCKS} blocks) could not be read: ${window.why}`,
        );
    }
  }

  // Judge every non-canonical token met, up to the cap. Fixture tokens bring their own metadata.
  const fx = opts.fixture && opts.fixture.address.toLowerCase() === me ? opts.fixture : null;
  const meta = new Map<string, TokenMeta>(fx ? Object.entries(fx.tokens).map(([k, v]) => [k.toLowerCase(), v]) : []);
  const distinct = [...new Set(transfers.map((t) => t.token))].filter((t) => !skip(t));
  const toRead = distinct.filter((t) => !meta.has(t)).slice(0, MAX_TOKENS_JUDGED);
  if (toRead.length > 0) {
    try {
      for (const [k, v] of await withinBudget(readTokenMeta(toRead, block, rpc))) meta.set(k, v);
    } catch (err) {
      notes.push((err as Error)?.message === "budget" ? "token names could not be read: no time was left inside the record's deadline" : "token names could not be read: the public RPC refused or was too slow");
    }
  }
  const judged = distinct.filter((t) => meta.has(t)).length;
  const counterparties = [...new Set([...usdgCounterparties(transfers, me), ...(fx?.counterparties ?? [])])];
  const lookalikes = buildLookalikes(transfers, meta, me, counterparties);
  if (distinct.length > judged) notes.push(`${distinct.length - judged} tokens met but not judged`);
  return {
    lookalikes,
    lookalikes_scope: {
      complete: complete && distinct.length === judged,
      searched,
      not_scanned: notes,
      tokens_judged: judged,
      tokens_not_judged: distinct.length - judged,
    },
  };
}
