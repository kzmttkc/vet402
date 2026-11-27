// ============================================================
// 公開 export の末尾 2 列（2026-11-24・F3）— 支払い付き応答の本文の指紋。
//
//   response_sha256  読んだバイト列の SHA-256（小文字 hex 64）
//   response_bytes   そのバイト数
//
// 守ること:
//  1. 記録なしは空。0 に倒さない（空本文を読めた行だけ 0）。
//  2. 列の追加は末尾だけ。既存列の名前と順序は変えない。
//  3. 列を足したら openapi・methodology・llms.txt に名前で出る（export-request-body.test.ts と同じ）。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  EXPORT_CSV_COLUMNS,
  EXPORT_CSV_COLUMNS_ADDED,
  EXPORT_CSV_COLUMNS_SINCE_2026_11_24,
} from "@/lib/observatory/export-columns";
import { L1_PAID_BODY_CAP_BYTES } from "@/lib/observatory/l2-check";
import {
  paidResponseFingerprintRecord,
  responseBytesOf,
  responseSha256Of,
  responseBytesSql,
  responseSha256Sql,
} from "@/lib/observatory/paid-response-fingerprint";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const EMPTY_SHA = createHash("sha256").update(new Uint8Array(0)).digest("hex");

test("列: 末尾に response_sha256 / response_bytes（既存 19 列はそのまま）", () => {
  assert.equal(EXPORT_CSV_COLUMNS.length, 21);
  assert.deepEqual(EXPORT_CSV_COLUMNS.slice(18, 19), ["l2_reading"]);
  assert.deepEqual([...EXPORT_CSV_COLUMNS_SINCE_2026_11_24], ["response_sha256", "response_bytes"]);
  assert.deepEqual(EXPORT_CSV_COLUMNS.slice(-2), ["response_sha256", "response_bytes"]);
  assert.deepEqual(EXPORT_CSV_COLUMNS.slice(0, 19), [
    "attempted_at",
    "resource_key",
    "network",
    "status",
    "amount_units",
    "spent_units",
    "tx_hash",
    "http_status_paid",
    "latency_ms",
    "l2_schema",
    "held_reason",
    "request_body",
    "request_body_sha256",
    "settlement_source",
    "request_query",
    "request_query_sha256",
    "confirmed_units",
    "purchase_id",
    "l2_reading",
  ]);
  assert.ok(
    [...EXPORT_CSV_COLUMNS_ADDED].slice(-2).every((c) => (EXPORT_CSV_COLUMNS_SINCE_2026_11_24 as readonly string[]).includes(c)),
  );
});

test("paidResponseFingerprintRecord: 読み切れたときだけ SHA-256（上限・失敗・UTF-8・空）", () => {
  const cap = L1_PAID_BODY_CAP_BYTES;
  const ja = "こんにちは";
  const rawJa = new TextEncoder().encode(ja);
  const shaJa = createHash("sha256").update(rawJa).digest("hex");
  assert.deepEqual(paidResponseFingerprintRecord(true, rawJa, null), {
    responseSha256: shaJa,
    responseBytes: rawJa.byteLength,
  });
  assert.ok(rawJa.byteLength > ja.length, "UTF-8 多バイトでバイト数と文字数が違う");
  assert.equal(createHash("sha256").update(rawJa).digest("hex"), createHash("sha256").update(ja, "utf8").digest("hex"));

  const empty = paidResponseFingerprintRecord(true, new Uint8Array(0), null);
  assert.deepEqual(empty, { responseSha256: EMPTY_SHA, responseBytes: 0 });

  const atCap = new Uint8Array(cap).fill(0x61);
  const shaAtCap = createHash("sha256").update(atCap).digest("hex");
  assert.deepEqual(paidResponseFingerprintRecord(true, atCap, null), {
    responseSha256: shaAtCap,
    responseBytes: cap,
  });

  const overCap = new Uint8Array(cap + 1).fill(0x62);
  assert.deepEqual(paidResponseFingerprintRecord(true, overCap, null), { responseFingerprint: "truncated" });
  assert.equal(responseSha256Of({ responseFingerprint: "truncated" }), null);
  assert.equal(responseBytesOf({ responseFingerprint: "truncated" }), null);

  const partialRaw = new Uint8Array([1, 2, 3]);
  assert.deepEqual(paidResponseFingerprintRecord(true, partialRaw, new Error("socket hang up")), {
    responseFingerprint: "partial",
  });
  assert.equal(responseSha256Of({ responseFingerprint: "partial" }), null);

  assert.equal(paidResponseFingerprintRecord(false, new Uint8Array([1]), null), null, "応答を読んでいない");
  assert.equal(paidResponseFingerprintRecord(true, null, null), null);
  assert.equal(paidResponseFingerprintRecord(true, undefined, null), null);
});

test("responseSha256Of / responseBytesOf: 記録の形だけ", () => {
  const h = "a".repeat(64);
  assert.equal(responseSha256Of({ responseSha256: h, responseBytes: 3 }), h);
  assert.equal(responseSha256Of({ responseSha256: h.toUpperCase() }), null);
  assert.equal(responseSha256Of({ responseSha256: "bad" }), null);
  assert.equal(responseSha256Of({ phase: "paid" }), null);
  assert.equal(responseBytesOf({ responseSha256: h, responseBytes: 0 }), 0);
  assert.equal(responseBytesOf({ responseBytes: 0 }), null, "hash 無しに 0 だけは出さない");
  assert.equal(responseBytesOf({ responseSha256: h, responseBytes: -1 }), null);
  assert.equal(responseBytesOf({ responseSha256: h, responseBytes: 1.5 }), null);
});

test("ランナーは paidResponseFingerprintRecord を行に書く", () => {
  const src = read("src/lib/observatory/l1-runner.ts");
  assert.ok(src.includes("paidResponseFingerprintRecord(paid !== null, paidBodyRaw, paidBodyFailure)"), "rawResponseMeta に展開する");
  assert.ok(src.includes("paidBodyRaw = read.raw"), "読んだ生バイトを保持する");
});

test("docs: response_sha256 / response_bytes は読み切れた行だけ（英語 1 文）", () => {
  const need = "Filled only when vet402 read the paid response body through to the end (not when the read hit the cap or stopped partway).";
  const oneLine = (s: string) => s.replace(/\s+/g, " ");
  for (const f of ["docs/openapi.yaml", "public/llms-full-prose.txt", "src/app/observatory/methodology/page.tsx"]) {
    assert.ok(oneLine(read(f)).includes(need), f);
  }
});

test("export route: responseSha256Sql / responseBytesSql を使う", () => {
  const lib = read("src/lib/observatory/ledger-export.ts");
  assert.match(lib, /responseSha256Sql\("pu"\)/);
  assert.match(lib, /responseBytesSql\("pu"\)/);
  const route = read("src/app/api/v1/observatory/export.csv/route.ts");
  assert.match(route, /const CSV_COLUMNS = EXPORT_CSV_COLUMNS;/);
});

test("SQL 断片は JS の述語と同じ規則", () => {
  assert.match(responseSha256Sql("pu"), /responseSha256/);
  assert.match(responseBytesSql("pu"), /responseBytes/);
});