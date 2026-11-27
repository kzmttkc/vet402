// ============================================================
// 月次の購入台帳凍結（F5・2026-11-27）。11 月分は 2026-12-01 00:00 UTC から公開する。
//
// 凍結の内容は export.csv の既定 21 列・attempted_at 昇順（同時刻は purchase_id 昇順）と同じ。
// contentSha256 はデータ行だけ（見出しなし）を csvCell で直列化した UTF-8 の sha256。
// 日次 root への足し込みは 2026-12-01 以降の日だけ。1 凍結月あたり 1 行:
//   monthly-freeze:v1:YYYY-MM:<contentSha256>
// ============================================================
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { getDb } from "@/lib/db/client";
import { EXPORT_CSV_COLUMNS } from "@/lib/observatory/export-columns";
import { readLedgerExportRows } from "@/lib/observatory/ledger-export";
import { csvCell } from "@/lib/util/csv-write";

type AppDb = NonNullable<ReturnType<typeof getDb>>;

const MONTH_RE = /^(\d{4})-(\d{2})$/;
const YEAR_MIN = 2026;
const YEAR_MAX = 2100;

/** この日より前の日次 root には月次行を足さない（過去の封印 root を変えない）。 */
export const MONTHLY_FREEZE_ANCHOR_FROM_DAY = "2026-12-01";

export const MONTHLY_FREEZE_STATUS_NOT_CLOSED = "month_not_closed";
export const MONTHLY_FREEZE_STATUS_NOT_FROZEN_YET = "not_frozen_yet";

export type MonthlyFreezeError = typeof MONTHLY_FREEZE_STATUS_NOT_CLOSED | typeof MONTHLY_FREEZE_STATUS_NOT_FROZEN_YET;

export type MonthlyFreezeSummary = {
  v: 1;
  month: string;
  periodStart: string;
  periodEndExclusive: string;
  rowCount: number;
  contentSha256: string;
  columns: readonly string[];
  sort: readonly ["attempted_at", "purchase_id"];
  frozenAt: string;
};

export type MonthlyFreezePublic =
  | { status: "frozen"; summary: MonthlyFreezeSummary }
  | { status: typeof MONTHLY_FREEZE_STATUS_NOT_FROZEN_YET; month: string }
  | { status: typeof MONTHLY_FREEZE_STATUS_NOT_CLOSED; month: string };

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function parseMonthlyFreezeMonth(monthRaw: string | null): { ok: true; month: string } | { ok: false } {
  const text = (monthRaw ?? "").trim();
  const match = MONTH_RE.exec(text);
  if (!match) return { ok: false };
  const year = Number(match[1]);
  const mon = Number(match[2]);
  if (!Number.isInteger(year) || !Number.isInteger(mon) || year < YEAR_MIN || year > YEAR_MAX) return { ok: false };
  if (mon < 1 || mon > 12) return { ok: false };
  return { ok: true, month: `${match[1]}-${match[2]}` };
}

function nextMonthStart(year: number, month: number): string {
  const y = month === 12 ? year + 1 : year;
  const m = month === 12 ? 1 : month + 1;
  return `${String(y).padStart(4, "0")}-${pad2(m)}-01`;
}

/** 凍結を公開してよい UTC 瞬間（締まった月の翌月 1 日 00:00 UTC）。 */
export function monthlyFreezePublishAt(month: string): number {
  const parsed = parseMonthlyFreezeMonth(month);
  if (!parsed.ok) return NaN;
  const match = MONTH_RE.exec(parsed.month)!;
  const year = Number(match[1]);
  const mon = Number(match[2]);
  return Date.parse(`${nextMonthStart(year, mon)}T00:00:00.000Z`);
}

/** 未来の月は month_not_closed。締まった月は publish 前は not_frozen_yet。 */
export function monthlyFreezePublicationError(month: string, now: Date = new Date()): MonthlyFreezeError | null {
  const parsed = parseMonthlyFreezeMonth(month);
  if (!parsed.ok) return MONTHLY_FREEZE_STATUS_NOT_CLOSED;
  const match = MONTH_RE.exec(parsed.month)!;
  const year = Number(match[1]);
  const mon = Number(match[2]);
  const nowYear = now.getUTCFullYear();
  const nowMonth = now.getUTCMonth() + 1;
  if (year > nowYear || (year === nowYear && mon > nowMonth)) return MONTHLY_FREEZE_STATUS_NOT_CLOSED;
  const publishAt = monthlyFreezePublishAt(parsed.month);
  if (!Number.isFinite(publishAt) || now.getTime() < publishAt) return MONTHLY_FREEZE_STATUS_NOT_FROZEN_YET;
  return null;
}

export function monthlyFreezeAnchorLine(month: string, contentSha256: string): string {
  return `monthly-freeze:v1:${month}:${contentSha256}`;
}

function compareExportRows(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const at = String(a.attempted_at ?? "");
  const bt = String(b.attempted_at ?? "");
  if (at !== bt) return at < bt ? -1 : 1;
  const aid = String(a.purchase_id ?? "");
  const bid = String(b.purchase_id ?? "");
  if (aid !== bid) return aid < bid ? -1 : 1;
  return 0;
}

