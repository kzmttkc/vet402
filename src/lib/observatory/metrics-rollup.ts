// ============================================================
// 日次メトリクスのロールアップ（Phase 1.1）。
//
// raw（x402_l0_probes / x402_l1_purchases）を UTC 日 × チェーンで集計し、
// x402_daily_metrics へ冪等 upsert する。1文の INSERT ... SELECT ... ON
// CONFLICT DO UPDATE で書くのは l1-runner.reserveSpend と同じ理由——
// 読んでから書く形にすると並行実行（cron と backfill の重なり）で
// 半端な合成が起き得る。ここは事実のキャッシュであり、いつでも raw から
// 再導出できる（正本は raw）。
//
// 2026-09-05 修正（公開2面の突合不能）:
//
//  1. **凍結**。集計 cron は 10:30 UTC、L1 の決済確認 cron は 14:00 UTC。
//     その日の後半に settled へ昇格した行は、当日ぶんを1回書いたきりの
//     旧実装では二度と集計へ入らなかった（実測 2026-09-05: 集計済み 13 日で
//     live settled > rolled settled、Base だけで 221 件の過小）。
//     直し方は「毎回、直近 N 日を丸ごと再計算する」（rollupRecentDailyMetrics）。
//     再計算は raw からの再導出なので何度走らせても同値。
//
//  2. **分母の食い違い**。旧実装は L1 の行を status で絞らずに全部
//     l1_attempts として数えていた。/api/v1/observatory/state は
//     PAID_ATTEMPT_STATUSES（実際に署名して払った試行）だけを attempts と
//     呼ぶ。同じ語が2面で別の意味だった（実測: Solana は rolled 50 / live 38、
//     差の 13 件は no_eligible_accept 7 + over_cap 6——金は動いていない）。
//     ここは state と同じ PAID_ATTEMPT_STATUSES を分母にする。
//
//  3. **消えた行が残る**。再計算で導出されなくなったチェーン行（分母の変更で
//     0 件になった日×チェーン）を消さないと、古い定義の数字が表に残る。
//     upsert と同じ1文の中で、agg に現れないその日の行を DELETE する。
//
// chain は「実際に払ったレール」（pu.network）→ カタログ申告網（e.network）
// → "unknown" の順。NULL も空文字も unknown に落とす——空文字はネットワークの
// 申告ではないので、'' という名前のチェーンを表に作らない（state 側の
// chainLabel() も空文字をチェーンとして扱わない）。申告が無いことを集計から
// 黙って消さない（facts with denominators）。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { utcDayStartOf } from "@/lib/db/utc-day";
import { PAID_ATTEMPT_STATUSES } from "./reader";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/**
 * 毎回さかのぼって再計算する日数の既定値。
 *
 * なぜ 14 か: 遅れて確定する経路は verify-settlements（当日 14:00 UTC）と
 * recoverLateSettlements（署名した EIP-3009 の有効窓の内側で後から決済された
 * 分の回収）で、いずれも数日以内に落ち着く。2週間はその 2 倍以上の余裕。
 * これより古い日は backfill スクリプトの守備範囲で、cron が過去へ無限に
 * 手を伸ばさない。
 */
export const METRICS_ROLLUP_LOOKBACK_DEFAULT_DAYS = 14;

/**
 * 再計算する日数（env METRICS_ROLLUP_LOOKBACK_DAYS）。
 * 読めない値は既定へ黙って戻さず投げる——設定を間違えたまま
 * 「動いているように見える」のがこのファイルが直している欠陥そのもの。
 */
export function metricsRollupLookbackDays(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.METRICS_ROLLUP_LOOKBACK_DAYS;
  if (raw === undefined || raw.trim() === "") return METRICS_ROLLUP_LOOKBACK_DEFAULT_DAYS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 366) {
    throw new Error(
      `METRICS_ROLLUP_LOOKBACK_DAYS: 1..366 の整数である必要がある（受け取った値: ${JSON.stringify(raw)}）`,
    );
  }
  return n;
}

