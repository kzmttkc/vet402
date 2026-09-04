// ============================================================
// schema.ts に無い本番オブジェクト（2026-09-04 監査 D・P1）。
//
// `drizzle-kit push` は schema.ts を正として本番を揃える——schema に無いテーブル・索引は
// **drop される**。本番には raw SQL で作った job_leases（cron の排他リース）と部分索引
// x402_l1_purchases_pending_verify_idx（照合 cron の主索引）があり、どちらも schema.ts に
// 無かった。push を 1 回叩けば排他が消え、照合 cron が全走査になる。
// ここでは schema.ts がそれらを本番と同じ形で持っていることを固定する。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "@/lib/db/schema";

function col(cfg: ReturnType<typeof getTableConfig>, name: string) {
  const c = cfg.columns.find((x) => x.name === name);
  assert.ok(c, `column ${name} が無い`);
  return c;
}

test("job_leases が本番 \\d と同じ形で schema.ts にある", () => {
  const cfg = getTableConfig(schema.jobLeases);
  assert.equal(cfg.name, "job_leases");
  const name = col(cfg, "name");
  assert.equal(name.getSQLType(), "text");
  assert.equal(name.primary, true);
  const holder = col(cfg, "holder");
  assert.equal(holder.getSQLType(), "uuid");
  assert.equal(holder.notNull, true);
  const acquired = col(cfg, "acquired_at");
  assert.equal(acquired.getSQLType(), "timestamp with time zone");
  assert.equal(acquired.notNull, true);
  assert.equal(acquired.hasDefault, true);
  const expires = col(cfg, "expires_at");
  assert.equal(expires.getSQLType(), "timestamp with time zone");
  assert.equal(expires.notNull, true);
  assert.equal(expires.hasDefault, false);
  assert.equal(cfg.columns.length, 4);
});

test("x402_l1_purchases の部分索引 pending_verify_idx が schema.ts にある（WHERE つき）", () => {
  const cfg = getTableConfig(schema.x402L1Purchases);
  const idx = cfg.indexes.find((i) => i.config.name === "x402_l1_purchases_pending_verify_idx");
  assert.ok(idx, "x402_l1_purchases_pending_verify_idx が無い——push で drop される");
  assert.equal(idx.config.unique, false);
  assert.ok(idx.config.where, "部分索引の WHERE が無い——全行の索引になり意味が変わる");
  const cols = idx.config.columns.map((c) => ("name" in c ? c.name : String(c)));
  assert.deepEqual(cols, ["attempted_at"]);
});

test("decision_idempotency（Idempotency-Key の応答保存）が schema.ts にある", () => {
  const cfg = getTableConfig(schema.decisionIdempotency);
  assert.equal(cfg.name, "decision_idempotency");
  const key = col(cfg, "key_hash");
  assert.equal(key.getSQLType(), "text");
  assert.equal(key.primary, true);
  const body = col(cfg, "body");
  assert.equal(body.getSQLType(), "jsonb");
  assert.equal(body.notNull, true);
  const expires = col(cfg, "expires_at");
  assert.equal(expires.getSQLType(), "timestamp with time zone");
  assert.equal(expires.notNull, true);
  assert.ok(
    cfg.indexes.some((i) => i.config.columns.some((c) => "name" in c && c.name === "expires_at")),
    "expires_at の索引が無い——期限切れの掃除が全走査になる",
  );
});