/** データ行だけを決定的に並べ、csvCell で直列化して sha256。 */
export function hashMonthlyLedgerExportBody(
  rows: readonly Record<string, unknown>[],
  columns: readonly string[] = EXPORT_CSV_COLUMNS,
): string {
  const sorted = [...rows].sort(compareExportRows);
  const lines = sorted.map((r) => columns.map((c) => csvCell(r[c])).join(","));
  const body = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function buildMonthlyFreezeSummary(
  month: string,
  rows: readonly Record<string, unknown>[],
  columns: readonly string[],
  frozenAt: Date = new Date(),
): MonthlyFreezeSummary {
  const parsed = parseMonthlyFreezeMonth(month);
  if (!parsed.ok) throw new Error(`buildMonthlyFreezeSummary: invalid month ${month}`);
  const match = MONTH_RE.exec(parsed.month)!;
  const year = Number(match[1]);
  const mon = Number(match[2]);
  const periodStart = `${match[1]}-${match[2]}-01`;
  const periodEndExclusive = nextMonthStart(year, mon);
  return {
    v: 1,
    month: parsed.month,
    periodStart,
    periodEndExclusive,
    rowCount: rows.length,
    contentSha256: hashMonthlyLedgerExportBody(rows, columns),
    columns,
    sort: ["attempted_at", "purchase_id"],
    frozenAt: frozenAt.toISOString(),
  };
}

/** 錨定用: day 以前に公開済みの凍結月だけ、月の昇順で 1 行ずつ。 */
export function buildAnchorPayloadWithMonthlyLines(
  ledgerPayload: string,
  day: string,
  frozen: readonly { month: string; contentSha256: string }[],
): string {
  if (day < MONTHLY_FREEZE_ANCHOR_FROM_DAY || frozen.length === 0) return ledgerPayload;
  const publishCutoff = day;
  const lines = frozen
    .filter((r) => {
      const pubDay = nextMonthStart(
        Number(r.month.slice(0, 4)),
        Number(r.month.slice(5, 7)),
      );
      return pubDay <= publishCutoff;
    })
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((r) => monthlyFreezeAnchorLine(r.month, r.contentSha256));
  if (lines.length === 0) return ledgerPayload;
  return `${ledgerPayload}\n${lines.join("\n")}`;
}

export async function listFrozenMonthlyLedger(db: Pick<AppDb, "execute">): Promise<
  { month: string; contentSha256: string; summary: MonthlyFreezeSummary }[]
> {
  const raw = await db.execute(sql`
    SELECT month, content_sha256, summary_json::text AS summary_json
    FROM ledger_monthly_frozen
    ORDER BY month ASC
  `);
  const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as {
    month: string;
    content_sha256: string;
    summary_json: string;
  }[];
  return rows.map((r) => ({
    month: String(r.month),
    contentSha256: String(r.content_sha256),
    summary: JSON.parse(r.summary_json) as MonthlyFreezeSummary,
  }));
}

export async function anchorPayloadForDay(
  db: Pick<AppDb, "execute">,
  day: string,
  ledgerPayload: string,
): Promise<string> {
  if (day < MONTHLY_FREEZE_ANCHOR_FROM_DAY) return ledgerPayload;
  const frozen = await listFrozenMonthlyLedger(db);
  return buildAnchorPayloadWithMonthlyLines(
    ledgerPayload,
    day,
    frozen.map((r) => ({ month: r.month, contentSha256: r.contentSha256 })),
  );
}

export async function loadMonthlyFreezeSummary(db: Pick<AppDb, "execute">, month: string): Promise<MonthlyFreezeSummary | null> {
  const raw = await db.execute(sql`
    SELECT summary_json::text AS summary_json
    FROM ledger_monthly_frozen
    WHERE month = ${month}
    LIMIT 1
  `);
  const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as { summary_json: string }[];
  if (rows.length === 0) return null;
  return JSON.parse(rows[0].summary_json) as MonthlyFreezeSummary;
}

export async function readMonthlyFreezePublic(
  db: Pick<AppDb, "execute">,
  month: string,
  now: Date = new Date(),
): Promise<MonthlyFreezePublic> {
  const publication = monthlyFreezePublicationError(month, now);
  if (publication === MONTHLY_FREEZE_STATUS_NOT_CLOSED) {
    return { status: MONTHLY_FREEZE_STATUS_NOT_CLOSED, month };
  }
  const stored = await loadMonthlyFreezeSummary(db, month);
  if (stored) return { status: "frozen", summary: stored };
  if (publication === MONTHLY_FREEZE_STATUS_NOT_FROZEN_YET) {
    return { status: MONTHLY_FREEZE_STATUS_NOT_FROZEN_YET, month };
  }
  return { status: MONTHLY_FREEZE_STATUS_NOT_FROZEN_YET, month };
}

export async function computeMonthlyFreezeFromDb(
  db: Pick<AppDb, "execute">,
  month: string,
  frozenAt: Date = new Date(),
): Promise<MonthlyFreezeSummary> {
  const { rows, columns } = await readLedgerExportRows(db, { kind: "utc_month", month: month });
  return buildMonthlyFreezeSummary(month, rows, columns, frozenAt);
}

export async function insertMonthlyFreeze(
  db: Pick<AppDb, "execute">,
  summary: MonthlyFreezeSummary,
): Promise<"inserted" | "unchanged"> {
  const raw = await db.execute(sql`
    INSERT INTO ledger_monthly_frozen (month, period_start, period_end_exclusive, row_count, content_sha256, summary_json, frozen_at)
    VALUES (
      ${summary.month},
      ${summary.periodStart}::date,
      ${summary.periodEndExclusive}::date,
      ${summary.rowCount},
      ${summary.contentSha256},
      ${JSON.stringify(summary)}::jsonb,
      ${summary.frozenAt}::timestamptz
    )
    ON CONFLICT (month) DO NOTHING
    RETURNING month
  `);
  const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as { month: string }[];
  return rows.length > 0 ? "inserted" : "unchanged";
}