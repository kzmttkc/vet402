import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { getIndexerCheckpoint } from "@/lib/db/owner-index";
import {
  ERC8004_SOLANA_CAIP,
  ERC8004_SOLANA_DB_CHAIN_ID,
  ERC8004_SOLANA_X402_SCOPE,
} from "@/lib/observatory/erc8004-solana-constants";
import { erc8004SolanaMatchQuery, type Erc8004MatchRead } from "@/lib/observatory/erc8004-match";
import { logServerErrorSafe } from "@/lib/util/log-safe";

export type Erc8004SolanaLadder = {
  registered: number | { unavailable: true; reason: string };
  x402Declared: number | { unavailable: true; reason: string };
  matchedAgents: number | { unavailable: true; reason: string };
  purchaseAttempts: number | { unavailable: true; reason: string };
  settled: number | { unavailable: true; reason: string };
  delivered: number | { unavailable: true; reason: string };
  indexSlot: string | null;
  readAt: string;
};

function rowsOf(raw: unknown): Record<string, unknown>[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
}

function unavailable(reason: string): { unavailable: true; reason: string } {
  return { unavailable: true, reason };
}

async function readPurchaseCounts(db: NonNullable<ReturnType<typeof getDb>>): Promise<{
  attempts: number;
  settled: number;
  delivered: number;
} | null> {
  try {
    const row = rowsOf(
      await db.execute(sql`
        WITH matched AS (
          SELECT DISTINCT paid.pay_to
          FROM x402_l1_purchases paid
          WHERE paid.network = ${ERC8004_SOLANA_CAIP}
            AND paid.pay_to IS NOT NULL
            AND (
              EXISTS (
                SELECT 1 FROM erc8004_chain_agents ca
                WHERE ca.chain_id = ${ERC8004_SOLANA_DB_CHAIN_ID} AND ca.owner = paid.pay_to
              )
              OR EXISTS (
                SELECT 1 FROM erc8004_chain_agents ca
                WHERE ca.chain_id = ${ERC8004_SOLANA_DB_CHAIN_ID} AND ca.wallet = paid.pay_to
              )
            )
        )
        SELECT
          count(*)::int AS attempts,
          count(*) FILTER (WHERE p.status = 'settled')::int AS settled,
          count(*) FILTER (
            WHERE p.status = 'settled'
              AND p.http_status_paid IS NOT NULL
              AND p.http_status_paid >= 200
              AND p.http_status_paid < 300
              AND p.http_status_paid <> 202
              AND p.payload_non_empty IS TRUE
          )::int AS delivered
        FROM x402_l1_purchases p
        WHERE p.network = ${ERC8004_SOLANA_CAIP}
          AND p.pay_to IN (SELECT pay_to FROM matched)
      `),
    )[0];
    if (!row) return null;
    return {
      attempts: Number(row.attempts ?? 0),
      settled: Number(row.settled ?? 0),
      delivered: Number(row.delivered ?? 0),
    };
  } catch (error) {
    logServerErrorSafe("erc8004_solana_ladder.purchases", error);
    return null;
  }
}

export async function readErc8004SolanaLadder(match: Erc8004MatchRead): Promise<Erc8004SolanaLadder> {
  const readAt = match.readAt;
  const solRow = match.status === "ok" ? match.byChain[ERC8004_SOLANA_CAIP] : null;

  let registered: Erc8004SolanaLadder["registered"] = unavailable("chain_index_not_read");
  let matchedAgents: Erc8004SolanaLadder["matchedAgents"] = unavailable("chain_index_not_read");
  let indexSlot: string | null = null;

  if (solRow?.status === "scanned") {
    registered = solRow.scannedAgents;
    matchedAgents = solRow.matchedAgents;
    indexSlot = solRow.indexBlock;
  } else if (solRow?.status === "unavailable") {
    registered = unavailable(solRow.reason);
    matchedAgents = unavailable(solRow.reason);
  }

  const x402Cp = await getIndexerCheckpoint(ERC8004_SOLANA_X402_SCOPE);
  const x402Declared =
    x402Cp === null
      ? unavailable("index_not_started")
      : Number(x402Cp);

  const db = getDb();
  let purchaseAttempts: Erc8004SolanaLadder["purchaseAttempts"] = unavailable("database_not_configured");
  let settled: Erc8004SolanaLadder["settled"] = unavailable("database_not_configured");
  let delivered: Erc8004SolanaLadder["delivered"] = unavailable("database_not_configured");

  if (db) {
    const counts = await readPurchaseCounts(db);
    if (counts === null) {
      purchaseAttempts = unavailable("query_failed");
      settled = unavailable("query_failed");
      delivered = unavailable("query_failed");
    } else if (typeof matchedAgents === "number" && matchedAgents === 0) {
      purchaseAttempts = 0;
      settled = 0;
      delivered = 0;
    } else {
      purchaseAttempts = counts.attempts;
      settled = counts.settled;
      delivered = counts.delivered;
    }
    if (
      solRow?.status === "scanned" &&
      typeof matchedAgents === "number" &&
      matchedAgents > 0 &&
      typeof purchaseAttempts !== "number"
    ) {
      try {
        const row = rowsOf(await db.execute(erc8004SolanaMatchQuery()))[0];
        if (row) {
          purchaseAttempts = Number(row.matched_purchases ?? 0);
          settled = Number(row.matched_settled ?? 0);
        }
      } catch {
        /* keep unavailable */
      }
    }
  }

  return {
    registered,
    x402Declared,
    matchedAgents,
    purchaseAttempts,
    settled,
    delivered,
    indexSlot,
    readAt,
  };
}

/** Type guard helper for templates. */
export function ladderCount(value: number | { unavailable: true; reason: string }): string {
  return typeof value === "number" ? value.toLocaleString("en-US") : `unavailable (${value.reason})`;
}