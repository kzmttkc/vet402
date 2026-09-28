import { and, eq, sql } from "drizzle-orm";
import { getDb } from "./db/client";
import { isMissingSchemaError } from "./db/pg-errors";
import { watchlistEntries } from "./db/schema";
import { scoreAgentById, scoreWallet } from "./scoring/engine";
import { dispatchWebhookEvent } from "./webhooks";
import { invalidatePayeeCacheForVerdictChange } from "./payee/cache-guard";
import { logServerErrorSafe } from "@/lib/util/log-safe";

// ============================================================
// Vouch — watchlist (N-15, 2026-08-05).
//
// The pull-API gap, closed: a customer who gated settlement on a score had
// no way to learn the world changed BETWEEN lookups. The watchlist inverts
// it — register targets once, the cron re-scores them, and a webhook fires
// ONLY when the recommendation moved (score jitter without a verdict change
// is stored but not pushed; a webhook that fires on noise trains its
// receiver to ignore it).
//
// The re-scan bypasses nothing: it calls the same engine with the same
// fail-closed rules, so a watchlist BLOCK is exactly what a live lookup
// would have returned.
// ============================================================

export const MAX_WATCHLIST_PER_KEY = 50;

export interface WatchlistEntry {
  id: string;
  targetType: "agent" | "wallet";
  target: string;
  chainId: number;
  lastScore: number | null;
  lastRecommendation: string | null;
  lastCheckedAt: string | null;
  active: boolean;
}

export async function listWatchlist(apiKeyId: string): Promise<WatchlistEntry[]> {
  const db = getDb();
  if (!db) return [];
  try {
    const rows = await db
      .select()
      .from(watchlistEntries)
      .where(eq(watchlistEntries.apiKeyId, apiKeyId));
    return rows.map((r) => ({
      id: r.id,
      targetType: r.targetType as "agent" | "wallet",
      target: r.target,
      chainId: r.chainId,
      lastScore: r.lastScore,
      lastRecommendation: r.lastRecommendation,
      lastCheckedAt: r.lastCheckedAt?.toISOString() ?? null,
      active: r.active,
    }));
  } catch (error) {
    if (isMissingSchemaError(error)) return [];
    throw error;
  }
}

export async function addWatch(params: {
  apiKeyId: string;
  targetType: "agent" | "wallet";
  target: string;
  chainId?: number;
}): Promise<{ id: string } | { error: "limit_reached" | "store_unavailable" }> {
  const db = getDb();
  if (!db) return { error: "store_unavailable" };
  try {
    const count = await db
      .select({ n: sql<number>`count(*)` })
      .from(watchlistEntries)
      .where(eq(watchlistEntries.apiKeyId, params.apiKeyId));
    if (Number(count[0]?.n ?? 0) >= MAX_WATCHLIST_PER_KEY) {
      return { error: "limit_reached" };
    }
    const inserted = await db
      .insert(watchlistEntries)
      .values({
        apiKeyId: params.apiKeyId,
        targetType: params.targetType,
        target: params.target.toLowerCase(),
        chainId: params.chainId ?? 8453,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) return { id: inserted[0].id };
    // conflict = already watched; find and return the existing row's id
    const existing = await db
      .select({ id: watchlistEntries.id })
      .from(watchlistEntries)
      .where(
        and(
          eq(watchlistEntries.apiKeyId, params.apiKeyId),
          eq(watchlistEntries.targetType, params.targetType),
          eq(watchlistEntries.target, params.target.toLowerCase()),
        ),
      )
      .limit(1);
    return existing[0] ? { id: existing[0].id } : { error: "store_unavailable" };
  } catch (error) {
    if (isMissingSchemaError(error)) return { error: "store_unavailable" };
    throw error;
  }
}

export async function removeWatch(apiKeyId: string, id: string): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  try {
    const deleted = await db
      .delete(watchlistEntries)
      .where(and(eq(watchlistEntries.id, id), eq(watchlistEntries.apiKeyId, apiKeyId)))
      .returning();
    return deleted.length > 0;
  } catch (error) {
    if (isMissingSchemaError(error)) return false;
    throw error;
  }
}

/** One cron pass: re-score active entries, persist, webhook on verdict change. */
export async function scanWatchlist(limit = 100): Promise<{
  scanned: number;
  changed: number;
  errors: number;
}> {
  const db = getDb();
  if (!db) return { scanned: 0, changed: 0, errors: 0 };
  let rows: (typeof watchlistEntries.$inferSelect)[];
  try {
    rows = await db
      .select()
      .from(watchlistEntries)
      .where(eq(watchlistEntries.active, true))
      .limit(limit);
  } catch (error) {
    if (isMissingSchemaError(error)) return { scanned: 0, changed: 0, errors: 0 };
    throw error;
  }

  let scanned = 0;
  let changed = 0;
  let errors = 0;
  for (const row of rows) {
    scanned += 1;
    try {
      const result =
        row.targetType === "agent"
          ? await scoreAgentById(BigInt(row.target), {
              apiKeyId: row.apiKeyId,
              chainId: row.chainId,
            })
          : await scoreWallet(row.target, { apiKeyId: row.apiKeyId });

      const verdictChanged =
        row.lastRecommendation !== null && row.lastRecommendation !== result.recommendation;

      await db
        .update(watchlistEntries)
        .set({
          lastScore: result.trustScore,
          lastRecommendation: result.recommendation,
          lastCheckedAt: new Date(),
        })
        .where(eq(watchlistEntries.id, row.id));

      if (verdictChanged) {
        changed += 1;
        // H-3: a worsened verdict (a drain flipping ALLOW→WARN/BLOCK is the
        // canonical cause) must also drop the wallet from the buyer-side payee
        // cache, or a buyer lookup keeps replaying the pre-drain ALLOW for up
        // to the 5-min TTL. Best-effort, in-process (see cache-guard's note).
        invalidatePayeeCacheForVerdictChange({
          targetType: row.targetType as "agent" | "wallet",
          target: row.target,
          previous: row.lastRecommendation,
          current: result.recommendation,
        });
        void dispatchWebhookEvent(row.apiKeyId, "watch.verdict_changed", {
          watchId: row.id,
          targetType: row.targetType,
          target: row.target,
          chainId: row.chainId,
          previous: { score: row.lastScore, recommendation: row.lastRecommendation },
          current: { score: result.trustScore, recommendation: result.recommendation },
        }).catch((error) => logServerErrorSafe("watchlist_webhook", error));
      }
    } catch (error) {
      errors += 1;
      logServerErrorSafe("watchlist_scan_entry", error);
    }
  }
  return { scanned, changed, errors };
}
