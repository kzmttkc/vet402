// ============================================================
// 払い手から全宛先への USDC（または USD1）送金を窓で読む（payer-reconcile）。
// recover-late の TransferReader は payTo 固定。ここは from のみで読む。
// ============================================================
import { createPublicClient, defineChain, http, parseAbiItem, type Address } from "viem";
import { arc, arbitrum, avalanche, base, bsc, celo, tempo as tempoChain } from "viem/chains";
import {
  BlockscoutUnavailableError,
  fetchBlockscoutIndexedHeadMs,
  fetchPayerTokenTransfersV2Page,
  type PayerTokenTransfersV2Page,
} from "@/lib/chain/blockscout";
import { getLogScanClient } from "@/lib/chain/client";
import { AlchemyUnavailableError, fetchAssetTransfersPage, isAlchemyEnabled } from "@/lib/chain/alchemy";
import {
  makeRoutescanAvalanchePayerFetch,
  RoutescanUnavailableError,
  type RoutescanPayerTokenTxFetch,
} from "@/lib/chain/routescan";
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
  ARC_TRANSFER_READ_CHUNK_BLOCKS,
  ARC_TRANSFER_READ_MARGIN_BLOCKS,
  ARBITRUM_TRANSFER_READ_CHUNK_BLOCKS,
  ARBITRUM_TRANSFER_READ_MARGIN_BLOCKS,
  AVALANCHE_TRANSFER_READ_CHUNK_BLOCKS,
  AVALANCHE_TRANSFER_READ_MARGIN_BLOCKS,
  BNB_TRANSFER_READ_CHUNK_BLOCKS,
  CELO_TRANSFER_READ_CHUNK_BLOCKS,
  locateEvmBlock,
  STELLAR_LATE_READ_MAX_PAGES,
  STELLAR_LATE_READ_OPERATIONS_PER_PAGE,
  type ChainTransfer,
  type StellarHorizonLateReadClient,
} from "@/lib/settlements/recover-late";
import { EVM_INDEX_CHAINS } from "@/lib/settlements/index-evm";
import { payerReconcilePurchaseNetwork } from "@/lib/settlements/payer-reconcile-network";
import { redactForLog, redactUrls } from "@/lib/observatory/redact";

const TRANSFER_LOG = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const TEMPO_TRANSFER_WITH_MEMO_LOG = parseAbiItem(
  "event TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 indexed memo)",
);
const BASE_NETWORK_KEYS = ["eip155:8453", "base"];
const BASE_USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_INDEX_CHAIN = EVM_INDEX_CHAINS.find((c) => c.caip2 === "eip155:8453");
/** index-settlements の Base subWindow と同じ幅で区切る。 */
const BASE_PAYER_LOG_CHUNK_BLOCKS = BASE_INDEX_CHAIN?.subWindowBlocks ?? 20_000n;
/** v2 token-transfers の 1 ページあたり件数（Blockscout 既定 50）。 */
const BASE_BLOCKSCOUT_V2_PAGE_SIZE = 50;
/** 窓の始端まで遡れなければ unavailable（stellar の horizon_scan_incomplete と同型）。 */
const BASE_BLOCKSCOUT_MAX_PAGES = 50;
const PAYER_BASE_LOG_CONCURRENCY = 1;
const PAYER_BASE_RATE_LIMIT_RETRIES = 3;
export const PAYER_RECONCILE_LOCATE_BINARY_SEARCH_MAX_ITERS = 40;
const PAYER_ARC_LOG_CONCURRENCY = 1;
const PAYER_ARC_DEFAULT_CHUNK_DELAY_MS = 100;
/**
 * Robinhood のブロックは約 0.11 秒（2026-11-27 公開 RPC で 10 万ブロックを実測）。2 日の窓は約 160 万ブロック。
 * 500 刻みでは 3,000 回を超える getLogs になり、本番で締切切れになった。公開 RPC は 1 回 1,000 万ブロックまで受け、
 * 払い手で絞った 160 万ブロックの getLogs は 0.2 秒で返った。だから 100 万刻みにする（数回で読み切る）。
 */
const ROBINHOOD_PAYER_LOG_CHUNK_BLOCKS = 1_000_000n;
const ROBINHOOD_BLOCK_SECONDS = 0.11;
/** 許容 30 秒をこのブロック間隔で覆う幅（30 / 0.11 ≒ 273）に余裕を足す。 */
const ROBINHOOD_PAYER_MARGIN_BLOCKS = 600n;
const PAYER_ROBINHOOD_LOG_CONCURRENCY = 1;
const PAYER_ROBINHOOD_RATE_LIMIT_RETRIES = 5;
const PAYER_ROBINHOOD_DEFAULT_CHUNK_DELAY_MS = 150;

function robinhoodPayerLogDelayMs(): number {
  const raw = process.env.GET_LOGS_CHUNK_DELAY_MS;
  if (!raw) return PAYER_ROBINHOOD_DEFAULT_CHUNK_DELAY_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : PAYER_ROBINHOOD_DEFAULT_CHUNK_DELAY_MS;
}

