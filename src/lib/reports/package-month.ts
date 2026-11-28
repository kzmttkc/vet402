// ============================================================
// 凍結済み月次購入台帳の外部公開束（I6）。DB には触らない。
// 入力は公開 URL から取った summary と CSV 本文（見出しなし）。
// ============================================================
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeliveryHttp } from "@/lib/observatory/delivery";
import { EXPORT_CSV_COLUMNS } from "@/lib/observatory/export-columns";
import type { MonthlyFreezeSummary } from "@/lib/observatory/monthly-freeze";
import {
  MONTHLY_FREEZE_STATUS_NOT_CLOSED,
  MONTHLY_FREEZE_STATUS_NOT_FROZEN_YET,
  monthlyFreezePublicationError,
  parseMonthlyFreezeMonth,
} from "@/lib/observatory/monthly-freeze";
export const DEFAULT_REPORTS_ORIGIN = "https://vet402.com";

/** 公開 export に無い列の断片。L1 の証拠 2 列は src で名指さない決まり（tests/l1-purchase-evidence.pg.test.ts）なので、
 *  ここには書かず、見出しの EXPORT_CSV_COLUMNS との完全一致で締め出す（試験は tests/reports-package-month.test.ts）。 */
const FORBIDDEN_HEADER_TOKENS = ["caller_hash", "raw_"] as const;

/** C2: 束に入れてはいけない列名・サマリ鍵の断片（小文字で照合）。 */
export const REPORTS_PACKAGE_FORBIDDEN_COLUMN_TOKENS = [
  "mrr",
  "revenue",
  "arpu",
  "arr",
  "churn",
  "subscriber",
  "subscription_count",
  "paid_customer",
  "kpi",
  "stripe",
  "gross_margin",
  "retention",
  "cac",
  "variable_cost",
  "net_revenue",
  "recurring",
] as const;

/** 公開 summary JSON に許す鍵だけ。 */
export const REPORTS_PACKAGE_ALLOWED_SUMMARY_KEYS = [
  "v",
  "month",
  "periodStart",
  "periodEndExclusive",
  "rowCount",
  "contentSha256",
  "columns",
  "sort",
  "frozenAt",
] as const;

export type MonthlyPackageInput = {
  summary: MonthlyFreezeSummary;
  /** 見出しなしの凍結 CSV 本文（サーバーが返す content_csv と同じ形）。 */
  csvBody: string;
  /**
   * 公開の /api/v1/observatory/delivery.csv で delivery = delivered の purchase_id。行の述語に加えて
   * この集合にも入っている行だけを配達に数える（台帳の CSV だけでは 2026-11-24 より前の空の本文を見分けられない）。
   * 必須: 無ければ束を作らない（C1 を台帳の列だけで判定しない）。
   */
  deliveredPurchaseIds: ReadonlySet<string>;
};

/**
 * C1: 束（外部に出す物）では、その月に 1 行も配達が無い売り手を名指ししない。resource_key だけを空にし、
 * 行は消さない（件数・並び・ほかの列は凍結のまま）。配達の述語は isDelivered と同じ形を台帳の列で当てる:
 * settled かつ有料の HTTP が 2xx（202 を除く）かつ response_bytes が 0 でない。
 */
export const REPORTS_PACKAGE_WITHHELD_RESOURCE_KEY = "";

/** RFC 4180 の CSV 本文を、各セルの原文（引用符ごと）のまま行に分ける。末尾の改行は行の終わりとして扱う。 */
export function splitCsvRecordsRaw(body: string): string[][] {
  const records: string[][] = [];
  let fields: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') i++;
        else quoted = false;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      fields.push(body.slice(start, i));
      start = i + 1;
    } else if (ch === "\n") {
      fields.push(body.slice(start, i));
      records.push(fields);
      fields = [];
      start = i + 1;
    }
  }
  if (quoted) throw new Error("csv body has an unterminated quoted field");
  if (start < body.length) {
    fields.push(body.slice(start));
    records.push(fields);
  }
  return records;
}

function unquoteCell(raw: string): string {
  return raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw;
}

function ledgerRowDelivered(cells: readonly string[], col: (name: string) => number, delivered: ReadonlySet<string>): boolean {
  if (unquoteCell(cells[col("status")]!) !== "settled") return false;
  const http = unquoteCell(cells[col("http_status_paid")]!);
  if (!/^[0-9]+$/.test(http) || !isDeliveryHttp(Number(http))) return false;
  if (unquoteCell(cells[col("response_bytes")]!) === "0") return false;
  if (!delivered.has(unquoteCell(cells[col("purchase_id")]!))) return false;
  return true;
}

