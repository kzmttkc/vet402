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
  deliveredPurchaseIdsOfDeliveryCsv,
  fetchPublicMonthlyFreeze,
  headerLineOfCsv,
  packageMonthFromInput,
  publishedCsvWithHeader,
  splitCsvRecordsRaw,
  withholdUndeliveredSellers,
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

test("frozenAt が無い summary は日付を作らずに止める", () => {
  const input = fixtureInput();
  const { frozenAt: _drop, ...rest } = input.summary;
  assert.throws(
    () => buildMonthlyReportBundleFiles({ ...input, summary: rest as typeof input.summary }),
    /frozenAt is missing/,
  );
});

test("L1 の証拠 2 列と呼び手のハッシュは束の見出しに出ない", () => {
  const files = buildMonthlyReportBundleFiles(fixtureInput());
  for (const rel of ["zenodo/vet402-ledger-2026-10.csv", "huggingface/vet402-ledger-2026-10.csv", "dune/vet402-ledger-2026-10.csv"]) {
    const header = headerLineOfCsv(files[rel]!);
    for (const token of ["challenge_402", "payment_payload", "caller_hash", "raw_"]) {
      assert.ok(!header.includes(token), `${rel} header has ${token}`);
    }
  }
  const withEvidence = [...EXPORT_CSV_COLUMNS, "challenge_402"].join(",");
  assert.throws(() => assertMonthlyPackageColumns(withEvidence), /column count/);
});

// C1: 外部に出す束は、その月に配達が無い売り手を名指ししない（2026-11-28）。
const BASE_ROW = sampleRows[0];
function row(over: Partial<Record<keyof typeof BASE_ROW, string | number>>): Record<string, unknown> {
  return { ...BASE_ROW, ...over };
}
const c1Rows = [
  row({ resource_key: "good.example/api", purchase_id: "00000000-0000-4000-8000-0000000000a1", attempted_at: "2026-10-02T00:00:00Z" }),
  row({ resource_key: "good.example/api", status: "settle_failed", http_status_paid: "", tx_hash: "", purchase_id: "00000000-0000-4000-8000-0000000000a2", attempted_at: "2026-10-03T00:00:00Z" }),
  row({ resource_key: "accepted.example/api", http_status_paid: 202, purchase_id: "00000000-0000-4000-8000-0000000000b1", attempted_at: "2026-10-04T00:00:00Z" }),
  row({ resource_key: "empty.example/api", response_bytes: "0", purchase_id: "00000000-0000-4000-8000-0000000000c1", attempted_at: "2026-10-05T00:00:00Z" }),
  row({ resource_key: "err.example/api", http_status_paid: 500, purchase_id: "00000000-0000-4000-8000-0000000000d1", attempted_at: "2026-10-06T00:00:00Z" }),
  row({ resource_key: "q\"uote,comma.example/api", http_status_paid: 400, purchase_id: "00000000-0000-4000-8000-0000000000e1", attempted_at: "2026-10-07T00:00:00Z" }),
  row({ resource_key: "old.example/api", response_bytes: "", purchase_id: "00000000-0000-4000-8000-0000000000f1", attempted_at: "2026-10-08T00:00:00Z" }),
];

function c1Input(deliveredPurchaseIds?: Set<string>) {
  const summary = { ...buildMonthlyFreezeSummary("2026-10", c1Rows, EXPORT_CSV_COLUMNS), frozenAt: FROZEN_AT };
  const csvBody = serializeMonthlyLedgerExportBody(c1Rows, EXPORT_CSV_COLUMNS);
  return { summary, csvBody, ...(deliveredPurchaseIds ? { deliveredPurchaseIds } : {}) };
}

function bodyRows(csvWithHeader: string): string[][] {
  return splitCsvRecordsRaw(csvWithHeader).slice(1);
}

test("C1: 配達が無い売り手の resource_key は空になり、行の数・順序・ほかの列は凍結のまま", () => {
  const input = c1Input();
  const original = splitCsvRecordsRaw(input.csvBody);
  const keyCol = EXPORT_CSV_COLUMNS.indexOf("resource_key");
  const files = buildMonthlyReportBundleFiles(input);
  for (const rel of ["zenodo/vet402-ledger-2026-10.csv", "huggingface/vet402-ledger-2026-10.csv", "dune/vet402-ledger-2026-10.csv"]) {
    const rows = bodyRows(files[rel]!);
    assert.equal(rows.length, original.length, `${rel} keeps every row`);
    assert.equal(rows.length, input.summary.rowCount);
    for (let i = 0; i < rows.length; i++) {
      const a = [...rows[i]!];
      const b = [...original[i]!];
      a[keyCol] = "";
      b[keyCol] = "";
      assert.deepEqual(a, b, `${rel} row ${i} changes only resource_key`);
    }
    const named = new Set(rows.map((r) => r[keyCol]).filter((k) => k !== ""));
    assert.deepEqual([...named].sort(), ["good.example/api", "old.example/api"]);
    const text = files[rel]!;
    for (const hidden of ["accepted.example", "empty.example", "err.example", "uote,comma.example"]) {
      assert.ok(!text.includes(hidden), `${rel} names ${hidden}`);
    }
  }
});