function arcPayerLogDelayMs(): number {
  const raw = process.env.GET_LOGS_CHUNK_DELAY_MS;
  if (!raw) return PAYER_ARC_DEFAULT_CHUNK_DELAY_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : PAYER_ARC_DEFAULT_CHUNK_DELAY_MS;
}

const ROBINHOOD_CHAIN = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RWA_PUBLIC_RPC_URL] } },
});

export type PayerOutgoingReadResult =
  | { ok: true; transfers: ChainTransfer[]; readThroughMs?: number }
  | { ok: false; detail: string };

export type PayerOutgoingReader = (q: {
  network: string;
  payer: string;
  from: Date;
  to: Date;
  timeoutMs?: number;
  signal?: AbortSignal;
}) => Promise<PayerOutgoingReadResult>;

export function payerOutgoingOk(transfers: ChainTransfer[], readThroughMs?: number): PayerOutgoingReadResult {
  return readThroughMs !== undefined ? { ok: true, transfers, readThroughMs } : { ok: true, transfers };
}

export function payerOutgoingFail(detail: string): PayerOutgoingReadResult {
  return { ok: false, detail };
}

/** read_failed の detail 欄・ログ用。URL とクエリは伏せる。 */
export function formatPayerOutgoingFailure(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "AbortError: aborted";
  const e = error as {
    name?: string;
    message?: string;
    code?: number;
    shortMessage?: string;
    details?: string;
    cause?: { name?: string; message?: string; code?: number; details?: string; shortMessage?: string };
  };
  const name =
    (typeof e?.name === "string" && e.name) ||
    (typeof e?.cause?.name === "string" && e.cause.name) ||
    "Error";
  const bits: string[] = [name];
  const code = e?.code ?? e?.cause?.code;
  if (code !== undefined) bits.push(`code=${code}`);
  const raw = [e?.details, e?.shortMessage, e?.message, e?.cause?.details, e?.cause?.shortMessage, e?.cause?.message]
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .join(" ")
  .replace(/\s+/g, " ")
    .slice(0, 220);
  const msg = redactForLog(redactUrls(raw));
  if (msg) bits.push(msg);
  return bits.join(": ");
}

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

export type BlockscoutIndexedHeadMs = (chainId: number, budgetMs?: number) => Promise<number>;

export type BasePayerBlockscoutFetch = (
  payer: Address,
  opts: {
    contractAddress: Address;
    chainId: number;
    budgetMs?: number;
    cursor?: Record<string, string> | null;
  },
) => Promise<PayerTokenTransfersV2Page>;

/**
 * 時刻 t 以下でいちばん新しいブロック（照合専用・recover-late の locateEvmBlock は触らない）。
 */
export async function locateEvmBlockBinarySearch(
  c: Pick<EvmLogClient, "getBlock">,
  head: { number: bigint; timestamp: bigint },
  t: Date,
  expired: () => void,
  chainName: string,
  maxIters = PAYER_RECONCILE_LOCATE_BINARY_SEARCH_MAX_ITERS,
): Promise<bigint> {
  const targetMs = t.getTime();
  const headMs = Number(head.timestamp) * 1000;
  if (targetMs >= headMs) return head.number;
  let lo = 0n;
  let hi = head.number;
  let iters = 0;
  while (lo < hi && iters < maxIters) {
    expired();
    iters++;
    const mid = lo + (hi - lo + 1n) / 2n;
    const block = await c.getBlock({ blockNumber: mid });
    const blockMs = Number(block.timestamp) * 1000;
    if (blockMs <= targetMs) lo = mid;
    else hi = mid - 1n;
  }
  expired();
  if (lo < hi) {
    throw new Error(
      `could not locate the ${chainName} block for the window (binary search iteration cap); head_block=${head.number} head_time=${new Date(headMs).toISOString()}`,
    );
  }
  const chosen = await c.getBlock({ blockNumber: lo });
  if (Number(chosen.timestamp) * 1000 > targetMs) {
    throw new Error(
      `could not locate the ${chainName} block for the window; head_block=${head.number} head_time=${new Date(headMs).toISOString()}`,
    );
  }
  return lo;
}

type TransferPageReadOpts = { /** Alchemy は満たないページでも pageKey で続けうる。 */ alchemyPagination?: boolean };

