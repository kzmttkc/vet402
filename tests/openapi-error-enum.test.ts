// ============================================================
// vet402 — openapi の ErrorResponse.error enum ⊇ 実装が返すコード (2026-09-02)
//
// WHY. 2026-09-02 の敵対的監査で、§7.3 / §9.1 の新規ルート（resolve / resources /
// endpoints / payees / facts / decision / census / corrections）が返す 12 語が
// docs/openapi.yaml の `ErrorResponse.error` enum に無かった。enum で検証する
// 生成クライアントは、仕様に無いコードを「不正な応答」として捨てる——サーバは
// 正しいことを言っているのに、クライアント側で黙って壊れる、最悪の形。
//
// HOW. openapi.yaml に載っている path ごとに対応する route.ts を解決し、その
// ファイル（と全ルート共通の src/lib/api/*）に書かれた `error: "…"` リテラルを
// 集め、enum の部分集合であることを検査する。未文書のルート（admin / cron /
// dashboard / billing）は tests/openapi-route-parity.test.ts の許可リスト側の
// 責任なので、ここでは見ない。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

function documentedPaths(spec: string): string[] {
  return [...spec.matchAll(/^\s{2}(\/api\/[^\s:]+):/gm)].map((m) => m[1]);
}

/** `/api/v1/resources/{resourceId}/decision` → `src/app/api/v1/resources/[resourceId]/decision/route.ts` */
function routeFileFor(apiPath: string): string | null {
  const fsPath = apiPath.replace(/\{([^}]+)\}/g, "[$1]");
  const candidates = [fsPath, fsPath.replace(/\.svg$/, "")];
  for (const c of candidates) {
    const rel = join("src/app", c, "route.ts");
    if (existsSync(join(ROOT, rel))) return rel;
  }
  return null;
}

function errorLiterals(source: string): string[] {
  return [...source.matchAll(/error:\s*"([a-z0-9_]+)"/g)].map((m) => m[1]);
}

function enumValues(spec: string): string[] {
  const start = spec.indexOf("    ErrorResponse:");
  assert.ok(start !== -1, "components.schemas.ErrorResponse が見つからない");
  const block = spec.slice(start);
  const enumStart = block.indexOf("          enum:");
  assert.ok(enumStart !== -1, "ErrorResponse.error.enum が見つからない");
  const out: string[] = [];
  for (const line of block.slice(enumStart).split("\n").slice(1)) {
    const m = /^\s{12}-\s+([a-z0-9_]+)\s*$/.exec(line);
    if (m) {
      out.push(m[1]);
      continue;
    }
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    break;
  }
  return out;
}

test("抽出器が enum と route を実際に読めている (空集合で緑にならない)", () => {
  const spec = read("docs/openapi.yaml");
  const values = enumValues(spec);
  assert.ok(values.includes("invalid_request"), `enum に invalid_request が無い: ${values.join(",")}`);
  assert.ok(values.length >= 20, `enum が短すぎる (${values.length})`);
  const paths = documentedPaths(spec);
  assert.ok(paths.length >= 40, `documented paths が少なすぎる (${paths.length})`);
  const resolved = paths.map(routeFileFor).filter((x): x is string => x !== null);
  assert.ok(resolved.length >= 40, `route.ts へ解決できた path が少なすぎる (${resolved.length})`);
  assert.ok(errorLiterals(read("src/app/api/v1/resolve/route.ts")).includes("invalid_query"));
});

test("文書化された全ルートが返す error コードは ErrorResponse.error enum の部分集合", () => {
  const spec = read("docs/openapi.yaml");
  const allowed = new Set(enumValues(spec));

  const sharedDir = join(ROOT, "src/lib/api");
  const shared = readdirSync(sharedDir)
    .filter((f) => f.endsWith(".ts"))
    .flatMap((f) => errorLiterals(read(join("src/lib/api", f))));

  const missing = new Map<string, string[]>();
  const record = (code: string, where: string) => {
    if (allowed.has(code)) return;
    const list = missing.get(code) ?? [];
    if (!list.includes(where)) list.push(where);
    missing.set(code, list);
  };
  for (const code of shared) record(code, "src/lib/api");
  for (const apiPath of documentedPaths(spec)) {
    const rel = routeFileFor(apiPath);
    if (!rel) continue; // パス網羅は openapi-route-parity の責任
    for (const code of errorLiterals(read(rel))) record(code, apiPath);
  }

  assert.deepEqual(
    [...missing.entries()].map(([code, where]) => `${code} ← ${where.join(", ")}`),
    [],
    "docs/openapi.yaml の ErrorResponse.error enum に無いコードを実装が返している。" +
      "enum で検証する生成クライアントは、そのコードを不正な応答として捨てる。",
  );
});
