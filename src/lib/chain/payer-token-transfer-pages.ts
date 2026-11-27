// ============================================================
// 払い手の USDC 送金を索引 API（Alchemy / Blockscout 形 / Routescan）のページで時刻の窓まで読む。
// payer-outgoing-readers（from のみ）と recover-late（from + to）の両方から使う。
// ============================================================
import type { Address } from "viem";
import type { PayerTokenTransfersV2Page } from "@/lib/chain/blockscout";
import { AlchemyUnavailableError, fetchAssetTransfersPage } from "@/lib/chain/alchemy";
import { ROUTESCAN_PAYER_TOKENTX_PAGE_SIZE } from "@/lib/chain/routescan";

/** v2 token-transfers / Routescan tokentx の 1 ページあたり件数（既定 50）。 */
export const PAYER_TOKEN_TRANSFER_PAGE_SIZE = 50;
/** 窓の始端まで遡れなければ incomplete（stellar の horizon_scan_incomplete と同型）。 */
export const PAYER_TOKEN_TRANSFER_MAX_PAGES = 50;

export type PayerTokenTransferPageFetch = (
  payer: Address,
  opts: {
    contractAddress: Address;
    chainId: number;
    budgetMs?: number;
    cursor?: Record<string, string> | null;
  },
) => Promise<PayerTokenTransfersV2Page>;

export type PayerTokenTransferInWindow = {
  txHash: string;
  from: string;
  to: string;
  value: string;
  blockTime: string;
  blockNumber: bigint;
};

export type PayerTokenTransferWindowResult =
  | { ok: true; transfers: PayerTokenTransferInWindow[] }
  | { ok: false; detail: string };

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

type TransferPageReadOpts = {
  contractAddress: Address;
  chainId: number;
  /** recover-late: 宛先 payTo で行を絞る（省略時は from のみ）。 */
  payTo?: string;
  /** Alchemy は満たないページでも pageKey で続けうる。 */
  alchemyPagination?: boolean;
};

/** 払い手 reconciliation 用の Alchemy 1 ページ取得（chainId 固定）。 */
export function makeAlchemyPayerFetch(chainId: number): PayerTokenTransferPageFetch {
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
      if (pageOldestSec === null || sec < pageOldestSec) pageOldestSec = sec;
      return { hash: t.hash, blockNumber: t.blockNumber, timeStamp: t.timeStamp, from: t.from, to: t.to, value: t.value };
    });
    return { rows, rawItemCount: page.rawCount, pageOldestSec, nextCursor: page.pageKey ? { pageKey: page.pageKey } : null };
  };
}

/**
 * 索引の 1 ページずつ新しい順に読み、時刻の窓に入る払い手発の erc20 送金を集める。
 * 窓の始端より古いページに到達するか、ページが尽きるまで読み切ったときだけ ok。
 */
export async function readPayerTokenTransfersInWindow(
  payer: string,
  from: Date,
  to: Date,
  deadline: number,
  signal: AbortSignal | undefined,
  fetchPage: PayerTokenTransferPageFetch,
  pageOpts: TransferPageReadOpts,
): Promise<PayerTokenTransferWindowResult> {
  const fromSec = Math.floor(from.getTime() / 1000);
  const toSec = Math.floor(to.getTime() / 1000);
  const payerLower = payer.toLowerCase();
  const payToLower = pageOpts.payTo?.toLowerCase();
  const out: PayerTokenTransferInWindow[] = [];
  const seen = new Set<string>();
  let pages = 0;
  let reachedPastWindow = false;
  let cursor: Record<string, string> | null = null;
  const pageSize = pageOpts.alchemyPagination ? 1000 : ROUTESCAN_PAYER_TOKENTX_PAGE_SIZE;

  while (pages < PAYER_TOKEN_TRANSFER_MAX_PAGES) {
    throwIfAborted(signal);
    if (Date.now() > deadline) return { ok: false, detail: "Error: transfer read ran past its time limit" };
    const budgetMs = deadline === Infinity ? undefined : Math.max(1, deadline - Date.now());
    const page = await fetchPage(payer as Address, {
      contractAddress: pageOpts.contractAddress,
      chainId: pageOpts.chainId,
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
      if (payToLower !== undefined && tx.to.toLowerCase() !== payToLower) continue;
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
  // 次のページの鍵が無ければ終わり。Blockscout / Routescan は満たないページで終わる（Alchemy は満たないページでも pageKey を返しうる）。
    const alchemyPagination = pageOpts.alchemyPagination === true;
    if (!page.nextCursor || (!alchemyPagination && page.rawItemCount < pageSize)) {
      reachedPastWindow = true;
      break;
    }
    cursor = page.nextCursor;
  }
  if (!reachedPastWindow) return { ok: false, detail: "blockscout_scan_incomplete" };
  return { ok: true, transfers: out };
}