async function readPayerOutgoingViaTransferPages(
  payer: string,
  from: Date,
  to: Date,
  deadline: number,
  signal: AbortSignal | undefined,
  fetchPage: BasePayerBlockscoutFetch,
  pageOpts: TransferPageReadOpts = {},
): Promise<PayerOutgoingReadResult> {
  const fromSec = Math.floor(from.getTime() / 1000);
  const toSec = Math.floor(to.getTime() / 1000);
  const payerLower = payer.toLowerCase();
  const out: ChainTransfer[] = [];
  const seen = new Set<string>();
  let pages = 0;
  let reachedPastWindow = false;
  let cursor: Record<string, string> | null = null;

  while (pages < BASE_BLOCKSCOUT_MAX_PAGES) {
    throwIfAborted(signal);
    if (Date.now() > deadline) return payerOutgoingFail("Error: transfer read ran past its time limit");
    const budgetMs = deadline === Infinity ? undefined : Math.max(1, deadline - Date.now());
    const page = await fetchPage(payer as Address, {
      contractAddress: BASE_USDC,
      chainId: BASE_CHAIN_ID,
      budgetMs,
      cursor,
    });
    pages++;
    if (page.rawItemCount === 0) {
      reachedPastWindow = true;
      break;
    }
    for (const tx of page.rows) {
      const ts = Number(tx.timeStamp);
      if (!Number.isFinite(ts)) continue;
      if (ts < fromSec || ts > toSec) continue;
      if (tx.from.toLowerCase() !== payerLower) continue;
      const hash = tx.hash;
      if (!hash) continue;
      const key = hash.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        txHash: hash,
        from: tx.from,
        to: tx.to,
        value: tx.value,
        blockTime: new Date(ts * 1000).toISOString(),
        blockNumber: BigInt(tx.blockNumber),
      });
    }
    if (page.pageOldestSec !== null && page.pageOldestSec < fromSec) {
      reachedPastWindow = true;
      break;
    }
    // 次のページの鍵が無ければ終わり。Blockscout は満たないページで終わる（Alchemy は満たないページでも pageKey を返しうる）。
    const alchemyPagination = pageOpts.alchemyPagination === true;
    if (
      !page.nextCursor ||
      (!alchemyPagination && page.rawItemCount < BASE_BLOCKSCOUT_V2_PAGE_SIZE)
    ) {
      reachedPastWindow = true;
      break;
    }
    cursor = page.nextCursor;
  }
  if (!reachedPastWindow) return payerOutgoingFail("blockscout_scan_incomplete");
  return payerOutgoingOk(out);
}

async function readBasePayerOutgoingViaBlockscout(
  payer: string,
  from: Date,
  to: Date,
  deadline: number,
  signal: AbortSignal | undefined,
  fetchPage: BasePayerBlockscoutFetch,
  pageOpts?: TransferPageReadOpts,
): Promise<PayerOutgoingReadResult> {
  return readPayerOutgoingViaTransferPages(payer, from, to, deadline, signal, fetchPage, pageOpts);
}

async function readBasePayerOutgoingViaRpc(
  c: EvmLogClient,
  payer: string,
  from: Date,
  to: Date,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<PayerOutgoingReadResult> {
  const head = await c.getBlock({ blockTag: "latest" });
  throwIfAborted(signal);
  const blockAt = (t: Date) => firstBlockAtOrAfter(BASE_BLOCK_TIME_SCHEDULE, t.getTime() / 1000);
  const headMs = Number(head.timestamp) * 1000;
  const fromBlock = blockAt(from) - 60n;
  const toBlock = blockAt(to) + 60n > head.number ? head.number : blockAt(to) + 60n;
  if (fromBlock < 0n) return payerOutgoingFail("invalid_block_range: fromBlock < 0");
  if (fromBlock > toBlock) return payerOutgoingFail("invalid_block_range: fromBlock > toBlock");
  const readThroughMs = Math.min(to.getTime(), headMs);
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
    BASE_PAYER_LOG_CHUNK_BLOCKS,
    PAYER_BASE_LOG_CONCURRENCY,
    remainingMs === undefined
      ? { signal, rateLimitMaxRetries: PAYER_BASE_RATE_LIMIT_RETRIES }
      : { deadlineMs: remainingMs, delayMs: 0, signal, rateLimitMaxRetries: PAYER_BASE_RATE_LIMIT_RETRIES },
  )) as unknown as {
    blockNumber: bigint | null;
    transactionHash: string | null;
    args: { from: Address; to: Address; value?: bigint };
  }[];
  const out: ChainTransfer[] = [];
  for (const l of logs) {
    throwIfAborted(signal);
    if (Date.now() > deadline) return payerOutgoingFail("Error: transfer read ran past its time limit");
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
  return payerOutgoingOk(out, readThroughMs < to.getTime() ? readThroughMs : undefined);
}

/** 払い手 reconciliation 用の Alchemy 1 ページ取得（chainId 固定）。 */
export function makeAlchemyPayerFetch(chainId: number): BasePayerBlockscoutFetch {
  return async (payer, opts) => {
    const page = await fetchAssetTransfersPage({
      address: payer,
      direction: "from",
      categories: ["erc20"],
      contractAddress: opts.contractAddress,
      limit: 1000,
      order: "desc",
      chainId,
      budgetMs: opts.budgetMs,
      pageKey: opts.cursor?.pageKey ?? null,
    });
    let pageOldestSec: number | null = null;
    const rows = page.transfers.map((t) => {
      const sec = Number(t.timeStamp);
      // 時刻の無い行は窓の外として捨てると、記録に無い送金を黙って見逃す。読めなかったことにして従来の読み先へ戻す。
      if (!Number.isFinite(sec) || sec <= 0) throw new AlchemyUnavailableError("alchemy_missing_block_timestamp");
      if (Number.isFinite(sec) && sec > 0 && (pageOldestSec === null || sec < pageOldestSec)) pageOldestSec = sec;
      return { hash: t.hash, blockNumber: t.blockNumber, timeStamp: t.timeStamp, from: t.from, to: t.to, value: t.value };
    });
    return { rows, rawItemCount: page.rawCount, pageOldestSec, nextCursor: page.pageKey ? { pageKey: page.pageKey } : null };
  };
}