test("C1: 金額の列の合計は伏せる前と同じ", () => {
  const input = c1Input();
  const sum = (rows: string[][], name: string) => {
    const i = EXPORT_CSV_COLUMNS.indexOf(name as (typeof EXPORT_CSV_COLUMNS)[number]);
    return rows.reduce((acc, r) => acc + BigInt(r[i] === "" ? "0" : r[i]!), 0n);
  };
  const before = splitCsvRecordsRaw(input.csvBody);
  const after = bodyRows(buildMonthlyReportBundleFiles(input)["zenodo/vet402-ledger-2026-10.csv"]!);
  for (const name of ["amount_units", "spent_units", "confirmed_units"]) {
    assert.equal(sum(after, name), sum(before, name), name);
  }
});

test("C1: delivery.csv の delivered に無い purchase_id の行は配達に数えない", () => {
  const ids = new Set(["00000000-0000-4000-8000-0000000000a1"]);
  const rows = bodyRows(buildMonthlyReportBundleFiles(c1Input(ids))["zenodo/vet402-ledger-2026-10.csv"]!);
  const keyCol = EXPORT_CSV_COLUMNS.indexOf("resource_key");
  const named = new Set(rows.map((r) => r[keyCol]).filter((k) => k !== ""));
  assert.deepEqual([...named], ["good.example/api"]);
  const w = withholdUndeliveredSellers(c1Input(ids).csvBody, EXPORT_CSV_COLUMNS, ids);
  assert.equal(w.rows, c1Rows.length);
  assert.equal(w.withheldRows, c1Rows.length - 2);
  assert.equal(w.namedSellers, 1);
});

test("C1: 説明文に伏せた行の数と、contentSha256 が伏せる前の本文の値であることを書く", () => {
  const files = buildMonthlyReportBundleFiles(c1Input());
  assert.match(files["zenodo/README.md"]!, /Rows with `resource_key` left empty: 4/);
  assert.match(files["zenodo/README.md"]!, /before `resource_key` was left empty/);
  assert.doesNotMatch(files["zenodo/README.md"]!, /byte for byte/);
  assert.match(files["huggingface/README.md"]!, /Sellers named: 2/);
  assert.match(files["dune/DESCRIPTION.md"]!, /does not name a seller that did not deliver/);
  for (const rel of ["zenodo/README.md", "zenodo/metadata.json", "huggingface/README.md", "dune/DESCRIPTION.md"]) {
    assert.doesNotMatch(files[rel]!, /[—–]/);
    assert.doesNotMatch(files[rel]!, /\b(we|our|us)\b/i);
  }
});

test("C1: 本文の行数が summary.rowCount と違えば束を作らない", () => {
  const input = c1Input();
  assert.throws(() => buildMonthlyReportBundleFiles({ ...input, summary: { ...input.summary, rowCount: input.summary.rowCount + 1 } }), /rowCount/);
});

test("C1: delivery.csv から delivered の purchase_id だけを読む", () => {
  const csv = [
    "purchase_id,attempted_at,latency_ms,observed_at,resource_key,network,delivery,delivery_reason,http_status_paid,body_bytes,payload_non_empty,held_reason,tx_hash,buyer,payer",
    "p1,2026-10-01T00:00:00Z,1,2026-10-01T00:00:01Z,a.example/x,eip155:8453,delivered,,200,10,true,,0x1,vet402,0x2",
    'p2,2026-10-01T00:00:00Z,1,2026-10-01T00:00:01Z,"b,example/x",eip155:8453,no_body_observed,empty_body,200,0,false,,0x1,vet402,0x2',
    "p3,2026-10-01T00:00:00Z,1,2026-10-01T00:00:01Z,c.example/x,eip155:8453,not_established,settled_4xx,400,,true,settled_4xx,0x1,vet402,0x2",
    "",
  ].join("\n");
  assert.deepEqual([...deliveredPurchaseIdsOfDeliveryCsv(csv)], ["p1"]);
  assert.throws(() => deliveredPurchaseIdsOfDeliveryCsv("purchase_id,status\np1,settled\n"), /lacks purchase_id or delivery/);
});

test("C1: --fetch は delivery.csv が読めなければ束を作らない", async () => {
  const input = c1Input();
  const fetchFn = (async (url: string) => {
    if (url.endsWith("/api/v1/reports/2026-10.json")) return new Response(JSON.stringify(input.summary), { status: 200 });
    if (url.endsWith("/api/v1/reports/2026-10.csv")) return new Response(input.csvBody, { status: 200 });
    return new Response("busy", { status: 503 });
  }) as typeof fetch;
  await assert.rejects(fetchPublicMonthlyFreeze("2026-10", "https://vet402.test", fetchFn), /delivery csv fetch failed/);
});
