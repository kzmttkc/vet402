// Chain reads that feed the reconstruction (SPEC §9: on-demand, address-scoped).
import type { RwaReceipt } from "./classify";
import { TOPICS } from "./events";
import { hex, padAddress, rpcBatch, rpcCall, RpcError, type RpcOptions } from "./rpc";

export type RawLog = { transactionHash: string; blockNumber: string; logIndex: string; topics: string[]; data: string; address: string };

/** Blocks per eth_getLogs range. The primary RPC began refusing ranges over
 *  10,000,000 blocks ("only 10000000 are allowed for this request") on or before
 *  2026-09-29 05:4x JST; the 40M chunks that answered in ~0.3s on 2026-09-28 then
 *  failed every cold reconstruction. At head ~75M that is 8 chunks per side, still
 *  one batch. If the provider names a smaller limit, getLogsChunked re-walks with
 *  it. Heavy addresses still time out on wide ranges (the Fixture A holder did on
 *  2026-09-17), so a chunk that times out or exceeds the 10,000-log cap is split in
 *  half, down to MIN_CHUNK_BLOCKS. */
export const LOG_CHUNK_BLOCKS = 10_000_000;
const MIN_CHUNK_BLOCKS = 64;
/** A walk from genesis that would need more ranges than this is refused at once. A provider that
 *  allows only 10,000 blocks per query would need ~7,600 ranges per side at head ~76M; walking them
 *  would hold the one reconstruction slot for minutes and then time out anyway. */
export const MAX_LOG_RANGES = 64;

function isSplittable(err: unknown): boolean {
  return err instanceof RpcError && /timed out|timeout|deadline exceeded|exceeds limit|too many|response size|narrow the block range/i.test(err.message);
}

/** The block span the provider says it allows ("… but only 10000000 are allowed …"), or null. */
export function allowedSpan(err: unknown): number | null {
  const m = err instanceof RpcError ? /only (\d+) (?:blocks )?are allowed/i.exec(err.message) : null;
  return m ? Number(m[1]) : null;
}

async function getLogsRange(filter: Record<string, unknown>, from: number, to: number, opts?: RpcOptions): Promise<RawLog[]> {
  try {
    return await rpcCall<RawLog[]>("eth_getLogs", [{ ...filter, fromBlock: hex(from), toBlock: hex(to) }], opts);
  } catch (err) {
    if (!isSplittable(err) || to - from < MIN_CHUNK_BLOCKS) throw err;
    const mid = from + Math.floor((to - from) / 2);
    return [...(await getLogsRange(filter, from, mid, opts)), ...(await getLogsRange(filter, mid + 1, to, opts))];
  }
}

/** Pause between consecutive log requests: the public RPC throttles bursts (measured 2026-09-17/18). */
const LOG_CHUNK_PACING_MS = 250;
const LOG_BATCH = 4;
const LOG_BATCH_PACING_MS = 300;

async function getLogsChunked(filter: Record<string, unknown>, from: number, to: number, opts?: RpcOptions, chunk = LOG_CHUNK_BLOCKS): Promise<RawLog[]> {
  // Genesis-range log queries need an archive node; the fallback RPC refuses them
  // without a token, so log reads stay on the primary and retry longer instead.
  // No URL list is fixed here: rpc.ts picks the primary per batch and never adds the
  // fallback for eth_getLogs, so a refused Alchemy key moves the walk to the
  // non-Alchemy primary like every other read.
  const logOpts: RpcOptions = { retries: 5, ...opts };
  const pause = opts?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const starts: number[] = [];
  for (let start = from; start <= to; start += chunk) starts.push(start);

  // Fast path: the chunks in small JSON-RPC batches. Measured 2026-09-18: 17 chunks answered in
  // 0.5s as one POST, while 34 paced single requests drew 429s and took 25s+. Measured 2026-09-29:
  // batches of 8 now draw 429 about half the time, so they go 4 at a time with a short pause.
  try {
    const results: RawLog[][] = [];
    for (let i = 0; i < starts.length; i += LOG_BATCH) {
      if (i > 0) await pause(LOG_BATCH_PACING_MS);
      results.push(
        ...(await rpcBatch<RawLog[]>(
          starts.slice(i, i + LOG_BATCH).map((start) => ({ method: "eth_getLogs", params: [{ ...filter, fromBlock: hex(start), toBlock: hex(Math.min(to, start + chunk - 1)) }] })),
          logOpts,
        )),
      );
    }
    return results.flat();
  } catch (err) {
    const allowed = allowedSpan(err);
    if (allowed && allowed < chunk && allowed >= MIN_CHUNK_BLOCKS) {
      if (Math.ceil((to - from + 1) / allowed) > MAX_LOG_RANGES) throw new RpcError(`log span limit too small: ${allowed} blocks per query`, "eth_getLogs");
      return getLogsChunked(filter, from, to, opts, allowed);
    }
    if (!isSplittable(err)) throw err;
  }

  // Slow path: a chunk timed out or hit the 10,000-log cap. Walk one by one and split the offender.
  const out: RawLog[] = [];
  for (const start of starts) {
    if (start > from) await pause(LOG_CHUNK_PACING_MS);
    out.push(...(await getLogsRange(filter, start, Math.min(to, start + chunk - 1), logOpts)));
  }
  return out;
}