/**
 * Base の払い手の USDC 送金を Alchemy の alchemy_getAssetTransfers（fromAddress・新しい順・pageKey）で読む。
 * readBasePayerOutgoingViaBlockscout と同じページの形で返し、窓の判定はそちらに任せる（2026-11-27:
 * base.blockscout.com が Cloudflare の確認画面で 403 を返し、公開 RPC は getLogs を回数で断った）。
 */
export const alchemyBasePayerFetch: BasePayerBlockscoutFetch = makeAlchemyPayerFetch(BASE_CHAIN_ID);

function makeAlchemyFirstEvmPayerOutgoingReader(cfg: EvmOutgoingConfig): PayerOutgoingReader {
  const rpcReader = makeEvmPayerOutgoingReader(cfg);
  const alchemyFetch = makeAlchemyPayerFetch(cfg.chainId);
  return async (query) => {
    if (query.network !== cfg.network) return payerOutgoingFail("wrong_network");
    throwIfAborted(query.signal);
    const deadline = typeof query.timeoutMs === "number" ? Date.now() + query.timeoutMs : Infinity;
    if (isAlchemyEnabled(cfg.chainId)) {
      try {
        const viaAlchemy = await readPayerOutgoingViaTransferPages(
          query.payer,
          query.from,
          query.to,
          deadline,
          query.signal,
          (payer, opts) => alchemyFetch(payer, { ...opts, contractAddress: cfg.token, chainId: cfg.chainId }),
          { alchemyPagination: true },
        );
        if (viaAlchemy.ok) return viaAlchemy;
      } catch (e) {
        // 読めなかった（AlchemyUnavailableError ほか）: Base と同じく止めずに従来の RPC へ。中断だけは投げる。
        if (!(e instanceof AlchemyUnavailableError)) throwIfAborted(query.signal);
      }
    }
    // RPC へ戻るときは残り時間だけを渡す（Alchemy で使った時間を足し直して照合の締切を越えない）。
    if (deadline === Infinity) return rpcReader(query);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return payerOutgoingFail("Error: transfer read ran past its time limit");
    return rpcReader({ ...query, timeoutMs: remainingMs });
  };
}

/**
 * Avalanche 払い手: Alchemy → Routescan tokentx → RPC getLogs（2026-11-27 本番で Alchemy/RPC が読めず Routescan は鍵なしで読める）。
 */
export function makeAvalanchePayerOutgoingReader(
  cfg: EvmOutgoingConfig,
  routescanFetch: RoutescanPayerTokenTxFetch = makeRoutescanAvalanchePayerFetch(),
): PayerOutgoingReader {
  const rpcReader = makeEvmPayerOutgoingReader(cfg);
  const alchemyFetch = makeAlchemyPayerFetch(cfg.chainId);
  return async (query) => {
    if (query.network !== cfg.network) return payerOutgoingFail("wrong_network");
    throwIfAborted(query.signal);
    const deadline = typeof query.timeoutMs === "number" ? Date.now() + query.timeoutMs : Infinity;
    if (isAlchemyEnabled(cfg.chainId)) {
      try {
        const viaAlchemy = await readPayerOutgoingViaTransferPages(
          query.payer,
          query.from,
          query.to,
          deadline,
          query.signal,
          (payer, opts) => alchemyFetch(payer, { ...opts, contractAddress: cfg.token, chainId: cfg.chainId }),
          { alchemyPagination: true },
        );
        if (viaAlchemy.ok) return viaAlchemy;
      } catch (e) {
        if (!(e instanceof AlchemyUnavailableError)) throwIfAborted(query.signal);
      }
    }
    try {
      const viaRoutescan = await readPayerOutgoingViaTransferPages(
        query.payer,
        query.from,
        query.to,
        deadline,
        query.signal,
        (payer, opts) => routescanFetch(payer, { ...opts, contractAddress: cfg.token, chainId: cfg.chainId }),
      );
      if (viaRoutescan.ok) return viaRoutescan;
    } catch (e) {
      if (!(e instanceof RoutescanUnavailableError)) throwIfAborted(query.signal);
    }
    if (deadline === Infinity) return rpcReader(query);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return payerOutgoingFail("Error: transfer read ran past its time limit");
    return rpcReader({ ...query, timeoutMs: remainingMs });
  };
}

