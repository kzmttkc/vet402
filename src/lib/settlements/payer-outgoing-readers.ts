// ============================================================
// 払い手から全宛先への USDC（または USD1）送金を窓で読む（payer-reconcile）。
// recover-late の TransferReader は payTo 固定。ここは from のみで読む。
// ============================================================
import { createPublicClient, defineChain, http, parseAbiItem, type Address } from "viem";
import { arc, arbitrum, avalanche, base, bsc, celo, tempo as tempoChain } from "viem/chains";
import { getLogScanClient } from "@/lib/chain/client";
import { toCaip2 } from "@/lib/observatory/chains";
import { getLogsChunked } from "@/lib/chain/chunked-logs";
import { BASE_BLOCK_TIME_SCHEDULE, firstBlockAtOrAfter } from "@/lib/chain/block-clock";
import { BASE_CHAIN_ID } from "@/lib/chain/config";
import { ARBITRUM_CAIP2, ARBITRUM_CHAIN_ID, ARBITRUM_USDC_ADDRESS } from "@/lib/chain/arbitrum";
import { ARC_CAIP2, ARC_CHAIN_ID, ARC_USDC_ADDRESS } from "@/lib/chain/arc";
import { AVALANCHE_CAIP2, AVALANCHE_CHAIN_ID, AVALANCHE_USDC_ADDRESS } from "@/lib/chain/avalanche";
import { BNB_CAIP2, BNB_CHAIN_ID, BNB_USD1_ADDRESS } from "@/lib/chain/bnb";
import { CELO_CAIP2, CELO_CHAIN_ID, CELO_USDC_ADDRESS } from "@/lib/chain/celo";
import { TEMPO_CHAIN_ID, TEMPO_MAINNET_CAIP2, TEMPO_USDC_E, tempoRpcUrl } from "@/lib/observatory/mpp-payer";
import { ROBINHOOD_CAIP2, ROBINHOOD_USDG } from "@/lib/observatory/evm-lane-ingest";
import { SOLANA_MAINNET_CAIP2, SOLANA_USDC_MINT } from "@/lib/observatory/sol402-payer";
import { STELLAR_LEDGER_SCALE, STELLAR_PUBNET_CAIP2, STELLAR_USDC_ISSUER } from "@/lib/observatory/stellar402-payer";
import { stellarDecimalToStroops } from "@/lib/observatory/settlement-verify-stellar";
import { usdcOwnerDelta, type SolanaTokenBalance } from "@/lib/observatory/settlement-verify-solana";
import { evmIndexLedgerAmount } from "@/lib/settlements/index-evm";
import { solanaUsdcTokenAccount } from "@/lib/settlements/index-solana";
import {
  RLUSD_ISSUER,
  XRPL_MAINNET_CAIP2,
  createXrplJsonRpc,
  isRlusdAsset,
  rlusdToUnitsFloor,
} from "@/lib/observatory/xrpl402-payer";
import { rippleTimeToDate } from "@/lib/observatory/settlement-verify-xrpl";
import type { XrplAccountTxEntry } from "@/lib/settlements/index-xrpl";
import { rwaNonAlchemyRpcUrl, RWA_PUBLIC_RPC_URL } from "../../../packages/rwa/config";
import {
  CELO_TRANSFER_READ_CHUNK_BLOCKS,
  STELLAR_LATE_READ_MAX_PAGES,
  STELLAR_LATE_READ_OPERATIONS_PER_PAGE,
  type ChainTransfer,
  type StellarHorizonLateReadClient,
} from "@/lib/settlements/recover-late";

const TRANSFER_LOG = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const TEMPO_TRANSFER_WITH_MEMO_LOG = parseAbiItem(
  "event TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 indexed memo)",
);
const BASE_NETWORK_KEYS = ["eip155:8453", "base"];
const BASE_USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const ROBINHOOD_CHAIN = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RWA_PUBLIC_RPC_URL] } },
});

export type PayerOutgoingReader = (q: {
  network: string;
  payer: string;
  from: Date;
  to: Date;
  timeoutMs?: number;
  signal?: AbortSignal;
}) => Promise<ChainTransfer[] | null>;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

type EvmLogClient = Pick<ReturnType<typeof getLogScanClient>, "getBlock" | "getLogs" | "getChainId">;

