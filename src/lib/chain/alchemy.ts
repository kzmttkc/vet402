import { DEFAULT_CHAIN_ID, chainById } from "./chains";
import { createDeadline } from "@/lib/util/deadline";
import type { Address } from "viem";

/**
 * Alchemy `alchemy_getAssetTransfers` — the transfer-history source that can
 * actually answer for a busy wallet.
 *
 * WHY THIS EXISTS (measured 2026-08-13). The payee engine could not return a
 * real verdict for high-activity wallets because no public Blockscout endpoint
 * would serve their history. Same address (0xd8dA…6045, vitalik.eth, 37,157
 * transactions on Base), same 100-transfer window, three providers, three
 * attempts each:
 *
 *   base.blockscout.com v1 (with BLOCKSCOUT_API_KEY)   429 / 429 / 429
 *   api.blockscout.com/8453 gateway (with API key)     500 / 500 / 500  (server-side query timeout)
 *   Alchemy alchemy_getAssetTransfers                  200 / 200 / 200  in 1,310 / 2,200 / 1,510ms
 *
 * The Blockscout key does not help: v1 answers three back-to-back requests and
 * then penalty-boxes the client, and the gateway times the query out inside
 * its own planner. Alchemy answers the same question from an index that was
 * built for it.
 *
 * WHAT THIS DOES NOT CHANGE. Nothing here softens a verdict. A read that does
 * not complete throws, the caller still names the missing signal in
 * `signalsUnavailable`, a partially-measured wallet is still capped below
 * ALLOW and a fully-unread one is still a fail-closed BLOCK. This module only
 * removes an outage Vouch was manufacturing by asking a provider that could
 * not answer.
 *
 * ONE ASSET PER CALL, DELIBERATELY. `category` accepts ["external","erc20"] in
 * a single request, and the ETH and USDC legs could therefore share one round
 * trip. They do not, because the legs are assessed INDEPENDENTLY on purpose
 * (see detectDrainPattern): on 2026-08-13 Blockscout served the USDC leg while
 * the native leg answered HTTP 500 on 10 of 10 requests, and the engine was
 * changed that day to keep the leg that DID answer rather than throw both
 * away. Sharing a request would make every failure a double failure and undo
 * that. The combined form IS used where the question is genuinely one question
 * — a wallet's first activity on this chain (fetchAlchemyHistoryHead).
 */

/** Same row shape Blockscout's readers produce, so callers' arithmetic is
 *  unchanged and only the source differs. Structurally identical on purpose. */
export type ChainTransfer = {
  hash: string;
  blockNumber: string;
  timeStamp: string;
  from: string;
  to: string;
  value: string;
};

export class AlchemyUnavailableError extends Error {
  /** True when repeating the same request has a real chance of succeeding. */
  readonly retryable: boolean;

  constructor(message = "alchemy_unavailable", cause?: unknown, retryable = false) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "AlchemyUnavailableError";
    this.retryable = retryable;
  }
}

export type AssetCategory = "external" | "erc20";

/** Alchemy network slug per chain id. Only chains we can actually serve. */
const ALCHEMY_NETWORKS: Record<number, string> = {
  8453: "base-mainnet",
  1: "eth-mainnet",
};

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 300;
const DEFAULT_BUDGET_MS = 5_000;

const REQUEST_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  Accept: "application/json",
  // Same courtesy as the Blockscout reader: a verification service reading
  // someone else's API should be identifiable by them.
  "User-Agent": "vet402-verifier/0.1 (+https://vet402.com)",
};

function apiKey(): string | undefined {
  const raw = process.env.ALCHEMY_API_KEY;
  return raw && raw.trim() !== "" ? raw.trim() : undefined;
}

/**
 * Endpoint for this chain, or null when Alchemy cannot serve it here.
 *
 * `ALCHEMY_API_URL` is an ops escape hatch (and the seam tests stub against);
 * it only applies to the default chain, exactly like BLOCKSCOUT_API_URL.
 */
export function alchemyUrl(chainId?: number): string | null {
  const id = chainId ?? DEFAULT_CHAIN_ID;
  const override = process.env.ALCHEMY_API_URL?.trim();
  if (override && id === DEFAULT_CHAIN_ID) return override;
  const network = ALCHEMY_NETWORKS[id];
  const key = apiKey();
  if (!network || !key) return null;
  // A chain we do not have in the registry is not a chain we score.
  if (!chainById(id)) return null;
  return `https://${network}.g.alchemy.com/v2/${key}`;
}

/** True when a read through this module is worth attempting at all. */
export function isAlchemyEnabled(chainId?: number): boolean {
  return alchemyUrl(chainId) !== null;
}

