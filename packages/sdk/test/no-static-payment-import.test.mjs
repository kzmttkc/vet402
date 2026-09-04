// ============================================================
// 第3層の検算（WINDOW_PLAN §4「呼べないことの4層証明」）。
//
// `pay-or-refuse.test.mjs` の冒頭は「支払い実装は ALLOW ブランチ内の動的 import で、
// 拒否経路では**モジュールの評価すら起きない**」と宣言している。
// ところがその宣言は、2026-09-05 まで**どのテストでも検算されていなかった**——
// `pay-or-refuse.ts` の動的 import を static import に書き換えても、既存の 106 本は
// 1本も赤くならなかった。主張だけあって計器が無い状態で、検証を売る製品としては最悪。
//
// このファイルがその計器。**src ではなく dist（＝実際に走るコード）** の静的な
// モジュールグラフを、公開入口 `dist/index.js` から辿り、支払いモジュールに
// **静的には到達できない**ことを示す。型だけの import は tsc が消すので dist には出ない。
//
// 変異で確かめてあること（2026-09-05）:
//   `const { executeX402Payment } = await import("./x402-pay.js");`
//   → `import { executeX402Payment } from "./x402-pay.js";` に書き換えると
//   「第3層: dist の静的グラフに支払いモジュールが現れない」が赤くなる。
// ============================================================
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(here, "../dist");
const SRC = resolve(here, "../src");
/** 支払い（署名）実装。ここへ静的に届いてはいけない。 */
const PAYMENT_MODULE = resolve(DIST, "x402-pay.js");

/**
 * コメントを落とす。import 文がコメントの中にあるのを本物と数えないため
 * （dist は JSDoc をそのまま残すので、`./x402-pay.js` を説明する行が実在する）。
 */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** 静的な import / export ... from の指定子だけを拾う（`import(...)` は動的なので拾わない）。 */
function staticSpecifiers(code) {
  const src = stripComments(code);
  const out = [];
  // `import x from "m"` / `import "m"` / `export * from "m"` / `export { x } from "m"`
  // `(?!\s*\()` で動的 `import("m")` を外す——それがまさに第3層で許している形。
  const re = /(?:^|[;}\n])\s*(?:import|export)\b(?!\s*\()(?:[^;]*?\bfrom)?\s*["']([^"']+)["']\s*;?/g;
  for (const m of src.matchAll(re)) out.push(m[1]);
  // `import "m";`（副作用 import）は上の正規表現で from 無しとして拾える。
  return out;
}

function resolveSpecifier(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null; // 外部パッケージは辿らない
  return resolve(dirname(fromFile), specifier);
}

/** `dist/index.js` から静的 import だけを辿って到達できるファイル一覧。 */
function staticGraphFrom(entry) {
  const seen = new Set();
  const queue = [entry];
  const edges = [];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const spec of staticSpecifiers(readFileSync(file, "utf8"))) {
      const target = resolveSpecifier(file, spec);
      if (!target) continue;
      edges.push(`${file} -> ${spec}`);
      queue.push(target);
    }
  }
  return { files: seen, edges };
}

test("第3層: dist の静的グラフに支払いモジュールが現れない（拒否経路では評価すら起きない）", () => {
  const entry = resolve(DIST, "index.js");
  assert.ok(existsSync(entry), "dist/index.js がある（npm test は tsc を通してから走る）");
  assert.ok(existsSync(PAYMENT_MODULE), "dist/x402-pay.js がある（検査対象が実在する）");

  const { files, edges } = staticGraphFrom(entry);
  assert.ok(files.size >= 3, `グラフを実際に辿れている（辿ったファイル数=${files.size}）`);
  assert.equal(
    files.has(PAYMENT_MODULE),
    false,
    "支払いモジュールへ静的に到達できてしまう。動的 import に戻すこと。辿った辺:\n" + edges.join("\n"),
  );
});

test("第3層: 支払いモジュールは動的 import でだけ参照される", () => {
  const code = readFileSync(resolve(DIST, "pay-or-refuse.js"), "utf8");
  const stripped = stripComments(code);
  assert.match(
    stripped,
    /await\s+import\(\s*["']\.\/x402-pay\.js["']\s*\)/,
    "ALLOW ブランチ内の動的 import が消えている（消すと第3層の主張が空になる）",
  );
  assert.deepEqual(
    staticSpecifiers(code).filter((s) => s.includes("x402-pay")),
    [],
    "pay-or-refuse.js に x402-pay への静的 import がある",
  );
});

test("第3層: src 側も値としては静的 import していない（型だけは可・tsc が消す）", () => {
  const code = readFileSync(resolve(SRC, "pay-or-refuse.ts"), "utf8");
  const stripped = stripComments(code);
  const lines = stripped.split("\n");
  const offenders = lines.filter((line) => {
    if (!line.includes("x402-pay")) return false;
    const t = line.trim();
    if (!/^(import|export)\b/.test(t)) return false; // 動的 import / 型注釈は対象外
    // `import type ...` / `export type ...` は tsc が消すので値の参照にならない。
    return !/^(import|export)\s+type\b/.test(t);
  });
  assert.deepEqual(offenders, [], "src で x402-pay を値として静的 import している");
});
