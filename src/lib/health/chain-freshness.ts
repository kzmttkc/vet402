/**
 * Data freshness by chain (2026-11-08).
 *
 * WHY THIS FILE EXISTS. /api/health answers one question for uptime pollers:
 * can the service answer right now. It does not say how far behind each chain's
 * settlements index is, and it should not: a lagging index is not an outage,
 * and the two uptime monitors (.github/workflows/uptime.yml and
 * scripts/uptime-cron.sh) read that endpoint's 200/503 as-is. This module is
 * the other half: per chain, when the index last ran, how far behind the chain
 * tip it is in SECONDS, and whether the chain's block interval still matches
 * the number vet402's windows are built on.
 *
 * The lag is measured from real block timestamps (the tip block and the
 * checkpoint block, both read from the chain), never from a block count times
 * a constant. Base moved from 2 s to 0.2 s blocks on 2026-11-05 and a constant
 * turned "one day behind" into "2.4 hours behind" for two days before anyone
 * noticed. The interval check exists so the next change on any chain is seen
 * within one read, not two days later.
 */

import { getDb } from "@/lib/db/client";
import { indexerCheckpoints } from "@/lib/db/schema";
import { inArray, like, sql } from "drizzle-orm";
import { getLogScanClient } from "@/lib/chain/client";
import { SECONDS_PER_DAY, type BlockTimeSegment } from "@/lib/chain/block-clock";
import { EVM_INDEX_CHAINS, isEvmChainIndexable, type EvmIndexChain } from "@/lib/settlements/index-evm";
import { SOLANA_CHECKPOINT_SCOPE_PREFIX } from "@/lib/settlements/index-solana";
import { XRPL_CHECKPOINT_SCOPE_PREFIX } from "@/lib/settlements/index-xrpl";
import { publicChainLabel } from "@/lib/observatory/chains";

/** Blocks between the two samples the interval is measured over. */
export const INTERVAL_SAMPLE_BLOCKS = 1_000n;
/** Measured vs expected: at or beyond this factor either way, the expected number is stale. */
export const INTERVAL_DRIFT_FACTOR = 2;
/** Per-chain RPC budget. A slow chain shows as "not read", it does not hold the page. */
export const CHAIN_READ_TIMEOUT_MS = 3_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export type IntervalVerdict = "ok" | "drift" | "unknown";

/** The block interval vet402's windows assume at the newest block: the schedule's last segment, else blocksPerDay. */
export function expectedMsPerBlock(
  chain: { blocksPerDay: bigint | number; blockTimeSchedule?: readonly BlockTimeSegment[] },
): number {
  const schedule = chain.blockTimeSchedule;
  if (schedule && schedule.length > 0) return schedule[schedule.length - 1]!.msPerBlock;
  return (SECONDS_PER_DAY * 1000) / Number(chain.blocksPerDay);
}

export function intervalVerdict(expectedMs: number, measuredMs: number | null): IntervalVerdict {
  if (measuredMs === null || !Number.isFinite(measuredMs) || measuredMs <= 0 || expectedMs <= 0) return "unknown";
  const ratio = measuredMs / expectedMs;
  return ratio >= INTERVAL_DRIFT_FACTOR || ratio <= 1 / INTERVAL_DRIFT_FACTOR ? "drift" : "ok";
}

/** ms per block over [from, to], from the two blocks' own timestamps (unix seconds). */
export function measuredMsPerBlock(fromBlock: bigint, fromTs: number, toBlock: bigint, toTs: number): number | null {
  const blocks = Number(toBlock - fromBlock);
  if (blocks <= 0) return null;
  return ((toTs - fromTs) * 1000) / blocks;
}

export type ChainFreshness = {
  network: string;
  label: string;
  /** When the settlements index last saved a checkpoint for this chain. Null: never, or not readable. */
  lastIndexedAt: Date | null;
  /** Chain time between the checkpoint block and the tip, from both blocks' timestamps. Null: not measured. */
  secondsBehind: number | null;
  expectedMsPerBlock: number | null;
  measuredMsPerBlock: number | null;
  interval: IntervalVerdict;
  /** Why a value is missing, in a few words. Never a secret, never an RPC URL. */
  note: string | null;
};

type BlockReader = {
  getBlockNumber(): Promise<bigint>;
  getBlock(args: { blockNumber: bigint }): Promise<{ number: bigint | null; timestamp: bigint }>;
};

/**
 * One EVM chain, given its checkpoint row. Exported for tests: the reader is
 * injected, so no test reaches a real RPC.
 */