const AVALANCHE_PAYER_OUTGOING_CFG: EvmOutgoingConfig = {
  network: AVALANCHE_CAIP2,
  chainId: AVALANCHE_CHAIN_ID,
  token: AVALANCHE_USDC_ADDRESS as Address,
  chunkBlocks: AVALANCHE_TRANSFER_READ_CHUNK_BLOCKS,
  marginBlocks: AVALANCHE_TRANSFER_READ_MARGIN_BLOCKS,
  blockSeconds: 0.97,
  toleranceSeconds: 30,
  chainName: "Avalanche",
  client: () => rpcClient(avalanche, process.env.AVALANCHE_RPC_URL?.trim(), 20_000),
  binarySearchOnLocateFailure: true,
  chunkedGetLogs: {
    concurrency: PAYER_ARC_LOG_CONCURRENCY,
    rateLimitMaxRetries: PAYER_BASE_RATE_LIMIT_RETRIES,
    delayMs: 0,
  },
};

export function makeBasePayerOutgoingReader(
  client?: EvmLogClient,
  blockscoutFetch?: BasePayerBlockscoutFetch,
  indexedHeadMs: BlockscoutIndexedHeadMs = fetchBlockscoutIndexedHeadMs,
): PayerOutgoingReader {
  const fetchPage =
    blockscoutFetch ??
    ((payer, opts) => fetchPayerTokenTransfersV2Page(payer, opts.contractAddress, opts));
  return async ({ network, payer, from, to, timeoutMs, signal }) => {
    if (!BASE_NETWORK_KEYS.includes(network)) return payerOutgoingFail("wrong_network");
    throwIfAborted(signal);
    const deadline = typeof timeoutMs === "number" ? Date.now() + timeoutMs : Infinity;
    // Alchemy の鍵がある本番では、まず Alchemy で読む（差し替えの fetch を渡したテストは従来どおり）。
    // 索引は最新のブロックまでなので、読めた窓をそのまま返す。読めなければ従来の Blockscout → RPC へ。
    if (!blockscoutFetch && isAlchemyEnabled(BASE_CHAIN_ID)) {
      try {
        const viaAlchemy = await readBasePayerOutgoingViaBlockscout(
          payer,
          from,
          to,
          deadline,
          signal,
          alchemyBasePayerFetch,
          { alchemyPagination: true },
        );
        if (viaAlchemy.ok) return viaAlchemy;
      } catch (e) {
        // 読めなかった（AlchemyUnavailableError ほか）: 止めずに従来の読み先へ。中断だけは従来どおり投げる。
        if (!(e instanceof AlchemyUnavailableError)) throwIfAborted(signal);
      }
    }
    try {
      const blockscout = await readBasePayerOutgoingViaBlockscout(payer, from, to, deadline, signal, fetchPage);
      if (!blockscout.ok) return blockscout;
      const budgetMs = deadline === Infinity ? undefined : Math.max(1, deadline - Date.now());
      const indexedMs = await indexedHeadMs(BASE_CHAIN_ID, budgetMs);
      const readThroughMs = Math.min(to.getTime(), indexedMs);
      return payerOutgoingOk(
        blockscout.transfers,
        readThroughMs < to.getTime() ? readThroughMs : undefined,
      );
    } catch (e) {
      if (e instanceof BlockscoutUnavailableError) {
        try {
          const c = client ?? (typeof timeoutMs === "number" ? boundedBaseClient(timeoutMs) : getLogScanClient(8453));
          const chainId = await c.getChainId();
          if (chainId !== BASE_CHAIN_ID) {
            return payerOutgoingFail(`wrong_chain_id: rpc=${chainId} expected=${BASE_CHAIN_ID}`);
          }
          return await readBasePayerOutgoingViaRpc(c, payer, from, to, deadline, signal);
        } catch (rpcErr) {
          if (signal?.aborted || (rpcErr instanceof DOMException && rpcErr.name === "AbortError")) {
            return payerOutgoingFail("AbortError: aborted");
          }
          return payerOutgoingFail(formatPayerOutgoingFailure(rpcErr));
        }
      }
      if (signal?.aborted || (e instanceof DOMException && e.name === "AbortError")) {
        return payerOutgoingFail("AbortError: aborted");
      }
      return payerOutgoingFail(formatPayerOutgoingFailure(e));
    }
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
  chainName: string;
  client: () => EvmLogClient | null;
  formatAmount?: (raw: bigint) => string | null;
  tempoMemo?: boolean;
  /** recover-late の Base と同じ getLogsChunked（上限エラー再試行・区切り間の待ち）。 */
  chunkedGetLogs?: {
    concurrency: number;
    rateLimitMaxRetries: number;
    delayMs: number;
  };
  /** locateEvmBlock が失敗したら getBlock の二分探索で探し直す（Avalanche・Robinhood）。 */
  binarySearchOnLocateFailure?: boolean;
};

async function locateBlockForPayerReconcile(
  c: EvmLogClient,
  head: { number: bigint; timestamp: bigint },
  t: Date,
  cfg: EvmOutgoingConfig,
  expired: () => void,
): Promise<bigint> {
  try {
    return await locateEvmBlock(
      c,
      head,
      t,
      cfg.blockSeconds,
      cfg.toleranceSeconds,
      expired,
      cfg.chainName,
    );
  } catch (e) {
    if (!cfg.binarySearchOnLocateFailure) throw e;
    return locateEvmBlockBinarySearch(c, head, t, expired, cfg.chainName);
  }
}

async function readEvmPayerOutgoing(
  c: EvmLogClient,
  cfg: EvmOutgoingConfig,
  payer: string,
  from: Date,
  to: Date,
  deadline: number,
  event: typeof TRANSFER_LOG | typeof TEMPO_TRANSFER_WITH_MEMO_LOG,
  signal?: AbortSignal,
): Promise<PayerOutgoingReadResult> {
  const expired = () => {
    throwIfAborted(signal);
    if (Date.now() > deadline) throw new Error("transfer read ran past its time limit");
  };
  throwIfAborted(signal);
  const [chainId, head] = await Promise.all([c.getChainId(), c.getBlock({ blockTag: "latest" })]);
  if (chainId !== cfg.chainId) {
    return payerOutgoingFail(`wrong_chain_id: rpc=${chainId} expected=${cfg.chainId}`);
  }
  const headMs = Number(head.timestamp) * 1000;
  const effectiveToMs = Math.min(to.getTime(), headMs);
  if (effectiveToMs < from.getTime()) {
    return payerOutgoingFail(`node_behind_window: head=${new Date(headMs).toISOString()} before_from=${from.toISOString()}`);
  }
  const windowTo = new Date(effectiveToMs);
  const expiredLocate = () => {
    expired();
  };
  try {
    const [fromAt, toAt] = await Promise.all([
      locateBlockForPayerReconcile(c, head, from, cfg, expiredLocate),
      locateBlockForPayerReconcile(c, head, windowTo, cfg, expiredLocate),
    ]);
    const fromBlock = fromAt - cfg.marginBlocks < 0n ? 0n : fromAt - cfg.marginBlocks;
    const toBlock = toAt + cfg.marginBlocks > head.number ? head.number : toAt + cfg.marginBlocks;
    if (fromBlock > toBlock) return payerOutgoingOk([]);
    const out: ChainTransfer[] = [];
    const pushLog = (l: {
      blockNumber: bigint | null;
      transactionHash: string | null;
      args: { from?: unknown; to?: unknown; value?: bigint; amount?: bigint };
    }) => {
      if (l.blockNumber === null || !l.transactionHash) return;
      const args = l.args;
      const raw = cfg.tempoMemo ? args.amount : args.value;
      if (typeof raw !== "bigint") return;
      const value = cfg.formatAmount ? cfg.formatAmount(raw) : raw.toString();
      if (value === null) return;
      expired();
      out.push({
        txHash: l.transactionHash,
        from: String(args.from),
        to: String(args.to),
        value,
        blockTime: "",
        blockNumber: l.blockNumber,
      });
    };
    if (cfg.chunkedGetLogs) {
      const remainingMs = deadline === Infinity ? undefined : Math.max(1, deadline - Date.now());
      const logs = (await getLogsChunked(
        c as unknown as Parameters<typeof getLogsChunked>[0],
        {
          address: cfg.token,
          event,
          args: { from: payer as Address },
          fromBlock,
          toBlock,
        } as never,
        cfg.chunkBlocks,
        cfg.chunkedGetLogs.concurrency,
        {
          signal,
          delayMs: cfg.chunkedGetLogs.delayMs,
          rateLimitMaxRetries: cfg.chunkedGetLogs.rateLimitMaxRetries,
          ...(remainingMs === undefined ? {} : { deadlineMs: remainingMs }),
        },
      )) as unknown as {
        blockNumber: bigint | null;
        transactionHash: string | null;
        args: { from?: unknown; to?: unknown; value?: bigint; amount?: bigint };
      }[];
      for (const l of logs) pushLog(l);
    } else {
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
        for (const l of logs) pushLog(l);
      }
    }
    const partialHead = headMs < to.getTime();
    return payerOutgoingOk(out, partialHead ? effectiveToMs : undefined);
  } catch (e) {
    return payerOutgoingFail(formatPayerOutgoingFailure(e));
  }
}

