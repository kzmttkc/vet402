// ============================================================
// 2026-09-04 W15: settlements の日次集約と生行の保持期間。
//
// なぜ要るか: 決済索引は 1 日 3 万行・約 33 MB 積む。Neon 無料枠 512 MB に対し
// 2026-09-02 20:43 UTC から INSERT が `53100 project size limit` で全部落ちていた。
// 30 日ぶんの生行（約 1 GB）は無料枠でも有料でも持てない——際限が無いから。
//
// 何をするか: 生行 `settlements` は直近 RAW_RETENTION_DAYS 日だけ残し、
// それより古い UTC 日を (day, chain, payee_id, payer_id, wash_flag, source,
// attribution, endpoint_id, resource_id) の日次集約 `settlement_daily` へ畳む。
// payer_id / payee_id / endpoint_id を鍵に持つので、センサスの
// count(DISTINCT ...) は集約からも**正確に**出る。丸めない。
//
// 二重計上しない仕組み: DELETE ... RETURNING を CTE に置いた**単一文**で
// 「畳んで消す」。1 件の決済が生行と集約の両方に載る瞬間は無いので、
// センサスは「生行 ∪ 集約」を素直に足すだけでよい（→ census.ts）。
// cron がいつ走ったか・落ちたかに依存しない。畳み直しは冪等
//（残っている生行が無ければ何もしない）。
//
// 失うもの: 畳んだ日の tx_hash / raw jsonb / 個票の時刻。受領証の突合と
// /resolve の tx 逆引きは直近 RAW_RETENTION_DAYS 日の窓の中だけ。
// ============================================================
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { rowsOf } from "./upsert";

/** 生行を残す UTC 日数。これより古い日は畳んで消す。 */
export const RAW_RETENTION_DAYS = intFromEnv("SETTLEMENTS_RAW_RETENTION_DAYS", 7);
/** 日次集約を残す UTC 日数。ここで全体の保存量が有界になる。 */
export const DAILY_RETENTION_DAYS = intFromEnv("SETTLEMENTS_DAILY_RETENTION_DAYS", 400);

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 決済が属する UTC 日。block_time が無い行は observed_at で決める（センサスと同じ規則）。 */
export const SETTLEMENT_DAY: SQL = sql`(coalesce(block_time, observed_at) AT TIME ZONE 'UTC')::date`;
/** UTC の今日。サーバのタイムゾーン設定に依存させない。 */
export const UTC_TODAY: SQL = sql`(now() AT TIME ZONE 'UTC')::date`;

export type RollupDayPlan = { day: string; rows: number; groups: number };

export type RollupResult = {
  applied: boolean;
  rawRetentionDays: number;
  dailyRetentionDays: number;
  /** この日以前（<=）が畳む対象。 */
  cutoff: string | null;
  days: RollupDayPlan[];
  rowsFolded: number;
  groupsWritten: number;
  /** 生行 1 行あたりの実測バイト（heap + 索引）から出した削減見込み。 */
  estimatedFreedMb: number;
  /** 保持期間を過ぎて落とした集約行。 */
  dailyPruned: number;
  /** DELETE だけでは Neon の project size は下がらない。 */
  note: string;
};

const VACUUM_NOTE =
  "DELETE frees no space by itself: the rows stay as dead tuples and Neon still counts them. Run VACUUM (FULL, ANALYZE) settlements after applying to actually shrink the project.";

function emptyResult(applied: boolean): RollupResult {
  return {
    applied,
    rawRetentionDays: RAW_RETENTION_DAYS,
    dailyRetentionDays: DAILY_RETENTION_DAYS,
    cutoff: null,
    days: [],
    rowsFolded: 0,
    groupsWritten: 0,
    estimatedFreedMb: 0,
    dailyPruned: 0,
    note: VACUUM_NOTE,
  };
}

/** 畳む対象の日ごとの行数と、畳んだ後の集約行数。書かない。 */
async function readPlan(): Promise<{ days: RollupDayPlan[]; cutoff: string | null; bytesPerRow: number }> {
  const db = getDb();
  if (!db) return { days: [], cutoff: null, bytesPerRow: 0 };
  const rows = rowsOf<{ day: string; rows: number; groups: number }>(
    await db.execute(sql`
      WITH old AS (
        SELECT ${SETTLEMENT_DAY} AS day, chain, payee_id, payer_id, wash_flag, source, attribution, endpoint_id, resource_id
        FROM settlements
        WHERE ${SETTLEMENT_DAY} <= ${UTC_TODAY} - ${RAW_RETENTION_DAYS}::int
      ), g AS (
        SELECT day, count(*)::bigint AS n
        FROM old
        GROUP BY day, chain, payee_id, payer_id, wash_flag, source, attribution, endpoint_id, resource_id
      )
      SELECT day::text AS day, sum(n)::int AS rows, count(*)::int AS groups
      FROM g GROUP BY day ORDER BY day
    `),
  );
  const cutoffRow = rowsOf<{ cutoff: string }>(
    await db.execute(sql`SELECT (${UTC_TODAY} - ${RAW_RETENTION_DAYS}::int)::text AS cutoff`),
  )[0];
  // 実測の 1 行あたりバイト（heap + 索引 + TOAST）。空表なら 0。
  const size = rowsOf<{ bytes_per_row: number }>(
    await db.execute(sql`
      SELECT (pg_total_relation_size('settlements')::numeric / greatest(count(*), 1))::int AS bytes_per_row
      FROM settlements
    `),
  )[0];
  return {
    days: rows.map((r) => ({ day: r.day, rows: Number(r.rows), groups: Number(r.groups) })),
    cutoff: cutoffRow?.cutoff ?? null,
    bytesPerRow: Number(size?.bytes_per_row ?? 0),
  };
}

