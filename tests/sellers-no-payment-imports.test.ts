// ============================================================
// /sellers の公開頁は支払いのコードを読み込まない（独立レビュー 2026-09-28 BLOCK-1）。
//
// 頁・描画・src/lib/sellers と src/proxy.ts から import を辿り、l1-runner と支払いのモジュール
// （payer・署名の鍵を持つもの）、viem/accounts・@solana/web3.js に届かないことを確かめる。
// `import type` は実行時に消えるので辿らない。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = process.cwd();
const FORBIDDEN_FILES = [
  "src/lib/observatory/l1-runner.ts",
  "src/lib/observatory/payer-funds.ts",
  "src/lib/observatory/x402-payer.ts",
  "src/lib/observatory/sol402-payer.ts",
  "src/lib/observatory/xrpl402-payer.ts",
  "src/lib/observatory/mpp-payer.ts",
];
const FORBIDDEN_PACKAGES = [/^viem\/accounts/, /^@solana\/web3\.js/];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(ROOT, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null;
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

function runtimeImports(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const specs: string[] = [];
  for (const m of src.matchAll(/^\s*(import|export)\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm)) specs.push(m[2]);
  for (const m of src.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) specs.push(m[1]);
  for (const m of src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) specs.push(m[1]);
  return specs;
}

test("/sellers の頁・描画・lib と proxy から、l1-runner と支払いのモジュールに届かない", () => {
  const starts = [
    ...walk(join(ROOT, "src/app/sellers")),
    ...walk(join(ROOT, "src/components/site/sellers")),
    ...walk(join(ROOT, "src/lib/sellers")),
    join(ROOT, "src/proxy.ts"),
  ];
  const seen = new Set<string>();
  const parent = new Map<string, string>();
  const packages = new Map<string, string>();
  const queue = [...starts];
  while (queue.length) {
    const f = queue.shift()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const spec of runtimeImports(f)) {
      const r = resolveImport(f, spec);
      if (r === null) {
        if (!spec.startsWith(".") && !spec.startsWith("@/")) packages.set(spec, f);
        continue;
      }
      if (!parent.has(r)) parent.set(r, f);
      queue.push(r);
    }
  }
  const chain = (f: string): string => {
    const out = [relative(ROOT, f)];
    let p = parent.get(f);
    while (p) {
      out.push(relative(ROOT, p));
      p = parent.get(p);
    }
    return out.reverse().join(" -> ");
  };
  const reached = FORBIDDEN_FILES.map((f) => join(ROOT, f)).filter((f) => seen.has(f));
  assert.deepEqual(reached.map(chain), [], "a /sellers module reaches payment code");
  const pk = [...packages.entries()].filter(([spec]) => FORBIDDEN_PACKAGES.some((re) => re.test(spec)));
  assert.deepEqual(pk.map(([spec, f]) => `${relative(ROOT, f)} imports ${spec}`), []);
  // 辿れていること（空集合で緑にならない）
  assert.ok(seen.has(join(ROOT, "src/lib/observatory/retest-sellers-sql.ts")), "the retest SQL module is reached");
  assert.ok(seen.size > 20, `walked ${seen.size} files`);
});

test("検査が効いている: l1-runner からは支払いのモジュールに届く", () => {
  const src = readFileSync(join(ROOT, "src/lib/observatory/l1-runner.ts"), "utf8");
  assert.ok(runtimeImports(join(ROOT, "src/lib/observatory/l1-runner.ts")).some((s) => /payer-funds|x402-payer/.test(s)), src.length > 0 ? "l1-runner imports a payer module" : "");
});
