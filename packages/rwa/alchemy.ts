// A thin client for the two Alchemy enhanced APIs /rwa uses on Robinhood Chain
// (SPEC patches 020 and 021).
//
// alchemy_getAssetTransfers answers "which tokens ever moved to or from this
// address" in a few calls, where the public RPC needs 16 eth_getLogs per token.
// The record uses it twice from one read: to find every canonical Stock Token the
// address ever moved (patch 020), and to list the look-alikes it met (patch 021).
// alchemy_getTokenBalances reads balances by contract.
//
// The endpoint comes from config.ts (rwaAlchemyUrl): RWA_ALCHEMY_URL, else
// ALCHEMY_API_KEY on Alchemy's Robinhood Chain mainnet host, else none. Without one
// every call throws AlchemyNotConfigured and callers keep the public-RPC path.
//
// The URL carries the key. It is passed to fetch and nowhere else. Every error
// thrown here is an AlchemyError that names the method and an HTTP status or a
// JSON-RPC code, nothing more: no URL, no provider message, no response body.
// A 401/403 or a "network not enabled" answer is an AlchemyRefused, remembered for
// a while so the next records go straight to the public path.
//
// Request and response shapes follow Alchemy's public docs for
// alchemy_getAssetTransfers and alchemy_getTokenBalances.
import { rwaAlchemyUrl } from "./config";
import { hex, rpcCall, RpcError, urlRefused, type RpcOptions } from "./rpc";

export class AlchemyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlchemyError";
  }
}

export class AlchemyNotConfigured extends AlchemyError {
  constructor() {
    super("alchemy_not_configured: RWA_ALCHEMY_URL is not set and ALCHEMY_API_KEY is not set");
    this.name = "AlchemyNotConfigured";
  }
}

/** The key was refused (401/403) or Robinhood Chain is not enabled for it. */
export class AlchemyRefused extends AlchemyError {
  constructor(method: string, readonly status: number | undefined) {
    super(`${method}: refused${status ? ` (HTTP ${status})` : ""}`);
    this.name = "AlchemyRefused";
  }
}

/** More transfers than a request can walk in its time budget: the caller says so rather than guessing. */
export class TooManyTransfers extends AlchemyError {
  constructor(readonly pages: number) {
    super("too_many_transfers");
    this.name = "TooManyTransfers";
  }
}

/** True while a recent refusal of the configured endpoint stands (rpc.ts keeps it for REFUSED_URL_TTL_MS).
 *  The record then takes the public path without asking Alchemy. */
export function alchemyRefused(now: number = Date.now()): boolean {
  const url = rwaAlchemyUrl();
  return url !== null && urlRefused(url, now);
}

/** The configured endpoint, or null. Read at call time so a test can set it. */
export function alchemyUrl(): string | null {
  return rwaAlchemyUrl();
}

export type AssetTransfer = {
  blockNum: string;
  uniqueId: string;
  hash: string;
  from: string;
  to: string | null;
  value: number | null;
  asset: string | null;
  category: string;
  rawContract: { value: string | null; address: string | null; decimal: string | null };
};

export type AssetTransfersOptions = {
  fromAddress?: string;
  toAddress?: string;
  /** any length: split into requests of CONTRACTS_PER_REQUEST. Omitted: every ERC-20 */
  contractAddresses?: readonly string[];
  /** default ["erc20"] */
  category?: string[];
  /** block number or hex; default 0 */
  fromBlock?: number | string;
  /** block number or hex; default "latest" */
  toBlock?: number | string;
  /** default false: a zero-value Transfer log is still a log the reconstruction reads */
  excludeZeroValue?: boolean;
  order?: "asc" | "desc";
  /** pages followed per contract chunk (1,000 transfers a page) */
  maxPages?: number;
};

export type AlchemyOptions = RpcOptions & { url?: string };

/** One read of both sides of an address, shared between discovery and the look-alike search. */
export type AlchemyPrefetch = { transfers: AssetTransfer[]; complete: boolean } | { failed: string };

/** Contract addresses sent per request. The 195 canonical tokens go in two requests. */
export const CONTRACTS_PER_REQUEST = 100;
export const DEFAULT_MAX_PAGES = 20;
const PAGE_SIZE = "0x3e8"; // 1,000, the documented maximum

function endpoint(opts: AlchemyOptions): RpcOptions {
  const url = opts.url ?? rwaAlchemyUrl();
  if (!url) throw new AlchemyNotConfigured();
  return { retries: 3, ...opts, urls: [url] };
}

/** One Alchemy call. Any failure leaves as an AlchemyError that carries only the method and a status or code. */
async function call<T>(method: string, params: unknown[], rpc: RpcOptions): Promise<T> {
  let res: T;
  try {
    res = await rpcCall<T>(method, params, rpc);
  } catch (err) {
    if (err instanceof RpcError && err.refused) throw new AlchemyRefused(method, err.method === "batch" ? err.code : undefined);
    if (err instanceof RpcError && err.code !== undefined) throw new AlchemyError(`${method}: ${err.method === "batch" ? "HTTP" : "JSON-RPC error"} ${err.code}`);
    throw new AlchemyError(`${method}: ${err instanceof RpcError && /^transport/.test(err.message) ? "network error" : "unreadable answer"}`);
  }
  if (res === null || typeof res !== "object") throw new AlchemyError(`${method}: unreadable answer`);
  return res;
}

const blockParam = (b: number | string | undefined, dflt: string) => (b === undefined ? dflt : typeof b === "number" ? hex(b) : b);

function chunks<T>(list: readonly T[] | undefined, size: number): (T[] | undefined)[] {
  if (!list) return [undefined];
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out.length > 0 ? out : [[]];
}

