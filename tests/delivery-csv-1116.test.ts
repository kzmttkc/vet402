// ============================================================
// delivery.csv の 2026-11-16 の追加（x402-foundation/x402#3226 の要望 3 つ）。DB なし。
//   1. body_bytes を http_status_paid の隣に（空は 0・記録なしは空欄）
//   2. 誰の購入か（methodology の 1 文・x-vet402-buyer）
//   3. x-vet402-as-of と x-vet402-generated-at
// 既定の export.csv（凍結）には何も足さない。
// ============================================================
import { apiDocsPageText } from "./lib/api-docs-source";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  bodyBytesCell,
  DELIVERY_CSV_BODY_BYTES_NOTE,
  DELIVERY_CSV_BUYER,
  DELIVERY_CSV_COLUMN_NOTES,
  DELIVERY_CSV_COLUMNS,
  DELIVERY_CSV_HEADER_NOTES,
  DELIVERY_CSV_WHOSE_PURCHASES,
  deliveryCsvAsOf,
  deliveryCsvValuesFromRow,
  type DeliveryExportDbRow,
} from "@/lib/observatory/delivery-export";
import { EXPORT_CSV_COLUMNS } from "@/lib/observatory/export-columns";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

function assertPublicEnglish(text: string, label: string) {
  assert.match(text, /^[\x20-\x7E]*$/, `${label} must be ASCII`);
  assert.doesNotMatch(text, /\b(we|our|us)\b/i, `${label}: we/our/us`);
  assert.doesNotMatch(text, /[—–]/, `${label}: dash`);
  assert.doesNotMatch(text, /;/, `${label}: semicolon`);
}

const row = (over: Partial<DeliveryExportDbRow>): DeliveryExportDbRow => ({
  purchase_id: "00000000-0000-0000-0000-000000000001",
  attempted_at: "2026-11-16T00:00:00Z",
  observed_at: null,
  latency_ms: null,
  resource_key: "x.example/api",
  network: "eip155:8453",
  status: "settled",
  http_status_paid: 200,
  body_bytes: null,
  payload_non_empty: true,
  held_reason: null,
  tx_hash: null,
  payer: null,
  ...over,
});

test("列の位置: body_bytes は http_status_paid の隣", () => {
  const i = DELIVERY_CSV_COLUMNS.indexOf("http_status_paid");
  assert.ok(i >= 0);
  assert.equal(DELIVERY_CSV_COLUMNS[i + 1], "body_bytes");
  assert.equal(DELIVERY_CSV_COLUMNS.length, 15);
});

test("body_bytes: 空は 0・記録なしは空欄・数でない値は空欄", () => {
  assert.equal(bodyBytesCell(0), 0);
  assert.equal(bodyBytesCell("0"), 0);
  assert.equal(bodyBytesCell(5120), 5120);
  assert.equal(bodyBytesCell("262144"), 262144);
  assert.equal(bodyBytesCell(null), "");
  assert.equal(bodyBytesCell(undefined), "");
  assert.equal(bodyBytesCell(""), "");
  assert.equal(bodyBytesCell("abc"), "");
  assert.equal(bodyBytesCell(-1), "");
  assert.equal(bodyBytesCell(1.5), "");
  assert.equal(deliveryCsvValuesFromRow(row({ body_bytes: 0, payload_non_empty: false })).body_bytes, 0);
  assert.equal(deliveryCsvValuesFromRow(row({ body_bytes: null })).body_bytes, "");
  assert.equal(deliveryCsvValuesFromRow(row({ body_bytes: "512" })).body_bytes, 512);
});

test("x-vet402-as-of: ファイルの行の attempted_at の最大・行が無ければ空", () => {
  assert.equal(deliveryCsvAsOf([]), "");
  assert.equal(
    deliveryCsvAsOf([{ attempted_at: "2026-11-15T23:59:59Z" }, { attempted_at: "2026-11-16T00:00:01Z" }, { attempted_at: "2026-11-16T00:00:00Z" }]),
    "2026-11-16T00:00:01Z",
  );
  assert.equal(DELIVERY_CSV_BUYER, "vet402");
});

