// ============================================================
// payTo への Base USDC 入金を公開索引から期間指定で読む（KPI I0）。
// 読めなければ例外ではなく呼び手が unreadable にする。
// ============================================================
import type { Address } from "viem";
import { AlchemyUnavailableError, fetchAssetTransfersPage } from "@/lib/chain/alchemy";
import { BASE_CHAIN_ID, USDC } from "@/lib/x402/base-usdc";
import { createDeadline } from "@/lib/util/deadline";

const MAX_ALCHEMY_PAGES = 200;
const PAGE_LIMIT = 1000;

export type RawInboundUsdc = {
  txHash: string;
  blockNumber: string;
  timeStamp: string;
  from: string;
  to: string;
  value: string;
};

export type ReadInboundResult =
  | {
      ok: true;
      source: "alchemy" | "public_rpc";
      transfers: RawInboundUsdc[];
      /** 読み手が見た最新の時刻（秒）。期間の終わりより前なら、期間はまだ締まっていない */
      readThroughSec: number;
    }
  | { ok: false; detail: string };

async function readViaAlchemy(
  payTo: Address,
  fromSec: number,
  toExclusiveSec: number,
  budgetMs?: number,
): Promise<ReadInboundResult> {
  const deadline = createDeadline(budgetMs);
  const out: RawInboundUsdc[] = [];
  const seen = new Set<string>();
  let pageKey: string | null = null;
  let pages = 0;
  let reachedPast = false;

  try {
    while (pages < MAX_ALCHEMY_PAGES) {
      deadline.throwIfExpired("kpi_x402_alchemy");
      const page = await fetchAssetTransfersPage({
        address: payTo,
        direction: "to",
        categories: ["erc20"],
        contractAddress: USDC as Address,
        limit: PAGE_LIMIT,
        order: "desc",
        chainId: BASE_CHAIN_ID,
        budgetMs: budgetMs === undefined ? undefined : deadline.remaining(),
        pageKey,
      });
      pages += 1;
      if (page.rawCount === 0 && !page.pageKey) break;

      let pageOldest = Infinity;
      for (const t of page.transfers) {
        const sec = Number(t.timeStamp);
        if (!Number.isFinite(sec) || sec <= 0) {
          return { ok: false, detail: "alchemy_missing_block_timestamp" };
        }
        if (sec < pageOldest) pageOldest = sec;
        if (sec >= toExclusiveSec) continue;
        if (sec < fromSec) {
          reachedPast = true;
          continue;
        }
        const toL = t.to.toLowerCase();
        if (toL !== payTo.toLowerCase()) continue;
        // uniqueId は Alchemy が転送ごとに振る ID（tx 内の log まで区別する）。同じ tx に同じ額の Transfer が 2 つあっても潰さない。
        const key = t.uniqueId;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          txHash: t.hash,
          blockNumber: t.blockNumber,
          timeStamp: t.timeStamp,
          from: t.from,
          to: t.to,
          value: t.value,
        });
      }

      if (reachedPast) break;
      if (!page.pageKey) break;
      pageKey = page.pageKey;
      if (pageOldest < fromSec) reachedPast = true;
      if (reachedPast) break;
    }

    if (pages >= MAX_ALCHEMY_PAGES && !reachedPast) {
      return { ok: false, detail: "alchemy_page_limit" };
    }
    // Alchemy は最新ブロックまで返す。見た時刻は読み終えた時点とする。
    return { ok: true, source: "alchemy", transfers: out, readThroughSec: Math.floor(Date.now() / 1000) };
  } catch (e) {
    const msg =
      e instanceof AlchemyUnavailableError
        ? e.message
        : e instanceof Error
          ? e.message
          : "alchemy_error";
    return { ok: false, detail: msg };
  }
}

/** Base の公開 RPC。鍵なしで eth_getLogs を 1 回 50,000 ブロックまで受け付ける（2026-11-27 実測）。 */
export const BASE_PUBLIC_RPC_URL = "https://base-rpc.publicnode.com";
/** 1 回の eth_getLogs で問う包含ブロック数。 */
export const PUBLIC_RPC_LOG_CHUNK_BLOCKS = 50_000;
/** 挟み込みで 1 回に戻るブロック数の上限。保持範囲の外へ大きく飛ばないため。 */
const MAX_BACK_STEP_BLOCKS = 2_000_000;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export type JsonRpcFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

type RpcLog = {
  transactionHash?: string;
  blockNumber?: string;
  logIndex?: string;
  topics?: string[];
  data?: string;
  removed?: boolean;
};

