// 2026-10-24: docs/openapi.yaml の paths にある公開窓口は、全部 /docs/api のカード path に出る。
// admin / cron / billing / dashboard / signup は paths に無い（openapi 先頭のコメント）。
// /api/v1/guarantee/quote も paths に無い。休眠中なのでカードにも載せない。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const yaml = readFileSync("docs/openapi.yaml", "utf8");
const page = readFileSync("src/app/docs/api/page.tsx", "utf8");

function publicOpenApiPaths(source: string): string[] {
  const start = source.indexOf("\npaths:\n");
  const end = source.indexOf("\ncomponents:\n", start);
  assert.ok(start > 0 && end > start, "paths と components の位置");
  return [...source.slice(start, end).matchAll(/^  (\/\S+):$/gm)].map((m) => m[1]!);
}

function cardPaths(source: string): string[] {
  return [...source.matchAll(/path: "([^"]+)"/g)].map((m) => m[1]!.split("?")[0]!);
}

test("openapi の公開パスは全部 /docs/api の path カードにある", () => {
  const keys = publicOpenApiPaths(yaml);
  assert.ok(keys.length >= 50, `paths が少なすぎる: ${keys.length}`);
  const cards = new Set(cardPaths(page));
  const missing = keys
    .map((key) => key.replace(/\{([^}]+)\}/g, ":$1"))
    .filter((colon) => !cards.has(colon));
  assert.deepEqual(missing, []);
});

test("/docs/api のカードのパスは全部 openapi の公開パスにある", () => {
  const keys = new Set(publicOpenApiPaths(yaml).map((key) => key.replace(/\{([^}]+)\}/g, ":$1")));
  const missing = cardPaths(page).filter((path) => path.startsWith("/api/") && !keys.has(path));
  assert.deepEqual(missing, []);
});

test("guarantee/quote は paths にも /docs/api のカードにも無い", () => {
  assert.equal(publicOpenApiPaths(yaml).includes("/api/v1/guarantee/quote"), false);
  assert.equal(cardPaths(page).includes("/api/v1/guarantee/quote"), false);
});
