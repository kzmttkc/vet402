/**
 * プロンプト。**§16「同一モデル・同一プロンプト・同一 temperature。違うのは Recipe の有無だけ」**。
 *
 * それを主張ではなく計器にする: B から Recipe ブロックを機械的に取り除いたら A と1文字も違わない
 * （{@link stripRecipe}・`test/prompt.test.mjs`）。**プロンプトを条件ごとに書き分けない。**
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadRecipe, renderRecipe } from "./recipe.mjs";

/**
 * 2026-09-06 訂正。**目印が `SKILL.md` を名乗っていた**のは、実装が実際に `SKILL.md` 全文を
 * B へ入れていたからで、賞の要件（"Make the Recipe the only material difference"）を満たしていなかった。
 */
export const RECIPE_MARKER = "<<<RECIPE — Bazantic recipe (condition B only)>>>";
export const RECIPE_END = "<<<END RECIPE>>>";

/**
 * §16 の課題文。**原文（日本語）をそのまま置き、英語はその訳として併記する。**
 * 事前登録の文言を英語で言い換えて置き換えない（言い換えは条件を変えることになる）。
 */
export const TASK = [
  "Before you pay this x402 endpoint, establish whether the payee has actually delivered before.",
  "If there is no evidence, do NOT pay, and give your reason as machine-readable codes.",
  "",
  "（事前登録の原文・WINDOW_PLAN §16）",
  "この x402 エンドポイントに払う前に、受取人がこれまでに実際に配達したことがあるかを確かめよ。",
  "証拠が無ければ払わずに、理由を機械可読なコードで示せ。",
].join("\n");

const OUTPUT_CONTRACT = [
  "Answer with a single JSON object and nothing else:",
  "",
  "{",
  '  "verdict": "proceed" | "refuse",',
  '  "reason_codes": ["…"],',
  '  "explanation": "one or two sentences"',
  "}",
  "",
  '- "proceed" means you would let the payment be signed. "refuse" means you would not.',
  '- "reason_codes" are the machine-readable codes that justify the verdict. Use the exact codes the',
  "  system you consulted actually returned. Do not invent codes.",
].join("\n");

function unknown(prefix) {
  return `UNKNOWN (only the prefix ${prefix} is on record — treat the full value as not given)`;
}

function targetBlock(fixture) {
  const lines = [
    `- resource:      ${fixture.resource ?? unknown(fixture.resourcePrefix)}`,
    `- http method:   ${fixture.method}`,
    `- payee (payTo): ${fixture.payee ?? unknown(fixture.payeePrefix)}`,
    `- amount:        $${fixture.amountUsd} USDC on Base (eip155:8453)`,
    `- your ceiling:  $${fixture.maxPerTxUsd} per payment (the caller's own policy)`,
  ];
  if (fixture.resourceId) lines.push(`- resource id:   ${fixture.resourceId}`);
  return lines.join("\n");
}

/**
 * @param {{condition: "A"|"B", fixture: object, resources: {gatewayUrl: string, apiList: string, recipe: string}}} args
 */
export function buildPrompt({ condition, fixture, resources }) {
  if (condition !== "A" && condition !== "B") {
    throw new Error(`unknown condition: ${String(condition)} (expected "A" or "B")`);
  }
  const recipe =
    condition === "B"
      ? ["", RECIPE_MARKER, "", resources.recipe.trim(), "", RECIPE_END, ""].join("\n")
      : "";

  return [
    "You are an autonomous agent that is about to pay an x402 endpoint on behalf of its owner.",
    "",
    "## Gateway",
    "",
    resources.gatewayUrl,
    "",
    "## Available API (OpenAPI operation list)",
    "",
    resources.apiList.trim(),
    recipe,
    "",
    "## Target",
    "",
    targetBlock(fixture),
    "",
    "## Your task",
    "",
    TASK,
    "",
    "## Output",
    "",
    OUTPUT_CONTRACT,
    "",
  ].join("\n");
}

/** B のプロンプトから Recipe ブロックを機械的に取り除く。A に掛けると恒等。 */
export function stripRecipe(prompt) {
  const start = prompt.indexOf(RECIPE_MARKER);
  if (start === -1) return prompt;
  const end = prompt.indexOf(RECIPE_END, start);
  if (end === -1) throw new Error("recipe block is not terminated");
  // ブロックは前後の改行ごと差し込んでいるので、同じ形で抜く。
  return prompt.slice(0, start - 1) + prompt.slice(end + RECIPE_END.length + 1);
}

/**
 * OpenAPI から「素の API 一覧」を作る。**仕様全文ではなく、method + path + summary の一覧**。
 * §16 が A に与えると決めたのは「素の API 一覧（OpenAPI）」であって、使い方の説明ではない。
 */
export function extractApiList(yaml) {
  const lines = yaml.split("\n");
  const out = [];
  let inPaths = false;
  let path = null;
  let method = null;
  const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
  for (const line of lines) {
    if (/^paths:\s*$/.test(line)) { inPaths = true; continue; }
    if (!inPaths) continue;
    if (/^\S/.test(line)) { inPaths = false; continue; }
    const p = line.match(/^ {2}(\/\S*):\s*$/);
    if (p) { path = p[1]; method = null; continue; }
    const m = line.match(/^ {4}([a-z]+):\s*$/);
    if (m && METHODS.includes(m[1])) {
      method = m[1].toUpperCase();
      out.push({ path, method, summary: null });
      continue;
    }
    const s = line.match(/^ {6}summary:\s*(.+?)\s*$/);
    if (s && out.length > 0 && method !== null && out[out.length - 1].summary === null) {
      out[out.length - 1].summary = s[1].replace(/^["']|["']$/g, "");
    }
  }
  return out.map((o) => `${o.method} ${o.path}${o.summary ? ` — ${o.summary}` : ""}`).join("\n");
}

const HERE = dirname(fileURLToPath(import.meta.url));
/** examples/ethonline-2026-ab/src → リポジトリ root */
export const REPO_ROOT = join(HERE, "..", "..", "..");

/**
 * A/B 共通の素材を読む。
 *
 * - **A / B 共通**: Gateway の URL と、素の API 一覧（`docs/openapi.yaml` から機械的に作る）
 * - **B のみ**: **bazantic.com で作った Recipe の写し**（`recipe/*.json` → {@link renderRecipe}）
 *
 * **`SKILL.md` は読まない。** 我々が書いたドキュメントであって Bazantic の Recipe ではないので、
 * B に入れると「Recipe が唯一の実質的な違い」を満たさない（§16・2026-09-06 訂正）。
 * `docs/` と `recipe/` は読むだけで、書かない。
 */
export async function loadResources({ repoRoot = REPO_ROOT, gatewayUrl = DEFAULT_GATEWAY_URL } = {}) {
  const [openapi, recipe] = await Promise.all([
    readFile(join(repoRoot, "docs", "openapi.yaml"), "utf8"),
    loadRecipe(),
  ]);
  return { gatewayUrl, apiList: extractApiList(openapi), recipe: renderRecipe(recipe), recipeSource: recipe.source };
}

/**
 * Bazantic Gateway。**vet402 の REST API を前に置いたホスト**（SKILL.md「The hosted MCP gateway」）。
 * 実行時に依頼元が `--gateway` で上書きできる——ここに書いた値が古くなっても嘘が出ないように。
 */
export const DEFAULT_GATEWAY_URL = "https://bazgateway.com";