export function alchemyBudgetMs(fallback = DEFAULT_BUDGET_MS): number {
  const raw = process.env.ALCHEMY_BUDGET_MS;
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

function budgetSignal(budgetMs?: number): AbortSignal | undefined {
  if (budgetMs === undefined || !Number.isFinite(budgetMs)) return undefined;
  return AbortSignal.timeout(Math.max(1, budgetMs));
}

type RawTransfer = {
  uniqueId?: string;
  hash?: string;
  blockNum?: string;
  from?: string | null;
  to?: string | null;
  category?: string;
  rawContract?: { value?: string | null; address?: string | null; decimal?: string | null } | null;
  metadata?: { blockTimestamp?: string | null } | null;
};

type TransferPage = { transfers: RawTransfer[]; pageKey?: string };

export type TransferQuery = {
  address: Address;
  /** `to` = inflow to the address, `from` = outflow from it. */
  direction: "to" | "from";
  categories: AssetCategory[];
  /** Restrict ERC-20 results to one token. Ignored for a native-only query. */
  contractAddress?: Address;
  /** Rows requested, Alchemy's `maxCount` (hard max 1000). */
  limit: number;
  order: "asc" | "desc";
  chainId?: number;
  budgetMs?: number;
};

/**
 * Rows enriched with what the caller needs to tell one asset from another.
 * `value` is the RAW smallest-unit amount (wei for ETH, 6-decimal units for
 * USDC), taken from `rawContract.value`. The top-level `value` Alchemy returns
 * is a JSON float and would silently lose precision on large amounts — the
 * drain ratio is computed in BigInt for exactly that reason.
 */
export type CategorizedTransfer = ChainTransfer & {
  category: string;
  uniqueId: string;
};

function hexToDecimalString(hex: string | undefined | null): string {
  if (!hex) return "0";
  try {
    return BigInt(hex).toString();
  } catch {
    return "0";
  }
}

function toEpochSeconds(iso: string | undefined | null): string {
  if (!iso) return "0";
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? String(Math.floor(ms / 1000)) : "0";
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function toTransfer(raw: RawTransfer): CategorizedTransfer | null {
  const from = raw.from;
  if (!from) return null;
  return {
    hash: raw.hash ?? "",
    blockNumber: hexToDecimalString(raw.blockNum),
    timeStamp: toEpochSeconds(raw.metadata?.blockTimestamp),
    from,
    // A contract creation has no `to`. It moves value OUT of the wallet, so
    // dropping it would understate outflow — the fail-open direction on a
    // drain ratio. Counted against the burn address instead.
    to: raw.to ?? ZERO_ADDRESS,
    value: hexToDecimalString(raw.rawContract?.value),
    category: raw.category ?? "unknown",
    uniqueId: raw.uniqueId ?? `${raw.hash ?? ""}:${raw.category ?? ""}:${raw.to ?? ""}`,
  };
}

async function rpcOnce(url: string, params: unknown, budgetMs?: number): Promise<TransferPage> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: REQUEST_HEADERS,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "alchemy_getAssetTransfers",
        params: [params],
      }),
      signal: budgetSignal(budgetMs),
      next: { revalidate: 0 },
    });
  } catch (error) {
    // An abort is the caller's own budget firing: retrying would have nothing
    // left to run in. A socket-level blip is worth one more try.
    if (isAbortError(error)) throw new AlchemyUnavailableError("alchemy_timeout", error, false);
    throw new AlchemyUnavailableError("alchemy_network_error", error, true);
  }

  if (!response.ok) {
    throw new AlchemyUnavailableError(
      `alchemy_http_${response.status}`,
      undefined,
      response.status === 429 || response.status >= 500,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new AlchemyUnavailableError("alchemy_invalid_json", error);
  }

  const envelope = body as { result?: unknown; error?: { message?: string; code?: number } };
  if (envelope?.error) {
    const code = envelope.error.code;
    throw new AlchemyUnavailableError(
      `alchemy_rpc_error:${envelope.error.message ?? code ?? "unknown"}`,
      undefined,
      // -32000 is Alchemy's generic server-side error; the rest are our request
      // being wrong, and repeating a wrong request changes nothing.
      code === -32000,
    );
  }

  const result = envelope?.result as TransferPage | undefined;
  // A 200 whose body is not the shape we asked for is a read we did not
  // complete — never an empty history. The same asymmetry cost the Blockscout
  // v2 reader a silent "this wallet has moved nothing" (see
  // blockscout_v2_bad_shape), and it must not be reintroduced here: an empty
  // transfer list means no outflow, which means no drain ratio, which scores
  // near-neutral with no `*_unavailable` flag anywhere.
  if (!result || typeof result !== "object" || !Array.isArray(result.transfers)) {
    throw new AlchemyUnavailableError("alchemy_bad_shape");
  }
  return result;
}