/** Logs matching `filter` from genesis to head, walked in the same chunks (the provider caps the span per query). */
export async function getLogsFromGenesis(filter: Record<string, unknown>, opts?: RpcOptions): Promise<RawLog[]> {
  const head = await fetchHead(opts);
  return getLogsChunked(filter, 0, head, opts);
}

/** Transfer logs of `token` where `address` is sender or recipient, up to and including `toBlock`, ordered by block then log index. */
export async function fetchCanonicalTransfers(token: string, address: string, toBlock: number, opts?: RpcOptions, chunk = LOG_CHUNK_BLOCKS): Promise<RawLog[]> {
  const me = padAddress(address);
  // The two sides run one after the other: two parallel walks doubled the burst and drew 429s.
  const out = await getLogsChunked({ address: token, topics: [TOPICS.transfer, me] }, 0, toBlock, opts, chunk);
  await (opts?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(1_000);
  const inn = await getLogsChunked({ address: token, topics: [TOPICS.transfer, null, me] }, 0, toBlock, opts, chunk);
  const seen = new Set<string>();
  const all: RawLog[] = [];
  for (const l of [...out, ...inn]) {
    const k = `${l.transactionHash}:${l.logIndex}`;
    if (seen.has(k)) continue;
    seen.add(k);
    all.push(l);
  }
  all.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex));
  return all;
}

/** Transfer logs of `token` sent by `address` (the sending side only), up to `toBlock`. */
export async function fetchTransfersOut(token: string, address: string, toBlock: number, opts?: RpcOptions): Promise<RawLog[]> {
  return getLogsChunked({ address: token, topics: [TOPICS.transfer, padAddress(address)] }, 0, toBlock, opts);
}

/** Transfer logs of `token` that paid `address` (the receiving side only), up to `toBlock`.
 *  Every way of holding a token starts with one of these (a mint is a Transfer from 0x0), so an
 *  empty answer means the address never held it; half the cost of fetchCanonicalTransfers. */
export async function fetchTransfersIn(token: string, address: string, toBlock: number, opts?: RpcOptions): Promise<RawLog[]> {
  return getLogsChunked({ address: token, topics: [TOPICS.transfer, null, padAddress(address)] }, 0, toBlock, opts);
}

/**
 * UIMultiplierUpdated logs of each token, from its own `from` block up to `toBlock`.
 * The provider wants one address per log filter, so each token is its own filter.
 * The chunks of all tokens go out together, LOG_BATCH per JSON-RPC batch with the
 * same pacing as the Transfer walk; a tail read (from a recent block) is one chunk
 * per token. If a batch is refused or rate-limited past its retries, the tokens are
 * walked one by one on the chunked path, which knows how to split and narrow.
 */
