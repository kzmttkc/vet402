// Chainlink equity feed reads and staleness (SPEC §2, §6).
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import { hex, rpcBatch, word } from "./rpc";

/** SPEC §6: the official heartbeat is unpublished; 26h is the v0 constant. */
export const EQUITY_STALE_AFTER_SEC = 26 * 3600;

export type FeedStatusInput = { updatedAt: number; oraclePaused: boolean; asOf: number };
export type FeedStatus = { stale: boolean; ageSec: number; reasons: ("paused" | "age")[] };

export function feedStatus({ updatedAt, oraclePaused, asOf }: FeedStatusInput): FeedStatus {
  const ageSec = Math.max(0, asOf - updatedAt);
  const reasons: FeedStatus["reasons"] = [];
  if (oraclePaused) reasons.push("paused");
  if (ageSec > EQUITY_STALE_AFTER_SEC) reasons.push("age");
  return { stale: reasons.length > 0, ageSec, reasons };
}

export function isWeekendUtc(unixSec: number): boolean {
  const day = new Date(unixSec * 1000).getUTCDay();
  return day === 0 || day === 6;
}

const SEL = {
  balanceOf: "0x70a08231",
  uiMultiplier: "0xa60bf13d",
  oraclePaused: "0x7706ba52",
  latestRoundData: "0xfeaf968c",
  decimals: "0x313ce567",
} as const;

export type TokenFeedRead = {
  raw: bigint;
  uiMultiplier: bigint;
  oraclePaused: boolean;
  feedDecimals: number;
  round: { roundId: bigint; answer: bigint; startedAt: number; updatedAt: number; answeredInRound: bigint };
};

/** One batched read of balanceOf / uiMultiplier / oraclePaused / feed decimals / latestRoundData at `block`. */
export async function readTokenAndFeed(
  token: string,
  feed: string,
  holder: string,
  block: number,
  opts?: Parameters<typeof rpcBatch>[1],
): Promise<TokenFeedRead> {
  const at = hex(block);
  const [bal, mult, paused, dec, round] = await rpcBatch<string>(
    [
      { method: "eth_call", params: [{ to: token, data: `${SEL.balanceOf}000000000000000000000000${holder.slice(2)}` }, at] },
      { method: "eth_call", params: [{ to: token, data: SEL.uiMultiplier }, at] },
      { method: "eth_call", params: [{ to: token, data: SEL.oraclePaused }, at] },
      { method: "eth_call", params: [{ to: feed, data: SEL.decimals }, at] },
      { method: "eth_call", params: [{ to: feed, data: SEL.latestRoundData }, at] },
    ],
    opts,
  );
  return {
    raw: word(bal, 0),
    uiMultiplier: word(mult, 0),
    oraclePaused: word(paused, 0) !== 0n,
    feedDecimals: Number(word(dec, 0)),
    round: {
      roundId: word(round, 0),
      answer: word(round, 1),
      startedAt: Number(word(round, 2)),
      updatedAt: Number(word(round, 3)),
      answeredInRound: word(round, 4),
    },
  };
}

export type TokenState = {
  token: string;
  raw: bigint;
  uiMultiplier: bigint;
  oraclePaused: boolean;
  /** null when the token has no Chainlink feed in the registry */
  feed: null | { decimals: number; round: TokenFeedRead["round"] };
};

/** Multicall3, the same address on every EVM chain; code present on 4663 (measured 2026-09-29, 3,808 bytes). */
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const multicallAbi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);

/**
 * Balances of `tokens` held by `holder` at `block`, in one eth_call through
 * Multicall3. 195 separate calls drew per-item 429s from the public RPC and took
 * ~5 s even in batches (measured 2026-09-29); one aggregate call answers at once.
 * A token whose call fails reads as an error, not as zero.
 */
export async function readBalances(tokens: readonly string[], holder: string, block: number, opts?: Parameters<typeof rpcBatch>[1]): Promise<Map<string, bigint>> {
  const data = encodeFunctionData({
    abi: multicallAbi,
    functionName: "aggregate3",
    args: [tokens.map((t) => ({ target: t as `0x${string}`, allowFailure: true, callData: `${SEL.balanceOf}000000000000000000000000${holder.slice(2)}` as `0x${string}` }))],
  });
  const [raw] = await rpcBatch<string>([{ method: "eth_call", params: [{ to: MULTICALL3, data }, hex(block)] }], { retries: 5, ...opts });
  const results = decodeFunctionResult({ abi: multicallAbi, functionName: "aggregate3", data: raw as `0x${string}` }) as readonly { success: boolean; returnData: `0x${string}` }[];
  const out = new Map<string, bigint>();
  results.forEach((r, i) => {
    if (!r.success || r.returnData.length < 66) throw new Error(`balanceOf failed for ${tokens[i]}`);
    out.set(tokens[i].toLowerCase(), BigInt(r.returnData.slice(0, 66)));
  });
  return out;
}

/** balanceOf / uiMultiplier / oraclePaused of one token, and its feed's decimals / latestRoundData when it has one. */
export async function readTokenState(
  token: string,
  feed: string | null,
  holder: string,
  block: number,
  opts?: Parameters<typeof rpcBatch>[1],
): Promise<TokenState> {
  const at = hex(block);
  const calls = [
    { method: "eth_call", params: [{ to: token, data: `${SEL.balanceOf}000000000000000000000000${holder.slice(2)}` }, at] },
    { method: "eth_call", params: [{ to: token, data: SEL.uiMultiplier }, at] },
    { method: "eth_call", params: [{ to: token, data: SEL.oraclePaused }, at] },
  ];
  if (feed) {
    calls.push({ method: "eth_call", params: [{ to: feed, data: SEL.decimals }, at] });
    calls.push({ method: "eth_call", params: [{ to: feed, data: SEL.latestRoundData }, at] });
  }
  const [bal, mult, paused, dec, round] = await rpcBatch<string>(calls, opts);
  return {
    token: token.toLowerCase(),
    raw: word(bal, 0),
    uiMultiplier: word(mult, 0),
    oraclePaused: word(paused, 0) !== 0n,
    feed: feed
      ? {
          decimals: Number(word(dec, 0)),
          round: {
            roundId: word(round, 0),
            answer: word(round, 1),
            startedAt: Number(word(round, 2)),
            updatedAt: Number(word(round, 3)),
            answeredInRound: word(round, 4),
          },
        }
      : null,
  };
}