function boundedBaseClient(timeoutMs: number): EvmLogClient {
  const indexer = process.env.INDEXER_RPC_URL?.trim();
  const baseRpc = process.env.BASE_RPC_URL?.trim();
  const url =
    (indexer && indexer.length > 0 ? indexer : null) ??
    (baseRpc && baseRpc.length > 0 ? baseRpc : null) ??
    "https://mainnet.base.org";
  return createPublicClient({
    chain: base,
    transport: http(url, { timeout: Math.max(1_000, Math.trunc(timeoutMs)), retryCount: 0 }),
  }) as unknown as EvmLogClient;
}

function rpcClient(chain: unknown, url: string | null | undefined, timeoutMs: number | undefined): EvmLogClient | null {
  if (!url) return null;
  return createPublicClient({
    chain: chain as typeof base,
    transport: http(url, { timeout: Math.max(1_000, Math.trunc(timeoutMs ?? 20_000)), retryCount: 0 }),
  }) as unknown as EvmLogClient;
}

function robinhoodClient(timeoutMs: number | undefined): EvmLogClient {
  const url = rwaNonAlchemyRpcUrl();
  return createPublicClient({
    chain: ROBINHOOD_CHAIN,
    transport: http(url, { timeout: Math.max(1_000, Math.trunc(timeoutMs ?? 20_000)), retryCount: 0 }),
  }) as unknown as EvmLogClient;
}

export function makeBasePayerOutgoingReader(client?: EvmLogClient): PayerOutgoingReader {
  return async ({ network, payer, from, to, timeoutMs, signal }) => {
    if (!BASE_NETWORK_KEYS.includes(network)) return null;
    throwIfAborted(signal);
    const c = client ?? (typeof timeoutMs === "number" ? boundedBaseClient(timeoutMs) : getLogScanClient(8453));
    const deadline = typeof timeoutMs === "number" ? Date.now() + timeoutMs : Infinity;
    const chainId = await c.getChainId();
    if (chainId !== BASE_CHAIN_ID) return null;
    const head = await c.getBlock({ blockTag: "latest" });
    throwIfAborted(signal);
    const blockAt = (t: Date) => firstBlockAtOrAfter(BASE_BLOCK_TIME_SCHEDULE, t.getTime() / 1000);
    const fromBlock = blockAt(from) - 60n;
    const toBlock = blockAt(to) + 60n > head.number ? head.number : blockAt(to) + 60n;
    if (fromBlock < 0n || fromBlock > toBlock) return null;
    const remainingMs = deadline === Infinity ? undefined : Math.max(1, deadline - Date.now());
    const logs = (await getLogsChunked(
      c as unknown as Parameters<typeof getLogsChunked>[0],
      {
        address: BASE_USDC,
        event: TRANSFER_LOG,
        args: { from: payer as Address },
        fromBlock,
        toBlock,
      } as never,
      undefined,
      undefined,
      remainingMs === undefined ? undefined : { deadlineMs: remainingMs, delayMs: 0, signal },
    )) as unknown as {
      blockNumber: bigint | null;
      transactionHash: string | null;
      args: { from: Address; to: Address; value?: bigint };
    }[];
    const out: ChainTransfer[] = [];
    for (const l of logs) {
      throwIfAborted(signal);
      if (Date.now() > deadline) throw new Error("transfer read ran past its time limit");
      if (l.blockNumber === null || !l.transactionHash || typeof l.args.value !== "bigint") continue;
      out.push({
        txHash: l.transactionHash,
        from: String(l.args.from),
        to: String(l.args.to),
        value: l.args.value.toString(),
        blockTime: "",
        blockNumber: l.blockNumber,
      });
    }
    return out;
  };
}

type EvmOutgoingConfig = {
  network: string;
  chainId: number;
  token: Address;
  chunkBlocks: bigint;
  marginBlocks: bigint;
  blockSeconds: number;
  toleranceSeconds: number;
  client: () => EvmLogClient | null;
  formatAmount?: (raw: bigint) => string | null;
  tempoMemo?: boolean;
};