export async function fetchMultiplierLogs(ranges: { token: string; from: number }[], toBlock: number, opts?: RpcOptions): Promise<RawLog[]> {
  const logOpts: RpcOptions = { retries: 5, ...opts };
  const pause = opts?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const calls: { method: string; params: unknown[] }[] = [];
  for (const { token, from } of ranges)
    for (let start = from; start <= toBlock; start += LOG_CHUNK_BLOCKS)
      calls.push({ method: "eth_getLogs", params: [{ address: token, topics: [TOPICS.uiMultiplierUpdated], fromBlock: hex(start), toBlock: hex(Math.min(toBlock, start + LOG_CHUNK_BLOCKS - 1)) }] });
  try {
    const out: RawLog[] = [];
    for (let i = 0; i < calls.length; i += LOG_BATCH) {
      if (i > 0) await pause(LOG_BATCH_PACING_MS);
      for (const logs of await rpcBatch<RawLog[]>(calls.slice(i, i + LOG_BATCH), logOpts)) out.push(...logs);
    }
    return out;
  } catch {
    const out: RawLog[] = [];
    for (const [i, { token, from }] of ranges.entries()) {
      if (i > 0) await pause(LOG_CHUNK_PACING_MS);
      if (from <= toBlock) out.push(...(await getLogsChunked({ address: token, topics: [TOPICS.uiMultiplierUpdated] }, from, toBlock, opts)));
    }
    return out;
  }
}

/** Unix timestamps of `blocks`, in one batch. */
export async function fetchBlockTimestamps(blocks: number[], opts?: RpcOptions): Promise<Map<number, number>> {
  const uniq = [...new Set(blocks)];
  const res = await rpcBatch<{ timestamp: string }>(uniq.map((b) => ({ method: "eth_getBlockByNumber", params: [hex(b), false] })), opts);
  return new Map(uniq.map((b, i) => [b, Number(res[i].timestamp)]));
}

type RawReceipt = { transactionHash: string; blockNumber: string; from: string; to: string | null; logs: { address: string; topics: string[]; data: string; logIndex: string }[] };

/** Receipts for `txs`, fetched `batchSize` per JSON-RPC batch with `concurrency` batches in flight, returned in the order given. Only the fields the classifier reads. */
export async function fetchReceipts(txs: string[], opts?: RpcOptions, batchSize = 50, concurrency = 1): Promise<RwaReceipt[]> {
  const batches: string[][] = [];
  for (let i = 0; i < txs.length; i += batchSize) batches.push(txs.slice(i, i + batchSize));
  const results: RwaReceipt[][] = new Array(batches.length);
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const idx = next++;
      const slice = batches[idx];
      // A short pause between batches: back-to-back receipt batches drew 429s (measured 2026-09-29).
      if (idx > 0) await (opts?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(300);
      const rs = await rpcBatch<RawReceipt | null>(slice.map((tx) => ({ method: "eth_getTransactionReceipt", params: [tx] })), opts);
      results[idx] = rs.map((r, j) => {
        if (!r) throw new Error(`receipt missing for ${slice[j]}`);
        return {
          transactionHash: r.transactionHash,
          blockNumber: Number(r.blockNumber),
          from: r.from.toLowerCase(),
          to: r.to ? r.to.toLowerCase() : null,
          logs: r.logs.map((l) => ({ address: l.address.toLowerCase(), topics: l.topics, data: l.data, logIndex: Number(l.logIndex) })),
        };
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  return results.flat();
}

export async function fetchBlockTimestamp(block: number, opts?: RpcOptions): Promise<number> {
  const b = await rpcCall<{ timestamp: string }>("eth_getBlockByNumber", [hex(block), false], opts);
  return Number(b.timestamp);
}

/** What the empty answer states about the address at `block`: transactions it sent, whether it has code, and the block time. One batch. */
export async function readAccount(address: string, block: number, opts?: RpcOptions): Promise<{ sentTxCount: number; isContract: boolean; blockTimestamp: number }> {
  const at = hex(block);
  const [nonce, code, b] = await rpcBatch<unknown>(
    [
      { method: "eth_getTransactionCount", params: [address, at] },
      { method: "eth_getCode", params: [address, at] },
      { method: "eth_getBlockByNumber", params: [at, false] },
    ],
    opts,
  );
  return { sentTxCount: Number(nonce as string), isContract: typeof code === "string" && code !== "0x" && code !== "0x0", blockTimestamp: Number((b as { timestamp: string }).timestamp) };
}

export async function fetchHead(opts?: RpcOptions): Promise<number> {
  return Number(await rpcCall<string>("eth_blockNumber", [], opts));
}
