// ============================================================
// §7.1 EVM 決済索引 — エンドポイントのページ読みを試し直す（2026-11-04）。
//
// 事故: 分けて読むようにした後も、ページの読み取りで HTTP の流れが切れる回があり、
// その回の Base の索引がまるごと止まっていた。
//
// 守ること:
//  1. 途中のページが切れても試し直して、行を重複も抜けもなく返す
//  2. 試し直しは同じ位置から読み、成功したページの後ろへ進む
//  3. 試し直した回数を呼び手へ知らせる
//  4. 3 回続けて切れたら、空の結果にせず失敗を上へ返す
//
// Run: npx tsx --test tests/settlements-endpoints-retry.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { loadChainEndpoints } from "@/lib/settlements/index-evm";

const row = (n: number) => ({
  id: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`,
  resource_id: null,
  pay_to: "0xb1",
  price_amount: "10000",
  price_asset: null,
  network: "eip155:8453",
});

const cut = () => new Error("Stream closed with error code NGHTTP2_INTERNAL_ERROR");

test("a page read that is cut is tried again and no row is lost or repeated", async () => {
  const answers: Array<() => { rows: ReturnType<typeof row>[] }> = [
    () => ({ rows: [row(1), row(2)] }),
    () => {
      throw cut();
    },
    () => {
      throw cut();
    },
    () => ({ rows: [row(3)] }),
  ];
  const dialect = new PgDialect();
  const afterIds: unknown[] = [];
  let calls = 0;
  const db = {
    execute: async (query: SQL) => {
      afterIds.push(dialect.sqlToQuery(query).params[2]);
      return answers[calls++]();
    },
  };
  let retries = 0;

  const rows = await loadChainEndpoints(db, "eip155:8453", 2, 0, () => {
    retries += 1;
  });

  assert.equal(calls, 4);
  assert.equal(retries, 2);
  assert.deepEqual(afterIds, ["00000000-0000-0000-0000-000000000000", row(2).id, row(2).id, row(2).id]);
  assert.deepEqual(
    rows.map((r) => r.id),
    [row(1).id, row(2).id, row(3).id],
  );
});

test("three cuts in a row fail the read instead of returning a short list", async () => {
  let calls = 0;
  const db = {
    execute: async () => {
      calls++;
      throw cut();
    },
  };

  await assert.rejects(loadChainEndpoints(db, "eip155:8453", 2, 0), /NGHTTP2_INTERNAL_ERROR/);
  assert.equal(calls, 3);
});