export function utcDayString(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

export function shiftDay(day: string, days: number): string {
  if (!DAY_RE.test(day)) throw new Error(`shiftDay: not a YYYY-MM-DD day: ${day}`);
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * その日ぶんの parts / agg CTE。ロールアップ（書く）と preview（書かない）が
 * **同じ文字列**を使う——定義が2箇所にあると、片方だけ直した日に
 * 「backfill の予測」と「実際に書かれる値」が静かにずれる。
 */
function partsAndAggCte(day: string) {
  const paidStatuses = sql.join(
    PAID_ATTEMPT_STATUSES.map((st) => sql`${st}`),
    sql`, `,
  );
  // 日境界は接続の TimeZone に依存させない（utcDayStartOf の comment を見よ）。
  // 終端も「+ interval '1 day'」ではなく翌日の 00:00 UTC を名指しする——
  // timestamptz への日加算は session TimeZone で行われる。
  const dayStart = utcDayStartOf(day);
  const nextStart = utcDayStartOf(shiftDay(day, 1));
  return sql`
    parts AS (
      SELECT
        coalesce(nullif(e.network, ''), 'unknown') AS chain,
        count(*) AS l0_probes,
        count(*) FILTER (WHERE p.verdict = 'pass') AS l0_pass,
        0::bigint AS l1_attempts, 0::bigint AS l1_settled, 0::numeric AS spent_units
      FROM x402_l0_probes p
      JOIN x402_endpoints e ON e.id = p.endpoint_id
      WHERE p.probed_at >= ${dayStart} AND p.probed_at < ${nextStart}
      GROUP BY 1
      UNION ALL
      SELECT
        -- L1のchainは「実際に支払ったレール」（pu.network＝acceptの網）。
        -- カタログ申告網で数えると、Solana申告の壁にBaseレールで払った決済が
        -- Solana実績に見える（2026-08-20 助成金提案書の検算で実際に25件検出）。
        -- 旧行（pu.network無し）だけ申告網へフォールバック。
        coalesce(nullif(pu.network, ''), nullif(e.network, ''), 'unknown') AS chain,
        0::bigint, 0::bigint,
        count(*) AS l1_attempts,
        count(*) FILTER (WHERE pu.status = 'settled') AS l1_settled,
        coalesce(sum(pu.spent_units::numeric), 0) AS spent_units
      FROM x402_l1_purchases pu
      JOIN x402_endpoints e ON e.id = pu.endpoint_id
      WHERE pu.attempted_at >= ${dayStart} AND pu.attempted_at < ${nextStart}
        -- state と同じ分母。払っていない試行（budget_denied / no_402 /
        -- no_eligible_accept / over_cap / …）を attempts と呼ばない。
        AND pu.status IN (${paidStatuses})
      GROUP BY 1
    ),
    agg AS (
      SELECT
        chain,
        coalesce(sum(l0_probes), 0)::int AS l0_probes,
        coalesce(sum(l0_pass), 0)::int AS l0_pass,
        coalesce(sum(l1_attempts), 0)::int AS l1_attempts,
        coalesce(sum(l1_settled), 0)::int AS l1_settled,
        coalesce(sum(spent_units), 0)::text AS spent_units
      FROM parts
      GROUP BY chain
    )
  `;
}

/** Aggregate one UTC day from the raw tables into x402_daily_metrics. */
export async function rollupDailyMetrics(day: string): Promise<void> {
  if (!DAY_RE.test(day)) throw new Error(`rollupDailyMetrics: not a YYYY-MM-DD day: ${day}`);
  const db = getDb();
  if (!db) throw new Error("rollupDailyMetrics: DATABASE_URL is not configured");

  // 1文。upsert と「導出されなくなった行の削除」を同じ文に入れる——別々の文に
  // すると、その隙間に history が読んだときだけ古い定義の行が見える。
  // データ変更 CTE（upserted）は参照されなくても必ず 1 回実行される（PostgreSQL 保証）。
  // DELETE は agg に無い chain だけを対象にするので、INSERT が触る行とは交わらない。
  await db.execute(sql`
    WITH ${partsAndAggCte(day)},
    upserted AS (
      INSERT INTO x402_daily_metrics (day, chain, l0_probes, l0_pass, l1_attempts, l1_settled, spent_units, updated_at)
      SELECT ${day}, chain, l0_probes, l0_pass, l1_attempts, l1_settled, spent_units, now()
      FROM agg
      ON CONFLICT (day, chain) DO UPDATE SET
        l0_probes = EXCLUDED.l0_probes,
        l0_pass = EXCLUDED.l0_pass,
        l1_attempts = EXCLUDED.l1_attempts,
        l1_settled = EXCLUDED.l1_settled,
        spent_units = EXCLUDED.spent_units,
        updated_at = EXCLUDED.updated_at
      RETURNING chain
    )
    DELETE FROM x402_daily_metrics d
    WHERE d.day = ${day}
      AND NOT EXISTS (SELECT 1 FROM agg a WHERE a.chain = d.chain)
  `);
}

/**
 * 書かずに、その日が今 raw からどう導出されるかを返す（backfill の dry-run 用）。
 * rollupDailyMetrics と同じ CTE を使う。
 */
export async function previewDailyMetrics(day: string): Promise<DailyMetricsRow[]> {
  if (!DAY_RE.test(day)) throw new Error(`previewDailyMetrics: not a YYYY-MM-DD day: ${day}`);
  const db = getDb();
  if (!db) throw new Error("previewDailyMetrics: DATABASE_URL is not configured");
  const raw = await db.execute(sql`
    WITH ${partsAndAggCte(day)}
    SELECT ${day} AS day, chain, l0_probes, l0_pass, l1_attempts, l1_settled, spent_units
    FROM agg ORDER BY chain ASC
  `);
  return toDailyMetricsRows(raw);
}

/**
 * 直近 N 日（既定 14・env METRICS_ROLLUP_LOOKBACK_DAYS）を古い順に再計算する。
 * 冪等。返すのは実際に回した日（古い順）。
 *
 * 古い順に回すのは、途中で落ちたときに「新しい日が古いまま」で終わるほうが
 * 「古い日に穴」より読み手にとって安全だから（穴は合計を静かに減らす）。
 */
export async function rollupRecentDailyMetrics(
  options: { days?: number; endDay?: string } = {},
): Promise<string[]> {
  const days = options.days ?? metricsRollupLookbackDays();
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(`rollupRecentDailyMetrics: days は 1 以上の整数（受け取った値: ${days}）`);
  }
  const endDay = options.endDay ?? utcDayString();
  if (!DAY_RE.test(endDay)) {
    throw new Error(`rollupRecentDailyMetrics: not a YYYY-MM-DD day: ${endDay}`);
  }
  const list: string[] = [];
  for (let i = days - 1; i >= 0; i--) list.push(shiftDay(endDay, -i));
  for (const day of list) await rollupDailyMetrics(day);
  return list;
}

export type DailyMetricsRow = {
  day: string;
  chain: string;
  l0Probes: number;
  l0Pass: number;
  l1Attempts: number;
  l1Settled: number;
  spentUnits: string;
};

function toDailyMetricsRows(raw: unknown): DailyMetricsRow[] {
  const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Record<
    string,
    unknown
  >[];
  return rows.map((r) => ({
    day: String(r.day),
    chain: String(r.chain),
    l0Probes: Number(r.l0_probes),
    l0Pass: Number(r.l0_pass),
    l1Attempts: Number(r.l1_attempts),
    l1Settled: Number(r.l1_settled),
    spentUnits: String(r.spent_units),
  }));
}

/**
 * History for the public API/page, newest day last. Bounded (≤ 366 days) —
 * this feeds a key-less endpoint, so the caller never controls an unbounded
 * scan.
 */
export async function getDailyMetricsHistory(days: number): Promise<DailyMetricsRow[]> {
  const span = Math.min(Math.max(Math.trunc(days) || 0, 1), 366);
  const db = getDb();
  if (!db) return [];
  const raw = await db.execute(sql`
    SELECT day, chain, l0_probes, l0_pass, l1_attempts, l1_settled, spent_units
    FROM x402_daily_metrics
    WHERE day >= to_char((now() AT TIME ZONE 'utc')::date - ${span}::int, 'YYYY-MM-DD')
    ORDER BY day ASC, chain ASC
  `);
  return toDailyMetricsRows(raw);
}

export type DailyMetricsCoverage = {
  /** 表にある最も古い日（この日より前は集計していない）。行が無ければ null。 */
  coverageFrom: string | null;
  /** 表にある最も新しい日。 */
  rolledUpThrough: string | null;
  /** 最後にロールアップが走った時刻（ISO8601・UTC）。 */
  lastRollupAt: string | null;
};

/**
 * 表そのものの被覆。history の応答へ添える——開始日と「いつ集計したか」を
 * 書かずに合計だけ出すと、読み手は state の live 合計と突き合わせて
 * 差を説明できない（2026-09-05 に第三者の検算で実際にそうなった）。
 */
export async function getDailyMetricsCoverage(): Promise<DailyMetricsCoverage> {
  const db = getDb();
  const empty: DailyMetricsCoverage = {
    coverageFrom: null,
    rolledUpThrough: null,
    lastRollupAt: null,
  };
  if (!db) return empty;
  const raw = await db.execute(sql`
    SELECT
      min(day) AS coverage_from,
      max(day) AS rolled_up_through,
      to_char(max(updated_at) AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_rollup_at
    FROM x402_daily_metrics
  `);
  const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Record<
    string,
    unknown
  >[];
  const r = rows[0];
  if (!r) return empty;
  return {
    coverageFrom: r.coverage_from == null ? null : String(r.coverage_from),
    rolledUpThrough: r.rolled_up_through == null ? null : String(r.rolled_up_through),
    lastRollupAt: r.last_rollup_at == null ? null : String(r.last_rollup_at),
  };
}