/** 公開 RPC への 1 回の呼び出しの上限。応答が返らないまま予算を食い潰さないため。 */
const PUBLIC_RPC_CALL_TIMEOUT_MS = 30_000;

function topicToAddress(topic: string): string {
  return `0x${topic.slice(-40)}`.toLowerCase();
}

function padAddressTopic(addr: string): string {
  return `0x${addr.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

async function readViaPublicRpc(
  payTo: Address,
  fromSec: number,
  toExclusiveSec: number,
  opts: { budgetMs?: number; rpcUrl?: string; fetchImpl?: JsonRpcFetch } = {},
): Promise<ReadInboundResult> {
  const url = opts.rpcUrl ?? BASE_PUBLIC_RPC_URL;
  const fetchImpl: JsonRpcFetch = opts.fetchImpl ?? ((u, init) => fetch(u, init));
  const deadline = createDeadline(opts.budgetMs);
  let id = 0;

  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    deadline.throwIfExpired("kpi_x402_public_rpc");
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      signal: AbortSignal.timeout(PUBLIC_RPC_CALL_TIMEOUT_MS),
    });
    if (!res.ok) {
      let why = "";
      try {
        const errBody = (await res.json()) as { error?: { message?: string } };
        if (/archive/i.test(errBody.error?.message ?? "")) why = ":archive_range_refused";
      } catch {
        // 本文が JSON でなければ状態コードだけ
      }
      throw new Error(`public_rpc_http_${res.status}:${method}${why}`);
    }
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (body.error) throw new Error(`public_rpc_error:${method}:${body.error.message ?? "unknown"}`);
    if (body.result === undefined || body.result === null) throw new Error(`public_rpc_empty:${method}`);
    return body.result;
  }

  const tsCache = new Map<number, number>();
  async function blockTime(n: number): Promise<number> {
    const hit = tsCache.get(n);
    if (hit !== undefined) return hit;
    const b = await rpc<{ timestamp?: string }>("eth_getBlockByNumber", [`0x${n.toString(16)}`, false]);
    const t = Number(BigInt(b.timestamp ?? "0x0"));
    if (!(t > 0)) throw new Error(`public_rpc_missing_block_timestamp:${n}`);
    tsCache.set(n, t);
    return t;
  }

  /**
   * 時刻 sec 以上の最初のブロック。head の時刻が sec より前なら head+1。
   * 公開 RPC は古いブロックの読み取りを「Archive requests require a personal token」で断る（2026-11-27 実測）。
   * ブロック間隔も一定ではない（直近は 1 秒未満）。だから全履歴の二分探索はせず、直近の間隔から見積もった
   * 下限から挟み込み、補間で詰める。読むのは目的のブロックの近くだけ。
   */
  async function firstBlockAtOrAfter(sec: number, head: number, headTs: number): Promise<number> {
    if (headTs < sec) return head + 1;
    // ブロック間隔は時期で違う（2026-11-27 実測: 直近は 0.2 秒、9〜11 月は約 1.6 秒）。
    // 見積もりの半分ずつ戻り、戻るたびに実測の間隔で見積もり直す。行き過ぎて公開 RPC の保持範囲の外を読まないため。
    const probe = Math.min(head, 10_000);
    let secPerBlock = probe > 0 ? Math.max(0.01, (headTs - (await blockTime(head - probe))) / probe) : 2;
    let hi = head;
    let hiTs = headTs;
    let lo = hi;
    let loTs = hiTs;
    for (let i = 0; loTs >= sec; i++) {
      if (lo === 0) return 0;
      if (i > 40) throw new Error("public_rpc_block_search_not_converged");
      hi = lo;
      hiTs = loTs;
      const gap = Math.min(MAX_BACK_STEP_BLOCKS, Math.max(1, Math.floor(((hiTs - sec) / secPerBlock) * 0.5)));
      lo = Math.max(0, hi - gap);
      // 行き過ぎて保持範囲の外に出たら、hi との中点へ戻して読み直す（範囲の外のまま 0 と扱わない）。
      for (let k = 0; ; k++) {
        try {
          loTs = await blockTime(lo);
          break;
        } catch (e) {
          const archive = e instanceof Error && e.message.includes("archive_range_refused");
          if (!archive || k >= 30 || hi - lo <= 1) throw e;
          lo = lo + Math.ceil((hi - lo) / 2);
        }
      }
      if (hi > lo) secPerBlock = Math.max(0.01, (hiTs - loTs) / (hi - lo));
    }
    // 不変条件: ts(lo) < sec <= ts(hi)
    for (let i = 0; hi - lo > 1; i++) {
      if (i > 64) throw new Error("public_rpc_block_search_not_converged");
      let mid = lo + Math.floor(((sec - loTs) * (hi - lo)) / Math.max(1, hiTs - loTs));
      if (i % 2 === 1 || mid <= lo || mid >= hi) mid = lo + Math.floor((hi - lo) / 2);
      const t = await blockTime(mid);
      if (t >= sec) {
        hi = mid;
        hiTs = t;
      } else {
        lo = mid;
        loTs = t;
      }
    }
    return hi;
  }

  try {
    const head = Number(BigInt(await rpc<string>("eth_blockNumber", [])));
    const headTs = await blockTime(head);
    const fromBlock = await firstBlockAtOrAfter(fromSec, head, headTs);
    const toBlockExclusive = await firstBlockAtOrAfter(toExclusiveSec, head, headTs);
    const out: RawInboundUsdc[] = [];
    const seen = new Set<string>();
    const payToL = payTo.toLowerCase();

    for (let start = fromBlock; start < toBlockExclusive; start += PUBLIC_RPC_LOG_CHUNK_BLOCKS) {
      const endInclusive = Math.min(start + PUBLIC_RPC_LOG_CHUNK_BLOCKS - 1, toBlockExclusive - 1);
      const logs = await rpc<RpcLog[]>("eth_getLogs", [
        {
          address: USDC,
          fromBlock: `0x${start.toString(16)}`,
          toBlock: `0x${endInclusive.toString(16)}`,
          topics: [TRANSFER_TOPIC, null, padAddressTopic(payTo)],
        },
      ]);
      if (!Array.isArray(logs)) throw new Error("public_rpc_logs_not_array");
      for (const log of logs) {
        if (log.removed) continue;
        const topics = log.topics ?? [];
        if (!log.transactionHash || !log.blockNumber || !log.logIndex || topics.length < 3 || !log.data) {
          throw new Error("public_rpc_malformed_log");
        }
        const to = topicToAddress(topics[2]);
        if (to !== payToL) continue;
        const from = topicToAddress(topics[1]);
        const value = BigInt(log.data).toString();
        const bn = Number(BigInt(log.blockNumber));
        const sec = await blockTime(bn);
        if (sec < fromSec || sec >= toExclusiveSec) continue;
        // 同じ tx に同じ額の Transfer が 2 つあっても潰さない（logIndex で区別）。
        const key = `${log.transactionHash}:${Number(BigInt(log.logIndex))}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          txHash: log.transactionHash,
          blockNumber: String(bn),
          timeStamp: String(sec),
          from,
          to,
          value,
        });
      }
    }
    return { ok: true, source: "public_rpc", transfers: out, readThroughSec: headTs };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : "public_rpc_error" };
  }
}

