// ============================================================
// pay_if_trusted の refuse() の引数型が REFUSE_REASONS から導いた RefuseReason であること（2026-09-07）
//
// SDK の `refuse(reasons: PayRefuseReason[])` と同じ方針。この橋が**自分で足す**語は定数配列
// `REFUSE_REASONS` に持ち、型はそこから導く。サーバ由来の語（decision の reason_codes・
// `rate_limited` 等のエラー語・caller_policy の語）は狭めず、別の型で透過する。
//   1. `REFUSE_REASONS` が dist から読め、`refuse` の第2引数が string[] ではなく RefuseReason を受ける
//   2. `refuse(` に文字列リテラルとして現れる語は全部 REFUSE_REASONS にある
//   3. `as RefuseReason` の抜け道は 1 箇所以下
// ============================================================
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src/pay-if-trusted.ts");
const src = readFileSync(SRC, "utf8");
const srcNoComments = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("REFUSE_REASONS が dist にあり、refuse() の第2引数は RefuseReason を受ける型（string[] ではない）", async () => {
  const mod = await import("../dist/pay-if-trusted.js");
  assert.ok(Array.isArray(mod.REFUSE_REASONS) && mod.REFUSE_REASONS.length > 0, "REFUSE_REASONS が export されていない");
  const m = srcNoComments.match(/function refuse\(\s*measurement:[^,]+,\s*refuse_reasons:\s*([^,]+),/);
  assert.ok(m, "function refuse(measurement, refuse_reasons: ...) が見つからない");
  const type = m[1].trim();
  assert.notEqual(type, "string[]", "refuse の引数が string[] のまま——未知の語が型検査を素通りする");
  assert.match(type, /RefuseReason/, `refuse の引数型に RefuseReason が無い: ${type}`);
});

test("refuse( に文字列リテラルで渡る語は全部 REFUSE_REASONS にある", async () => {
  const { REFUSE_REASONS } = await import("../dist/pay-if-trusted.js");
  const used = new Set();
  // refuse(measure(...), [ ... ], "summary") — 第2引数の配列リテラルの中だけを読む
  for (const m of srcNoComments.matchAll(/refuse\(\s*[^,]+,\s*\[([^\]]*)\]/g)) {
    for (const lit of m[1].matchAll(/"([^"]+)"/g)) used.add(lit[1]);
  }
  assert.ok(used.size >= 4, `refuse の呼び出しが見つからない: ${[...used]}`);
  const declared = new Set(REFUSE_REASONS);
  assert.deepEqual([...used].filter((w) => !declared.has(w)), []);
});

test("`as RefuseReason` の抜け道は 1 箇所以下", () => {
  const hits = [...srcNoComments.matchAll(/as RefuseReason\b/g)];
  assert.ok(hits.length <= 1, `as RefuseReason が ${hits.length} 箇所——型を偽って通している`);
});