test("route は 3 つのヘッダを付け、CSV の本文に注釈行を入れない", () => {
  const src = read("src/app/api/v1/observatory/delivery.csv/route.ts");
  assert.match(src, /"x-vet402-buyer": DELIVERY_CSV_BUYER/);
  assert.match(src, /"x-vet402-as-of": deliveryCsvAsOf\(rows\)/);
  assert.match(src, /"x-vet402-generated-at": generatedAt/);
  const lib = read("src/lib/observatory/delivery-export.ts");
  assert.match(lib, /const lines = \[DELIVERY_CSV_COLUMNS\.join\(","\)\];/, "1 行目は見出し");
});

test("誰の購入か・ヘッダの意味は 1 か所の定数で、methodology と /docs/api が描画する", () => {
  assert.equal(
    DELIVERY_CSV_WHOSE_PURCHASES,
    "Every row is a purchase vet402 made with its own wallets, so the rates describe vet402's own purchases, not every buyer of the seller.",
  );
  assertPublicEnglish(DELIVERY_CSV_WHOSE_PURCHASES, "whose purchases");
  for (const [k, v] of Object.entries(DELIVERY_CSV_HEADER_NOTES)) {
    assert.ok(v.startsWith(k), k);
    assertPublicEnglish(v, k);
  }
  assertPublicEnglish(DELIVERY_CSV_COLUMN_NOTES, "column notes");
  const page = read("src/app/observatory/methodology/page.tsx");
  const docs = apiDocsPageText();
  for (const src of [page, docs]) {
    assert.ok(src.includes("DELIVERY_CSV_WHOSE_PURCHASES"));
    assert.ok(src.includes("DELIVERY_CSV_HEADER_NOTES"));
  }
  const openapi = read("docs/openapi.yaml");
  const o = openapi.slice(openapi.indexOf("  /api/v1/observatory/delivery.csv:"), openapi.indexOf("  /api/v1/observatory/l0/export.csv:"));
  for (const h of ["body_bytes", "x-vet402-buyer", "x-vet402-as-of", "x-vet402-generated-at"]) assert.ok(o.includes(h), h);
});

test("body_bytes の意味は 1 か所の定数で、上限の扱いまで書く・CHANGELOG の 2026-11-16 の節も公開文の決まり", () => {
  assert.match(DELIVERY_CSV_BODY_BYTES_NOTE, /0 for an empty body, blank when the row has no record/);
  assert.match(DELIVERY_CSV_BODY_BYTES_NOTE, /262144-byte read cap shows 262144, the read cap, not the full size/);
  assertPublicEnglish(DELIVERY_CSV_BODY_BYTES_NOTE, "body_bytes note");
  assert.ok(DELIVERY_CSV_COLUMN_NOTES.includes(DELIVERY_CSV_BODY_BYTES_NOTE));
  for (const p of ["src/app/observatory/methodology/page.tsx", "src/lib/docs/api-endpoints-data.tsx"]) {
    assert.ok(read(p).includes("DELIVERY_CSV_BODY_BYTES_NOTE"), p);
  }
  const changelog = read("docs/handoffs/CHANGELOG.md");
  const start = changelog.indexOf("## 2026-11-16 delivery.csv");
  const end = changelog.indexOf("\n## ", start + 5);
  assert.ok(start >= 0 && end > start);
  for (const line of changelog.slice(start, end).split("\n")) assertPublicEnglish(line, "CHANGELOG 2026-11-16");
});

test("既定の export.csv は不変: 新しい列もヘッダも足さない", () => {
  assert.equal(EXPORT_CSV_COLUMNS.length, 21);
  assert.ok(!(EXPORT_CSV_COLUMNS as readonly string[]).includes("body_bytes"));
  const route = read("src/app/api/v1/observatory/export.csv/route.ts");
  for (const h of ["x-vet402-buyer", "x-vet402-as-of", "x-vet402-generated-at"]) assert.ok(!route.includes(h), h);
});
