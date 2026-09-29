// ============================================================
// §10 訂正ログと異議のレート制限。
//
//   recordCorrection        公開判定が変わったとき before/after を単文 INSERT で残す
//   isDisputeRateLimited    同一 endpoint への連続異議を 7 日 3 件で止める（純関数）
//   listCorrections         公開用の読み出し
//
// 自社に不利な数字を隠すことは仕様違反（§10）。訂正は消さない。
// ============================================================
import { sql, type SQL } from "drizzle-orm";
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

/** 訂正ログの before / after: JS の値（JSON にして入れる）か、`changed`（更新された行）を参照する jsonb 式。 */
export type CorrectionValue = { json: unknown } | { expr: SQL };

type Executor = { execute: (query: SQL) => Promise<unknown> };

/**
 * 台帳の UPDATE と訂正ログの INSERT を**1 つの文**で書く（2026-09-29 敵対的監査 4 周目）。
 *
 * 以前は UPDATE の後に recordCorrection を別の文で呼び、失敗は `.catch(logAndSwallow…)` で
 * 握りつぶしていた。公開の状態（status / tx_hash / 照合の理由）は変わったのに、「いつ何が
 * 変わったか」の記録だけが欠ける——訂正ログの存在理由（§10: 消さない・隠さない）と逆になる。
 * neon-http は複数文のトランザクションを持たないので、データ変更 CTE で 1 文にまとめる:
 *
 *   WITH changed AS (<UPDATE … RETURNING …, <subject id> AS correction_subject_id>),
 *        logged  AS (INSERT INTO correction_log … SELECT … FROM changed RETURNING 1)
 *   SELECT changed.*, (SELECT count(*) FROM logged) AS correction_logged FROM changed
 *
 * どちらかが落ちれば両方とも書かれず、例外は呼び手へ上がる（fail-loud。照合器は行単位で
 * 捕まえて rowErrors に数え、次回のバッチが同じ行を拾い直す＝再試行）。
 * `update` は `correction_subject_id` を RETURNING に含めること。更新 0 行なら訂正も 0 行。
 */
export async function updateWithCorrection<T extends Record<string, unknown>>(
  db: Executor,
  input: {
    update: SQL;
    subjectType: "endpoint" | "purchase";
    level: CorrectionLevel;
    reason: CorrectionReason;
    before: CorrectionValue;
    after: CorrectionValue;
    disputeId?: string | null;
  },
): Promise<(T & { correction_subject_id: string; correction_logged: number })[]> {
  const value = (v: CorrectionValue): SQL => ("expr" in v ? v.expr : sql`${JSON.stringify(v.json)}::jsonb`);
  const rows = rowsOf<T & { correction_subject_id: string; correction_logged: number }>(
    await db.execute(sql`
      WITH changed AS (${input.update}),
      logged AS (
        INSERT INTO correction_log (subject_type, subject_id, level, before, after, reason, dispute_id)
        SELECT ${input.subjectType}, changed.correction_subject_id::text, ${input.level},
               ${value(input.before)}, ${value(input.after)}, ${input.reason}, ${input.disputeId ?? null}::uuid
        FROM changed
        RETURNING 1
      )
      SELECT changed.*, (SELECT count(*) FROM logged)::int AS correction_logged FROM changed
    `),
  );
  for (const r of rows) {
    if (Number(r.correction_logged) !== rows.length) {
      // 同じ文なので起きないはずだが、起きたら黙らない（計器の故障）。
      throw new Error(`correction_log count mismatch: changed=${rows.length} logged=${r.correction_logged}`);
    }
  }
  return rows;
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

/**
 * 訂正ログの**全件**を reason で数える（2026-09-19 独立レビュー W7）。
 *
 * /corrections の見出しは `listCorrections({ limit: 500 })` の配列長を件数として出していたが、
 * 本番ではその上限に張り付いていて、見出しの「500」は件数ではなく**上限**だった
 * （2026-09-04 監査 P1-11 と同種の事故——同じ頁で見出しと本文が別の数を名乗る）。
 * 見出しはここで数え、表は読み込んだ分だけ描く。
 */
export async function countCorrectionsByReason(): Promise<{ settlementBackfill: number; verdictChanges: number }> {
  const db = getDb();
  if (!db) return { settlementBackfill: 0, verdictChanges: 0 };
  const rows = rowsOf<{ settlement_backfill: number; verdict_changes: number }>(
    await db.execute(sql`
      SELECT count(*) FILTER (WHERE reason = 'settlement_backfill')::int AS settlement_backfill,
             count(*) FILTER (WHERE reason <> 'settlement_backfill')::int AS verdict_changes
      FROM correction_log
    `),
  );
  return {
    settlementBackfill: Number(rows[0]?.settlement_backfill ?? 0),
    verdictChanges: Number(rows[0]?.verdict_changes ?? 0),
  };
}

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
