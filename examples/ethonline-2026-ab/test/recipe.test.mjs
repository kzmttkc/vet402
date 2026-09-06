// 条件 B が渡すものは **bazantic.com で作った Recipe**（WINDOW_PLAN §16・2026-09-06 訂正）。
// 賞ページ原文: "Make the Recipe the only material difference between the tests."
//
// **リポに置くのは写しであって、原本ではない。** だから写しは「どこから・いつ写したか」を必ず持ち、
// **写せていない項目を空のまま持ち歩く**（埋めると原本と食い違い、それが誰にも見えなくなる）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  RECIPE_FILE,
  loadRecipe,
  assertRecipeShape,
  renderRecipe,
  NOT_RETRIEVED,
  RECIPE_FIELDS,
} from "../src/recipe.mjs";

const recipe = await loadRecipe();

test("写しは bazantic.com の実在の Recipe を名指しする（slug と name は確定値）", () => {
  assert.equal(recipe.slug, "x402-payee-verification-via-vet402-gateway");
  assert.equal(recipe.name, "X402 Payee Verification via vet402 Gateway");
});

test("写しは Bazantic Gateway と MCP の口を持つ（A/B のツールはここから引く）", () => {
  assert.equal(recipe.source.gatewayUrl, "https://2vjhqfgvw5dt5lja2zpjsjwrem.bazgateway.com");
  assert.equal(recipe.source.mcpUrl, "https://2vjhqfgvw5dt5lja2zpjsjwrem.bazgateway.com/mcp");
  assert.equal(recipe.source.platform, "bazantic.com");
});

test("写しは『いつ・どこから写したか』を持つ（出所の無い写しを置かない）", () => {
  assert.match(recipe.source.copiedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(recipe.source.copiedFrom.length > 0);
  assert.equal(recipe.source.state, "draft");
});

test("Recipe が呼ぶツールは vet402 gateway の3本", () => {
  assert.deepEqual(
    recipe.tools.map((t) => t.name),
    ["getResourceDecision", "getPayeeScore", "getObservatoryEndpointPurchases"],
  );
});

test("写せていない項目は notRetrieved に並び、値は null（作り話を置かない）", () => {
  assert.ok(recipe.notRetrieved.length > 0);
  for (const field of recipe.notRetrieved) {
    assert.ok(RECIPE_FIELDS.includes(field), `${field} は Recipe の項目ではない`);
    assert.equal(recipe[field], null, `${field} は未取得なのに値が入っている`);
  }
});

test("notRetrieved に載っていない項目が null なら投げる（黙って空にできない）", () => {
  assert.throws(() => assertRecipeShape({ ...recipe, name: null }), /name/);
});

test("notRetrieved に載っているのに値が入っていたら投げる（写していない物を書いたことになる）", () => {
  const field = recipe.notRetrieved[0];
  assert.throws(() => assertRecipeShape({ ...recipe, [field]: "でっちあげ" }), new RegExp(field));
});

test("renderRecipe は未取得を明記し、'null' という語を出さない", () => {
  const text = renderRecipe(recipe);
  assert.equal(text.includes("null"), false);
  assert.ok(text.includes(NOT_RETRIEVED));
  for (const field of recipe.notRetrieved) assert.ok(text.includes(field), field);
});

test("renderRecipe に slug・name・3ツール・MCP の口が出る", () => {
  const text = renderRecipe(recipe);
  assert.ok(text.includes(recipe.slug));
  assert.ok(text.includes(recipe.name));
  assert.ok(text.includes(recipe.source.mcpUrl));
  for (const t of recipe.tools) assert.ok(text.includes(t.name), t.name);
});

test("renderRecipe は写しであることと出所を本文に残す（審査員が原本と突き合わせられる）", () => {
  const text = renderRecipe(recipe);
  assert.ok(text.includes("bazantic.com"));
  assert.ok(text.includes(recipe.source.copiedAt));
});

test("RECIPE_FILE は実在し、読んだ JSON が loadRecipe と一致する", async () => {
  const onDisk = JSON.parse(await readFile(RECIPE_FILE, "utf8"));
  assert.deepEqual(onDisk, recipe);
});

test("SKILL.md は Recipe ではない（写しに SKILL.md 由来の本文を入れない）", () => {
  const text = renderRecipe(recipe);
  assert.equal(/SKILL\.md/.test(text), false);
});
