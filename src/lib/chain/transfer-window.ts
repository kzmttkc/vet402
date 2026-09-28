import type { Address } from "viem";
import {
  fetchTokenTransferWindow as blockscoutTokenWindow,
  fetchWalletTransferWindow as blockscoutNativeWindow,
} from "./blockscout";
import {
  alchemyBudgetMs,
  fetchAlchemyTransferWindow,
  isAlchemyEnabled,
  type ChainTransfer,
} from "./alchemy";
import { logServerErrorSafe } from "@/lib/util/log-safe";

/**
 * The transfer window the drain check reads, from whichever provider can
 * actually deliver it.
 *
 * PROVIDER ORDER, AND WHY (measured 2026-08-13, third pass). For a wallet with
 * real history no public Blockscout endpoint would answer at all. Three
 * attempts each at the same 100-transfer window for 0xd8dA…6045:
 *
 *   Alchemy alchemy_getAssetTransfers   200 / 200 / 200   1,310-2,200ms
 *   base.blockscout.com v1 (+API key)   429 / 429 / 429
 *   api.blockscout.com gateway (+key)   500 / 500 / 500
 *
 * So Alchemy is first: it is the only provider measured to answer for the
 * addresses the product could not score. Blockscout stays behind it — v2 then
 * v1, hedged exactly as before — because a degraded second source beats none
 * when Alchemy is unreachable or unconfigured.
 *
 * NOTHING HERE SOFTENS A VERDICT. When no provider completes the read this
 * throws, the caller flags the leg unmeasured, and the engine caps or blocks.
 * The fallback chain removes outages Vouch was manufacturing; it never hides a
 * real one.
 */
export type TransferSource = "alchemy" | "v2" | "v1";

export type TransferWindow = {
  transfers: ChainTransfer[];
  /** Which upstream answered. Reported so an operator can see the fallback
   *  carrying traffic instead of having to infer it from latency. */
  source: TransferSource;
};

export type TransferWindowOptions = {
  limit?: number;
  chainId?: number;
  /** Allowance for the Alchemy attempt before Blockscout is tried. */
  alchemyBudgetMs?: number;
  /** Total allowance for the Blockscout v2 attempt. */
  v2BudgetMs?: number;
  /** Total allowance for the Blockscout v1 attempt. */
  v1BudgetMs?: number;
  /** How long v2 runs alone before v1 is started alongside it. */
  hedgeAfterMs?: number;
};

async function withBlockscoutFallback(
  label: string,
  alchemy: () => Promise<ChainTransfer[]>,
  blockscout: () => Promise<{ transfers: ChainTransfer[]; source: "v2" | "v1" }>,
  enabled: boolean,
): Promise<TransferWindow> {
  if (enabled) {
    try {
      return { transfers: await alchemy(), source: "alchemy" };
    } catch (error) {
      // Named, not swallowed: an operator must be able to see the primary
      // provider handing traffic to the fallback, and `logServerError` is the
      // same channel every other degraded read here reports on.
      logServerErrorSafe(`transfer_window_alchemy_${label}`, error);
    }
  }
  return blockscout();
}

/** Native-token transfers, newest first. */
export async function fetchNativeTransferWindow(
  address: Address,
  options: TransferWindowOptions = {},
): Promise<TransferWindow> {
  const limit = options.limit ?? 100;
  return withBlockscoutFallback(
    "native",
    () =>
      fetchAlchemyTransferWindow(address, {
        categories: ["external"],
        limit,
        chainId: options.chainId,
        budgetMs: options.alchemyBudgetMs ?? alchemyBudgetMs(),
      }),
    () => blockscoutNativeWindow(address, options),
    isAlchemyEnabled(options.chainId),
  );
}

/** ERC-20 transfers for one token, newest first. */
export async function fetchErc20TransferWindow(
  address: Address,
  contractAddress: Address,
  options: TransferWindowOptions = {},
): Promise<TransferWindow> {
  const limit = options.limit ?? 100;
  return withBlockscoutFallback(
    "erc20",
    () =>
      fetchAlchemyTransferWindow(address, {
        categories: ["erc20"],
        contractAddress,
        limit,
        chainId: options.chainId,
        budgetMs: options.alchemyBudgetMs ?? alchemyBudgetMs(),
      }),
    () => blockscoutTokenWindow(address, contractAddress, options),
    isAlchemyEnabled(options.chainId),
  );
}
