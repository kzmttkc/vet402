// ============================================================
// refuse() の引数型が PAY_REFUSE_REASONS から導いた PayRefuseReason[] であること（2026-09-07）
//
// 背景: `payee_recommendation_block` が型に無いまま実装が出していた。`refuse` の引数が
// `string[]` だったので tsc が素通しした。守るのは型（未知の語はコンパイルで止まる）なので、
// ここは薄い**ソース走査**だけ:
//   1. `refuse` の引数が string[] でなく PayRefuseReason を受ける
//   2. `refuse([...])` に文字列リテラルとして現れる語は全部 PAY_REFUSE_REASONS にある
//   3. `as PayRefuseReason` の抜け道は 1 箇所以下（判別関数の中だけ）
// サーバ由来の語（decision.reason_codes 等）は PayRefuseReason に狭めず、別の型で透過する。
// ============================================================
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PAY_REFUSE_REASONS } from "../dist/index.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src/pay-or-refuse.ts");
const src = readFileSync(SRC, "utf8");
const srcNoComments = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("refuse() の第1引数は PayRefuseReason を受ける型（string[] ではない）", () => {
  const m = srcNoComments.match(/const refuse = \(\s*reason_codes:\s*([^,]+),/);
  assert.ok(m, "const refuse = (reason_codes: ...) が見つからない");
  const type = m[1].trim();
  assert.notEqual(type, "string[]", "refuse の引数が string[] のまま——未知の語が型検査を素通りする");
  assert.match(type, /PayRefuseReason/, `refuse の引数型に PayRefuseReason が無い: ${type}`);
});

test("refuse([...]) に文字列リテラルで渡る語は全部 PAY_REFUSE_REASONS にある", () => {
  const used = new Set();
  for (const m of srcNoComments.matchAll(/refuse\(\s*\[([^\]]*)\]/g)) {
    for (const lit of m[1].matchAll(/"([^"]+)"/g)) used.add(lit[1]);
  }
  assert.ok(used.size >= 6, `refuse の呼び出しが見つからない: ${[...used]}`);
  const declared = new Set(PAY_REFUSE_REASONS);
  assert.deepEqual([...used].filter((w) => !declared.has(w)), []);
});

test("`as PayRefuseReason` の抜け道は 1 箇所以下", () => {
  const hits = [...srcNoComments.matchAll(/as PayRefuseReason\b/g)];
  assert.ok(hits.length <= 1, `as PayRefuseReason が ${hits.length} 箇所——型を偽って通している`);
});