export async function readEvmChainFreshness(
  chain: Pick<EvmIndexChain, "caip2" | "blocksPerDay" | "blockTimeSchedule">,
  checkpoint: { lastBlock: bigint; updatedAt: Date | null } | null,
  reader: BlockReader,
): Promise<ChainFreshness> {
  const expected = expectedMsPerBlock(chain);
  const base: ChainFreshness = {
    network: chain.caip2,
    label: publicChainLabel(chain.caip2),
    lastIndexedAt: checkpoint?.updatedAt ?? null,
    secondsBehind: null,
    expectedMsPerBlock: expected,
    measuredMsPerBlock: null,
    interval: "unknown",
    note: checkpoint ? null : "not indexed yet",
  };
  try {
    const tip = await reader.getBlockNumber();
    const sampleFrom = tip > INTERVAL_SAMPLE_BLOCKS ? tip - INTERVAL_SAMPLE_BLOCKS : 0n;
    const [tipBlock, sampleBlock, checkpointBlock] = await Promise.all([
      reader.getBlock({ blockNumber: tip }),
      reader.getBlock({ blockNumber: sampleFrom }),
      checkpoint && checkpoint.lastBlock < tip ? reader.getBlock({ blockNumber: checkpoint.lastBlock }) : Promise.resolve(null),
    ]);
    const tipTs = Number(tipBlock.timestamp);
    const measured = measuredMsPerBlock(sampleFrom, Number(sampleBlock.timestamp), tip, tipTs);
    base.measuredMsPerBlock = measured;
    base.interval = intervalVerdict(expected, measured);
    if (checkpoint) {
      base.secondsBehind = checkpointBlock ? Math.max(0, tipTs - Number(checkpointBlock.timestamp)) : 0;
    }
  } catch {
    base.note = "chain not read";
  }
  return base;
}

/**
 * Every chain the settlements index covers. EVM chains get a measured lag and
 * interval; Solana and XRPL keep one checkpoint per payee, so they show only
 * the newest index run.
 */
/** Per running copy of the function: /status is rendered per request (CSP nonce), the RPCs should not be. */
export const FRESHNESS_MEMO_MS = 120_000;
let memo: { at: number; value: Promise<ChainFreshness[] | null> } | null = null;

export function readChainFreshness(now: number = Date.now()): Promise<ChainFreshness[] | null> {
  if (memo && now - memo.at < FRESHNESS_MEMO_MS) return memo.value;
  const value = readChainFreshnessUncached();
  memo = { at: now, value };
  // A failed read is not remembered for the full window.
  void value.then(
    (v) => {
      if (v === null && memo?.value === value) memo = null;
    },
    () => {
      if (memo?.value === value) memo = null;
    },
  );
  return value;
}

async function readChainFreshnessUncached(): Promise<ChainFreshness[] | null> {
  const db = getDb();
  if (!db) return null;
  const evm = EVM_INDEX_CHAINS.filter(isEvmChainIndexable);
  let rows: { scope: string; lastBlock: bigint; updatedAt: Date | null }[];
  let perPayee: { prefix: string; updatedAt: Date | null }[];
  try {
    rows = await db
      .select({ scope: indexerCheckpoints.scope, lastBlock: indexerCheckpoints.lastBlock, updatedAt: indexerCheckpoints.updatedAt })
      .from(indexerCheckpoints)
      .where(inArray(indexerCheckpoints.scope, evm.map((c) => `settlements:${c.caip2}`)));
    perPayee = await Promise.all(
      [SOLANA_CHECKPOINT_SCOPE_PREFIX, XRPL_CHECKPOINT_SCOPE_PREFIX].map(async (prefix) => {
        const [row] = await db
          .select({ updatedAt: sql<Date | null>`max(${indexerCheckpoints.updatedAt})` })
          .from(indexerCheckpoints)
          .where(like(indexerCheckpoints.scope, `${prefix}%`));
        const v = row?.updatedAt ?? null;
        const d = v === null ? null : new Date(v);
        // An unreadable value is "not indexed yet", never an Invalid Date that would throw while rendering.
        return { prefix, updatedAt: d && !Number.isNaN(d.getTime()) ? d : null };
      }),
    );
  } catch {
    return null;
  }
  const byScope = new Map(rows.map((r) => [r.scope, r]));
  const evmRows = await Promise.all(
    evm.map((chain) => {
      const cp = byScope.get(`settlements:${chain.caip2}`) ?? null;
      const fallback: ChainFreshness = {
        network: chain.caip2,
        label: publicChainLabel(chain.caip2),
        lastIndexedAt: cp?.updatedAt ?? null,
        secondsBehind: null,
        expectedMsPerBlock: expectedMsPerBlock(chain),
        measuredMsPerBlock: null,
        interval: "unknown",
        note: "chain not read",
      };
      try {
        const client = (chain.makeClient ? chain.makeClient() : getLogScanClient(chain.chainId)) as unknown as BlockReader;
        return withTimeout(readEvmChainFreshness(chain, cp, client), CHAIN_READ_TIMEOUT_MS).catch(() => fallback);
      } catch {
        return Promise.resolve(fallback);
      }
    }),
  );
  const others: ChainFreshness[] = perPayee.map(({ prefix, updatedAt }) => {
    const network = prefix === SOLANA_CHECKPOINT_SCOPE_PREFIX ? "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" : "xrpl:0";
    return {
      network,
      label: prefix === SOLANA_CHECKPOINT_SCOPE_PREFIX ? "Solana" : "XRPL",
      lastIndexedAt: updatedAt,
      secondsBehind: null,
      expectedMsPerBlock: null,
      measuredMsPerBlock: null,
      interval: "unknown",
      note: updatedAt ? "indexed per payee" : "not indexed yet",
    };
  });
  return [...evmRows, ...others];
}
