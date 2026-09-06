/**
 * 条件 B が渡すもの＝**bazantic.com で作った Recipe**。
 *
 * 賞ページ原文:
 *   > Create a Recipe that explains when, why, and how to use your service.
 *   > **Make the Recipe the only material difference between the tests.**
 *
 * 2026-09-06 まで、この実装は条件 B に **`SKILL.md` 全文**を入れていた。
 * `SKILL.md` は我々が書いたドキュメントであって Bazantic の Recipe ではないので、
 * **賞の要件（唯一の実質的な違いを Recipe にする）を満たしていなかった**
 * （正典 `docs/ethonline-2026/WINDOW_PLAN.md` §16 は同日に訂正済みで、コードだけが古かった）。
 *
 * **リポに置くのは写しであって原本ではない。** 原本は bazantic.com にある。
 * だから写しは「どこから・いつ写したか」を必ず持ち、**写せていない項目は空のまま持ち歩く**
 * （埋めれば原本と食い違い、その食い違いが誰にも見えなくなる）。
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

/** リポに置いた写し。**原本は bazantic.com。** */
export const RECIPE_FILE = join(HERE, "..", "recipe", "x402-payee-verification.json");

/** Recipe の定義が持つ項目。ここに無い名前は `notRetrieved` に書けない。 */
export const RECIPE_FIELDS = Object.freeze(["name", "description", "prompt", "tools", "inputs"]);

/** 未取得の項目を本文でどう書くか。**`null` とは書かない**（値として読まれる）。 */
export const NOT_RETRIEVED = "(not retrieved from bazantic.com — left blank on purpose, not empty on the original)";

/**
 * 写しの形を検める。**「未取得」と「値がある」を必ず一致させる。**
 * これが無いと、写せていない項目をこっそり埋めても、こっそり空にしても、誰も気づかない。
 */
export function assertRecipeShape(recipe) {
  if (recipe === null || typeof recipe !== "object") throw new Error("recipe is not an object");
  const missing = ["slug", "name", "tools", "notRetrieved", "source"].filter((k) => recipe[k] === undefined);
  if (missing.length > 0) throw new Error(`recipe is missing: ${missing.join(", ")}`);

  const notRetrieved = recipe.notRetrieved;
  if (!Array.isArray(notRetrieved)) throw new Error("recipe.notRetrieved must be an array");
  for (const field of notRetrieved) {
    if (!RECIPE_FIELDS.includes(field)) throw new Error(`recipe.notRetrieved names an unknown field: ${field}`);
    if (recipe[field] !== null) {
      throw new Error(`recipe.${field} is listed as not retrieved but has a value — do not write what you did not copy`);
    }
  }
  for (const field of RECIPE_FIELDS) {
    if (recipe[field] === null && !notRetrieved.includes(field)) {
      throw new Error(`recipe.${field} is null but is not listed in notRetrieved — say so in the open`);
    }
  }
  for (const key of ["platform", "gatewayUrl", "mcpUrl", "copiedAt", "copiedFrom", "state"]) {
    if (typeof recipe.source?.[key] !== "string" || recipe.source[key].length === 0) {
      throw new Error(`recipe.source.${key} is required — a copy without provenance is not a copy`);
    }
  }
  if (!Array.isArray(recipe.tools) || recipe.tools.length === 0) throw new Error("recipe.tools is empty");
  return recipe;
}

/** @returns {Promise<object>} 検めた写し。 */
export async function loadRecipe({ file = RECIPE_FILE } = {}) {
  return assertRecipeShape(JSON.parse(await readFile(file, "utf8")));
}

/**
 * 条件 B のプロンプトに入る本文。**Recipe の定義そのもの**（name / description / prompt / tools / inputs）で、
 * 我々のドキュメントの引き写しではない。**未取得の項目は「未取得」と書く**（作らない）。
 */
export function renderRecipe(recipe) {
  assertRecipeShape(recipe);
  const L = [];
  const field = (label, value) => L.push(`${label}: ${value === null ? NOT_RETRIEVED : value}`);

  L.push(`This is a Recipe published on ${recipe.source.platform} (state: ${recipe.source.state}).`);
  L.push(`Copied into this repository on ${recipe.source.copiedAt}. Source of the copy: ${recipe.source.copiedFrom}`);
  L.push("");
  field("slug", recipe.slug);
  field("name", recipe.name);
  field("description", recipe.description);
  L.push("");
  L.push("prompt:");
  L.push(recipe.prompt === null ? NOT_RETRIEVED : recipe.prompt);
  L.push("");
  L.push(`tools (served by the ${recipe.source.gatewayName ?? recipe.source.platform} MCP server at ${recipe.source.mcpUrl}):`);
  for (const t of recipe.tools) {
    L.push(`  - ${t.name}${t.server ? ` (server: ${t.server})` : ""}`);
  }
  L.push("  Call them over MCP. Their descriptions and input schemas come from the server's own tools/list.");
  L.push("");
  L.push("inputs:");
  L.push(recipe.inputs === null ? NOT_RETRIEVED : JSON.stringify(recipe.inputs, null, 2));
  if (recipe.notRetrieved.length > 0) {
    L.push("");
    L.push(`Fields not retrieved from ${recipe.source.platform} at copy time: ${recipe.notRetrieved.join(", ")}.`);
  }
  return L.join("\n");
}
