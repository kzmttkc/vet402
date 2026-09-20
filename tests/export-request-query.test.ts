// ============================================================
// 公開 export の末尾 2 列（2026-09-21）— どの URL で払ったか。
//
//   request_query         declared / empty / refused / 空（記録なし）
//   request_query_sha256  足した対の form-urlencoded 文字列の SHA-256。文字列そのものは出さない
//
// 守ること（本文側 tests/export-request-body.test.ts と同じ 4 つ）:
//  1. 「記録なし」は空で、false 側の値（empty・refused）に倒さない。
//  2. 語彙は組み立て側（declared-input.ts の RequestQuerySource）と 1 文字もずれない。
//  3. 列の追加は末尾だけ。既存 14 列の名前と順序は変えない（本文側のテストが持つ）。
//  4. ランナーがこの 2 つのキー名で行に書いている（名前が動くと export が黙って空になる）。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { EXPORT_CSV_COLUMNS_SINCE_2026_09_21 } from "@/lib/observatory/export-columns";
import {
  REQUEST_QUERY_KINDS,
  requestQueryKindOf,
  requestQueryKindSql,
  requestQuerySha256Of,
  requestQuerySha256Sql,
} from "@/lib/observatory/request-query";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const SHA = "b".repeat(64);

test("語彙: declared / empty / refused——組み立て側の 3 つと同じ", () => {
  assert.deepEqual([...REQUEST_QUERY_KINDS], ["declared", "empty", "refused"]);
  // 組み立て側の正典。型では縛ってあるが（request-query.ts の _KindsMatchSource）、
  // 語そのものが declared-input.ts に在ることを文字列でも見る。
  const canon = read("src/lib/observatory/declared-input.ts");
  assert.ok(canon.includes('export type RequestQuerySource = "declared" | "empty" | "refused"'));
});

test("request_query: 記録が無い行は null（empty にも refused にも倒さない）", () => {
  assert.equal(requestQueryKindOf({ requestQuery: "declared" }), "declared");
  assert.equal(requestQueryKindOf({ requestQuery: "empty" }), "empty");
  assert.equal(requestQueryKindOf({ requestQuery: "refused" }), "refused");
  assert.equal(requestQueryKindOf({ phase: "paid" }), null, "許可リストに無い network の行・2026-09-20 より前の行");
  assert.equal(requestQueryKindOf(null), null);
  assert.equal(requestQueryKindOf([]), null);
  assert.equal(requestQueryKindOf({ requestQuery: "something-else" }), null, "知らない値を分類に混ぜない");
  assert.equal(requestQueryKindOf({ requestQuery: true }), null);
});

test("request_query_sha256: 宣言クエリを足した行の 64 桁 hex だけ", () => {
  assert.equal(requestQuerySha256Of({ requestQuery: "declared", requestQuerySha256: SHA }), SHA);
  assert.equal(requestQuerySha256Of({ requestQuery: "declared" }), null, "hash の無い declared 行");
  assert.equal(requestQuerySha256Of({ requestQuery: "empty", requestQuerySha256: SHA }), null, "足していない行に hash を出さない");
  assert.equal(requestQuerySha256Of({ requestQuery: "refused", requestQuerySha256: SHA }), null);
  assert.equal(requestQuerySha256Of({ requestQuery: "declared", requestQuerySha256: "not-a-hash" }), null);
  assert.equal(requestQuerySha256Of({ requestQuery: "declared", requestQuerySha256: SHA.toUpperCase() }), null, "記録は小文字 hex");
});

test("SQL 式: JS と同じ語彙から作り、alias は素の識別子だけ", () => {
  const kind = requestQueryKindSql("pu");
  for (const k of REQUEST_QUERY_KINDS) assert.ok(kind.includes(`'${k}'`), k);
  assert.ok(kind.includes("jsonb_typeof(pu.raw_response_meta->'requestQuery') = 'string'"), "true や 1 を文字列に倒さない");
  const sha = requestQuerySha256Sql("pu");
  assert.ok(sha.includes("^[0-9a-f]{64}$"));
  assert.ok(sha.includes("= 'declared'"), "declared の行にだけ出す");
  assert.throws(() => requestQueryKindSql("pu; drop table x402_l1_purchases --"), /plain identifier/);
  assert.throws(() => requestQuerySha256Sql("pu'"), /plain identifier/);
});

test("ランナーはこの 2 つのキー名で行に書く（名前が動くと export が黙って空になる）", () => {
  const src = read("src/lib/observatory/l1-runner.ts");
  assert.ok(/\{ requestQuery: paidRequestUrl\.source \}/.test(src), "raw_response_meta に requestQuery を置く");
  assert.ok(src.includes("{ requestQuerySha256: createHash(\"sha256\").update(paidRequestUrl.query, \"utf8\").digest(\"hex\") }"));
});

test("列: 2026-09-21 の追加は request_query と request_query_sha256 の 2 つ", () => {
  assert.deepEqual([...EXPORT_CSV_COLUMNS_SINCE_2026_09_21], ["request_query", "request_query_sha256"]);
  // route がその 2 列を、この file の式で出している（別の手書き SQL を持たない）。
  const route = read("src/app/api/v1/observatory/export.csv/route.ts");
  assert.ok(route.includes('requestQueryKindSql("pu"))}) AS request_query'), "request_query は request-query.ts の式から");
  assert.ok(route.includes('requestQuerySha256Sql("pu"))}) AS request_query_sha256'), "hash も同じ file の式から");
});
