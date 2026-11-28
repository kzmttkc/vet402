// I6: 月次凍結の外部公開束: 決定性、未凍結、C2 列許可リスト。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXPORT_CSV_COLUMNS } from "@/lib/observatory/export-columns";
import { buildMonthlyFreezeSummary, serializeMonthlyLedgerExportBody } from "@/lib/observatory/monthly-freeze";
import {
  REPORTS_PACKAGE_FORBIDDEN_COLUMN_TOKENS,
  assertMonthlyPackageColumns,
  assertMonthlyPackageSummary,
  buildMonthlyReportBundleFiles,
  headerLineOfCsv,
  packageMonthFromInput,
  publishedCsvWithHeader,
  writeMonthlyReportBundles,
} from "@/lib/reports/package-month";

const sampleRows = [
  {
    attempted_at: "2026-10-01T12:00:00Z",
    resource_key: "a.example/api",
    network: "eip155:8453",
    status: "settled",
    amount_units: "1000",
    spent_units: "1000",
    tx_hash: "0xaa",
    http_status_paid: 200,
    latency_ms: 80,
    l2_schema: "pass",
    held_reason: "",
    request_body: "none",
    request_body_sha256: "",
    settlement_source: "seller_claim",
    request_query: "",
    request_query_sha256: "",
    confirmed_units: "1000",
    purchase_id: "00000000-0000-4000-8000-000000000001",
    l2_reading: "pass",
    response_sha256: "abc",
    response_bytes: "12",
  },
] as const;

const FROZEN_AT = "2026-11-01T00:10:00.000Z";

function fixtureInput(month = "2026-10"): { summary: ReturnType<typeof buildMonthlyFreezeSummary> & { frozenAt: string }; csvBody: string } {
  const summary = { ...buildMonthlyFreezeSummary(month, sampleRows, EXPORT_CSV_COLUMNS), frozenAt: FROZEN_AT };
  const csvBody = serializeMonthlyLedgerExportBody(sampleRows, EXPORT_CSV_COLUMNS);
  return { summary, csvBody };
}

test("C2: 許可リスト列だけが CSV 見出しに出る", () => {
  const input = fixtureInput();
  const files = buildMonthlyReportBundleFiles(input);
  const csv = files["zenodo/vet402-ledger-2026-10.csv"]!;
  const header = headerLineOfCsv(csv);
  assertMonthlyPackageColumns(header);
  assert.deepEqual(header.split(","), [...EXPORT_CSV_COLUMNS]);
  for (const token of REPORTS_PACKAGE_FORBIDDEN_COLUMN_TOKENS) {
    assert.equal(
      header.toLowerCase().includes(token),
      false,
      `header must not include KPI token ${token}`,
    );
  }
});

test("C2: 禁止列を足した summary は拒否する", () => {
  const input = fixtureInput();
  const bad = {
    ...input.summary,
    columns: [...EXPORT_CSV_COLUMNS, "mrr_usd"],
  };
  assert.throws(() => assertMonthlyPackageSummary(bad), /columns/);
  assert.throws(
    () => assertMonthlyPackageColumns([...EXPORT_CSV_COLUMNS, "mrr_usd"].join(",")),
    /column count|forbidden token: mrr/,
  );
});

test("summary に KPI 用の余分な鍵があれば拒否する", () => {
  const input = fixtureInput();
  const bad = { ...input.summary, revenue_usd: 100 } as typeof input.summary & { revenue_usd: number };
  assert.throws(() => assertMonthlyPackageSummary(bad), /disallowed key/);
});

test("同じ入力から同じ束（ファイル sha256 が一致）", () => {
  const input = fixtureInput();
  const a = buildMonthlyReportBundleFiles(input);
  const b = buildMonthlyReportBundleFiles(input);
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
  for (const key of Object.keys(a)) {
    assert.equal(a[key], b[key]);
  }
  const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
  const first = digest(a["zenodo/metadata.json"]!);
  const second = digest(b["huggingface/README.md"]!);
  assert.notEqual(first, second);
});

test("zenodo metadata の publication_date は frozenAt の UTC 日付", () => {
  const input = fixtureInput();
  const files = buildMonthlyReportBundleFiles(input);
  const meta = JSON.parse(files["zenodo/metadata.json"]!);
  assert.equal(meta.metadata.publication_date, "2026-11-01");
});

test("未凍結の月は書かず 未凍結 を返す", () => {
  const dir = mkdtempSync(join(tmpdir(), "reports-pkg-"));
  try {
    const input = fixtureInput("2026-11");
    const beforeFreeze = new Date("2026-11-30T12:00:00.000Z");
    const out = packageMonthFromInput(dir, input, { now: beforeFreeze });
    assert.equal(out.status, "not_frozen_yet");
    if (out.status === "not_frozen_yet") assert.equal(out.message, "未凍結");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("凍結公開後は dist 配下に 3 束を書く", () => {
  const dir = mkdtempSync(join(tmpdir(), "reports-pkg-"));
  try {
    const input = fixtureInput("2026-10");
    const afterFreeze = new Date("2026-11-02T00:00:00.000Z");
    const out = packageMonthFromInput(dir, input, { now: afterFreeze });
    assert.equal(out.status, "built");
    if (out.status !== "built") return;
    assert.ok(out.result.fileSha256["zenodo/SHA256SUMS"]);
    assert.ok(out.result.fileSha256["huggingface/README.md"]);
    assert.ok(out.result.fileSha256["dune/DESCRIPTION.md"]);
    const rebuilt = writeMonthlyReportBundles(join(dir, "rebuild"), input);
    assert.deepEqual(rebuilt.fileSha256, out.result.fileSha256);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("publishedCsvWithHeader は見出し付きで本文 sha が summary と一致", () => {
  const input = fixtureInput();
  const withHeader = publishedCsvWithHeader(input.csvBody);
  assert.match(withHeader, new RegExp(`^${EXPORT_CSV_COLUMNS[0]},`));
  const bodyOnly = createHash("sha256").update(input.csvBody, "utf8").digest("hex");
  assert.equal(bodyOnly, input.summary.contentSha256);
});
test("公開する説明文は英語の事実だけ（em-dash と we/our/us を含まない）", () => {
  const files = buildMonthlyReportBundleFiles(fixtureInput());
  for (const rel of ["zenodo/README.md", "zenodo/metadata.json", "huggingface/README.md", "dune/DESCRIPTION.md"]) {
    const text = files[rel]!;
    assert.doesNotMatch(text, /[—–]/, `${rel} has a dash`);
    assert.doesNotMatch(text, /\b(we|our|us)\b/i, `${rel} uses first person plural`);
  }
});
