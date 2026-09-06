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
  PUBLICATION_STATES,
  publicRecipeUrl,
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
});

// 2026-09-07: ここは `state === "draft"` を固定していた。写した日の状態であって規則ではなく、
// Recipe を公開したら赤くなった（**改善で赤くなるテストは状態固定**）。規則は
// 「公開なら誰でも開ける URL と公開日時を持つ／下書きならどちらも持たない」の両方向。
test("公開状態と証拠の対応が両方向で正しい（公開なら URL と日時、下書きならどちらも無い）", () => {
  assert.ok(PUBLICATION_STATES.includes(recipe.source.state), recipe.source.state);
  if (recipe.source.state === "published") {
    assert.equal(recipe.source.publicUrl, publicRecipeUrl(recipe));
    assert.match(recipe.source.publicUrl, /^https:\/\/bazantic\.com\/recipes\/[a-z0-9-]+$/);
    assert.match(recipe.source.publishedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    assert.equal(Number.isNaN(Date.parse(recipe.source.publishedAt)), false, "publishedAt は日時として読める");
    // 公開は read-only 化で、写した日より前には起こらない。
    assert.ok(Date.parse(recipe.source.publishedAt) >= Date.parse(recipe.source.copiedAt), "公開日時が写した日時より前");
  } else {
    assert.equal(recipe.source.publicUrl, undefined);
    assert.equal(recipe.source.publishedAt, undefined);
  }
});

test("published なのに公開 URL か公開日時が無ければ投げる（公開したと言うなら開ける場所を示す）", () => {
  const published = { ...recipe, source: { ...recipe.source, state: "published", publishedAt: "2026-09-07T06:15+09:00", publicUrl: publicRecipeUrl(recipe) } };
  assert.doesNotThrow(() => assertRecipeShape(published));
  const { publicUrl: _u, ...noUrl } = published.source;
  assert.throws(() => assertRecipeShape({ ...recipe, source: noUrl }), /publicUrl/);
  const { publishedAt: _t, ...noDate } = published.source;
  assert.throws(() => assertRecipeShape({ ...recipe, source: noDate }), /publishedAt/);
  // slug と食い違う URL は「この Recipe の」公開ページではない。
  assert.throws(
    () => assertRecipeShape({ ...recipe, source: { ...published.source, publicUrl: "https://bazantic.com/recipes/some-other-recipe" } }),
    /publicUrl/,
  );
  assert.throws(
    () => assertRecipeShape({ ...recipe, source: { ...published.source, publishedAt: "2026-09-07" } }),
    /publishedAt/,
  );
});

test("draft なのに公開 URL か公開日時があれば投げる（まだ無いものを書かない）", () => {
  const { publicUrl: _u, publishedAt: _t, ...bare } = recipe.source;
  const draft = { ...recipe, source: { ...bare, state: "draft" } };
  assert.doesNotThrow(() => assertRecipeShape(draft));
  assert.throws(() => assertRecipeShape({ ...recipe, source: { ...bare, state: "draft", publicUrl: publicRecipeUrl(recipe) } }), /publicUrl/);
  assert.throws(() => assertRecipeShape({ ...recipe, source: { ...bare, state: "draft", publishedAt: "2026-09-07T06:15+09:00" } }), /publishedAt/);
  assert.throws(() => assertRecipeShape({ ...recipe, source: { ...bare, state: "archived" } }), /state/);
});

test("renderRecipe は公開なら公開 URL を本文に出し、下書きなら出さない（審査員が開いて突き合わせられる）", () => {
  const { publicUrl: _u, publishedAt: _t, ...bare } = recipe.source;
  const draft = renderRecipe({ ...recipe, source: { ...bare, state: "draft" } });
  assert.equal(draft.includes("/recipes/"), false);
  const published = renderRecipe({ ...recipe, source: { ...bare, state: "published", publishedAt: "2026-09-07T06:15+09:00", publicUrl: publicRecipeUrl(recipe) } });
  assert.ok(published.includes(publicRecipeUrl(recipe)));
  assert.ok(published.includes("2026-09-07T06:15+09:00"));
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