/** dry-run。何も書かずに「畳む日数・削る行数・削減見込み MB」を返す。 */
export async function planRollup(): Promise<RollupResult> {
  const db = getDb();
  if (!db) return emptyResult(false);
  const { days, cutoff, bytesPerRow } = await readPlan();
  const rowsFolded = days.reduce((a, d) => a + d.rows, 0);
  const groupsWritten = days.reduce((a, d) => a + d.groups, 0);
  const stale = rowsOf<{ n: number }>(
    await db.execute(sql`
      SELECT count(*)::int AS n FROM settlement_daily WHERE day < ${UTC_TODAY} - ${DAILY_RETENTION_DAYS}::int
    `),
  )[0];
  return {
    ...emptyResult(false),
    cutoff,
    days,
    rowsFolded,
    groupsWritten,
    estimatedFreedMb: Math.round(((rowsFolded * bytesPerRow) / 1_048_576) * 10) / 10,
    dailyPruned: Number(stale?.n ?? 0),
  };
}

/**
 * 畳む。`apply: false`（既定）は planRollup と同じ dry-run。
 *
 * 書くときは 1 文で「消して・畳んで・入れる」。日ごとに分けないのは、
 * 分けると同じ表を日数ぶん走査するため（初回は 40 日ぶんある）。
 */
export async function runRollup(opts: { apply?: boolean } = {}): Promise<RollupResult> {
  if (!opts.apply) return planRollup();
  const db = getDb();
  if (!db) return emptyResult(true);

  const before = await readPlan();
  const inserted = rowsOf<{ day: string; groups: number; rows: number }>(
    await db.execute(sql`
      WITH moved AS (
        DELETE FROM settlements
        WHERE ${SETTLEMENT_DAY} <= ${UTC_TODAY} - ${RAW_RETENTION_DAYS}::int
        RETURNING coalesce(block_time, observed_at) AS at, chain, payee_id, payer_id,
                  wash_flag, source, attribution, endpoint_id, resource_id, amount
      ), g AS (
        SELECT (at AT TIME ZONE 'UTC')::date AS day, chain, payee_id, payer_id, wash_flag, source, attribution,
               endpoint_id, resource_id, count(*)::int AS n,
               -- amount は base units の 10 進文字列。索引の経路によっては
               -- 数字でない値が入りうるので、畳む処理を落とさず 0 として足す。
               sum(CASE WHEN amount ~ '^[0-9]+$' THEN amount::numeric ELSE 0 END) AS amount_sum
        FROM moved
        GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
      )
      INSERT INTO settlement_daily
        (day, chain, payee_id, payer_id, wash_flag, source, attribution, endpoint_id, resource_id, n, amount_sum)
      SELECT day, chain, payee_id, payer_id, wash_flag, source, attribution, endpoint_id, resource_id, n, amount_sum
      FROM g
      -- 遅れて届いた生行を畳み直すときは足す。消すのと同じ文なので、
      -- 同じ生行が 2 度足されることはない（＝何度走らせても同じ結果）。
      ON CONFLICT ON CONSTRAINT settlement_daily_key DO UPDATE
        SET n = settlement_daily.n + excluded.n,
            amount_sum = settlement_daily.amount_sum + excluded.amount_sum
      RETURNING day::text AS day, n AS rows
    `),
  );

  const pruned = rowsOf<{ day: string }>(
    await db.execute(sql`
      DELETE FROM settlement_daily WHERE day < ${UTC_TODAY} - ${DAILY_RETENTION_DAYS}::int RETURNING day::text AS day
    `),
  );

  const rowsFolded = before.days.reduce((a, d) => a + d.rows, 0);
  return {
    ...emptyResult(true),
    cutoff: before.cutoff,
    days: before.days,
    rowsFolded,
    groupsWritten: inserted.length,
    estimatedFreedMb: Math.round(((rowsFolded * before.bytesPerRow) / 1_048_576) * 10) / 10,
    dailyPruned: pruned.length,
  };
}
