// Minimal JSON-RPC client for Robinhood Chain (SPEC §9).
//
// The public RPC answers 429 under load and caps eth_getLogs at 10,000 matches.
// This client retries with backoff, batches calls, and falls back to the one
// configured secondary URL only when the primary fails. The primary is chosen
// at call time by rwaRpcUrl() (config.ts, SPEC patch 020). It has no dependency
// so packages/rwa can run under tsx, in a route handler, and in scripts alike.
import { RWA_RPC_FALLBACK_URL, rwaNonAlchemyRpcUrl, rwaRpcUrl } from "./config";

export type JsonRpcCall = { method: string; params: unknown[] };

export class RpcError extends Error {
  /** the provider refused the key (401/403, "network not enabled"): the next URL is tried, this one is not retried */
  readonly refused: boolean;
  constructor(message: string, readonly method: string, readonly code?: number, refused = false) {
    super(message);
    this.name = "RpcError";
    this.refused = refused;
  }
}

/** A provider's own words can quote the URL, and the URL can carry a key. Only the words stay. */
const redact = (msg: string) => msg.replace(/https?:\/\/\S+/gi, "<url>").replace(/\/v2\/[A-Za-z0-9_-]+/g, "/v2/<key>");

/** JSON-RPC errors that mean the key or the network is refused, not that the call is wrong (Alchemy's wording). */
const REFUSED_RPC_ERROR = /not enabled|must be authenticated|unauthori[sz]ed|invalid api key|forbidden/i;

/** How long a refused URL stays out of the default list. */
export const REFUSED_URL_TTL_MS = 10 * 60_000;
const refusedUrls = new Map<string, number>();

/** True while `url` has been refused within REFUSED_URL_TTL_MS. */
export function urlRefused(url: string, now: number = Date.now()): boolean {
  const at = refusedUrls.get(url);
  return at !== undefined && now - at < REFUSED_URL_TTL_MS;
}

export function noteRefused(url: string, now: number = Date.now()): void {
  refusedUrls.set(url, now);
}

export function __resetRefusedUrlsForTest(): void {
  refusedUrls.clear();
}

/** The default URLs: the primary unless refused lately, then the non-Alchemy primary, then the fallback for head reads. */
function defaultUrls(calls: JsonRpcCall[]): string[] {
  const primary = rwaRpcUrl();
  const plain = rwaNonAlchemyRpcUrl();
  const urls = primary === plain ? [plain] : urlRefused(primary) ? [plain] : [primary, plain];
  if (calls.every((c) => FALLBACK_SAFE_METHODS.has(c.method))) urls.push(RWA_RPC_FALLBACK_URL);
  return urls;
}

/** Methods the fallback RPC can actually serve. It has no archive state (measured
 *  2026-09-23: "Archive requests require a personal token"), so a historical
 *  eth_call, a receipt or a log range sent there fails with a misleading error.
 *  Everything else stays on the primary and retries there instead. */
const FALLBACK_SAFE_METHODS = new Set(["eth_blockNumber", "eth_chainId"]);

export type RpcOptions = {
  urls?: string[];
  /** retries per URL on 429 / network failure */
  retries?: number;
  timeoutMs?: number;
  /** test seam: replaces global fetch */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

/** JSON-RPC error messages that mean "the node behind the gateway was slow", not "the request is wrong". */
const TRANSIENT_RPC_ERROR = /deadline exceeded|try again|temporarily unavailable/i;
/** The public RPC rate-limits items inside a batch: one item errors "Too Many Requests" while its
 *  neighbours answer (measured 2026-09-29 reading 195 balances). That is a transport condition,
 *  retried with backoff like an HTTP 429, not a bad call. */
const RATE_LIMITED_ITEM = /^too many requests$|rate limit exceeded|exceeded .*rate limit/i;
const MAX_TRANSIENT_RETRIES = 2;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type RpcResponse = { id: number; result?: unknown; error?: { code?: number; message?: string } };

async function post(url: string, body: unknown, timeoutMs: number, fetchImpl: typeof fetch): Promise<RpcResponse[] | RpcResponse> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } catch (err) {
      // The primary URL may carry a provider key (SPEC patch 020). A transport error can quote the
      // URL ("Failed to parse URL from …"), so only its name leaves this function.
      throw new RpcError(`transport ${err instanceof Error ? err.name : "error"}`, "batch");
    }
    if (res.status === 401 || res.status === 403) throw new RpcError(`HTTP ${res.status}`, "batch", res.status, true);
    if (res.status === 429 || res.status >= 500) throw new RpcError(`HTTP ${res.status}`, "batch", res.status);
    return (await res.json()) as RpcResponse[] | RpcResponse;
  } finally {
    clearTimeout(timer);
  }
}

/** Send `calls` as one JSON-RPC batch. Returns results in order; throws RpcError on the first error entry. */
export async function rpcBatch<T = unknown>(calls: JsonRpcCall[], opts: RpcOptions = {}): Promise<T[]> {
  if (calls.length === 0) return [];
  const urls = opts.urls ?? defaultUrls(calls);
  const retries = opts.retries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const body = calls.map((c, i) => ({ jsonrpc: "2.0", id: i, method: c.method, params: c.params }));

  let lastError: unknown;
  for (const url of urls) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const raw = await post(url, calls.length === 1 ? body[0] : body, timeoutMs, fetchImpl);
        const list = Array.isArray(raw) ? raw : [raw];
        const byId = new Map(list.map((r) => [r.id, r]));
        return calls.map((c, i) => {
          const r = byId.get(i);
          if (!r) throw new RpcError("missing response", c.method);
          if (r.error) {
            const msg = redact(r.error.message ?? "rpc error");
            throw new RpcError(msg, c.method, r.error.code, REFUSED_RPC_ERROR.test(msg));
          }
          return r.result as T;
        });
      } catch (err) {
        lastError = err;
        if (err instanceof RpcError && err.refused) {
          // The key is refused here: remember it and go to the next URL without retrying this one.
          noteRefused(url);
          break;
        }
        if (err instanceof RpcError && err.method !== "batch" && !RATE_LIMITED_ITEM.test(err.message)) {
          // A JSON-RPC level error (bad params, log cap) is not a transport failure: do not retry or fall back.
          // The exception is the gateway's own upstream timeout ("context deadline exceeded", measured
          // 2026-09-18): the same call succeeds a moment later, so it gets a short, bounded retry.
          if (!TRANSIENT_RPC_ERROR.test(err.message) || attempt >= Math.min(retries, MAX_TRANSIENT_RETRIES)) throw err;
        }
        if (attempt < retries) await sleep(1_000 * 2 ** attempt);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new RpcError(String(lastError), "batch");
}

export async function rpcCall<T = unknown>(method: string, params: unknown[], opts?: RpcOptions): Promise<T> {
  const [r] = await rpcBatch<T>([{ method, params }], opts);
  return r;
}

export const hex = (n: number | bigint) => `0x${n.toString(16)}`;
export const word = (data: string, i: number) => BigInt(`0x${data.slice(2 + 64 * i, 2 + 64 * (i + 1))}`);
export const padAddress = (addr: string) => `0x000000000000000000000000${addr.slice(2).toLowerCase()}`;
