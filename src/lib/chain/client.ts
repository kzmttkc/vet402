import { createPublicClient, http, type Address } from "viem";
import { base } from "viem/chains";
import { BASE_CHAIN_ID } from "./config";
import { DEFAULT_CHAIN_ID, chainById, rpcUrlFor } from "./chains";
import { getLogsWithFailover, logScanFallbackRpcUrls, type LogScanEndpoint } from "./log-scan-failover";

/**
 * Explicit transport timeouts and retry counts (2026-08-22 audit).
 *
 * These were left unspecified, so viem's defaults applied: a 10s timeout with
 * retryCount 3 — up to FOUR attempts, ~30s+ worst case on one RPC call. Every
 * other outbound path in this codebase states its own number (l0-probe 10s,
 * payee-engine 8s, the scoring engine's 3.5s per-signal budget), and this was
 * the one that inherited a default nobody had checked against them.
 *
 * LIVE reads (getPublicClient) serve requests. The scoring engine gives a
 * single signal SIGNAL_BUDGET_MS = 3,500ms out of a 6,000ms total
 * (scoring/engine.ts), and the live log read documented below already runs
 * under a 2.5s deadline. A transport allowed to spend 30s inside a 3.5s
 * budget is not a timeout, it is decoration — the deadline was always the
 * thing doing the work. 2.5s with a single retry keeps one transient blip
 * survivable while staying the same order of magnitude as the budget that
 * bounds it. Shortening this does NOT make verdicts harsher: a signal that
 * misses its budget was already degrading to `*_unavailable`.
 *
 * BATCH reads (getIndexerPublicClient) run in cron with a 300s maxDuration and
 * no user waiting. Measured 2026-08-12: 173 consecutive eth_getLogs chunks
 * covering 345,600 blocks in 24.8s, i.e. ~0.14s per chunk. 20s is ~140x that
 * — generous on purpose, because for a batch a retry is much cheaper than a
 * gap in the index, which is why this one keeps three of them.
 */
const LIVE_RPC_TIMEOUT_MS = 2_500;
const LIVE_RPC_RETRIES = 1;
const BATCH_RPC_TIMEOUT_MS = 20_000;
const BATCH_RPC_RETRIES = 3;

/**
 * Chain-aware since 2026-08-05 (C-8). No argument = Base, so every existing
 * caller keeps its exact behaviour. A non-Base chain id resolves through the
 * registry and THROWS when that chain is not enabled in this environment —
 * a read against the wrong chain must be impossible, not merely unlikely.
 */
export function getPublicClient(chainId: number = DEFAULT_CHAIN_ID) {
  const chain = chainById(chainId);
  if (!chain) {
    throw new Error(`unsupported_chain:${chainId}`);
  }
  const rpcUrl = rpcUrlFor(chain);
  if (!rpcUrl) {
    throw new Error(`chain_not_enabled:${chain.slug}`);
  }
  return createPublicClient({
    // Typed as the Base chain so the client's TYPE stays what every existing
    // caller (indexers included) was written against; the RUNTIME chain and
    // transport differ per registry entry. Safe because all callers use only
    // the chain-agnostic read surface (readContract / getBlockNumber /
    // getTransactionReceipt / getLogs).
    chain: chain.viemChain as typeof base,
    transport: http(rpcUrl, {
      timeout: LIVE_RPC_TIMEOUT_MS,
      retryCount: LIVE_RPC_RETRIES,
    }),
  });
}

/**
 * The endpoint that can actually serve eth_getLogs (2026-08-12).
 *
 * MEASURED, not assumed. On this deployment the live endpoint behind
 * BASE_RPC_URL rejects eth_getLogs outright — it answers
 * "JSON is not a valid request object." to a well-formed 680-block query,
 * before range or rate limits enter into it. The indexer endpoint answered
 * 173 consecutive chunks covering 345,600 blocks in 24.8s without a single
 * failure. Same request shape, same chain, opposite outcome.
 *
 * That is the deeper half of the 2026-08-12 scoring outage: the 7-day feedback
 * scan was not merely too many round-trips for a request budget, it was being
 * asked of an endpoint that does not answer this method at all. Moving the
 * scan to a nightly indexer fixed the volume; it would still have failed on
 * the residual live read if that read kept using the live endpoint.
 *
 * So a log read goes where logs are served, regardless of which path is
 * asking. This does not undo the separation below — that exists to keep BATCH
 * volume off the live endpoint's budget, and the only live caller here is a
 * bounded tail read (typically one chunk, hard-capped at two days of blocks
 * with a 2.5s deadline), not a batch.
 */
export function getLogScanClient(chainId: number = DEFAULT_CHAIN_ID) {
  // getIndexerPublicClient is Base-only by construction. Any other chain has
  // no indexer endpoint configured, so its live client is all there is.
  if (chainId === BASE_CHAIN_ID) return getIndexerPublicClient();
  return getPublicClient(chainId);
}

/**
 * Separate RPC endpoint for the batch indexers so they don't compete with live API traffic for the same app's CU/s budget.
 *
 * 2026-10-13: eth_getLogs だけは、主の読み先が答えないときに予備の読み先へ回す
 * （log-scan-failover.ts。Base の公開 RPC が 10/8 に getLogs を閉じ、読み先が 1 つしか
 * 無かったので 3 つの索引が 5 日止まった）。ほかの読み取り（getBlockNumber・
 * readContract・getBlock）は主の読み先のまま: 断られたのは getLogs だけで、
 * 予備の公開の読み先へ流す量は、要る分だけにする。
 * 返す client の `transport.url` は主の読み先のまま（chunked-logs が学んだ範囲の上限の
 * 鍵に使う。予備が言った上限もこの鍵に入るので、次の走査は最初からその幅で始まる）。
 */
export function getIndexerPublicClient() {
  const indexer = process.env.INDEXER_RPC_URL?.trim();
  const baseRpc = process.env.BASE_RPC_URL?.trim();
  const rpcUrl =
    (indexer && indexer.length > 0 ? indexer : null) ??
    (baseRpc && baseRpc.length > 0 ? baseRpc : null) ??
    "https://mainnet.base.org";
  const make = (url: string) =>
    createPublicClient({
      chain: base,
      transport: http(url, {
        timeout: BATCH_RPC_TIMEOUT_MS,
        retryCount: BATCH_RPC_RETRIES,
      }),
    });
  const primary = make(rpcUrl);
  const fallbackUrls = logScanFallbackRpcUrls().filter((url) => url !== rpcUrl);
  if (fallbackUrls.length === 0) return primary;

  type GetLogs = typeof primary.getLogs;
  type Args = Parameters<GetLogs>[0];
  type Result = Awaited<ReturnType<GetLogs>>;
  const endpoints: LogScanEndpoint<Args, Result>[] = [
    { key: rpcUrl, label: "primary", getLogs: (args) => primary.getLogs(args) },
    ...fallbackUrls.map((url, i) => {
      const client = make(url);
      return {
        key: url,
        label: `fallback-${i + 1}`,
        getLogs: (args: Args) => client.getLogs(args),
      };
    }),
  ];
  const getLogs = ((args: Args) => getLogsWithFailover(endpoints, args)) as GetLogs;
  return { ...primary, getLogs } as typeof primary;
}

export function isValidAddress(value: string): value is Address {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

export function parseAgentId(value: string): bigint | null {
  if (!/^\d+$/.test(value)) return null;

  try {
    const id = BigInt(value);
    if (id < BigInt(0)) return null;
    return id;
  } catch {
    return null;
  }
}

export const CHAIN_ID = BASE_CHAIN_ID;
