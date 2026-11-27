// ============================================================
// Routescan の Etherscan 互換 API（鍵なし）— Avalanche 払い手照合用。
// Measured 2026-11-27: tokentx は status "1" で hash・timeStamp・from・to・value を返す。
// ============================================================
import type { Address } from "viem";
import type { PayerTokenTransfersV2Page } from "@/lib/chain/blockscout";
import { AVALANCHE_CHAIN_ID, AVALANCHE_USDC_ADDRESS } from "@/lib/chain/avalanche";

const USER_AGENT = "vet402-verifier/0.1 (+https://vet402.com)";
const REQUEST_HEADERS: Record<string, string> = {
  Accept: "application/json",
  "User-Agent": USER_AGENT,
};

/** Routescan Avalanche C-Chain mainnet etherscan-compatible root. */
export const ROUTESCAN_AVALANCHE_ETHERSCAN_API =
  "https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api";

/** 1 ページあたり件数（Blockscout 払い手照合と同じ既定 50）。 */
export const ROUTESCAN_PAYER_TOKENTX_PAGE_SIZE = 50;

type RoutescanTokenTx = {
  hash?: string;
  blockNumber?: string;
  timeStamp?: string;
  from?: string;
  to?: string;
  value?: string;
  contractAddress?: string;
};

type RoutescanResponse<T> = {
  status?: string;
  message?: string;
  result?: T;
};

export class RoutescanUnavailableError extends Error {
  constructor(message = "routescan_unavailable", cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "RoutescanUnavailableError";
  }
}

function budgetSignal(budgetMs?: number): AbortSignal | undefined {
  if (budgetMs === undefined || !Number.isFinite(budgetMs)) return undefined;
  return AbortSignal.timeout(Math.max(1, budgetMs));
}

/** Etherscan 互換の空応答だけを空として扱う。ほかの status "0"（窓が大きすぎる・レート制限など）は読めなかった。 */
function isEmptyResultMessage(message: string): boolean {
  return message.trim().toLowerCase() === "no transactions found";
}

function looksLikeHtml(text: string): boolean {
  const t = text.trimStart().slice(0, 64).toLowerCase();
  return t.startsWith("<!doctype") || t.startsWith("<html");
}

async function routescanGetTokentxOnce(
  params: Record<string, string>,
  budgetMs?: number,
): Promise<RoutescanTokenTx[] | null> {
  const url = new URL(ROUTESCAN_AVALANCHE_ETHERSCAN_API);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: REQUEST_HEADERS,
      signal: budgetSignal(budgetMs),
      next: { revalidate: 0 },
    });
  } catch (error) {
    if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) {
      throw new RoutescanUnavailableError("routescan_timeout", error);
    }
    throw new RoutescanUnavailableError("routescan_network_error", error);
  }

  if (response.status === 429) {
    throw new RoutescanUnavailableError("routescan_http_429");
  }

  const contentType = response.headers.get("content-type") ?? "";
  const raw = await response.text();
  if (!response.ok) {
    if (looksLikeHtml(raw)) throw new RoutescanUnavailableError("routescan_http_html");
    throw new RoutescanUnavailableError(`routescan_http_${response.status}`);
  }
  if (looksLikeHtml(raw) || (!contentType.includes("json") && looksLikeHtml(raw))) {
    throw new RoutescanUnavailableError("routescan_http_html");
  }

  let data: RoutescanResponse<RoutescanTokenTx[] | string>;
  try {
    data = JSON.parse(raw) as RoutescanResponse<RoutescanTokenTx[] | string>;
  } catch (error) {
    if (looksLikeHtml(raw)) throw new RoutescanUnavailableError("routescan_http_html");
    throw new RoutescanUnavailableError("routescan_invalid_json", error);
  }

  if (data.status === "1" && Array.isArray(data.result)) {
    return data.result;
  }

  const message = data.message ?? "";
  if (data.status === "0" && isEmptyResultMessage(message)) {
    return null;
  }

  if (data.status === "0" || data.status !== "1") {
    throw new RoutescanUnavailableError(`routescan_api_error:${message || data.status || "unknown"}`);
  }

  throw new RoutescanUnavailableError("routescan_bad_shape");
}

/**
 * payer-reconcile 専用: Routescan tokentx を新しい順に 1 ページ返す（page / offset ページング）。
 */
export async function fetchRoutescanPayerTokenTxPage(
  address: Address,
  contractAddress: Address,
  options: {
    page?: number;
    offset?: number;
    budgetMs?: number;
  } = {},
): Promise<PayerTokenTransfersV2Page> {
  const page = options.page ?? 1;
  const offset = options.offset ?? ROUTESCAN_PAYER_TOKENTX_PAGE_SIZE;
  const wanted = contractAddress.toLowerCase();

  const result = await routescanGetTokentxOnce(
    {
      module: "account",
      action: "tokentx",
      address,
      contractaddress: contractAddress,
      sort: "desc",
      page: String(page),
      offset: String(offset),
    },
    options.budgetMs,
  );

  if (result === null) {
    return { rows: [], rawItemCount: 0, pageOldestSec: null, nextCursor: null };
  }

  const rows: PayerTokenTransfersV2Page["rows"] = [];
  let pageOldestSec: number | null = null;

  for (const item of result) {
    const tsRaw = item.timeStamp;
    const sec = tsRaw !== undefined && tsRaw !== null && tsRaw !== "" ? Number(tsRaw) : NaN;
    if (!Number.isFinite(sec) || sec <= 0) {
      throw new RoutescanUnavailableError("routescan_missing_block_timestamp");
    }
    if (pageOldestSec === null || sec < pageOldestSec) pageOldestSec = sec;

    const token = item.contractAddress?.toLowerCase();
    if (token && token !== wanted) continue;

    const hash = item.hash ?? "";
    const from = item.from ?? "";
    const to = item.to ?? "";
    const value = item.value ?? "";
    // 窓の中の行を黙って捨てない: 欠けた行が1つでもあれば読めなかった扱い。
    if (!hash || !from || !to || !/^\d+$/.test(value) || !/^\d+$/.test(String(item.blockNumber ?? ""))) {
      throw new RoutescanUnavailableError("routescan_bad_row");
    }

    rows.push({
      hash,
      blockNumber: String(item.blockNumber),
      timeStamp: String(sec),
      from,
      to,
      value,
    });
  }

  const nextCursor = result.length >= offset ? { page: String(page + 1) } : null;
  return { rows, rawItemCount: result.length, pageOldestSec, nextCursor };
}

export type RoutescanPayerTokenTxFetch = (
  payer: Address,
  opts: {
    contractAddress: Address;
    chainId: number;
    budgetMs?: number;
    cursor?: Record<string, string> | null;
  },
) => Promise<PayerTokenTransfersV2Page>;

/** tests と差し替え用。 */
export function makeRoutescanAvalanchePayerFetch(
  impl: typeof fetchRoutescanPayerTokenTxPage = fetchRoutescanPayerTokenTxPage,
): RoutescanPayerTokenTxFetch {
  return async (payer, opts) => {
    const page = opts.cursor?.page ? Number(opts.cursor.page) : 1;
    if (!Number.isFinite(page) || page < 1) {
      throw new RoutescanUnavailableError("routescan_bad_page");
    }
    return impl(payer, opts.contractAddress ?? (AVALANCHE_USDC_ADDRESS as Address), {
      page,
      budgetMs: opts.budgetMs,
    });
  };
}

/** 型の re-export 用（循環を避ける）。 */
export const ROUTESCAN_AVALANCHE_CHAIN_ID = AVALANCHE_CHAIN_ID;