export type WithheldCsv = { csvBody: string; rows: number; withheldRows: number; namedSellers: number };

/** C1: その月に配達が 1 行も無い売り手の行の resource_key を空にした本文を返す。行の数と順序は変えない。 */
export function withholdUndeliveredSellers(
  csvBody: string,
  columns: readonly string[],
  deliveredPurchaseIds: ReadonlySet<string>,
): WithheldCsv {
  if (!(deliveredPurchaseIds instanceof Set)) {
    throw new Error("deliveredPurchaseIds is required (read delivery.csv before building a bundle)");
  }
  const index = new Map(columns.map((c, i) => [c, i]));
  const col = (name: string): number => {
    const i = index.get(name);
    if (i === undefined) throw new Error(`columns lack ${name}`);
    return i;
  };
  const keyCol = col("resource_key");
  const records = splitCsvRecordsRaw(csvBody);
  for (const cells of records) {
    if (cells.length !== columns.length) {
      throw new Error(`csv row has ${cells.length} cells, expected ${columns.length}`);
    }
  }
  const deliveredKeys = new Set<string>();
  for (const cells of records) {
    if (ledgerRowDelivered(cells, col, deliveredPurchaseIds)) deliveredKeys.add(cells[keyCol]!);
  }
  let withheldRows = 0;
  const lines = records.map((cells) => {
    if (deliveredKeys.has(cells[keyCol]!)) return cells.join(",");
    withheldRows++;
    const out = [...cells];
    out[keyCol] = REPORTS_PACKAGE_WITHHELD_RESOURCE_KEY;
    return out.join(",");
  });
  return {
    csvBody: lines.length === 0 ? "" : `${lines.join("\n")}\n`,
    rows: records.length,
    withheldRows,
    namedSellers: deliveredKeys.size,
  };
}

export type PackageMonthBuildResult = {
  month: string;
  rootDir: string;
  /** 相対パス → 小文字 hex sha256（UTF-8 ファイル内容）。 */
  fileSha256: Record<string, string>;
};

export type PackageMonthOutcome =
  | { status: "invalid_month" }
  | { status: typeof MONTHLY_FREEZE_STATUS_NOT_CLOSED; month: string }
  | { status: typeof MONTHLY_FREEZE_STATUS_NOT_FROZEN_YET; month: string; message: "未凍結" }
  | { status: "built"; result: PackageMonthBuildResult };

export function csvFilename(month: string): string {
  return `vet402-ledger-${month}.csv`;
}

export function publishedCsvWithHeader(body: string, columns: readonly string[] = EXPORT_CSV_COLUMNS): string {
  const header = columns.join(",");
  if (body.length === 0) return `${header}\n`;
  const normalized = body.endsWith("\n") ? body : `${body}\n`;
  return `${header}\n${normalized}`;
}

export function headerLineOfCsv(csvWithHeader: string): string {
  const end = csvWithHeader.indexOf("\n");
  return end === -1 ? csvWithHeader.replace(/\r$/, "") : csvWithHeader.slice(0, end).replace(/\r$/, "");
}

/** 見出しが EXPORT_CSV_COLUMNS と完全一致し、禁止トークンを含まない。 */
export function assertMonthlyPackageColumns(headerLine: string): void {
  const cols = headerLine.split(",");
  if (cols.length !== EXPORT_CSV_COLUMNS.length) {
    throw new Error(
      `column count ${cols.length} does not match EXPORT_CSV_COLUMNS (${EXPORT_CSV_COLUMNS.length})`,
    );
  }
  for (let i = 0; i < cols.length; i++) {
    if (cols[i] !== EXPORT_CSV_COLUMNS[i]) {
      throw new Error(`column ${i} is ${JSON.stringify(cols[i])}, expected ${JSON.stringify(EXPORT_CSV_COLUMNS[i])}`);
    }
  }
  const lower = headerLine.toLowerCase();
  for (const token of [...FORBIDDEN_HEADER_TOKENS, ...REPORTS_PACKAGE_FORBIDDEN_COLUMN_TOKENS]) {
    if (lower.includes(token)) {
      throw new Error(`header contains forbidden token: ${token}`);
    }
  }
}

