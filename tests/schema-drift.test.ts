// ============================================================
// schema.ts と本番 `\d` の突合（2026-09-04 監査 D・P1）。
//
// `drizzle-kit push` は schema.ts を正として DB を揃える。DB にだけあるものは drop、
// schema にだけあるものは create。job_leases と部分索引がその状態で放置されていた。
// 「push したら何が消えるか」を push せずに読める道具が要る（読み取り専用）。
// ここは純粋関数 diffSchema と、drizzle の schema から期待形を取る expectedFromDrizzle。
// 実接続は scripts/schema-drift.ts（npm run db:drift）。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { diffSchema, expectedFromDrizzle, normalizeType, parseIndexDef, type SchemaShape } from "@/lib/db/schema-drift";
import * as schema from "@/lib/db/schema";

const base: SchemaShape = {
  job_leases: {
    columns: {
      name: { type: "text", notNull: true, hasDefault: false },
      holder: { type: "uuid", notNull: true, hasDefault: false },
      expires_at: { type: "timestamptz", notNull: true, hasDefault: false },
    },
    indexes: {},
    primaryKey: ["name"],
  },
  x402_l1_purchases: {
    columns: {
      id: { type: "uuid", notNull: true, hasDefault: true },
      attempted_at: { type: "timestamptz", notNull: false, hasDefault: true },
    },
    indexes: {
      x402_l1_purchases_pending_verify_idx: { columns: ["attempted_at"], unique: false, partial: true },
    },
    primaryKey: ["id"],
  },
};

function clone(s: SchemaShape): SchemaShape {
  return JSON.parse(JSON.stringify(s));
}

test("同じ形なら drift は 0", () => {
  assert.deepEqual(diffSchema(base, clone(base)), []);
});

test("DB にだけあるテーブルは「push で drop される」として出る", () => {
  const actual = clone(base);
  actual.legacy_thing = { columns: { id: { type: "text", notNull: true, hasDefault: false } }, indexes: {}, primaryKey: ["id"] };
  const d = diffSchema(base, actual);
  assert.equal(d.length, 1);
  assert.match(d[0], /DROP TABLE legacy_thing/);
  assert.match(d[0], /push/);
});

test("schema にだけあるテーブル・列・索引は「push で create される」として出る", () => {
  const actual = clone(base);
  delete actual.job_leases;
  delete actual.x402_l1_purchases.indexes.x402_l1_purchases_pending_verify_idx;
  delete actual.x402_l1_purchases.columns.attempted_at;
  const d = diffSchema(base, actual);
  assert.equal(d.length, 3, d.join("\n"));
  assert.ok(d.some((l) => /CREATE TABLE job_leases/.test(l)));
  assert.ok(d.some((l) => /ADD COLUMN x402_l1_purchases\.attempted_at/.test(l)));
  assert.ok(d.some((l) => /CREATE INDEX x402_l1_purchases_pending_verify_idx/.test(l)));
});

test("DB にだけある索引・列は drop として出る", () => {
  const actual = clone(base);
  actual.x402_l1_purchases.indexes.extra_idx = { columns: ["id"], unique: false, partial: false };
  actual.x402_l1_purchases.columns.extra_col = { type: "text", notNull: false, hasDefault: false };
  const d = diffSchema(base, actual);
  assert.equal(d.length, 2, d.join("\n"));
  assert.ok(d.some((l) => /DROP INDEX extra_idx/.test(l)));
  assert.ok(d.some((l) => /DROP COLUMN x402_l1_purchases\.extra_col/.test(l)));
});

test("列の型・NOT NULL・default の違いと、索引の列・unique・partial の違いを出す", () => {
  const actual = clone(base);
  actual.job_leases.columns.holder.type = "text";
  actual.job_leases.columns.expires_at.notNull = false;
  actual.job_leases.columns.name.hasDefault = true;
  actual.x402_l1_purchases.indexes.x402_l1_purchases_pending_verify_idx.partial = false;
  const d = diffSchema(base, actual);
  assert.equal(d.length, 4, d.join("\n"));
  assert.ok(d.some((l) => /job_leases\.holder.*uuid.*text/.test(l)));
  assert.ok(d.some((l) => /job_leases\.expires_at.*NOT NULL/.test(l)));
  assert.ok(d.some((l) => /job_leases\.name.*default/.test(l)));
  assert.ok(d.some((l) => /x402_l1_purchases_pending_verify_idx.*partial/.test(l)));
});