async function readEvmPayerOutgoing(
  c: EvmLogClient,
  cfg: EvmOutgoingConfig,
  payer: string,
  from: Date,
  to: Date,
  deadline: number,
  event: typeof TRANSFER_LOG | typeof TEMPO_TRANSFER_WITH_MEMO_LOG,
  signal?: AbortSignal,
): Promise<ChainTransfer[] | null> {
  const expired = () => {
    throwIfAborted(signal);
    if (Date.now() > deadline) throw new Error("transfer read ran past its time limit");
  };
  throwIfAborted(signal);
  const [chainId, head] = await Promise.all([c.getChainId(), c.getBlock({ blockTag: "latest" })]);
  if (chainId !== cfg.chainId) return null;
  const headMs = Number(head.timestamp) * 1000;
  if (headMs < to.getTime()) return null;
  const locate = async (t: Date): Promise<bigint> => {
    let n = head.number - BigInt(Math.max(0, Math.ceil((headMs - t.getTime()) / (cfg.blockSeconds * 1000))));
    for (let i = 0; i < 3; i++) {
      expired();
      if (n < 0n) n = 0n;
      if (n > head.number) n = head.number;
      const block = await c.getBlock({ blockNumber: n });
      const driftSeconds = Math.round((Number(block.timestamp) * 1000 - t.getTime()) / 1000);
      if (Math.abs(driftSeconds) <= cfg.toleranceSeconds) return n;
      if ((n === 0n && driftSeconds > 0) || (n === head.number && driftSeconds < 0)) break;
      n -= BigInt(Math.trunc(driftSeconds / cfg.blockSeconds));
    }
    throw new Error(`could not locate block for the window`);
  };
  const [fromAt, toAt] = await Promise.all([locate(from), locate(to)]);
  const fromBlock = fromAt - cfg.marginBlocks < 0n ? 0n : fromAt - cfg.marginBlocks;
  const toBlock = toAt + cfg.marginBlocks > head.number ? head.number : toAt + cfg.marginBlocks;
  if (fromBlock > toBlock) return null;
  const out: ChainTransfer[] = [];
  for (let lo = fromBlock; lo <= toBlock; lo += cfg.chunkBlocks) {
    expired();
    const hi = lo + cfg.chunkBlocks - 1n < toBlock ? lo + cfg.chunkBlocks - 1n : toBlock;
    const logs = await c.getLogs({
      address: cfg.token,
      event,
      args: { from: payer as Address },
      fromBlock: lo,
      toBlock: hi,
    });
    for (const l of logs) {
      if (l.blockNumber === null || !l.transactionHash) continue;
      const args = l.args as { from?: unknown; to?: unknown; value?: bigint; amount?: bigint };
      const raw = cfg.tempoMemo ? args.amount : args.value;
      if (typeof raw !== "bigint") continue;
      const value = cfg.formatAmount ? cfg.formatAmount(raw) : raw.toString();
      if (value === null) continue;
      expired();
      out.push({
        txHash: l.transactionHash,
        from: String(args.from),
        to: String(args.to),
        value,
        blockTime: "",
        blockNumber: l.blockNumber,
      });
    }
  }
  return out;
}

function mergeUniqueTransfers(parts: (ChainTransfer[] | null)[]): ChainTransfer[] | null {
  if (parts.some((p) => p === null)) return null;
  const map = new Map<string, ChainTransfer>();
  for (const part of parts) {
    for (const t of part!) {
      const key = t.txHash.toLowerCase();
      if (!map.has(key)) map.set(key, t);
    }
  }
  return [...map.values()];
}

export function makeEvmPayerOutgoingReader(cfg: EvmOutgoingConfig, dualTempo = false): PayerOutgoingReader {
  return async ({ network, payer, from, to, timeoutMs, signal }) => {
    if (network !== cfg.network) return null;
    throwIfAborted(signal);
    const c = cfg.client();
    if (!c) return null;
    const deadline = typeof timeoutMs === "number" ? Date.now() + timeoutMs : Infinity;
    try {
      if (dualTempo) {
        const [memo, plain] = await Promise.all([
          readEvmPayerOutgoing(c, cfg, payer, from, to, deadline, TEMPO_TRANSFER_WITH_MEMO_LOG, signal),
          readEvmPayerOutgoing(c, cfg, payer, from, to, deadline, TRANSFER_LOG, signal),
        ]);
        return mergeUniqueTransfers([memo, plain]);
      }
      const event = cfg.tempoMemo ? TEMPO_TRANSFER_WITH_MEMO_LOG : TRANSFER_LOG;
      return await readEvmPayerOutgoing(c, cfg, payer, from, to, deadline, event, signal);
    } catch (e) {
      if (signal?.aborted || (e instanceof DOMException && e.name === "AbortError")) return null;
      return null;
    }
  };
}

