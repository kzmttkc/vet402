// Chain reads that feed the reconstruction (SPEC §9: on-demand, address-scoped).
import type { RwaReceipt } from "./classify";
import { TOPICS } from "./events";
import { RWA_RPC_URL } from "./config";
import { hex, padAddress, rpcBatch, rpcCall, RpcError, type RpcOptions } from "./rpc";

type RawLog = { transactionHash: string; blockNumber: string; logIndex: string; topics: string[]; data: string; address: string };

/** Blocks per eth_getLogs range. The public RPC answers "log query timed out" on
 *  genesis-to-head ranges, so ranges are walked in fixed chunks and a chunk that
 *  still times out or exceeds the 10,000-log cap is split in half. */
export const LOG_CHUNK_BLOCKS = 4_000_000;
const MIN_CHUNK_BLOCKS = 64;

function isSplittable(err: unknown): boolean {
  return err instanceof RpcError && /timed out|timeout|deadline exceeded|exceeds limit|too many|response size/i.test(err.message);
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

async function getLogsChunked(filter: Record<string, unknown>, from: number, to: number, opts?: RpcOptions, chunk = LOG_CHUNK_BLOCKS): Promise<RawLog[]> {
  // Genesis-range log queries need an archive node; the fallback RPC refuses them
  // without a token, so log reads stay on the primary and retry longer instead.
  const logOpts: RpcOptions = { retries: 5, ...opts, urls: opts?.urls ?? [RWA_RPC_URL] };
  const pause = opts?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const starts: number[] = [];
  for (let start = from; start <= to; start += chunk) starts.push(start);

  // Fast path: every chunk in one JSON-RPC batch. Measured 2026-09-18: 17 chunks answer in
  // 0.5s as one POST, while 34 paced single requests drew 429s and took 25s+.
  try {
    const results = await rpcBatch<RawLog[]>(
      starts.map((start) => ({ method: "eth_getLogs", params: [{ ...filter, fromBlock: hex(start), toBlock: hex(Math.min(to, start + chunk - 1)) }] })),
      logOpts,
    );
    return results.flat();
  } catch (err) {
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

export async function fetchHead(opts?: RpcOptions): Promise<number> {
  return Number(await rpcCall<string>("eth_blockNumber", [], opts));
}
