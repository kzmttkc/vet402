/**
 * LP §5 "Chains" — the copy and the state of each chain, in one place.
 *
 * Facts as of 2026-09-20. Nothing here is a count: a static number is wrong on
 * the day it is read. The LP prints the per-chain settled count next to each
 * lane from `stats.l1.byChain` (the ledger read the page already performs for
 * Fig. 1), and `effectiveLaneState` lets that ledger overrule the static word
 * below in both directions — a lane marked pending stops reading "pending" the
 * moment the ledger holds a settled purchase on it, and a lane marked as having
 * settled purchases stops saying so if a readable ledger holds none.
 *
 * "Readable" means `l1.byChain` is non-empty (`settledByChainOf`). An empty array
 * is what the reader returns when the L1 aggregate could not be read (it swallows
 * a missing-schema error), so empty is "unknown", never "zero everywhere": the
 * page then prints the static words and no counts. `totalEndpoints` is the L0
 * catalog and says nothing about whether the L1 ledger was read (2026-09-19 review C1).
 *
 * There is no "running" state (2026-09-19 review W1): nothing on this page backs
 * the freshness of such a word, and it would keep saying so on a day the lane is
 * switched off. The lanes state what the ledger holds, which stays true.
 *
 * The file sits under src/components/site so tests/claims-registry.test.ts
 * scans its prose like any other public copy. Mind what that scan does not see: the
 * `LANE_STATE_SENTENCE` and legend sentences carry none of the gate's assertive terms, so the
 * extractor returns nothing for them — a date or a count added to one of them would ship
 * unchecked. Keep them free of both (tests/lp-supported-chains.test.ts pins the wording).
 */

/**
 * - settled_on_record:      at least one purchase settled and was reconciled
 * - pending_first_purchase: lane and reconciliation are built, nothing bought yet
 *
 * 2026-09-20: no row starts as pending_first_purchase any more (Arc settled). The state
 * stays for two reasons: a future lane will start there, and a readable ledger that holds
 * no settled purchase for a lane still moves that lane to it (`effectiveLaneState`). The
 * section's legend names "pending" only when a row is drawn with it (`chainsLegend`).
 */
export type LaneState = "settled_on_record" | "pending_first_purchase";

export type LaneChain = {
  kind: "lane";
  /** Must equal chainLabel() for the chain — it is the join key into `stats.l1.byChain`. */
  chain: string;
  asset: string;
  /** The payment rail, as it reads after "over". */
  rail: string;
  state: LaneState;
};

export type BodyPart = string | { code: string };

export type BuildingChain = {
  kind: "building";
  chain: string;
  body: BodyPart[];
};

export type SupportedChain = LaneChain | BuildingChain;

export const LANE_STATE_SENTENCE: Record<LaneState, string> = {
  settled_on_record: "Settled and reconciled purchases are on record.",
  pending_first_purchase:
    "The purchase lane and settlement reconciliation are implemented. The first real purchase on this chain is still pending.",
};

export const SUPPORTED_CHAINS: SupportedChain[] = [
  { kind: "lane", chain: "Base", asset: "USDC", rail: "x402", state: "settled_on_record" },
  { kind: "lane", chain: "Solana", asset: "USDC", rail: "x402", state: "settled_on_record" },
  { kind: "lane", chain: "Tempo", asset: "USDC.e", rail: "MPP, not x402", state: "settled_on_record" },
  {
    kind: "lane",
    chain: "XRPL",
    asset: "RLUSD",
    rail: "x402, through the t54 facilitator",
    state: "settled_on_record",
  },
  // ARC-SWAP (done 2026-09-20): the first real Arc purchase settled on 2026-09-20 00:00:17 UTC
  // and the production reconciler marked it settled, so this line moved from
  // `state: "pending_first_purchase"` to `state: "settled_on_record"`. The tx is in
  // docs/handoffs/CHANGELOG.md; the count on the page still comes from the ledger.
  { kind: "lane", chain: "Arc", asset: "USDC", rail: "x402", state: "settled_on_record" },
  // Robinhood Chain: the wording is fixed by agreement with the RWA session. The Japanese
  // source, verbatim:
  //   「Robinhood Chain（4663・本番網）: Stock Token の保有と取引履歴を公開チェーンデータから
  //   再構成する `vet402 /rwa` を実装中。購入レーンと決済索引は未対応」
  // The English below is a faithful translation of that sentence and carries nothing else.
  {
    kind: "building",
    chain: "Robinhood Chain (4663, mainnet)",
    body: [
      { code: "vet402 /rwa" },
      ", which reconstructs Stock Token holdings and trade history from public chain data, is being implemented. The purchase lane and the settlement index are not supported.",
    ],
  },
];