function stellarOutgoingFromOp(op: Record<string, unknown>, payer: string): ChainTransfer | null {
  if (op.transaction_successful !== true) return null;
  const txHash = typeof op.transaction_hash === "string" ? op.transaction_hash.trim().toLowerCase() : null;
  const createdAt = typeof op.created_at === "string" ? op.created_at : null;
  if (!txHash || !createdAt) return null;
  const parse = (from: unknown, to: unknown, amount: unknown, assetCode: unknown, assetIssuer: unknown): ChainTransfer | null => {
    if (from !== payer || assetCode !== "USDC" || assetIssuer !== STELLAR_USDC_ISSUER) return null;
    const dest = typeof to === "string" ? to : null;
    const amt = typeof amount === "string" ? amount : null;
    if (!dest || !amt) return null;
    const stroops = stellarDecimalToStroops(amt);
    if (stroops === null || stroops % STELLAR_LEDGER_SCALE !== 0n) return null;
    return { txHash, from: payer, to: dest, value: (stroops / STELLAR_LEDGER_SCALE).toString(), blockTime: createdAt };
  };
  if (op.type === "payment") {
    return parse(op.from, op.to, op.amount, op.asset_code, op.asset_issuer);
  }
  const changes = op.asset_balance_changes;
  if (!Array.isArray(changes)) return null;
  for (const raw of changes) {
    const c = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
    if (!c || c.type !== "transfer") continue;
    const t = parse(c.from, c.to, c.amount, c.asset_code, c.asset_issuer);
    if (t) return t;
  }
  return null;
}