export function assertMonthlyPackageSummary(summary: MonthlyFreezeSummary): void {
  const keys = Object.keys(summary).sort();
  const allowed = new Set<string>(REPORTS_PACKAGE_ALLOWED_SUMMARY_KEYS);
  for (const key of keys) {
    if (!allowed.has(key)) {
      throw new Error(`summary contains disallowed key: ${key}`);
    }
  }
  if (summary.columns.length !== EXPORT_CSV_COLUMNS.length) {
    throw new Error("summary.columns length does not match EXPORT_CSV_COLUMNS");
  }
  for (let i = 0; i < summary.columns.length; i++) {
    if (summary.columns[i] !== EXPORT_CSV_COLUMNS[i]) {
      throw new Error(`summary.columns[${i}] mismatch`);
    }
  }
  assertMonthlyPackageColumns(summary.columns.join(","));
}

function sha256Utf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sha256SumsLines(rootLabel: string, relPaths: readonly string[], digests: Record<string, string>): string {
  const sorted = [...relPaths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `${sorted.map((rel) => `${digests[rel]}  ${rootLabel}/${rel}`).join("\n")}\n`;
}

function frozenPublicationDate(frozenAt: string): string {
  return frozenAt.slice(0, 10);
}

function zenodoMetadata(summary: MonthlyFreezeSummary): Record<string, unknown> {
  const month = summary.month;
  const pubDate = frozenPublicationDate(summary.frozenAt);
  return {
    metadata: {
      title: `vet402 monthly ledger freeze: ${month}`,
      upload_type: "dataset",
      publication_date: pubDate,
      description: `<p>Frozen purchase ledger rows for UTC month ${month}. Column definitions match GET /api/v1/observatory/export.csv. resource_key is left empty on rows of a seller with no delivered row in this month. Methodology: https://vet402.com/observatory/methodology. Summary JSON: https://vet402.com/api/v1/reports/${month}.json</p>`,
      creators: [{ name: "KIZUNA Creation", affiliation: "vet402" }],
      access_right: "open",
      license: "CC-BY-4.0",
      keywords: ["x402", "vet402", "monthly-freeze", month],
      related_identifiers: [
        {
          identifier: "10.5281/zenodo.24195171",
          relation: "isPartOf",
          resource_type: "dataset",
        },
      ],
    },
  };
}

const WITHHELD_NOTE =
  "Rows of a seller with no delivered row in this month keep their place and every other value, with `resource_key` left empty, so the bundle does not name a seller that did not deliver. A delivered row is settled, with a paid HTTP status of 2xx other than 202 and a non-empty body.";

function withheldLines(w: WithheldCsv): string {
  return `- Rows: ${w.rows}\n- Rows with \`resource_key\` left empty: ${w.withheldRows}\n- Sellers named: ${w.namedSellers}`;
}

function zenodoReadme(summary: MonthlyFreezeSummary, w: WithheldCsv): string {
  const month = summary.month;
  const frozenAt = summary.frozenAt;
  return `# vet402 monthly ledger freeze: ${month}

This directory is a Zenodo upload bundle for one frozen UTC month of vet402 purchase rows. The measurements are CC BY 4.0.

## Contents

- \`metadata.json\` is deposition metadata for the Zenodo REST API (not uploaded by itself; merge into a deposition).
- \`${csvFilename(month)}\` is the frozen CSV with the public export header row added. The rows after the header are the rows of GET /api/v1/reports/${month}.csv in the same order. ${WITHHELD_NOTE}
- \`README.md\` is this note.
- \`SHA256SUMS\` lists sha256 digests for every other file in this directory.

## Freeze

- \`contentSha256\`: ${summary.contentSha256}
- \`frozenAt\` (UTC): ${frozenAt}
- \`rowCount\`: ${summary.rowCount}
- Period: [${summary.periodStart}, ${summary.periodEndExclusive})

\`contentSha256\` is the digest of the freeze body before \`resource_key\` was left empty. \`SHA256SUMS\` has the digest of the CSV in this bundle.

${withheldLines(w)}

Column definitions: https://vet402.com/openapi.yaml
`;
}

function huggingFaceReadme(summary: MonthlyFreezeSummary, w: WithheldCsv): string {
  const month = summary.month;
  const frozenAt = summary.frozenAt;
  return `---
language:
- en
license: cc-by-4.0
tags:
- x402
- vet402
- monthly-freeze
task_categories:
- other
---

# vet402 monthly ledger freeze: ${month}

## Dataset description

Frozen purchase ledger for UTC month \`${month}\`, published by vet402. Rows are vet402's own x402 purchase attempts. This file does not include revenue, MRR, or other KPI values.

| Field | Value |
| --- | --- |
| frozenAt (UTC) | ${frozenAt} |
| contentSha256 | ${summary.contentSha256} |
| rowCount | ${summary.rowCount} |
| periodStart | ${summary.periodStart} |
| periodEndExclusive | ${summary.periodEndExclusive} |

\`contentSha256\` is the digest of the freeze body before \`resource_key\` was left empty.

## Files

- \`${csvFilename(month)}\` is a CSV with the same columns as \`/api/v1/observatory/export.csv\`. ${WITHHELD_NOTE}

${withheldLines(w)}

## Source

- JSON summary: https://vet402.com/api/v1/reports/${month}.json
- CSV body: https://vet402.com/api/v1/reports/${month}.csv

Column definitions: https://vet402.com/openapi.yaml
`;
}

function duneDescription(summary: MonthlyFreezeSummary, w: WithheldCsv): string {
  const month = summary.month;
  return `# Dune import: vet402 monthly ledger freeze ${month}

Import \`${csvFilename(month)}\` as a comma-separated table.

- Time column: \`attempted_at\` (UTC, ISO-8601 with Z suffix).
- Amount columns \`amount_units\`, \`spent_units\`, and \`confirmed_units\` are 6-decimal integer strings in USDC micro-units, not dollars.
- This extract is purchase-attempt metadata only. It does not include vet402 revenue, MRR, subscriber counts, or other KPI fields.
- ${WITHHELD_NOTE}

${withheldLines(w)}

Freeze \`contentSha256\` (the freeze body before \`resource_key\` was left empty): ${summary.contentSha256}
Frozen at (UTC): ${summary.frozenAt}
`;
}

export function buildMonthlyReportBundleFiles(input: MonthlyPackageInput): Record<string, string> {
  assertMonthlyPackageSummary(input.summary);
  // frozenAt は DB の trigger が summary_json に書く（scripts/sql/2026-11-27-ledger-monthly-frozen.sql）。無ければ日付を作らず止める。
  if (typeof input.summary.frozenAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(input.summary.frozenAt)) {
    throw new Error("summary.frozenAt is missing or not an ISO timestamp");
  }
  const digest = sha256Utf8(input.csvBody);
  if (digest !== input.summary.contentSha256) {
    throw new Error("csvBody sha256 does not match summary.contentSha256");
  }
  const month = input.summary.month;
  const withheld = withholdUndeliveredSellers(input.csvBody, input.summary.columns, input.deliveredPurchaseIds);
  if (withheld.rows !== input.summary.rowCount) {
    throw new Error(`csv has ${withheld.rows} rows, summary.rowCount is ${input.summary.rowCount}`);
  }
  const csvWithHeader = publishedCsvWithHeader(withheld.csvBody, input.summary.columns);
  assertMonthlyPackageColumns(headerLineOfCsv(csvWithHeader));

  const files: Record<string, string> = {};

  const zenodoCsv = `zenodo/${csvFilename(month)}`;
  const hfCsv = `huggingface/${csvFilename(month)}`;
  const duneCsv = `dune/${csvFilename(month)}`;

  files[zenodoCsv] = csvWithHeader;
  files[hfCsv] = csvWithHeader;
  files[duneCsv] = csvWithHeader;

  files["zenodo/metadata.json"] = `${JSON.stringify(zenodoMetadata(input.summary), null, 2)}\n`;
  files["zenodo/README.md"] = zenodoReadme(input.summary, withheld);
  files["huggingface/README.md"] = huggingFaceReadme(input.summary, withheld);
  files["dune/DESCRIPTION.md"] = duneDescription(input.summary, withheld);

  const zenodoPlain = ["metadata.json", "README.md", csvFilename(month)] as const;
  const zenodoDigests: Record<string, string> = {};
  for (const plain of zenodoPlain) {
    zenodoDigests[plain] = sha256Utf8(files[`zenodo/${plain}`]!);
  }
  files["zenodo/SHA256SUMS"] = sha256SumsLines("zenodo", zenodoPlain, zenodoDigests);

  return files;
}

export function writeMonthlyReportBundles(
  rootDir: string,
  input: MonthlyPackageInput,
): PackageMonthBuildResult {
  const files = buildMonthlyReportBundleFiles(input);
  const fileSha256: Record<string, string> = {};
  const sorted = Object.keys(files).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const rel of sorted) {
    const abs = join(rootDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    const text = files[rel]!;
    writeFileSync(abs, text, "utf8");
    fileSha256[rel] = sha256Utf8(text);
  }
  return { month: input.summary.month, rootDir, fileSha256 };
}

export function packageMonthFromInput(
  rootDir: string,
  input: MonthlyPackageInput,
  options: { now?: Date; trustFrozen?: boolean } = {},
): PackageMonthOutcome {
  const month = input.summary.month;
  const parsed = parseMonthlyFreezeMonth(month);
  if (!parsed.ok) return { status: "invalid_month" };
  if (!options.trustFrozen) {
    const publication = monthlyFreezePublicationError(month, options.now ?? new Date());
    if (publication === MONTHLY_FREEZE_STATUS_NOT_CLOSED) {
      return { status: MONTHLY_FREEZE_STATUS_NOT_CLOSED, month };
    }
    if (publication === MONTHLY_FREEZE_STATUS_NOT_FROZEN_YET) {
      return { status: MONTHLY_FREEZE_STATUS_NOT_FROZEN_YET, month, message: "未凍結" };
    }
  }
  const result = writeMonthlyReportBundles(join(rootDir, month), input);
  return { status: "built", result };
}

export type FetchMonthlyFreezeResult =
  | { ok: false; status: "invalid_month" | typeof MONTHLY_FREEZE_STATUS_NOT_CLOSED | typeof MONTHLY_FREEZE_STATUS_NOT_FROZEN_YET; month?: string }
  | { ok: true; input: MonthlyPackageInput };

export async function fetchPublicMonthlyFreeze(
  month: string,
  origin: string = DEFAULT_REPORTS_ORIGIN,
  fetchFn: typeof fetch = fetch,
): Promise<FetchMonthlyFreezeResult> {
  const parsed = parseMonthlyFreezeMonth(month);
  if (!parsed.ok) return { ok: false, status: "invalid_month" };
  const base = origin.replace(/\/$/, "");
  const summaryRes = await fetchFn(`${base}/api/v1/reports/${parsed.month}.json`);
  if (summaryRes.status === 400) return { ok: false, status: MONTHLY_FREEZE_STATUS_NOT_CLOSED, month: parsed.month };
  if (summaryRes.status === 404) return { ok: false, status: MONTHLY_FREEZE_STATUS_NOT_FROZEN_YET, month: parsed.month };
  if (!summaryRes.ok) throw new Error(`summary fetch failed: HTTP ${summaryRes.status}`);
  const summary = (await summaryRes.json()) as MonthlyFreezeSummary;
  if (summary.month && summary.month !== parsed.month) {
    throw new Error(`summary.month ${summary.month} does not match requested ${parsed.month}`);
  }
  const csvRes = await fetchFn(`${base}/api/v1/reports/${parsed.month}.csv`);
  if (!csvRes.ok) throw new Error(`csv fetch failed: HTTP ${csvRes.status}`);
  const csvBody = await csvRes.text();
  const headerSha = csvRes.headers.get("x-vet402-content-sha256");
  if (headerSha && headerSha !== summary.contentSha256) {
    throw new Error("x-vet402-content-sha256 does not match summary.contentSha256");
  }
  const deliveredPurchaseIds = await fetchPublicDeliveredPurchaseIds(base, fetchFn);
  return { ok: true, input: { summary: { ...summary, month: parsed.month }, csvBody, deliveredPurchaseIds } };
}
/** 公開の delivery.csv（直近 366 日）から delivery = delivered の purchase_id を読む。読めなければ束を作らない。 */
export async function fetchPublicDeliveredPurchaseIds(
  origin: string = DEFAULT_REPORTS_ORIGIN,
  fetchFn: typeof fetch = fetch,
): Promise<Set<string>> {
  const base = origin.replace(/\/$/, "");
  const res = await fetchFn(`${base}/api/v1/observatory/delivery.csv?days=366`);
  if (!res.ok) throw new Error(`delivery csv fetch failed: HTTP ${res.status}`);
  return deliveredPurchaseIdsOfDeliveryCsv(await res.text());
}

/** delivery.csv（見出しつき）から delivery = delivered の purchase_id の集合を作る。 */
export function deliveredPurchaseIdsOfDeliveryCsv(csvWithHeader: string): Set<string> {
  const records = splitCsvRecordsRaw(csvWithHeader);
  const header = (records[0] ?? []).map(unquoteCell);
  const idCol = header.indexOf("purchase_id");
  const deliveryCol = header.indexOf("delivery");
  if (idCol === -1 || deliveryCol === -1) throw new Error("delivery csv lacks purchase_id or delivery");
  const out = new Set<string>();
  for (const cells of records.slice(1)) {
    if (cells.length !== header.length) throw new Error("delivery csv row has the wrong number of cells");
    if (unquoteCell(cells[deliveryCol]!) === "delivered") out.add(unquoteCell(cells[idCol]!));
  }
  return out;
}
