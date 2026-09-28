// ============================================================
// 「こちらが本文／クエリを送っていなかった」失敗の判定（2026-09-28）— JS の述語と SQL の断片が一致すること。
//
// 判定の正典は request-body.ts（bodyNotSentOnOurSide / bodyNotSentOnOurSideSql・declaresRequestBody(Sql)）と
// request-query.ts（queryNotSentOnOurSide / queryNotSentOnOurSideSql・declaresRequiredQuery(Sql)）。
// l1-runner の retest (b)(c) と /sellers の body_not_sent / query_not_sent が同じ組を import する。
// ここでは同じ行の集合に JS と SQL の両方を当て、1 行でも食い違えば赤くする。DB が無ければ JS 側だけを見る。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_census_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/request-not-sent.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";
import {
  DECLARED_BODY_SENT_SINCE,
  bodyNotSentOnOurSide,
  bodyNotSentOnOurSideSql,
  declaresRequestBody,
  type NotSentRowInput,
} from "@/lib/observatory/request-body";
import {
  BASE_DECLARED_QUERY_SINCE,
  declaresRequiredQuery,
  queryNotSentOnOurSide,
  queryNotSentOnOurSideSql,
} from "@/lib/observatory/request-query";

const schemaWith = (input: Record<string, unknown>) => ({ type: "object", properties: { input: { type: "object", properties: input } } });
const REQ_QUERY = schemaWith({ queryParams: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } });
const OPT_QUERY = schemaWith({ queryParams: { type: "object", properties: { q: { type: "string" } } } });
const EMPTY_REQ_QUERY = schemaWith({ queryParams: { type: "object", properties: { q: { type: "string" } }, required: [] } });
const EMPTY_QUERY = schemaWith({ queryParams: {} });
const BAD_REQ_QUERY = schemaWith({ queryParams: { type: "object", required: "q" } });
const BODY = schemaWith({ body: { type: "object", properties: { q: { type: "string" } } } });

const base: NotSentRowInput = {
  status: "settle_failed",
  txHash: null,
  httpStatusPaid: 400,
  attemptedAt: "2026-09-20T03:00:00Z",
  rawResponseMeta: { phase: "paid" },
  network: "eip155:8453",
  method: "GET",
  declaredSchema: REQ_QUERY,
};

/** [名前, 行, query の期待値, body の期待値] */
const CASES: [string, NotSentRowInput, boolean, boolean][] = [
  ["query: required", base, true, false],
  ["query: 422", { ...base, httpStatusPaid: 422 }, true, false],
  ["query: v1 base slug", { ...base, network: "base" }, true, false],
  ["query: requestQuery empty", { ...base, rawResponseMeta: { phase: "paid", requestQuery: "empty" } }, true, false],
  ["query: requestQuery declared", { ...base, rawResponseMeta: { phase: "paid", requestQuery: "declared" } }, false, false],
  ["query: requestQuery refused", { ...base, rawResponseMeta: { phase: "paid", requestQuery: "refused" } }, false, false],
  ["query: meta null", { ...base, rawResponseMeta: null }, true, false],
  ["query: optional only", { ...base, declaredSchema: OPT_QUERY }, false, false],
  ["query: required empty", { ...base, declaredSchema: EMPTY_REQ_QUERY }, false, false],
  ["query: queryParams empty", { ...base, declaredSchema: EMPTY_QUERY }, false, false],
  ["query: required not an array", { ...base, declaredSchema: BAD_REQ_QUERY }, false, false],
  ["query: no schema", { ...base, declaredSchema: null }, false, false],
  ["query: after cutoff", { ...base, attemptedAt: BASE_DECLARED_QUERY_SINCE }, false, false],
  ["query: xrpl", { ...base, network: "xrpl:0" }, false, false],
  ["query: 401", { ...base, httpStatusPaid: 401 }, false, false],
  ["query: 404", { ...base, httpStatusPaid: 404 }, false, false],
  ["query: settled", { ...base, status: "settled" }, false, false],
  ["query: tx present", { ...base, txHash: "0xabc" }, false, false],
  ["body: POST before", { ...base, method: "POST", attemptedAt: "2026-09-15T03:00:00Z", declaredSchema: BODY }, false, true],
  ["body: post lower-case", { ...base, method: "post", attemptedAt: "2026-09-15T03:00:00Z", declaredSchema: BODY }, false, true],
  ["body: 422", { ...base, method: "POST", httpStatusPaid: 422, attemptedAt: "2026-09-15T03:00:00Z", declaredSchema: BODY }, false, true],
  ["body: at cutoff", { ...base, method: "POST", attemptedAt: DECLARED_BODY_SENT_SINCE, declaredSchema: BODY }, false, false],
  ["body: GET", { ...base, attemptedAt: "2026-09-15T03:00:00Z", declaredSchema: BODY }, false, false],
  ["body: requestBody recorded", { ...base, method: "POST", attemptedAt: "2026-09-15T03:00:00Z", declaredSchema: BODY, rawResponseMeta: { requestBody: "empty" } }, false, false],
  ["body: no declaration", { ...base, method: "POST", attemptedAt: "2026-09-15T03:00:00Z", declaredSchema: OPT_QUERY }, false, false],
  // 2026-09-29: 宣言は送る規則と同じ情報源（declared_input）でも見る。本文は 415 も入る。
  ["query: declared_input example values (schema has none)", { ...base, declaredSchema: EMPTY_QUERY, declaredInput: { query: "declared", body: "empty" } }, true, false],
  ["query: declared_input refused", { ...base, declaredSchema: EMPTY_QUERY, declaredInput: { query: "refused", body: "empty" } }, false, false],
  ["query: declared_input empty", { ...base, declaredSchema: OPT_QUERY, declaredInput: { query: "empty", body: "empty" } }, false, false],
  ["query: declared_input not a string", { ...base, declaredSchema: EMPTY_QUERY, declaredInput: { query: true, body: "empty" } }, false, false],
  ["query: declared_input after cutoff", { ...base, declaredSchema: EMPTY_QUERY, declaredInput: { query: "declared", body: "empty" }, attemptedAt: BASE_DECLARED_QUERY_SINCE }, false, false],
  ["query: declared_input 415 is not a query refusal", { ...base, httpStatusPaid: 415, declaredSchema: EMPTY_QUERY, declaredInput: { query: "declared", body: "empty" } }, false, false],
  ["body: 415 before", { ...base, method: "POST", httpStatusPaid: 415, attemptedAt: "2026-09-10T12:07:00Z", declaredSchema: BODY }, false, true],
  ["body: declared_input only", { ...base, method: "POST", attemptedAt: "2026-09-15T03:00:00Z", declaredSchema: OPT_QUERY, declaredInput: { query: "empty", body: "declared" } }, false, true],
  ["body: declared_input empty", { ...base, method: "POST", attemptedAt: "2026-09-15T03:00:00Z", declaredSchema: OPT_QUERY, declaredInput: { query: "empty", body: "empty" } }, false, false],
  ["body: 415 after cutoff", { ...base, method: "POST", httpStatusPaid: 415, attemptedAt: DECLARED_BODY_SENT_SINCE, declaredSchema: BODY }, false, false],
  ["both: POST before with body and required query", { ...base, method: "POST", attemptedAt: "2026-09-15T03:00:00Z", declaredSchema: schemaWith({ body: { type: "object" }, queryParams: { type: "object", required: ["q"] } }) }, true, true],
];

