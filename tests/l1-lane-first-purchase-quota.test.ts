// ============================================================
// 初回購入の日次枠は、別枠を持つレーンには掛けない（2026-09-17・本番 21:5x の穴）。
//
// 本番で l1-purchase を手動で流したら laneFloor: {solana:5, arc:0, tempo:0, xrpl:0}。Tempo 265 件・
// XRPL 1 件の候補があるのに枠に載らなかった。FIRST_PURCHASE_DAILY_QUOTA（120）が当日ぶん使い
// 切られ、「購入行が無い」エンドポイントが候補 SQL で除外されていた。新しいチェーンの掃引は
// 初回購入しか無いので、この枠に当たると永久に始まらない。支出はチェーンの別枠（$2/日）で
// 既に縛られている。
//
// ここは reserveSpend（非公開）と候補 SQL の分岐を原文で固定する。挙動は
// tests/l1-lane-first-purchase-quota.pg.test.ts。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(process.cwd(), "src", "lib", "observatory", "l1-runner.ts"), "utf8");

test("reserveSpend: 初回購入の枠の条件は firstQuotaApplies（= 別枠を持たないチェーン）のときだけ 1 文に入る", () => {
  assert.match(src, /const firstQuotaApplies = capChain === null;/, "判断の変数が無い");
  assert.match(
    src,
    /\$\{firstQuotaApplies \? sql`AND \(NOT first_day\.is_first OR first_day\.n < \$\{FIRST_PURCHASE_DAILY_QUOTA\}\)` : sql``\}/,
    "INSERT の WHERE で枠の条件が無条件に付いている（別枠チェーンの初回購入が予約で止まる）",
  );
  assert.match(src, /if \(firstQuotaApplies && row\.is_first === true\) \{/, "first_purchase_quota の判定が別枠チェーンにも掛かる");
  // 枠を外しても、日次 $25・別枠・dup（掃引窓）の条件は同じ 1 文に残っている。
  assert.match(src, /WHERE NOT dup\.taken\s*\n\s*AND day\.spent \+ \$\{amountUnits\}::numeric <= \$\{String\(DAILY_BUDGET_UNITS\)\}::numeric/);
  assert.match(src, /AND chain_day\.spent \+ \$\{amountUnits\}::numeric <= \$\{capUnits\}::numeric/);
});

test("候補 SQL: レーン枠（lane 付き）の問い合わせには未購入の除外を付けない。主候補（Base）は従来どおり", () => {
  assert.match(
    src,
    /firstPurchasesSelectable \|\| lane\s*\n\s*\? sql``\s*\n\s*: sql`AND EXISTS \(SELECT 1 FROM x402_l1_purchases fp WHERE fp\.endpoint_id = e\.id\)`/,
    "レーン枠の問い合わせでも未購入を除外している（新しいチェーンの掃引が始まらない）",
  );
});