/**
 * Every transfer matching `q`, following pages up to `maxPages` per contract chunk.
 * `complete` is false when a chunk still had pages left at the cap.
 */
export async function getAssetTransferPages(
  q: AssetTransfersOptions,
  opts: AlchemyOptions = {},
): Promise<{ transfers: AssetTransfer[]; pages: number; complete: boolean }> {
  const rpc = endpoint(opts);
  const maxPages = q.maxPages ?? DEFAULT_MAX_PAGES;
  const transfers: AssetTransfer[] = [];
  let pages = 0;
  let complete = true;
  for (const contracts of chunks(q.contractAddresses, CONTRACTS_PER_REQUEST)) {
    if (contracts && contracts.length === 0) continue;
    let pageKey: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= maxPages) {
        complete = false;
        break;
      }
      const params: Record<string, unknown> = {
        fromBlock: blockParam(q.fromBlock, "0x0"),
        toBlock: blockParam(q.toBlock, "latest"),
        category: q.category ?? ["erc20"],
        excludeZeroValue: q.excludeZeroValue ?? false,
        withMetadata: false,
        maxCount: PAGE_SIZE,
        order: q.order ?? "asc",
      };
      if (q.fromAddress) params.fromAddress = q.fromAddress.toLowerCase();
      if (q.toAddress) params.toAddress = q.toAddress.toLowerCase();
      if (contracts) params.contractAddresses = contracts.map((c) => c.toLowerCase());
      if (pageKey) params.pageKey = pageKey;
      const res = await call<{ transfers?: AssetTransfer[]; pageKey?: string }>("alchemy_getAssetTransfers", [params], rpc);
      if (!Array.isArray(res.transfers)) throw new AlchemyError("alchemy_getAssetTransfers: unreadable answer");
      transfers.push(...res.transfers);
      pages++;
      if (!res.pageKey) break;
      pageKey = res.pageKey;
    }
  }
  return { transfers, pages, complete };
}

/** Every transfer matching `q`, all pages, all contract chunks. Past the page cap: TooManyTransfers. */
export async function getAssetTransfers(q: AssetTransfersOptions, opts: AlchemyOptions = {}): Promise<AssetTransfer[]> {
  const r = await getAssetTransferPages(q, opts);
  if (!r.complete) throw new TooManyTransfers(r.pages);
  return r.transfers;
}

export type TokenBalance = { contractAddress: string; /** null when Alchemy reported an error for this contract */ tokenBalance: bigint | null };

/**
 * Balances of `address`. With `contracts`, exactly those (split into requests of
 * CONTRACTS_PER_REQUEST); without, every ERC-20 Alchemy has seen it touch ("erc20"), all pages.
 */
export async function getTokenBalances(address: string, contracts?: readonly string[], opts: AlchemyOptions = {}): Promise<TokenBalance[]> {
  const rpc = endpoint(opts);
  type Answer = { tokenBalances?: { contractAddress: string; tokenBalance: string | null; error?: string | null }[]; pageKey?: string };
  const parse = (res: Answer): TokenBalance[] => {
    if (!Array.isArray(res.tokenBalances)) throw new AlchemyError("alchemy_getTokenBalances: unreadable answer");
    return res.tokenBalances.map((b) => ({
      contractAddress: b.contractAddress.toLowerCase(),
      tokenBalance: b.error || b.tokenBalance === null || b.tokenBalance === undefined ? null : BigInt(b.tokenBalance === "0x" ? "0x0" : b.tokenBalance),
    }));
  };
  const who = address.toLowerCase();
  const out: TokenBalance[] = [];
  if (contracts) {
    for (const c of chunks(contracts, CONTRACTS_PER_REQUEST)) {
      if (!c || c.length === 0) continue;
      out.push(...parse(await call<Answer>("alchemy_getTokenBalances", [who, c.map((x) => x.toLowerCase())], rpc)));
    }
    return out;
  }
  let pageKey: string | undefined;
  for (let page = 0; page < DEFAULT_MAX_PAGES; page++) {
    const res = await call<Answer>("alchemy_getTokenBalances", pageKey ? [who, "erc20", { pageKey }] : [who, "erc20"], rpc);
    out.push(...parse(res));
    if (!res.pageKey) return out;
    pageKey = res.pageKey;
  }
  throw new TooManyTransfers(DEFAULT_MAX_PAGES);
}

function dedupe(list: AssetTransfer[]): AssetTransfer[] {
  const seen = new Set<string>();
  const out: AssetTransfer[] = [];
  for (const t of list) {
    const key = t.uniqueId ?? `${t.hash}:${t.from}:${t.to}:${t.rawContract?.address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** Transfers to or from `address` (two queries, one per side, the sending side included), each transfer once. */
export async function getAddressTransferPages(
  address: string,
  q: Omit<AssetTransfersOptions, "fromAddress" | "toAddress"> = {},
  opts: AlchemyOptions = {},
): Promise<{ transfers: AssetTransfer[]; complete: boolean }> {
  const sent = await getAssetTransferPages({ ...q, fromAddress: address }, opts);
  const received = await getAssetTransferPages({ ...q, toAddress: address }, opts);
  return { transfers: dedupe([...sent.transfers, ...received.transfers]), complete: sent.complete && received.complete };
}

/** Transfers to or from `address`, all pages. Past the page cap: TooManyTransfers. */
export async function getAddressTransfers(
  address: string,
  q: Omit<AssetTransfersOptions, "fromAddress" | "toAddress"> = {},
  opts: AlchemyOptions = {},
): Promise<AssetTransfer[]> {
  const sent = await getAssetTransfers({ ...q, fromAddress: address }, opts);
  const received = await getAssetTransfers({ ...q, toAddress: address }, opts);
  return dedupe([...sent, ...received]);
}