/**
 * 1 payTo 分。Alchemy（鍵があるとき）→ Base 公開 RPC の 50,000 ブロック刻みの eth_getLogs。
 * どちらも読めなければ ok:false（呼び手は unreadable にし、0 と混ぜない）。
 */
export async function readPayToInboundUsdcWindow(
  payTo: Address,
  from: Date,
  toExclusive: Date,
  options: { budgetMs?: number; rpcUrl?: string; fetchImpl?: JsonRpcFetch; skipAlchemy?: boolean } = {},
): Promise<ReadInboundResult> {
  const fromSec = Math.floor(from.getTime() / 1000);
  const toSec = Math.floor(toExclusive.getTime() / 1000);
  if (!(fromSec < toSec)) return { ok: false, detail: "invalid_window" };

  // 予算は全体で1つ。Alchemy が鍵なしで即座に断れば、残りを公開 RPC が使う。
  const overall = createDeadline(options.budgetMs);
  const remaining = () => (options.budgetMs === undefined ? undefined : overall.remaining());
  let alchemyDetail = "skipped";
  if (!options.skipAlchemy) {
    const half = options.budgetMs === undefined ? undefined : Math.floor(options.budgetMs / 2);
    const viaAlchemy = await readViaAlchemy(payTo, fromSec, toSec, half);
    if (viaAlchemy.ok) return viaAlchemy;
    alchemyDetail = viaAlchemy.detail;
  }

  const viaRpc = await readViaPublicRpc(payTo, fromSec, toSec, {
    budgetMs: remaining(),
    rpcUrl: options.rpcUrl,
    fetchImpl: options.fetchImpl,
  });
  if (viaRpc.ok) return viaRpc;

  return {
    ok: false,
    detail: `unreadable:alchemy=${alchemyDetail};public_rpc=${viaRpc.detail}`,
  };
}