test("JS の述語: 期待どおり（必須のクエリ・本文の宣言・境目・ネットワーク・ステータス）", () => {
  for (const [name, row, q, b] of CASES) {
    assert.equal(queryNotSentOnOurSide(row), q, `query ${name}`);
    assert.equal(bodyNotSentOnOurSide(row), b, `body ${name}`);
  }
  assert.equal(declaresRequiredQuery(REQ_QUERY), true);
  assert.equal(declaresRequiredQuery(OPT_QUERY), false);
  assert.equal(declaresRequestBody(BODY), true);
  assert.equal(declaresRequestBody(REQ_QUERY), false);
});

test("SQL の断片は識別子だけを受け付ける", () => {
  assert.throws(() => queryNotSentOnOurSideSql({ row: "lr; DROP TABLE x", schema: "lr.declared_schema" }));
  assert.throws(() => bodyNotSentOnOurSideSql({ row: "lr", method: "lr.method", schema: "lr.declared_schema)" }));
});

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  test("request-not-sent SQL parity (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("SQL の断片は JS の述語と同じ行を選ぶ（1 行でも食い違えば赤）", async () => {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;
    const rows = CASES.map(([name, r]) => ({
      name,
      status: r.status,
      tx_hash: r.txHash,
      http_status_paid: r.httpStatusPaid,
      attempted_at: r.attemptedAt instanceof Date ? r.attemptedAt.toISOString() : r.attemptedAt,
      raw_response_meta: r.rawResponseMeta,
      network: r.network,
      method: r.method,
      declared_schema: r.declaredSchema,
      declared_input: r.declaredInput ?? null,
    }));
    const raw = await db.execute(sql`
      SELECT lr.name,
             ${sql.raw(queryNotSentOnOurSideSql({ row: "lr", schema: "lr.declared_schema", input: "lr.declared_input" }))} AS q,
             ${sql.raw(bodyNotSentOnOurSideSql({ row: "lr", method: "lr.method", schema: "lr.declared_schema", input: "lr.declared_input" }))} AS b
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS lr(
        name text, status text, tx_hash text, http_status_paid int, attempted_at timestamptz,
        raw_response_meta jsonb, network text, method text, declared_schema jsonb, declared_input jsonb)
    `);
    const out = (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as { name: string; q: boolean | null; b: boolean | null }[];
    assert.equal(out.length, CASES.length);
    for (const [name, , q, b] of CASES) {
      const r = out.find((x) => x.name === name)!;
      assert.equal(r.q === true, q, `SQL query ${name}`);
      assert.equal(r.b === true, b, `SQL body ${name}`);
    }
  });
}
