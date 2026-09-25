// W01 実現可能性の実測: route.ts から静的 import グラフを辿り process.env の参照を集める
// 依存ゼロ（正規表現のみ）。node envgraph.mjs <root> <entry...>
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const ROOT = process.argv[2];
const ENTRIES = process.argv.slice(3);
const SRC = join(ROOT, "src");

function resolveSpec(spec, fromFile) {
  let base;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null; // node_modules / bare
  for (const c of [base, base + ".ts", base + ".tsx", base + ".mts", join(base, "index.ts")]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?:[\s\S]*?\sfrom\s+)?["']([^"']+)["']/g;
const DYN_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const ENV_STATIC_RE = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g;
const ENV_DYNAMIC_RE = /process\.env\s*\[([^\]]*)\]/g;

const seen = new Set(), envStatic = new Map(), envDynamic = [], unresolved = new Set();
function walk(file) {
  if (seen.has(file)) return;
  seen.add(file);
  const src = readFileSync(file, "utf8");
  const rel = file.slice(ROOT.length + 1);
  for (const m of src.matchAll(ENV_STATIC_RE)) {
    if (!envStatic.has(m[1])) envStatic.set(m[1], []);
    envStatic.get(m[1]).push(rel);
  }
  for (const m of src.matchAll(ENV_DYNAMIC_RE)) envDynamic.push({ file: rel, expr: m[1].trim() });
  for (const re of [IMPORT_RE, DYN_IMPORT_RE]) {
    for (const m of src.matchAll(re)) {
      const t = resolveSpec(m[1], file);
      if (t) walk(t); else if (m[1].startsWith("@/") || m[1].startsWith(".")) unresolved.add(m[1]);
    }
  }
}
for (const e of ENTRIES) walk(resolve(e));
console.log(JSON.stringify({
  files: seen.size,
  envStaticNames: [...envStatic.keys()].sort(),
  envStaticCount: envStatic.size,
  envDynamic,
  unresolved: [...unresolved],
}, null, 1));
