// ============================================================
// 2026-09-04 金の経路監査 P2: デモ経由の L1 実購入がバッチ排他を取っていなかった。
//
// /api/cron/l1-purchase は acquireLease("l1-purchase", 330) を取ってから
// runL1Batch を呼ぶ。だが /api/v1/demo/verify は同じ runL1Batch を
// **リースを取らずに**呼んでいた。つまり定時 cron が走っている最中にデモを
// 叩けば、排他を入れた意味（孤児 in_flight の増減・summary の混乱・同じ
// エンドポイントへの重複購入）がそのまま戻る。しかもデモは API キー不要。
//
// 日次上限そのものは reserveSpend の単一文が守るので金額は破れない。守るのは
// 「2 つのバッチが同時に走らない」という運用上の不変条件。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

test("デモの L1 経路は cron と同じ l1-purchase リースを取る", () => {
  const route = read("src", "app", "api", "v1", "demo", "verify", "route.ts");
  assert.match(route, /acquireLease\(\s*"l1-purchase"/, "リースを取っていない");
  // 取れなかったときに購入を始めないこと。
  assert.match(route, /lease\.acquired/, "リースの結果を見ていない");
  assert.match(route, /runL1Batch/);
  const leaseAt = route.indexOf("acquireLease");
  const batchAt = route.indexOf("runL1Batch({");
  assert.ok(leaseAt > 0 && batchAt > leaseAt, "購入を始めてからリースを取っている");
});

test("リースは必ず解放される（finally）", () => {
  const route = read("src", "app", "api", "v1", "demo", "verify", "route.ts");
  assert.match(route, /finally \{[\s\S]{0,200}lease\.release\(\)/, "解放が finally に無い");
});

test("cron と同じリース名を使う（別名だと排他にならない）", () => {
  const cron = read("src", "app", "api", "cron", "l1-purchase", "route.ts");
  const cronName = /acquireLease\("([^"]+)"/.exec(cron)?.[1];
  const route = read("src", "app", "api", "v1", "demo", "verify", "route.ts");
  const demoName = /acquireLease\(\s*"([^"]+)"/.exec(route)?.[1];
  assert.equal(demoName, cronName);
});
