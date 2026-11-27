// ============================================================
// 凍結済み月次購入台帳の外部公開束（I6）。DB には触らない。
// 入力は公開 URL から取った summary と CSV 本文（見出しなし）。
// ============================================================
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EXPORT_CSV_COLUMNS } from "@/lib/observatory/export-columns";
import type { MonthlyFreezeSummary } from "@/lib/observatory/monthly-freeze";
import {
  MONTHLY_FREEZE_STATUS_NOT_CLOSED,
  MONTHLY_FREEZE_STATUS_NOT_FROZEN_YET,
  monthlyFreezePublicationError,
  parseMonthlyFreezeMonth,
} from "@/lib/observatory/monthly-freeze";
export const DEFAULT_REPORTS_ORIGIN = "https://vet402.com";

/** observatory-bundle.ts と同じ見出し禁止（公開 export に無い列）。 */
const FORBIDDEN_HEADER_TOKENS = ["challenge_402", "payment_payload", "caller_hash", "raw_"] as const;

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
};

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
      description: `<p>Frozen purchase ledger rows for UTC month ${month}. Column definitions match GET /api/v1/observatory/export.csv. Methodology: https://vet402.com/observatory/methodology. Summary JSON: https://vet402.com/api/v1/reports/${month}.json</p>`,
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

function zenodoReadme(summary: MonthlyFreezeSummary): string {
  const month = summary.month;
  const frozenAt = summary.frozenAt;
  return `# vet402 monthly ledger freeze: ${month}

This directory is a Zenodo upload bundle for one frozen UTC month of vet402 purchase rows. The measurements are CC BY 4.0.

## Contents

- \`metadata.json\` is deposition metadata for the Zenodo REST API (not uploaded by itself; merge into a deposition).
- \`${csvFilename(month)}\` is the frozen CSV with the public export header row. Body bytes match GET /api/v1/reports/${month}.csv.
- \`README.md\` is this note.
- \`SHA256SUMS\` lists sha256 digests for every other file in this directory.

## Freeze

- \`contentSha256\`: ${summary.contentSha256}
- \`frozenAt\` (UTC): ${frozenAt}
- \`rowCount\`: ${summary.rowCount}
- Period: [${summary.periodStart}, ${summary.periodEndExclusive})

Column definitions: https://vet402.com/openapi.yaml
`;
}

function huggingFaceReadme(summary: MonthlyFreezeSummary): string {
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

Frozen purchase ledger for UTC month \`${month}\`, published by vet402. Rows are vet402's own x402 purchase attempts. This file does not include revenue, MRR, or other KPI values (vet402 constraint C2).

| Field | Value |
| --- | --- |
| frozenAt (UTC) | ${frozenAt} |
| contentSha256 | ${summary.contentSha256} |
| rowCount | ${summary.rowCount} |
| periodStart | ${summary.periodStart} |
| periodEndExclusive | ${summary.periodEndExclusive} |

## Files

- \`${csvFilename(month)}\` — CSV with the same columns as \`/api/v1/observatory/export.csv\`.

## Source

- JSON summary: https://vet402.com/api/v1/reports/${month}.json
- CSV body: https://vet402.com/api/v1/reports/${month}.csv

Column definitions: https://vet402.com/openapi.yaml
`;
}

function duneDescription(summary: MonthlyFreezeSummary): string {
  const month = summary.month;
  return `# Dune import: vet402 monthly ledger freeze ${month}

Import \`${csvFilename(month)}\` as a comma-separated table.

- Time column: \`attempted_at\` (UTC, ISO-8601 with Z suffix).
- Amount columns \`amount_units\`, \`spent_units\`, and \`confirmed_units\` are 6-decimal integer strings in USDC micro-units, not dollars.
- This extract is purchase-attempt metadata only. It does not include vet402 revenue, MRR, subscriber counts, or other KPI fields.

Freeze \`contentSha256\`: ${summary.contentSha256}
Frozen at (UTC): ${summary.frozenAt}
`;
}

export function buildMonthlyReportBundleFiles(input: MonthlyPackageInput): Record<string, string> {
  assertMonthlyPackageSummary(input.summary);
  const digest = sha256Utf8(input.csvBody);
  if (digest !== input.summary.contentSha256) {
    throw new Error("csvBody sha256 does not match summary.contentSha256");
  }
  const month = input.summary.month;
  const csvWithHeader = publishedCsvWithHeader(input.csvBody, input.summary.columns);
  assertMonthlyPackageColumns(headerLineOfCsv(csvWithHeader));

  const files: Record<string, string> = {};

  const zenodoCsv = `zenodo/${csvFilename(month)}`;
  const hfCsv = `huggingface/${csvFilename(month)}`;
  const duneCsv = `dune/${csvFilename(month)}`;

  files[zenodoCsv] = csvWithHeader;
  files[hfCsv] = csvWithHeader;
  files[duneCsv] = csvWithHeader;

  files["zenodo/metadata.json"] = `${JSON.stringify(zenodoMetadata(input.summary), null, 2)}\n`;
  files["zenodo/README.md"] = zenodoReadme(input.summary);
  files["huggingface/README.md"] = huggingFaceReadme(input.summary);
  files["dune/DESCRIPTION.md"] = duneDescription(input.summary);

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
  return { ok: true, input: { summary: { ...summary, month: parsed.month }, csvBody } };
}