async function rpc(url: string, params: unknown, budgetMs?: number): Promise<TransferPage> {
  let lastError: unknown;
  // The budget bounds the RETRIES too, not just each attempt.
  const deadline = createDeadline(budgetMs);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await rpcOnce(url, params, budgetMs === undefined ? undefined : deadline.remaining());
    } catch (error) {
      lastError = error;
      const retryable = error instanceof AlchemyUnavailableError && error.retryable;
      if (!retryable || attempt === MAX_ATTEMPTS) break;
      const delay = RETRY_BASE_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * RETRY_BASE_MS);
      if (deadline.remaining() <= delay) break;
      await sleep(delay);
    }
  }
  throw lastError;
}

/** Alchemy's `maxCount` ceiling. */
const MAX_COUNT = 1_000;

/**
 * One directional page of asset transfers. Throws when the read did not
 * complete — a caller must never mistake a refusal for an empty history.
 */
export async function fetchAssetTransfers(query: TransferQuery): Promise<CategorizedTransfer[]> {
  return (await fetchAssetTransfersPage(query)).transfers;
}

/**
 * fetchAssetTransfers with Alchemy's `pageKey`: one page, and the key for the next one (null on the last page).
 * `rawCount` is the rows Alchemy returned before toTransfer dropped any. Throws when the read did not complete.
 */
export async function fetchAssetTransfersPage(
  query: TransferQuery & { pageKey?: string | null },
): Promise<{ transfers: CategorizedTransfer[]; rawCount: number; pageKey: string | null }> {
  const url = alchemyUrl(query.chainId);
  if (!url) throw new AlchemyUnavailableError("alchemy_not_configured");

  const params: Record<string, unknown> = {
    fromBlock: "0x0",
    toBlock: "latest",
    category: query.categories,
    withMetadata: true,
    maxCount: `0x${Math.min(Math.max(1, query.limit), MAX_COUNT).toString(16)}`,
    order: query.order,
  };
  params[query.direction === "to" ? "toAddress" : "fromAddress"] = query.address;
  if (query.contractAddress && query.categories.includes("erc20")) {
    params.contractAddresses = [query.contractAddress];
  }
  if (query.pageKey) params.pageKey = query.pageKey;

  const page = await rpc(url, params, query.budgetMs);
  const out: CategorizedTransfer[] = [];
  for (const raw of page.transfers) {
    const transfer = toTransfer(raw);
    if (transfer) out.push(transfer);
  }
  return { transfers: out, rawCount: page.transfers.length, pageKey: typeof page.pageKey === "string" && page.pageKey !== "" ? page.pageKey : null };
}

/**
 * The most recent `limit` transfers of ONE asset class, both directions.
 *
 * WHY TWO REQUESTS AND NOT ONE. `alchemy_getAssetTransfers` filters on
 * `fromAddress` OR `toAddress`, never "either", so a both-directions window is
 * inherently two reads. They run in parallel and BOTH must succeed: a missing
 * outflow page understates the drain numerator (fail-OPEN) and a missing
 * inflow page erases the `incomingCount > 0` gate the ratio is conditioned on.
 * Half a window is not a smaller window, it is a wrong one.
 *
 * The merged list is sorted newest-first and truncated to `limit`, so this is
 * the SAME window the Blockscout readers produce — the 100 most recent
 * transfers regardless of direction — and the drain arithmetic downstream is
 * byte-for-byte the arithmetic it was tested against.
 *
 * Deduplicated by `uniqueId` so a self-transfer (which appears in both
 * directions) is counted once, exactly as it appears once in a Blockscout row.
 */
export async function fetchAlchemyTransferWindow(
  address: Address,
  options: {
    categories: AssetCategory[];
    contractAddress?: Address;
    limit?: number;
    chainId?: number;
    budgetMs?: number;
  },
): Promise<ChainTransfer[]> {
  const limit = options.limit ?? 100;
  const deadline = createDeadline(options.budgetMs);
  const common = {
    address,
    categories: options.categories,
    contractAddress: options.contractAddress,
    limit,
    order: "desc" as const,
    chainId: options.chainId,
  };
  const [incoming, outgoing] = await Promise.all([
    fetchAssetTransfers({
      ...common,
      direction: "to",
      budgetMs: options.budgetMs === undefined ? undefined : deadline.remaining(),
    }),
    fetchAssetTransfers({
      ...common,
      direction: "from",
      budgetMs: options.budgetMs === undefined ? undefined : deadline.remaining(),
    }),
  ]);

  const merged = new Map<string, CategorizedTransfer>();
  for (const transfer of [...incoming, ...outgoing]) {
    if (!merged.has(transfer.uniqueId)) merged.set(transfer.uniqueId, transfer);
  }

  return [...merged.values()]
    .sort((a, b) => {
      const delta = BigInt(b.blockNumber || "0") - BigInt(a.blockNumber || "0");
      return delta > 0n ? 1 : delta < 0n ? -1 : 0;
    })
    .slice(0, limit)
    .map(({ hash, blockNumber, timeStamp, from, to, value }) => ({
      hash,
      blockNumber,
      timeStamp,
      from,
      to,
      value,
    }));
}

