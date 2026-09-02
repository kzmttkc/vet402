// ============================================================
// §10 訂正ログと異議のレート制限。
//
//   recordCorrection        公開判定が変わったとき before/after を単文 INSERT で残す
//   isDisputeRateLimited    同一 endpoint への連続異議を 7 日 3 件で止める（純関数）
//   listCorrections         公開用の読み出し
//
// 自社に不利な数字を隠すことは仕様違反（§10）。訂正は消さない。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { rowsOf } from "@/lib/settlements/upsert";

/** path_template: 2026-09-02 監査 A1——テンプレート URL を叩いて出した公開 fail を unverified へ戻す。 */
export type CorrectionReason = "dispute_remeasure" | "settlement_backfill" | "reverify" | "path_template";
export type CorrectionLevel = "l0" | "l1" | "l2" | "listing";

export const DISPUTE_WINDOW_DAYS = 7;
export const DISPUTE_MAX_PER_WINDOW = 3;

/** 純関数: 直近の異議の created_at 列（順不同）から、次の 1 件を止めるべきか。 */
export function isDisputeRateLimited(recentCreatedAt: readonly Date[], now: Date): boolean {
  const cutoff = now.getTime() - DISPUTE_WINDOW_DAYS * 86_400_000;
  const n = recentCreatedAt.filter((d) => d.getTime() >= cutoff).length;
  return n >= DISPUTE_MAX_PER_WINDOW;
}

export async function recordCorrection(input: {
  subjectType: "endpoint" | "purchase";
  subjectId: string;
  level: CorrectionLevel;
  before: unknown;
  after: unknown;
  reason: CorrectionReason;
  disputeId?: string | null;
}): Promise<string | null> {
  const db = getDb();
  if (!db) return null;
  const rows = rowsOf<{ id: string }>(
    await db.execute(sql`
      INSERT INTO correction_log (subject_type, subject_id, level, before, after, reason, dispute_id)
      VALUES (${input.subjectType}, ${input.subjectId}, ${input.level},
              ${JSON.stringify(input.before)}::jsonb, ${JSON.stringify(input.after)}::jsonb,
              ${input.reason}, ${input.disputeId ?? null}::uuid)
      RETURNING id::text AS id
    `),
  );
  return rows[0]?.id ?? null;
}

export type CorrectionRow = {
  id: string;
  subject_type: string;
  subject_id: string;
  level: string;
  before: unknown;
  after: unknown;
  reason: string;
  dispute_id: string | null;
  created_at: string;
};

export async function listCorrections(filter: { endpointId?: string; limit?: number } = {}): Promise<CorrectionRow[]> {
  const db = getDb();
  if (!db) return [];
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  return rowsOf<CorrectionRow>(
    await db.execute(sql`
      SELECT id::text AS id, subject_type, subject_id, level, before, after, reason,
             dispute_id::text AS dispute_id, created_at::text AS created_at
      FROM correction_log
      ${filter.endpointId ? sql`WHERE subject_type = 'endpoint' AND subject_id = ${filter.endpointId}` : sql``}
      ORDER BY created_at DESC LIMIT ${limit}
    `),
  );
}

/** endpoint の直近 7 日の異議 created_at（レート制限用）。 */
export async function recentDisputeTimes(endpointId: string): Promise<Date[]> {
  const db = getDb();
  if (!db) return [];
  return rowsOf<{ created_at: string }>(
    await db.execute(sql`
      SELECT created_at::text AS created_at FROM disputes
      WHERE endpoint_id = ${endpointId}::uuid AND created_at > now() - make_interval(days => ${DISPUTE_WINDOW_DAYS})
    `),
  ).map((r) => new Date(r.created_at));
}
