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
  // 日付だけでも、時刻つきでも可。**より精密な方を禁じない**（出所は細かいほどよい）。
  assert.match(recipe.source.copiedAt, /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/);
  assert.ok(recipe.source.copiedFrom.length > 0);
  assert.equal(recipe.source.state, "draft");
});

test("Recipe が呼ぶツールは vet402 gateway の3本", () => {
  assert.deepEqual(
    recipe.tools.map((t) => t.name),
    ["getResourceDecision", "getPayeeScore", "getObservatoryEndpointPurchases"],
  );
});

test("notRetrieved と値の対応が**両方向**で正しい（作り話も、黙った空欄も置かない）", () => {
  // 2026-09-06: 元の検査は `notRetrieved.length > 0` を要求していた。それは
  // **写しが未完成であるという状態**であって規則ではない。実物を写して埋めたら赤くなった。
  // 守るべき規則は「未取得と書いてあるものは null」かつ「null なら未取得と書いてある」。
  for (const field of recipe.notRetrieved) {
    assert.ok(RECIPE_FIELDS.includes(field), `${field} は Recipe の項目ではない`);
    assert.equal(recipe[field], null, `${field} は未取得なのに値が入っている`);
  }
  for (const field of RECIPE_FIELDS) {
    const empty = recipe[field] === null || recipe[field] === undefined;
    assert.equal(empty, recipe.notRetrieved.includes(field),
      `${field}: 値の有無と notRetrieved が食い違っている`);
  }
});

test("notRetrieved に載っていない項目が null なら投げる（黙って空にできない）", () => {
  assert.throws(() => assertRecipeShape({ ...recipe, name: null }), /name/);
});

test("notRetrieved に載っているのに値が入っていたら投げる（写していない物を書いたことになる）", () => {
  // 写しが完成していても規則は検査できる——任意の項目を「未取得」と宣言したうえで値を残す。
  const field = RECIPE_FIELDS.find((f) => f !== "slug" && f !== "name") ?? RECIPE_FIELDS[0];
  assert.throws(
    () => assertRecipeShape({ ...recipe, notRetrieved: [field], [field]: "でっちあげ" }),
    new RegExp(field),
  );
});

test("renderRecipe は 'null' という語を出さず、未取得があるときだけ未取得と書く（両方向）", () => {
  const text = renderRecipe(recipe);
  assert.equal(text.includes("null"), false);
  // 未取得が無いなら「未取得」の見出しを出さない（無い問題を書き続けない）。
  assert.equal(text.includes(NOT_RETRIEVED), recipe.notRetrieved.length > 0);
  for (const field of recipe.notRetrieved) assert.ok(text.includes(field), field);

  // 逆向き: 1項目を未取得へ戻せば、そのことが本文に出る。
  const field = RECIPE_FIELDS.find((f) => f !== "slug" && f !== "name") ?? RECIPE_FIELDS[0];
  const partial = renderRecipe({ ...recipe, notRetrieved: [field], [field]: null });
  assert.ok(partial.includes(NOT_RETRIEVED), "未取得があるのに明記していない");
  assert.ok(partial.includes(field), field);
  assert.equal(partial.includes("null"), false, "未取得でも 'null' という語は出さない");
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