/**
 * Everything fetchWalletMetrics needs about a wallet's history: how old it is,
 * who funded it, and roughly how busy it has been.
 *
 * THREE READS, IN PARALLEL, and each one answers a different question:
 *
 *   1. oldest OUTGOING transfer (external + erc20, ascending)
 *   2. oldest INCOMING transfers (external + erc20, ascending, up to `limit`)
 *   3. oldest INCOMING NATIVE transfers (external only, ascending)
 *
 * (1) and (2) together give the wallet's first activity on this chain, and (2)
 * gives the activity count. (3) exists because the FUNDER must keep its exact
 * meaning: `fetchFirstIncomingTransfer` — the read the funder index is built
 * from — takes the oldest incoming transfer with a non-zero NATIVE value, and
 * a funder derived from a different rule would be looked up in an index keyed
 * by the old one. A cluster lookup that silently misses is the fail-open
 * direction, so the rule is preserved rather than improved.
 *
 * HOW THIS DIFFERS FROM THE BLOCKSCOUT WALK, HONESTLY. Blockscout's `txlist`
 * counts transactions, including 0-value contract calls; Alchemy counts
 * transfers of value. So a wallet whose activity is entirely 0-value contract
 * interaction reads as YOUNGER and LESS active here than it did there. That is
 * the conservative direction (a lower wallet score, never a higher one), and
 * an empty result falls through to the Blockscout walk in wallet-metrics
 * rather than being served as "no history".
 */
export type AlchemyHistoryHead = {
  /** Unix seconds of the wallet's oldest transfer, or null when it has none. */
  firstTxTimestamp: number | null;
  /** Oldest incoming NATIVE value transfer — who funded this wallet. */
  incoming: { funder: Address; blockNumber: bigint; timestamp: number } | null;
  /** Distinct transactions touching this wallet, self-transfers excluded,
   *  capped at `limit`. A floor, not an exact total — see above. */
  nonSelfTxCount: number;
  /** True when no transfer of any kind was found in either direction. */
  empty: boolean;
};

export async function fetchAlchemyHistoryHead(
  address: Address,
  options: { limit?: number; chainId?: number; budgetMs?: number } = {},
): Promise<AlchemyHistoryHead> {
  const limit = options.limit ?? 100;
  const deadline = createDeadline(options.budgetMs);
  const budget = () => (options.budgetMs === undefined ? undefined : deadline.remaining());
  const both: AssetCategory[] = ["external", "erc20"];

  const [outgoing, incoming, nativeIncoming] = await Promise.all([
    fetchAssetTransfers({
      address,
      direction: "from",
      categories: both,
      limit,
      order: "asc",
      chainId: options.chainId,
      budgetMs: budget(),
    }),
    fetchAssetTransfers({
      address,
      direction: "to",
      categories: both,
      limit,
      order: "asc",
      chainId: options.chainId,
      budgetMs: budget(),
    }),
    fetchAssetTransfers({
      address,
      direction: "to",
      categories: ["external"],
      limit: 10,
      order: "asc",
      chainId: options.chainId,
      budgetMs: budget(),
    }),
  ]);

  const timestamps = [outgoing[0], incoming[0]]
    .map((transfer) => (transfer ? Number(transfer.timeStamp) : 0))
    .filter((seconds) => Number.isFinite(seconds) && seconds > 0);
  const firstTxTimestamp = timestamps.length > 0 ? Math.min(...timestamps) : null;

  const addressLower = address.toLowerCase();
  const funding = nativeIncoming.find(
    (transfer) => transfer.to.toLowerCase() === addressLower && BigInt(transfer.value || "0") > 0n,
  );

  // Distinct TRANSACTIONS, not transfers: several ERC-20 movements can share a
  // hash, and Blockscout's count treated them as the one transaction they are.
  const hashes = new Set<string>();
  for (const transfer of [...incoming, ...outgoing]) {
    const from = transfer.from.toLowerCase();
    const to = transfer.to.toLowerCase();
    // Self-transfers still excluded, so a wallet cannot inflate its activity
    // by paying gas to itself.
    if (from === addressLower && to === addressLower) continue;
    if (transfer.hash) hashes.add(transfer.hash);
  }

  return {
    firstTxTimestamp,
    incoming: funding
      ? {
          funder: funding.from as Address,
          blockNumber: BigInt(funding.blockNumber || "0"),
          timestamp: Number(funding.timeStamp),
        }
      : null,
    nonSelfTxCount: Math.min(hashes.size, limit),
    empty: incoming.length === 0 && outgoing.length === 0,
  };
}
