// §16「同一モデル・同一プロンプト・同一 temperature。違うのは Recipe の有無だけ」
import test from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, TASK, RECIPE_MARKER, stripRecipe, extractApiList, loadResources } from "../src/prompt.mjs";
import { FIXTURES } from "../src/fixtures.mjs";
import { loadRecipe, renderRecipe } from "../src/recipe.mjs";

const resources = {
  gatewayUrl: "https://bazgateway.com/example",
  apiList: "GET /api/v1/x — summary\nGET /api/v1/y — summary",
  recipe: "Recipe: x402-payee-verification-via-vet402-gateway\nrecipe body\n",
};
const f = FIXTURES[0];

test("A と B の差は Recipe ブロックだけ（それ以外は1文字も違わない）", () => {
  const a = buildPrompt({ condition: "A", fixture: f, resources });
  const b = buildPrompt({ condition: "B", fixture: f, resources });
  assert.notEqual(a, b);
  assert.ok(b.includes(RECIPE_MARKER), "B に Recipe ブロックが無い");
  // Recipe ブロックを取り除いたら A と1文字も違わない。これが「同一プロンプト」の定義。
  assert.equal(stripRecipe(b), a);
  assert.equal(stripRecipe(a), a);
});

test("A に Recipe は1文字も入らない", () => {
  const a = buildPrompt({ condition: "A", fixture: f, resources });
  assert.equal(a.includes(RECIPE_MARKER), false);
  assert.equal(a.includes("recipe body"), false);
});

test("B に入るのは Bazantic の Recipe（SKILL.md ではない）", () => {
  const b = buildPrompt({ condition: "B", fixture: f, resources });
  assert.ok(b.includes("recipe body"));
  // 賞ページ: "Make the Recipe the only material difference between the tests."
  assert.match(RECIPE_MARKER, /bazantic/i);
  assert.equal(/SKILL\.md/.test(RECIPE_MARKER), false, "目印がまだ SKILL.md を名乗っている");
});

test("条件 B の材料は Recipe の写しであって、リポの SKILL.md ではない", async () => {
  const res = await loadResources();
  assert.equal(res.skillMd, undefined, "loadResources がまだ SKILL.md を配っている");
  assert.equal(res.recipe, renderRecipe(await loadRecipe()));
  // SKILL.md は我々のドキュメントであって Bazantic の Recipe ではない。
  const b = buildPrompt({ condition: "B", fixture: f, resources: res });
  assert.equal(b.includes("The hosted MCP gateway"), false, "SKILL.md 本文が B に入っている");
  assert.ok(b.includes("x402-payee-verification-via-vet402-gateway"));
});

test("課題文は §16 の原文（A/B 共通）", () => {
  assert.match(TASK, /before you pay/i);
  for (const c of ["A", "B"]) {
    assert.ok(buildPrompt({ condition: c, fixture: f, resources }).includes(TASK));
  }
});

test("両条件に Gateway の URL と素の API 一覧が入る", () => {
  for (const c of ["A", "B"]) {
    const p = buildPrompt({ condition: c, fixture: f, resources });
    assert.ok(p.includes(resources.gatewayUrl));
    assert.ok(p.includes("GET /api/v1/x — summary"));
  }
});

test("フィクスチャ固有の値（対象・金額・上限）が入る", () => {
  const p = buildPrompt({ condition: "A", fixture: f, resources });
  assert.ok(p.includes(f.resource));
  assert.ok(p.includes(String(f.amountUsd)));
  assert.ok(p.includes(String(f.maxPerTxUsd)));
});

test("出力の契約（verdict と reason_codes の JSON）をプロンプトに明記する", () => {
  const p = buildPrompt({ condition: "A", fixture: f, resources });
  assert.ok(p.includes('"verdict"'));
  assert.ok(p.includes('"reason_codes"'));
  assert.ok(p.includes("proceed"));
  assert.ok(p.includes("refuse"));
});

test("値が未確定（null）のフィクスチャでも、嘘の値を入れず『不明』と書く", () => {
  const f3 = FIXTURES.find((x) => x.id === "F3");
  const p = buildPrompt({ condition: "A", fixture: f3, resources });
  assert.equal(p.includes("null"), false);
  assert.ok(p.includes("0xb15a55e8"));
});

test("未知の condition は投げる（黙って A に落とさない）", () => {
  assert.throws(() => buildPrompt({ condition: "C", fixture: f, resources }), /condition/);
});

test("extractApiList は OpenAPI から method+path+summary の一覧を作る", () => {
  const yaml = [
    "paths:",
    "  /api/v1/a:",
    "    get:",
    "      summary: Alpha thing",
    "    post:",
    "      summary: Beta thing",
    "  /api/v1/b:",
    "    get:",
    "      summary: Gamma thing",
  ].join("\n");
  const list = extractApiList(yaml);
  assert.deepEqual(list.split("\n"), [
    "GET /api/v1/a — Alpha thing",
    "POST /api/v1/a — Beta thing",
    "GET /api/v1/b — Gamma thing",
  ]);
});
