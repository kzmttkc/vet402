// Classification of one transaction receipt into canonical-token events (SPEC §3).
//
// Every canonical Transfer leg that touches the address becomes exactly one
// event. The rule, in order:
//   1. the transaction was a direct call to the canonical token contract
//      (transfer / transferFrom / issuer mint or burn) → `transfer`
//   2. the transaction carries Swap logs: every v3-shaped Swap emitter must be a
//      pool of the verified Uniswap v3 factory holding the token → `univ3_swap`;
//      every v4 Swap must be a PoolManager pool holding the token → `univ4_swap`.
//      Amounts always come from the canonical Transfer legs, never from the
//      Swap event (SPEC §3, hooked pools). An unverified emitter, or both v3 and
//      v4 pools holding the token in one transaction → `other_unparsed`
//   3. anything else that moved the token (unknown router, vault, RFQ) → `other_unparsed`
//
// `other_unparsed` is a classification, not a discard: the leg keeps its delta.

import { TOPICS, topicToAddress } from "./events";

export type RwaEventType = "transfer" | "univ3_swap" | "univ4_swap" | "other_unparsed";

export type RwaLog = { address: string; topics: string[]; data: string; logIndex: number };

export type RwaReceipt = {
  transactionHash: string;
  blockNumber: number;
  from: string;
  to: string | null;
  logs: RwaLog[];
};

export type RwaEvent = {
  tx: string;
  log_index: number;
  block_number: number;
  token: string;
  type: RwaEventType;
  /** signed raw amount from the address's point of view (uint256 units) */
  raw_delta: bigint;
  counterparty: string;
};

export interface PoolResolver {
  /** true when `pool` was created by the verified Uniswap v3 factory and has `token` as token0 or token1 */
  isUniswapV3PoolWith(pool: string, token: string): Promise<boolean>;
  /** true when the v4 PoolManager initialized `poolId` with `token` as currency0 or currency1 */
  isUniswapV4PoolWith(poolId: string, token: string): Promise<boolean>;
}

type Leg = { log: RwaLog; token: string; delta: bigint; counterparty: string };

function canonicalLegs(receipt: RwaReceipt, address: string, canonical: Set<string>): Leg[] {
  const me = address.toLowerCase();
  const legs: Leg[] = [];
  for (const log of receipt.logs) {
    const token = log.address.toLowerCase();
    if (!canonical.has(token) || log.topics[0] !== TOPICS.transfer || log.topics.length < 3) continue;
    const from = topicToAddress(log.topics[1]);
    const to = topicToAddress(log.topics[2]);
    const value = BigInt(log.data === "0x" ? "0x0" : log.data);
    if (from === me && to === me) continue; // SPEC §4: self-to-self is ignored
    if (to === me) legs.push({ log, token, delta: value, counterparty: from });
    else if (from === me) legs.push({ log, token, delta: -value, counterparty: to });
  }
  return legs;
}

async function venueFor(
  receipt: RwaReceipt,
  token: string,
  canonical: Set<string>,
  resolver: PoolResolver,
): Promise<RwaEventType> {
  if (receipt.to && canonical.has(receipt.to.toLowerCase()) && receipt.to.toLowerCase() === token) return "transfer";

  const v3 = receipt.logs.filter((l) => l.topics[0] === TOPICS.univ3Swap);
  const v4 = receipt.logs.filter((l) => l.topics[0] === TOPICS.univ4Swap);
  if (v3.length === 0 && v4.length === 0) return "other_unparsed";

  let v3Holds = false;
  for (const log of v3) {
    const verified = await resolver.isUniswapV3PoolWith(log.address, token);
    if (!verified) {
      // Either not a Uniswap pool (Sushi and friends share the signature) or a
      // Uniswap pool of other tokens. The first is unparsed; the second means
      // this leg was not moved by that swap, so keep looking.
      const anyToken = await Promise.all([...canonical].map((t) => resolver.isUniswapV3PoolWith(log.address, t)));
      if (!anyToken.some(Boolean)) return "other_unparsed";
      continue;
    }
    v3Holds = true;
  }
  let v4Holds = false;
  for (const log of v4) {
    if (log.topics.length < 2) return "other_unparsed";
    if (await resolver.isUniswapV4PoolWith(log.topics[1], token)) v4Holds = true;
  }
  if (v3Holds && v4Holds) return "other_unparsed";
  if (v3Holds) return "univ3_swap";
  if (v4Holds) return "univ4_swap";
  return "other_unparsed";
}

/**
 * Classify every canonical Transfer leg of one receipt that touches `address`.
 * `canonical` holds lower-cased token addresses from the canonical registry.
 */
export async function classifyReceipt(
  receipt: RwaReceipt,
  address: string,
  canonical: Set<string>,
  resolver: PoolResolver,
): Promise<RwaEvent[]> {
  const legs = canonicalLegs(receipt, address, canonical);
  const events: RwaEvent[] = [];
  const venueByToken = new Map<string, RwaEventType>();
  for (const leg of legs) {
    let type = venueByToken.get(leg.token);
    if (!type) {
      type = await venueFor(receipt, leg.token, canonical, resolver);
      venueByToken.set(leg.token, type);
    }
    events.push({
      tx: receipt.transactionHash,
      log_index: leg.log.logIndex,
      block_number: receipt.blockNumber,
      token: leg.token,
      type,
      raw_delta: leg.delta,
      counterparty: leg.counterparty,
    });
  }
  return events;
}

export type EventsSummary = { transfer: number; univ3: number; univ4: number; other_unparsed: number };

export function summarize(events: RwaEvent[]): EventsSummary {
  const s: EventsSummary = { transfer: 0, univ3: 0, univ4: 0, other_unparsed: 0 };
  for (const e of events) {
    if (e.type === "transfer") s.transfer++;
    else if (e.type === "univ3_swap") s.univ3++;
    else if (e.type === "univ4_swap") s.univ4++;
    else s.other_unparsed++;
  }
  return s;
}
