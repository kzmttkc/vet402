// Minimal JSON-RPC client for Robinhood Chain (SPEC §9).
//
// The public RPC answers 429 under load and caps eth_getLogs at 10,000 matches.
// This client retries with backoff, batches calls, and falls back to the one
// configured secondary URL only when the primary fails. It has no dependency
// so packages/rwa can run under tsx, in a route handler, and in scripts alike.
import { RWA_RPC_FALLBACK_URL, RWA_RPC_URL } from "./config";

export type JsonRpcCall = { method: string; params: unknown[] };

export class RpcError extends Error {
  constructor(message: string, readonly method: string, readonly code?: number) {
    super(message);
    this.name = "RpcError";
  }
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
const MAX_TRANSIENT_RETRIES = 2;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type RpcResponse = { id: number; result?: unknown; error?: { code?: number; message?: string } };

async function post(url: string, body: unknown, timeoutMs: number, fetchImpl: typeof fetch): Promise<RpcResponse[] | RpcResponse> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (res.status === 429 || res.status >= 500) throw new RpcError(`HTTP ${res.status}`, "batch", res.status);
    return (await res.json()) as RpcResponse[] | RpcResponse;
  } finally {
    clearTimeout(timer);
  }
}

/** Send `calls` as one JSON-RPC batch. Returns results in order; throws RpcError on the first error entry. */
export async function rpcBatch<T = unknown>(calls: JsonRpcCall[], opts: RpcOptions = {}): Promise<T[]> {
  if (calls.length === 0) return [];
  const urls =
    opts.urls ??
    (calls.every((c) => FALLBACK_SAFE_METHODS.has(c.method)) ? [RWA_RPC_URL, RWA_RPC_FALLBACK_URL] : [RWA_RPC_URL]);
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
          if (r.error) throw new RpcError(r.error.message ?? "rpc error", c.method, r.error.code);
          return r.result as T;
        });
      } catch (err) {
        lastError = err;
        if (err instanceof RpcError && err.method !== "batch") {
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
