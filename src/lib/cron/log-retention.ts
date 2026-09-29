import { lt, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { dashboardSessions, ipRateLimits } from "@/lib/db/schema";
import { isMissingSchemaError } from "@/lib/db/pg-errors";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const LOG_RETENTION_DAYS = {
  free: 90,
  pro: 365,
  scale: 365,
} as const;

export type PurgeLogsResult = {
  trustEventsDeleted: number;
  sessionsDeleted: number;
  rateLimitsDeleted: number;
  /** verification_requests rows whose raw requester IP was cleared. */
  requesterIpsScrubbed: number;
  /**
   * decision_lookup_callers rows older than LOOKUP_CALLER_RETENTION_DAYS (2026-09-29 audit round 5).
   * null when the table does not exist yet (DDL not applied) — not the same as 0 deleted.
   */
  lookupCallersDeleted: number | null;
};

/** decision_lookup_callers の保持日数。C2 の昇格は直近 7 日の問い合わせを見るので、それより 1 日長く持つ。 */
export const LOOKUP_CALLER_RETENTION_DAYS = 8;

function cutoffDate(days: number): Date {
  return new Date(Date.now() - days * MS_PER_DAY);
}

export async function purgeExpiredLogs(): Promise<PurgeLogsResult> {
  const db = getDb();
  if (!db) {
    throw new Error("DATABASE_URL is not configured");
  }

  const freeCutoff = cutoffDate(LOG_RETENTION_DAYS.free).toISOString();
  const paidCutoff = cutoffDate(LOG_RETENTION_DAYS.pro).toISOString();
  const now = new Date();

  const [freeDeleted, paidDeleted, sessionsDeleted, rateLimitsDeleted, ipsScrubbed] =
    await Promise.all([
      db.execute(sql`
        DELETE FROM trust_events te
        USING api_keys ak
        WHERE te.api_key_id = ak.id
          AND ak.plan = 'free'
          AND te.created_at < ${freeCutoff}
      `),
      db.execute(sql`
        DELETE FROM trust_events te
        USING api_keys ak
        WHERE te.api_key_id = ak.id
          AND ak.plan IN ('pro', 'scale')
          AND te.created_at < ${paidCutoff}
      `),
      db.delete(dashboardSessions).where(lt(dashboardSessions.expiresAt, now)).returning(),
      db.delete(ipRateLimits).where(lt(ipRateLimits.resetAt, now)).returning(),
      // 2026-08-22 audit: verification_requests.requester_ip stores a raw client
      // IP (observatory/requests.ts) and was the one PII column this purge did
      // not know about — it accumulated forever.
      //
      // Period: the free 90 days. The queue is the keyless free surface; there
      // is no api key on the row to look a plan up from, so the free tier's
      // retention is the only one it can honestly claim.
      //
      // Scrubbed rather than deleted, which is the ONE deliberate difference
      // from the statements above. The probe this request produced records
      // `requestId` in its raw_response_meta, and the observatory's whole claim
      // is that a published measurement can be traced to what triggered it.
      // Dropping the row would break that link to save nothing: the IP is the
      // personal data, the row is provenance. So the IP goes and the row stays.
      db.execute(sql`
        UPDATE verification_requests
        SET requester_ip = NULL
        WHERE requester_ip IS NOT NULL
          AND created_at < ${freeCutoff}
      `),
    ]);

  // 2026-09-29 監査 5 周目: 問い合わせの重複除去の表（呼び手の HMAC）も 8 日で消す。表がまだ無い環境
  // （DDL 未適用）では他の掃除を落とさない——null で返す。
  let lookupCallersDeleted: number | null = null;
  try {
    const lookupCutoff = new Date(Date.now() - LOOKUP_CALLER_RETENTION_DAYS * MS_PER_DAY).toISOString().slice(0, 10);
    lookupCallersDeleted = sqlDeleteCount(
      await db.execute(sql`DELETE FROM decision_lookup_callers WHERE day < ${lookupCutoff}`),
    );
  } catch (error) {
    if (!isMissingSchemaError(error)) throw error;
  }

  return {
    lookupCallersDeleted,
    trustEventsDeleted: sqlDeleteCount(freeDeleted) + sqlDeleteCount(paidDeleted),
    sessionsDeleted: sessionsDeleted.length,
    rateLimitsDeleted: rateLimitsDeleted.length,
    requesterIpsScrubbed: sqlDeleteCount(ipsScrubbed),
  };
}

/** rowCount for a raw DELETE/UPDATE, across the shapes the driver returns. */
function sqlDeleteCount(result: unknown): number {
  if (!result || typeof result !== "object") return 0;
  const meta = result as { rowCount?: number; count?: number };
  return Number(meta.rowCount ?? meta.count ?? 0);
}
