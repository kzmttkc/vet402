// ============================================================
// 既に索引した settlements / settlement_daily を、公開一覧の payer について
// wash_flag measurement へ揃える。本番では scripts/backfill-measurement-payers.ts
// から叩く。既定は数えるだけ。--apply のときだけ書く。
//
// test は動かさない（vet402 自身の測定購入は settlement_30d_test のまま）。
// 一覧に無い payer は動かさない。
// settlement_daily は wash_flag が鍵なので、移す行は消して measurement 側へ
// 件数と amount_sum を足す。同じ鍵が既にあれば足す。1 文で行う。
// ============================================================
import { sql, type SQL } from "drizzle-orm";
import { MEASUREMENT_PAYERS } from "./measurement-payers";
import { rowsOf } from "./upsert";

type Executor = { execute: (query: SQL) => Promise<unknown> };

export type FlagTally = { rows: number; payments: number };

export type MeasurementReclassReport = {
  apply: boolean;
  /** 一覧に載っていて、この実行が移す対象（test と既に measurement は除く）。 */
  settlementsToMove: number;
  dailyRowsToMove: number;
  dailyPaymentsToMove: number;
  /** 移したあとの行数。dry-run では 0。 */
  settlementsMoved: number;
  dailyRowsMoved: number;
  /** 一覧の payer が今持っている旗。test は残る。 */
  settlementsByFlag: Record<string, FlagTally>;
  dailyByFlag: Record<string, FlagTally>;
};

/** eip155 は lower で照合する。他 chain は payer_id の文字列のまま。 */
export function measurementPayerMatch(column: SQL): SQL {
  const eip = MEASUREMENT_PAYERS.filter((p) => p.chain.startsWith("eip155:")).map((p) => p.payerId);
  const rest = MEASUREMENT_PAYERS.filter((p) => !p.chain.startsWith("eip155:")).map((p) => p.payerId);
  const parts: SQL[] = [];
  if (eip.length > 0) {
    parts.push(sql`lower(${column}) IN (${sql.join(eip.map((id) => sql`${id}`), sql`, `)})`);
  }
  if (rest.length > 0) {
    parts.push(sql`${column} IN (${sql.join(rest.map((id) => sql`${id}`), sql`, `)})`);
  }
  if (parts.length === 0) return sql`false`;
  return sql`(${sql.join(parts, sql` OR `)})`;
}

const MOVE = sql`wash_flag <> 'test' AND wash_flag <> 'measurement'`;

function tally(rows: { wash_flag: string; rows: number; payments: number }[]): Record<string, FlagTally> {
  const out: Record<string, FlagTally> = {};
  for (const r of rows) out[r.wash_flag] = { rows: Number(r.rows), payments: Number(r.payments) };
  return out;
}

export async function reclassifyMeasurementPayers(
  db: Executor,
  opts: { apply: boolean },
): Promise<MeasurementReclassReport> {
  const match = measurementPayerMatch(sql`payer_id`);
  const settlementFlags = tally(
    rowsOf(
      await db.execute(sql`
        SELECT wash_flag, count(*)::int AS rows, count(*)::int AS payments
        FROM settlements
        WHERE ${match}
        GROUP BY wash_flag
      `),
    ),
  );
  const dailyFlags = tally(
    rowsOf(
      await db.execute(sql`
        SELECT wash_flag, count(*)::int AS rows, coalesce(sum(n), 0)::int AS payments
        FROM settlement_daily
        WHERE ${match}
        GROUP BY wash_flag
      `),
    ),
  );
  const settlementsToMove = rowsOf<{ n: number }>(
    await db.execute(sql`SELECT count(*)::int AS n FROM settlements WHERE ${match} AND ${MOVE}`),
  )[0]?.n ?? 0;
  const dailyMove = rowsOf<{ rows: number; payments: number }>(
    await db.execute(sql`
      SELECT count(*)::int AS rows, coalesce(sum(n), 0)::int AS payments
      FROM settlement_daily
      WHERE ${match} AND ${MOVE}
    `),
  )[0] ?? { rows: 0, payments: 0 };

  let settlementsMoved = 0;
  let dailyRowsMoved = 0;
  if (opts.apply) {
    const moved = rowsOf<{ n: number }>(
      await db.execute(sql`
        WITH moved AS (
          UPDATE settlements
          SET wash_flag = 'measurement'
          WHERE ${match} AND ${MOVE}
          RETURNING 1
        )
        SELECT count(*)::int AS n FROM moved
      `),
    );
    settlementsMoved = Number(moved[0]?.n ?? 0);
    const daily = rowsOf<{ n: number }>(
      await db.execute(sql`
        WITH moved AS (
          DELETE FROM settlement_daily
          WHERE ${match} AND ${MOVE}
          RETURNING day, chain, payee_id, payer_id, source, attribution, endpoint_id, resource_id, n, amount_sum
        ),
        agg AS (
          SELECT day, chain, payee_id, payer_id, source, attribution, endpoint_id, resource_id,
                 sum(n)::int AS n, sum(amount_sum) AS amount_sum
          FROM moved
          GROUP BY day, chain, payee_id, payer_id, source, attribution, endpoint_id, resource_id
        ),
        upserted AS (
          INSERT INTO settlement_daily
            (day, chain, payee_id, payer_id, wash_flag, source, attribution, endpoint_id, resource_id, n, amount_sum)
          SELECT day, chain, payee_id, payer_id, 'measurement', source, attribution, endpoint_id, resource_id, n, amount_sum
          FROM agg
          ON CONFLICT ON CONSTRAINT settlement_daily_key
          DO UPDATE SET
            n = settlement_daily.n + EXCLUDED.n,
            amount_sum = settlement_daily.amount_sum + EXCLUDED.amount_sum
          RETURNING 1
        )
        SELECT (SELECT count(*) FROM moved)::int AS n
      `),
    );
    dailyRowsMoved = Number(daily[0]?.n ?? 0);
  }

  return {
    apply: opts.apply,
    settlementsToMove: Number(settlementsToMove),
    dailyRowsToMove: Number(dailyMove.rows ?? 0),
    dailyPaymentsToMove: Number(dailyMove.payments ?? 0),
    settlementsMoved,
    dailyRowsMoved,
    settlementsByFlag: settlementFlags,
    dailyByFlag: dailyFlags,
  };
}