/**
 * The state the page prints for a lane. `settled` is that chain's settled count
 * from the ledger, or null when the ledger could not be read (then the static
 * word stands, and the page prints no count).
 */
export function effectiveLaneState(state: LaneState, settled: number | null): LaneState {
  if (settled === null) return state;
  return settled > 0 ? "settled_on_record" : "pending_first_purchase";
}

/**
 * `stats.l1.byChain` folded to chain → settled, or null when the L1 ledger was not
 * read. Empty counts as not read (see the header): the precedent is
 * /observatory/state, which draws its per-chain table on `byChain.length > 0`.
 * Rows that share a chain label are summed, not overwritten.
 */
export function settledByChainOf(
  byChain: readonly { chain: string; settled: number }[] | null | undefined,
): Map<string, number> | null {
  if (!byChain || byChain.length === 0) return null;
  const out = new Map<string, number>();
  for (const row of byChain) out.set(row.chain, (out.get(row.chain) ?? 0) + row.settled);
  return out;
}

/**
 * The count a row prints, or null for no count line. A building row has no lane, so
 * it prints no count whatever the ledger holds. A lane absent from a readable ledger
 * has no settled purchase: 0.
 */
export function settledCountOf(row: SupportedChain, settledByChain: Map<string, number> | null): number | null {
  if (row.kind !== "lane" || settledByChain === null) return null;
  return settledByChain.get(row.chain) ?? 0;
}

export type ChainMarker = { label: "implemented" | "pending" | "building"; live: boolean };

export function markerOf(row: SupportedChain, settled: number | null): ChainMarker {
  if (row.kind === "building") return { label: "building", live: false };
  return effectiveLaneState(row.state, settled) === "pending_first_purchase"
    ? { label: "pending", live: false }
    : { label: "implemented", live: true };
}

export function laneBody(row: LaneChain, settled: number | null): string {
  return `${row.asset} over ${row.rail}. ${LANE_STATE_SENTENCE[effectiveLaneState(row.state, settled)]}`;
}

/**
 * The legend sentence under the section heading. It explains the markers the rows below
 * actually carry: "pending" is named only when some row is drawn pending (2026-09-20 — with
 * every lane settled, a legend that defines a marker no row shows sends the reader looking
 * for a pending chain that is not there). "building" is always named: the Robinhood Chain
 * row is static.
 *
 * Two shapes. Ledger read: the markers are defined by the ledger, because the ledger set them.
 * Ledger not read (`settledByChain === null`): the markers are the static states above, so the
 * sentence does not name the ledger as their source, and a second sentence says it was not read.
 */
export const LEDGER_UNREAD_SENTENCE =
  "The public ledger could not be read for this rendering, so the markers below are the last recorded state and no counts are shown.";

export function chainsLegend(settledByChain: Map<string, number> | null): string {
  const anyPending = SUPPORTED_CHAINS.some(
    (row) => markerOf(row, settledCountOf(row, settledByChain)).label === "pending",
  );
  const pending = anyPending ? ", pending when it is built but has not bought yet" : "";
  // 2026-09-20 review W1: when the ledger was not read, the markers come from the static
  // defaults in this file, not from the ledger — so the legend must not define them by the
  // ledger, and it says outright that the ledger was not read.
  if (settledByChain === null) {
    return (
      "A lane is marked implemented when a settled purchase is on record" +
      pending +
      ", and building when the work has not shipped. " +
      LEDGER_UNREAD_SENTENCE
    );
  }
  return (
    "A lane is marked implemented when the public ledger holds a settled purchase on that chain" +
    pending +
    ", and building when the work has not shipped."
  );
}
