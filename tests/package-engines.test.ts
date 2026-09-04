// ============================================================
// package.json の engines.node と @types/node を実行環境に揃える（2026-09-04 監査 D・P2）。
//
// Vercel 本番は Node 24.x。engines が無いと Vercel は既定を選び、@types/node が ^20 のままだと
// 型は 20 の API で検査されて本番 24 の挙動と食い違う（型は通るのに走らない、の入口）。
// engines と @types/node の major を一致させる。
// ============================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
  engines?: { node?: string };
  devDependencies: Record<string, string>;
};

test("engines.node は Vercel 本番の 24.x", () => {
  assert.equal(pkg.engines?.node, "24.x");
});

test("@types/node の major は engines.node と同じ", () => {
  const types = pkg.devDependencies["@types/node"];
  assert.ok(types, "@types/node が無い");
  const major = types.replace(/^[\^~]/, "").split(".")[0];
  assert.equal(major, "24", `@types/node=${types} が engines.node=24.x と食い違う`);
});