function mergeUniqueOutgoing(parts: PayerOutgoingReadResult[]): PayerOutgoingReadResult {
  const failed = parts.find((p) => !p.ok);
  if (failed && !failed.ok) return failed;
  const map = new Map<string, ChainTransfer>();
  let readThroughMs: number | undefined;
  for (const part of parts) {
    if (!part.ok) continue;
    if (part.readThroughMs !== undefined) {
      readThroughMs =
        readThroughMs === undefined ? part.readThroughMs : Math.min(readThroughMs, part.readThroughMs);
    }
    for (const t of part.transfers) {
      const key = t.txHash.toLowerCase();
      if (!map.has(key)) map.set(key, t);
    }
  }
  return payerOutgoingOk([...map.values()], readThroughMs);
}

export function makeEvmPayerOutgoingReader(cfg: EvmOutgoingConfig, dualTempo = false): PayerOutgoingReader {
  return async ({ network, payer, from, to, timeoutMs, signal }) => {
    if (network !== cfg.network) return payerOutgoingFail("wrong_network");
    throwIfAborted(signal);
    const c = cfg.client();
    if (!c) return payerOutgoingFail(`missing_rpc: ${cfg.network}`);
    const deadline = typeof timeoutMs === "number" ? Date.now() + timeoutMs : Infinity;
    try {
      if (dualTempo) {
        const [memo, plain] = await Promise.all([
          readEvmPayerOutgoing(c, cfg, payer, from, to, deadline, TEMPO_TRANSFER_WITH_MEMO_LOG, signal),
          readEvmPayerOutgoing(c, cfg, payer, from, to, deadline, TRANSFER_LOG, signal),
        ]);
        return mergeUniqueOutgoing([memo, plain]);
      }
      const event = cfg.tempoMemo ? TEMPO_TRANSFER_WITH_MEMO_LOG : TRANSFER_LOG;
      return await readEvmPayerOutgoing(c, cfg, payer, from, to, deadline, event, signal);
    } catch (e) {
      if (signal?.aborted || (e instanceof DOMException && e.name === "AbortError")) {
        return payerOutgoingFail("AbortError: aborted");
      }
      return payerOutgoingFail(formatPayerOutgoingFailure(e));
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
    if (network !== STELLAR_PUBNET_CAIP2) return payerOutgoingFail("wrong_network");
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
        if (res.status === 429) throw new Error(`horizon_rate_limited: http=${res.status}`);
        if (!res.ok) throw new Error(`horizon_http_error: http=${res.status}`);
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
      if (Date.now() > deadline) return payerOutgoingFail("Error: transfer read ran past its time limit");
      pages++;
      let page: Awaited<ReturnType<NonNullable<StellarHorizonLateReadClient["getOperationsPage"]>>> | null;
      try {
        page = client ? await client.getOperationsPage(payer, cursor) : await getPage(cursor);
      } catch (e) {
        return payerOutgoingFail(formatPayerOutgoingFailure(e));
      }
      if (!page) return payerOutgoingFail("horizon_page_unavailable");
      const { records, nextCursor } = page;
      if (records.length === 0) {
        reachedPastWindow = true;
        break;
      }
      let oldestMs: number | null = null;
      for (const raw of records) {
        const op = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
        if (!op) return payerOutgoingFail("horizon_malformed_operation");
        const createdAt = typeof op.created_at === "string" ? op.created_at : null;
        const bt = createdAt !== null ? Date.parse(createdAt) : NaN;
        if (!Number.isFinite(bt)) return payerOutgoingFail("horizon_invalid_created_at");
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
    if (!reachedPastWindow) return payerOutgoingFail("horizon_scan_incomplete");
    return payerOutgoingOk(out);
  };
}

export function makeSolanaPayerOutgoingReader(): PayerOutgoingReader {
  return async ({ network, payer, from, to, timeoutMs, signal }) => {
    if (network !== SOLANA_MAINNET_CAIP2) return payerOutgoingFail("wrong_network");
    throwIfAborted(signal);
    const url = process.env.SOLANA_RPC_URL?.trim();
    if (!url) return payerOutgoingFail("missing_rpc: SOLANA_RPC_URL");
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
    if (!account) return payerOutgoingFail("invalid_solana_payer");
    const fromSeconds = Math.floor(from.getTime() / 1000);
    const toSeconds = Math.ceil(to.getTime() / 1000);
    const sigs: { signature: string; blockTime: number }[] = [];
    let before: string | undefined;
    let sigScanComplete = false;
    for (let pages = 0; pages < 20; pages++) {
      throwIfAborted(signal);
      if (Date.now() > deadline) return payerOutgoingFail("Error: transfer read ran past its time limit");
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
    if (!sigScanComplete) return payerOutgoingFail("solana_signature_scan_incomplete");
    const out: ChainTransfer[] = [];
    const seen = new Set<string>();
    for (const { signature, blockTime } of sigs) {
      throwIfAborted(signal);
      if (Date.now() > deadline) return payerOutgoingFail("Error: transfer read ran past its time limit");
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
    return payerOutgoingOk(out);
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
    if (network !== XRPL_MAINNET_CAIP2) return payerOutgoingFail("wrong_network");
    throwIfAborted(signal);
    const rpcUrl = process.env.XRPL_RPC_URL?.trim();
    if (!rpcUrl) return payerOutgoingFail("missing_rpc: XRPL_RPC_URL");
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
      if (Date.now() > deadline) return payerOutgoingFail("Error: transfer read ran past its time limit");
      pages++;
      let body: { transactions?: XrplAccountTxEntry[]; marker?: unknown } | null;
      try {
        body = (await rpc("account_tx", {
          account: payer,
          ledger_index_min: -1,
          ledger_index_max: -1,
          binary: false,
          forward: false,
          limit: 200,
          ...(marker !== undefined ? { marker } : {}),
        })) as { transactions?: XrplAccountTxEntry[]; marker?: unknown };
      } catch (e) {
        return payerOutgoingFail(formatPayerOutgoingFailure(e));
      }
      if (!body || !Array.isArray(body.transactions)) return payerOutgoingFail("xrpl_account_tx_unavailable");
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
    if (!complete) return payerOutgoingFail("xrpl_scan_incomplete");
    return payerOutgoingOk(out);
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
    chainName: "Celo",
    client: () => rpcClient(celo, process.env.CELO_RPC_URL?.trim(), 20_000),
  }),
  [BNB_CAIP2]: makeEvmPayerOutgoingReader({
    network: BNB_CAIP2,
    chainId: BNB_CHAIN_ID,
    token: BNB_USD1_ADDRESS as Address,
    chunkBlocks: BNB_TRANSFER_READ_CHUNK_BLOCKS,
    marginBlocks: 200n,
    blockSeconds: 0.45,
    toleranceSeconds: 30,
    chainName: "BNB",
    client: () => rpcClient(bsc, process.env.BNB_RPC_URL?.trim(), 20_000),
    formatAmount: (raw) => {
      const v = evmIndexLedgerAmount(BNB_CHAIN_ID, raw);
      return v === null ? null : v.toString();
    },
  }),
  [ARBITRUM_CAIP2]: makeAlchemyFirstEvmPayerOutgoingReader({
    network: ARBITRUM_CAIP2,
    chainId: ARBITRUM_CHAIN_ID,
    token: ARBITRUM_USDC_ADDRESS as Address,
    chunkBlocks: ARBITRUM_TRANSFER_READ_CHUNK_BLOCKS,
    marginBlocks: ARBITRUM_TRANSFER_READ_MARGIN_BLOCKS,
    blockSeconds: 0.28,
    toleranceSeconds: 30,
    chainName: "Arbitrum",
    client: () => rpcClient(arbitrum, process.env.ARBITRUM_RPC_URL?.trim(), 20_000),
    binarySearchOnLocateFailure: true,
  }),
  [AVALANCHE_CAIP2]: makeAvalanchePayerOutgoingReader(AVALANCHE_PAYER_OUTGOING_CFG),
  [ARC_CAIP2]: makeEvmPayerOutgoingReader({
    network: ARC_CAIP2,
    chainId: ARC_CHAIN_ID,
    token: ARC_USDC_ADDRESS as Address,
    chunkBlocks: ARC_TRANSFER_READ_CHUNK_BLOCKS,
    marginBlocks: ARC_TRANSFER_READ_MARGIN_BLOCKS,
    blockSeconds: 0.51,
    toleranceSeconds: 30,
    chainName: "Arc",
    client: () => rpcClient(arc, process.env.ARC_RPC_URL?.trim(), 20_000),
    chunkedGetLogs: {
      concurrency: PAYER_ARC_LOG_CONCURRENCY,
      rateLimitMaxRetries: PAYER_BASE_RATE_LIMIT_RETRIES,
      delayMs: arcPayerLogDelayMs(),
    },
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
      chainName: "Tempo",
      client: () => rpcClient(tempoChain, tempoRpcUrl(), 20_000),
      tempoMemo: true,
    },
    true,
  ),
  [ROBINHOOD_CAIP2]: makeEvmPayerOutgoingReader({
    network: ROBINHOOD_CAIP2,
    chainId: 4663,
    token: ROBINHOOD_USDG as Address,
    chunkBlocks: ROBINHOOD_PAYER_LOG_CHUNK_BLOCKS,
    marginBlocks: ROBINHOOD_PAYER_MARGIN_BLOCKS,
    blockSeconds: ROBINHOOD_BLOCK_SECONDS,
    toleranceSeconds: 30,
    chainName: "Robinhood",
    client: () => robinhoodClient(20_000),
    binarySearchOnLocateFailure: true,
    chunkedGetLogs: {
      concurrency: PAYER_ROBINHOOD_LOG_CONCURRENCY,
      rateLimitMaxRetries: PAYER_ROBINHOOD_RATE_LIMIT_RETRIES,
      delayMs: robinhoodPayerLogDelayMs(),
    },
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
    const network = payerReconcilePurchaseNetwork(q.network) ?? q.network;
    const query = network === q.network ? q : { ...q, network };
    if (PAYER_OUTGOING_UNAVAILABLE[network]) {
      return payerOutgoingFail(PAYER_OUTGOING_UNAVAILABLE[network]);
    }
    if (network === STELLAR_PUBNET_CAIP2) return stellar(query);
    if (network === SOLANA_MAINNET_CAIP2) return solana(query);
    if (network === XRPL_MAINNET_CAIP2) return xrpl(query);
    const evm = EVM_READERS[network];
    if (evm) return evm(query);
    if (BASE_NETWORK_KEYS.includes(network)) return baseReader(query);
    return payerOutgoingFail("no_payer_outgoing_reader");
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