// Chainlink equity feed reads and staleness (SPEC §2, §6).
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