export function makeStellarPayerOutgoingReader(client?: StellarHorizonLateReadClient): PayerOutgoingReader {
  return async ({ network, payer, from, to, timeoutMs, signal }) => {
    if (network !== STELLAR_PUBNET_CAIP2) return null;
    throwIfAborted(signal);
    const deadline = typeof timeoutMs === "number" ? Date.now() + timeoutMs : Infinity;
    const fromMs = from.getTime();
    const toMs = to.getTime();
    const out: ChainTransfer[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    let reachedPastWindow = false;
    const getPage = async (cur?: string) => {
      const { STELLAR_HORIZON_URL: STELLAR_HORIZON_DEFAULT_URL } = await import("@/lib/diagnose/readiness");
      const base = (process.env.STELLAR_HORIZON_URL?.trim() || STELLAR_HORIZON_DEFAULT_URL).replace(/\/$/, "");
      const url = new URL(`${base}/accounts/${encodeURIComponent(payer)}/operations`);
      url.searchParams.set("order", "desc");
      url.searchParams.set("limit", String(STELLAR_LATE_READ_OPERATIONS_PER_PAGE));
      if (cur) url.searchParams.set("cursor", cur);
      const cap = Math.max(1_000, Math.trunc(timeoutMs ?? 20_000));
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cap);
      try {
        const res = await fetch(url.toString(), { signal: ctrl.signal, headers: { Accept: "application/json" } });
        if (res.status === 429 || !res.ok) return null;
        const body = await res.json();
        const embedded = body?._embedded;
        const records = embedded?.records;
        if (!Array.isArray(records)) return null;
        let nextCursor: string | null = null;
        const href = body?._links?.next?.href;
        if (typeof href === "string") {
          try {
            nextCursor = new URL(href).searchParams.get("cursor");
          } catch {
            return null;
          }
        }
        return { records, nextCursor };
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    };
    while (pages < STELLAR_LATE_READ_MAX_PAGES) {
      throwIfAborted(signal);
      if (Date.now() > deadline) return null;
      pages++;
      const page = client ? await client.getOperationsPage(payer, cursor) : await getPage(cursor);
      if (!page) return null;
      const { records, nextCursor } = page;
      if (records.length === 0) {
        reachedPastWindow = true;
        break;
      }
      let oldestMs: number | null = null;
      for (const raw of records) {
        const op = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
        if (!op) return null;
        const createdAt = typeof op.created_at === "string" ? op.created_at : null;
        const bt = createdAt !== null ? Date.parse(createdAt) : NaN;
        if (!Number.isFinite(bt)) return null;
        if (oldestMs === null || bt < oldestMs) oldestMs = bt;
        if (bt < fromMs || bt > toMs) continue;
        const t = stellarOutgoingFromOp(op, payer);
        if (t && !seen.has(t.txHash)) {
          seen.add(t.txHash);
          out.push(t);
        }
      }
      if (oldestMs !== null && oldestMs < fromMs) {
        reachedPastWindow = true;
        break;
      }
      if (!nextCursor || records.length < STELLAR_LATE_READ_OPERATIONS_PER_PAGE) {
        reachedPastWindow = true;
        break;
      }
      cursor = nextCursor;
    }
    if (!reachedPastWindow) return null;
    return out;
  };
}

export function makeSolanaPayerOutgoingReader(): PayerOutgoingReader {
  return async ({ network, payer, from, to, timeoutMs, signal }) => {
    if (network !== SOLANA_MAINNET_CAIP2) return null;
    throwIfAborted(signal);
    const url = process.env.SOLANA_RPC_URL?.trim();
    if (!url) return null;
    const deadline = typeof timeoutMs === "number" ? Date.now() + timeoutMs : Infinity;
    const { Connection, PublicKey } = await import("@solana/web3.js");
    const conn = new Connection(url, {
      commitment: "confirmed",
      fetch: (input, init) => {
        const ctrl = new AbortController();
        const cap = Math.max(1_000, Math.min(15_000, Math.trunc(timeoutMs ?? 20_000)));
        const timer = setTimeout(() => ctrl.abort(), cap);
        const readerSignal = signal;
        if (readerSignal?.aborted) {
          clearTimeout(timer);
          return Promise.reject(new DOMException("Aborted", "AbortError"));
        }
        if (readerSignal) readerSignal.addEventListener("abort", () => ctrl.abort(), { once: true });
        const requestSignal = init?.signal;
        if (requestSignal) {
          if (requestSignal.aborted) ctrl.abort();
          else requestSignal.addEventListener("abort", () => ctrl.abort(), { once: true });
        }
        return fetch(input, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
      },
    });
    const account = solanaUsdcTokenAccount(payer);
    if (!account) return null;
    const fromSeconds = Math.floor(from.getTime() / 1000);
    const toSeconds = Math.ceil(to.getTime() / 1000);
    const sigs: { signature: string; blockTime: number }[] = [];
    let before: string | undefined;
    let sigScanComplete = false;
    for (let pages = 0; pages < 20; pages++) {
      throwIfAborted(signal);
      if (Date.now() > deadline) return null;
      const page = await conn.getSignaturesForAddress(new PublicKey(account), { limit: 100, ...(before ? { before } : {}) });
      if (page.length === 0) {
        sigScanComplete = true;
        break;
      }
      let reached = false;
      for (const s of page) {
        if (s.err || typeof s.blockTime !== "number") continue;
        if (s.blockTime < fromSeconds) {
          reached = true;
          break;
        }
        if (s.blockTime <= toSeconds) sigs.push({ signature: s.signature, blockTime: s.blockTime });
      }
      if (reached || page.length < 100) {
        sigScanComplete = true;
        break;
      }
      before = page[page.length - 1].signature;
    }
    if (!sigScanComplete) return null;
    const out: ChainTransfer[] = [];
    const seen = new Set<string>();
    for (const { signature, blockTime } of sigs) {
      throwIfAborted(signal);
      if (Date.now() > deadline) return null;
      const tx = await conn.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
      if (!tx?.meta || tx.meta.err) continue;
      const pre = tx.meta.preTokenBalances ?? [];
      const post = tx.meta.postTokenBalances ?? [];
      const source = usdcOwnerDelta(pre as readonly SolanaTokenBalance[], post as readonly SolanaTokenBalance[], payer, SOLANA_USDC_MINT);
      if (!source.attributable || source.sent <= 0n) continue;
      if (seen.has(signature)) continue;
      seen.add(signature);
      let dest = payer;
      for (const bal of post) {
        if (bal.mint !== SOLANA_USDC_MINT || !bal.owner) continue;
        const d = usdcOwnerDelta(pre as readonly SolanaTokenBalance[], post as readonly SolanaTokenBalance[], bal.owner, SOLANA_USDC_MINT);
        if (d.received > 0n) {
          dest = bal.owner;
          break;
        }
      }
      out.push({
        txHash: signature,
        from: payer,
        to: dest,
        value: source.sent.toString(),
        blockTime: new Date(blockTime * 1000).toISOString(),
      });
    }
    return out;
  };
}

function xrplOutgoingPayment(entry: XrplAccountTxEntry, payer: string, fromMs: number, toMs: number): ChainTransfer | null {
  if (entry.validated !== true) return null;
  const tx =
    typeof entry.tx_json === "object" && entry.tx_json !== null
      ? (entry.tx_json as Record<string, unknown>)
      : typeof entry.tx === "object" && entry.tx !== null
        ? (entry.tx as Record<string, unknown>)
        : null;
  const meta =
    typeof entry.meta === "object" && entry.meta !== null ? (entry.meta as Record<string, unknown>) : null;
  if (!tx || !meta) return null;
  if (tx.TransactionType !== "Payment") return null;
  if (meta.TransactionResult !== "tesSUCCESS") return null;
  if (tx.Account !== payer) return null;
  if (typeof tx.Destination !== "string") return null;
  const amount = typeof tx.Amount === "object" && tx.Amount !== null ? (tx.Amount as Record<string, unknown>) : null;
  if (!amount || typeof amount.currency !== "string" || !isRlusdAsset(amount.currency) || amount.issuer !== RLUSD_ISSUER) {
    return null;
  }
  const units = typeof amount.value === "string" ? rlusdToUnitsFloor(amount.value) : null;
  if (units === null || units <= 0n) return null;
  const hash =
    typeof entry.hash === "string"
      ? entry.hash
      : typeof tx.hash === "string"
        ? tx.hash
        : null;
  if (!hash) return null;
  const blockTime =
    typeof entry.close_time_iso === "string"
      ? new Date(entry.close_time_iso)
      : rippleTimeToDate(tx.date);
  if (!blockTime) return null;
  const bt = blockTime.getTime();
  if (bt < fromMs || bt > toMs) return null;
  return {
    txHash: hash.toUpperCase(),
    from: payer,
    to: tx.Destination,
    value: units.toString(),
    blockTime: blockTime.toISOString(),
  };
}

export function makeXrplPayerOutgoingReader(): PayerOutgoingReader {
  return async ({ network, payer, from, to, timeoutMs, signal }) => {
    if (network !== XRPL_MAINNET_CAIP2) return null;
    throwIfAborted(signal);
    const rpcUrl = process.env.XRPL_RPC_URL?.trim();
    if (!rpcUrl) return null;
    const deadline = typeof timeoutMs === "number" ? Date.now() + timeoutMs : Infinity;
    const fromMs = from.getTime();
    const toMs = to.getTime();
    const rpc = createXrplJsonRpc({ url: rpcUrl, timeoutMs: Math.max(1_000, Math.trunc(timeoutMs ?? 20_000)) });
    const out: ChainTransfer[] = [];
    const seen = new Set<string>();
    let marker: unknown;
    let pages = 0;
    let complete = false;
    while (pages < 30) {
      throwIfAborted(signal);
      if (Date.now() > deadline) return null;
      pages++;
      const cap = Math.max(1_000, Math.trunc(Math.min(15_000, deadline - Date.now())));
      const body = (await Promise.race([
        rpc("account_tx", {
          account: payer,
          ledger_index_min: -1,
          ledger_index_max: -1,
          binary: false,
          forward: false,
          limit: 200,
          ...(marker !== undefined ? { marker } : {}),
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("xrpl timeout")), cap)),
      ]).catch(() => null)) as { transactions?: XrplAccountTxEntry[]; marker?: unknown } | null;
      if (!body || !Array.isArray(body.transactions)) return null;
      const txs = body.transactions;
      if (txs.length === 0) {
        complete = true;
        break;
      }
      let oldestMs: number | null = null;
      for (const entry of txs) {
        const blockTime =
          typeof entry.close_time_iso === "string"
            ? Date.parse(entry.close_time_iso)
            : rippleTimeToDate(
                (entry.tx_json as Record<string, unknown> | undefined)?.date ??
                  (entry.tx as Record<string, unknown> | undefined)?.date,
              )?.getTime() ?? NaN;
        if (Number.isFinite(blockTime) && (oldestMs === null || blockTime < oldestMs)) oldestMs = blockTime;
        const t = xrplOutgoingPayment(entry, payer, fromMs, toMs);
        if (t && !seen.has(t.txHash)) {
          seen.add(t.txHash);
          out.push(t);
        }
      }
      if (oldestMs !== null && oldestMs < fromMs) {
        complete = true;
        break;
      }
      if (!body.marker) {
        complete = true;
        break;
      }
      marker = body.marker;
    }
    if (!complete) return null;
    return out;
  };
}

const EVM_READERS: Record<string, PayerOutgoingReader> = {
  [CELO_CAIP2]: makeEvmPayerOutgoingReader({
    network: CELO_CAIP2,
    chainId: CELO_CHAIN_ID,
    token: CELO_USDC_ADDRESS as Address,
    chunkBlocks: CELO_TRANSFER_READ_CHUNK_BLOCKS,
    marginBlocks: 35n,
    blockSeconds: 1,
    toleranceSeconds: 30,
    client: () => rpcClient(celo, process.env.CELO_RPC_URL?.trim(), 20_000),
  }),
  [BNB_CAIP2]: makeEvmPayerOutgoingReader({
    network: BNB_CAIP2,
    chainId: BNB_CHAIN_ID,
    token: BNB_USD1_ADDRESS as Address,
    chunkBlocks: CELO_TRANSFER_READ_CHUNK_BLOCKS,
    marginBlocks: 200n,
    blockSeconds: 0.45,
    toleranceSeconds: 30,
    client: () => rpcClient(bsc, process.env.BNB_RPC_URL?.trim(), 20_000),
    formatAmount: (raw) => {
      const v = evmIndexLedgerAmount(BNB_CHAIN_ID, raw);
      return v === null ? null : v.toString();
    },
  }),
  [ARBITRUM_CAIP2]: makeEvmPayerOutgoingReader({
    network: ARBITRUM_CAIP2,
    chainId: ARBITRUM_CHAIN_ID,
    token: ARBITRUM_USDC_ADDRESS as Address,
    chunkBlocks: 2_000n,
    marginBlocks: 60n,
    blockSeconds: 0.28,
    toleranceSeconds: 30,
    client: () => rpcClient(arbitrum, process.env.ARBITRUM_RPC_URL?.trim(), 20_000),
  }),
  [AVALANCHE_CAIP2]: makeEvmPayerOutgoingReader({
    network: AVALANCHE_CAIP2,
    chainId: AVALANCHE_CHAIN_ID,
    token: AVALANCHE_USDC_ADDRESS as Address,
    chunkBlocks: 100n,
    marginBlocks: 60n,
    blockSeconds: 0.97,
    toleranceSeconds: 30,
    client: () => rpcClient(avalanche, process.env.AVALANCHE_RPC_URL?.trim(), 20_000),
  }),
  [ARC_CAIP2]: makeEvmPayerOutgoingReader({
    network: ARC_CAIP2,
    chainId: ARC_CHAIN_ID,
    token: ARC_USDC_ADDRESS as Address,
    chunkBlocks: 5_000n,
    marginBlocks: 120n,
    blockSeconds: 0.51,
    toleranceSeconds: 30,
    client: () => rpcClient(arc, process.env.ARC_RPC_URL?.trim(), 20_000),
  }),
  [TEMPO_MAINNET_CAIP2]: makeEvmPayerOutgoingReader(
    {
      network: TEMPO_MAINNET_CAIP2,
      chainId: TEMPO_CHAIN_ID,
      token: TEMPO_USDC_E as Address,
      chunkBlocks: 5_000n,
      marginBlocks: 120n,
      blockSeconds: 0.56,
      toleranceSeconds: 30,
      client: () => rpcClient(tempoChain, tempoRpcUrl(), 20_000),
      tempoMemo: true,
    },
    true,
  ),
  [ROBINHOOD_CAIP2]: makeEvmPayerOutgoingReader({
    network: ROBINHOOD_CAIP2,
    chainId: 4663,
    token: ROBINHOOD_USDG as Address,
    chunkBlocks: 2_000n,
    marginBlocks: 120n,
    blockSeconds: 2,
    toleranceSeconds: 30,
    client: () => robinhoodClient(20_000),
  }),
};

/** 払い手から全宛先への送金を読めないチェーンと読めない理由（恒久的に未実装のものだけ）。 */
export const PAYER_OUTGOING_UNAVAILABLE: Readonly<Record<string, string>> = {};

export const PAYER_OUTGOING_CHAIN_SUPPORT: Readonly<Record<string, "ok" | "unavailable">> = {
  [BASE_NETWORK_KEYS[0]]: "ok",
  base: "ok",
  [STELLAR_PUBNET_CAIP2]: "ok",
  [SOLANA_MAINNET_CAIP2]: "ok",
  [XRPL_MAINNET_CAIP2]: "ok",
  [CELO_CAIP2]: "ok",
  [BNB_CAIP2]: "ok",
  [ARBITRUM_CAIP2]: "ok",
  [AVALANCHE_CAIP2]: "ok",
  [ARC_CAIP2]: "ok",
  [TEMPO_MAINNET_CAIP2]: "ok",
  [ROBINHOOD_CAIP2]: "ok",
};

export function makeChainPayerOutgoingReader(overrides: Partial<Record<string, PayerOutgoingReader>> = {}): PayerOutgoingReader {
  const baseReader = overrides.base ?? makeBasePayerOutgoingReader();
  const stellar = overrides.stellar ?? makeStellarPayerOutgoingReader();
  const solana = overrides.solana ?? makeSolanaPayerOutgoingReader();
  const xrpl = overrides.xrpl ?? makeXrplPayerOutgoingReader();
  return async (q) => {
    if (PAYER_OUTGOING_UNAVAILABLE[q.network]) return null;
    if (q.network === STELLAR_PUBNET_CAIP2) return stellar(q);
    if (q.network === SOLANA_MAINNET_CAIP2) return solana(q);
    if (q.network === XRPL_MAINNET_CAIP2) return xrpl(q);
    const evm = EVM_READERS[q.network];
    if (evm) return evm(q);
    if (BASE_NETWORK_KEYS.includes(q.network)) return baseReader(q);
    return null;
  };
}

const NOT_CONFIGURED_ENV: Readonly<Record<string, string>> = {
  [SOLANA_MAINNET_CAIP2]: "SOLANA_RPC_URL",
  [XRPL_MAINNET_CAIP2]: "XRPL_RPC_URL",
  [CELO_CAIP2]: "CELO_RPC_URL",
  [BNB_CAIP2]: "BNB_RPC_URL",
  [ARBITRUM_CAIP2]: "ARBITRUM_RPC_URL",
  [AVALANCHE_CAIP2]: "AVALANCHE_RPC_URL",
  [ARC_CAIP2]: "ARC_RPC_URL",
  [TEMPO_MAINNET_CAIP2]: "TEMPO_RPC_URL",
};

/** RPC が無く恒久に読めないチェーン。null なら読める（または公開 RPC がある）。 */
export function payerOutgoingNotConfiguredReason(network: string): string | null {
  const caip = toCaip2(network) ?? network;
  const envKey = NOT_CONFIGURED_ENV[caip];
  if (!envKey) return null;
  const val = process.env[envKey]?.trim();
  if (val && val.length > 0) return null;
  if (caip === TEMPO_MAINNET_CAIP2 && tempoRpcUrl()) return null;
  return `missing ${envKey}`;
}

function evmEnrichClient(network: string, timeoutMs?: number): EvmLogClient | null {
  const cap = Math.max(1_000, Math.trunc(timeoutMs ?? 20_000));
  switch (network) {
    case "eip155:8453":
    case "base":
      return boundedBaseClient(cap);
    case ARBITRUM_CAIP2:
      return rpcClient(arbitrum, process.env.ARBITRUM_RPC_URL?.trim(), cap);
    case AVALANCHE_CAIP2:
      return rpcClient(avalanche, process.env.AVALANCHE_RPC_URL?.trim(), cap);
    case BNB_CAIP2:
      return rpcClient(bsc, process.env.BNB_RPC_URL?.trim(), cap);
    case CELO_CAIP2:
      return rpcClient(celo, process.env.CELO_RPC_URL?.trim(), cap);
    case ARC_CAIP2:
      return rpcClient(arc, process.env.ARC_RPC_URL?.trim(), cap);
    case TEMPO_MAINNET_CAIP2:
      return rpcClient(tempoChain, tempoRpcUrl(), cap);
    case ROBINHOOD_CAIP2:
      return robinhoodClient(cap);
    default:
      return null;
  }
}

/** 未記録候補だけチェーンの実ブロック時刻を付ける（別経路用）。 */
export async function enrichOutgoingTransferBlockTimes(
  network: string,
  transfers: ChainTransfer[],
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const caip = toCaip2(network) ?? network;
  if (!caip.startsWith("eip155:")) return;
  const c = evmEnrichClient(caip, opts.timeoutMs);
  if (!c) return;
  const deadline = typeof opts.timeoutMs === "number" ? Date.now() + opts.timeoutMs : Infinity;
  for (const t of transfers) {
    throwIfAborted(opts.signal);
    if (t.blockTime && Number.isFinite(Date.parse(t.blockTime))) continue;
    if (t.blockNumber === undefined) continue;
    if (Date.now() > deadline) throw new Error("transfer read ran past its time limit");
    const block = await c.getBlock({ blockNumber: t.blockNumber });
    t.blockTime = new Date(Number(block.timestamp) * 1000).toISOString();
  }
}