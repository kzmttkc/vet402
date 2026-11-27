// ============================================================
// GET /api/v1/observatory/export.csv と月次凍結が共有する購入台帳の読み出し（2026-11-27 F5）。
// 列・並び・status の除外は export.csv route と同じ。新しい主張はここからは生まれない。
// ============================================================
import { sql } from "drizzle-orm";
import type { getDb } from "@/lib/db/client";
import { utcDayStartOf } from "@/lib/db/utc-day";
import { heldReasonSql } from "@/lib/observatory/delivery";
import { confirmedUnitsSql } from "@/lib/observatory/export-columns";
import { ledgerExportCsvShape } from "@/lib/observatory/export-csv-ledger-shape";
import { l2ReadingColumnsSql, l2ReadingOf } from "@/lib/observatory/l2-check";
import { responseBytesSql, responseSha256Sql } from "@/lib/observatory/paid-response-fingerprint";
import { requestBodySha256Sql, requestBodyKindSql } from "@/lib/observatory/request-body";
import { requestQuerySha256Sql, requestQueryKindSql } from "@/lib/observatory/request-query";
import { settlementSourceSql } from "@/lib/observatory/settlement-source";

type AppDb = NonNullable<ReturnType<typeof getDb>>;

const MONTH_RE = /^(\d{4})-(\d{2})$/;

export type LedgerExportWindow =
  | { kind: "rolling_days"; days: number }
  | { kind: "utc_month"; month: string };

export type ReadLedgerExportResult = {
  columns: readonly string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
};

function monthBounds(month: string): { start: string; endExclusive: string } {
  const match = MONTH_RE.exec(month);
  if (!match) throw new Error(`readLedgerExportRows: not YYYY-MM: ${month}`);
  const year = Number(match[1]);
  const mon = Number(match[2]);
  if (!Number.isInteger(year) || !Number.isInteger(mon) || mon < 1 || mon > 12) {
    throw new Error(`readLedgerExportRows: not YYYY-MM: ${month}`);
  }
  const start = `${match[1]}-${match[2]}-01`;
  const endYear = mon === 12 ? year + 1 : year;
  const endMonth = mon === 12 ? 1 : mon + 1;
  const endExclusive = `${String(endYear).padStart(4, "0")}-${String(endMonth).padStart(2, "0")}-01`;
  return { start, endExclusive };
}

/** export.csv と同じ l2_reading の読み直し。 */
export function mapLedgerExportRow(r: Record<string, unknown>): Record<string, unknown> {
  const l2Schema = typeof r.l2_schema === "string" ? r.l2_schema : null;
  return {
    ...r,
    l2_reading:
      l2Schema === null
        ? null
        : l2ReadingOf(
            {
              l2Schema,
              l2Detail: r.l2_detail,
              bodyHead: typeof r.l2_body_head === "string" ? r.l2_body_head : null,
              contentType: typeof r.l2_content_type === "string" ? r.l2_content_type : null,
            },
            r.l2_declared_schema ?? null,
          ),
  };
}

export async function readLedgerExportRows(
  db: Pick<AppDb, "execute">,
  window: LedgerExportWindow,
  opts?: { limit?: number; includeErc8004Agent?: boolean },
): Promise<ReadLedgerExportResult> {
  const limit = opts?.limit;
  const { columns, extraSelectSql } = ledgerExportCsvShape(opts?.includeErc8004Agent === true);

  let timeFilter: ReturnType<typeof sql>;
  if (window.kind === "rolling_days") {
    timeFilter = sql`pu.attempted_at >= now() - make_interval(days => ${window.days}::int)`;
  } else {
    const { start, endExclusive } = monthBounds(window.month);
    timeFilter = sql`pu.attempted_at >= ${utcDayStartOf(start)} AND pu.attempted_at < ${utcDayStartOf(endExclusive)}`;
  }

  const limitSql = limit === undefined ? sql`` : sql`LIMIT ${limit}`;

  const raw = await db.execute(sql`
    SELECT to_char(pu.attempted_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS attempted_at,
           e.resource_key, pu.network, pu.status, pu.amount_units, pu.spent_units,
           pu.tx_hash, pu.http_status_paid, pu.latency_ms, pu.l2_schema,
           (${sql.raw(heldReasonSql("pu"))}) AS held_reason,
           (${sql.raw(requestBodyKindSql("pu"))}) AS request_body,
           (${sql.raw(requestBodySha256Sql("pu"))}) AS request_body_sha256,
           (${sql.raw(settlementSourceSql("pu"))}) AS settlement_source,
           (${sql.raw(requestQueryKindSql("pu"))}) AS request_query,
           (${sql.raw(requestQuerySha256Sql("pu"))}) AS request_query_sha256,
           (${sql.raw(confirmedUnitsSql("pu"))}) AS confirmed_units,
           pu.id::text AS purchase_id,
           ${sql.raw(l2ReadingColumnsSql("pu"))},
           (${sql.raw(responseSha256Sql("pu"))}) AS response_sha256,
           (${sql.raw(responseBytesSql("pu"))}) AS response_bytes
           ${sql.raw(extraSelectSql)},
           CASE WHEN pu.l2_schema = 'mismatch' THEN e.declared_schema END AS l2_declared_schema
    FROM x402_l1_purchases pu
    JOIN x402_endpoints e ON e.id = pu.endpoint_id
    WHERE ${timeFilter}
      AND pu.status NOT IN ('budget_denied', 'halted', 'request_error', 'in_flight')
    ORDER BY pu.attempted_at ASC, pu.id ASC
    ${limitSql}
  `);
  const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Record<string, unknown>[];
  const truncated = limit !== undefined && rows.length >= limit;
  const emit = truncated && limit !== undefined ? rows.slice(0, limit - 1) : rows;
  return {
    columns,
    rows: emit.map(mapLedgerExportRow),
    truncated,
  };
}