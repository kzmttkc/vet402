// What the free /rwa surfaces say when there is no record to show (SPEC patch 020).
//
// The facts route and the /rwa page share these, so a judge who opens both
// reads the same reason and the same wait. Every failure names why, and how
// long to wait before trying again. Nothing here is on the paid lane.
import { getAddress } from "viem";
import { ReconstructionTimeout, TooBusy } from "./cache";
import { NoStockTokenActivity, WalletTooLarge, type NoActivityAnswer, type TooLargeAnswer } from "./facts";

export type FailureCode = "too_busy" | "still_reading" | "chain_unavailable";
export type FailureAnswer = { error: FailureCode; retry_after_sec: number; detail: string };

export const FAILURE_CODES: readonly FailureCode[] = ["too_busy", "still_reading", "chain_unavailable"];
export const CHAIN_UNAVAILABLE_RETRY_SEC = 60;

/** The one body for each kind of failure. Anything that is not a timeout or a full slot is the chain RPC failing. */
export function failureAnswer(err: unknown): FailureAnswer {
  if (err instanceof TooBusy) {
    return {
      error: "too_busy",
      retry_after_sec: err.retryAfterSec,
      detail: `Another wallet is being rebuilt on this server right now. Try again in about ${err.retryAfterSec} seconds.`,
    };
  }
  if (err instanceof ReconstructionTimeout) {
    return {
      error: "still_reading",
      retry_after_sec: err.retryAfterSec,
      detail: `Reading this wallet's history took longer than this request can wait. The read keeps going. Try again in about ${err.retryAfterSec} seconds.`,
    };
  }
  return {
    error: "chain_unavailable",
    retry_after_sec: CHAIN_UNAVAILABLE_RETRY_SEC,
    detail: `The Robinhood Chain RPC did not answer this time. Try again in about a minute.`,
  };
}

/** The 404 body: the stated answer when the reconstruction produced one, else the bare code. Address shown EIP-55. */
export function emptyAnswer(err: NoStockTokenActivity): NoActivityAnswer | { error: "no_stock_token_activity" } {
  return err.answer ? { ...err.answer, address: getAddress(err.answer.address) } : { error: "no_stock_token_activity" };
}

/** The 422 body for a wallet too large to rebuild in one request. Address shown EIP-55. */
export function tooLargeAnswer(err: WalletTooLarge): TooLargeAnswer {
  return { ...err.answer, address: getAddress(err.answer.address) };
}