test("主キーの違いを出す", () => {
  const actual = clone(base);
  actual.job_leases.primaryKey = ["holder"];
  const d = diffSchema(base, actual);
  assert.equal(d.length, 1, d.join("\n"));
  assert.match(d[0], /PRIMARY KEY job_leases/);
});

test("型の正規化: pg の表記と drizzle の表記が同じ値になる", () => {
  assert.equal(normalizeType("timestamp with time zone"), "timestamptz");
  assert.equal(normalizeType("character varying(255)"), "varchar(255)");
  assert.equal(normalizeType("varchar(255)"), "varchar(255)");
  assert.equal(normalizeType("serial"), "integer");
  assert.equal(normalizeType("BIGINT"), "bigint");
});

test("expectedFromDrizzle: 実 schema.ts から job_leases と部分索引が取れる", () => {
  const e = expectedFromDrizzle(schema);
  assert.deepEqual(e.job_leases.primaryKey, ["name"]);
  assert.equal(e.job_leases.columns.acquired_at.type, "timestamptz");
  assert.equal(e.job_leases.columns.acquired_at.hasDefault, true);
  const idx = e.x402_l1_purchases.indexes.x402_l1_purchases_pending_verify_idx;
  assert.deepEqual(idx, { columns: ["attempted_at"], unique: false, partial: true });
  // 複合主キー
  assert.deepEqual(e.decision_lookups.primaryKey, ["endpoint_id", "day"]);
  // uniqueIndex は unique:true
  assert.equal(e.owner_agents.indexes.owner_agents_unique.unique, true);
});

test("parseIndexDef: 部分索引の WHERE を列に混ぜない・複合列・unique・式索引", () => {
  assert.deepEqual(
    parseIndexDef(
      "CREATE INDEX x ON public.t USING btree (attempted_at) WHERE ((settlement_verified IS NULL) AND (tx_hash IS NOT NULL))",
    ),
    { columns: ["attempted_at"], unique: false, partial: true },
  );
  assert.deepEqual(parseIndexDef("CREATE UNIQUE INDEX u ON public.t USING btree (endpoint_id, day)"), {
    columns: ["endpoint_id", "day"],
    unique: true,
    partial: false,
  });
  assert.deepEqual(parseIndexDef("CREATE INDEX e ON public.owner_agents USING btree (lower(owner))"), {
    columns: ["<expr>"],
    unique: false,
    partial: false,
  });
});

test("unique() 制約は一意索引として期待形に入り、本番に無ければ drift になる", () => {
  const expected = expectedFromDrizzle(schema);
  const key = expected.settlement_daily?.indexes.settlement_daily_key;
  assert.ok(key, "settlement_daily_key が期待形に無い");
  assert.equal(key.unique, true);
  assert.deepEqual(key.columns, [
    "day", "chain", "payee_id", "payer_id", "wash_flag", "source", "attribution", "endpoint_id", "resource_id",
  ]);
  // 本番が制約を欠いた形（2026-09-04 に実際にあった状態）。
  const actual: SchemaShape = JSON.parse(JSON.stringify(expected));
  delete actual.settlement_daily.indexes.settlement_daily_key;
  const drift = diffSchema(expected, actual);
  assert.ok(drift.some((l) => l.includes("settlement_daily_key")), `drift に出ない: ${drift.join(" / ")}`);
  // pg_indexes の indexdef 末尾に NULLS NOT DISTINCT が付いても partial と誤読しない。
  const parsed = parseIndexDef(
    "CREATE UNIQUE INDEX settlement_daily_key ON public.settlement_daily USING btree (day, chain) NULLS NOT DISTINCT",
  );
  assert.deepEqual(parsed, { columns: ["day", "chain"], unique: true, partial: false });
});
