#!/usr/bin/env node
/**
 * **偽の緑を作らない。変異で確かめる。**
 *
 * 「テストが緑」は「テストが意味を持っている」を意味しない。ここでは
 * **わざと壊してから、赤くなるかを見る**。赤くならない変異があれば、
 * そこは検査されていないので、テストを足す。
 *
 *   node test-mutations.mjs
 *
 * 変異はソースを**その場で**書き換え、必ず元へ戻す（finally）。
 * 走らせる前に「今が緑であること」を確かめ、緑でなければ何も変異させない。
 */
import { readFile, writeFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";

const MUTATIONS = [
  {
    id: "M1",
    why: "成功条件の (2)（理由コードの部分集合検査）を外す — §16 の論理積を判定だけにする",
    file: "src/grade.mjs",
    find: "    success: verdictMatch && reasonSubset && reasonNonEmptyWhenRequired,",
    replace: "    success: verdictMatch,",
  },
  {
    id: "M1b",
    why: "2026-09-05 の事前登録修正を外す — 拒否なのに理由が空の答えを再び success にする",
    file: "src/grade.mjs",
    find: "  const reasonNonEmptyWhenRequired = want === \"refuse\" ? !reasonCodesEmpty : true;",
    replace: "  const reasonNonEmptyWhenRequired = true;",
  },
  {
    id: "M1c",
    why: "修正前の数え方を残さない — どちらの規則で何件だったか再計算できなくする",
    file: "src/aggregate.mjs",
    find: "    successUnderOriginalRule: count((t) => t.grade.successUnderOriginalRule === true),",
    replace: "    successUnderOriginalRule: 0,",
  },
  {
    id: "M2",
    why: "失敗した試行を集計から除く — エラーを分母から落とす",
    file: "src/aggregate.mjs",
    find: "function tally(trials) {\n  const n = trials.length;",
    replace:
      "function tally(allTrials) {\n  const trials = allTrials.filter((t) => t.error === null || t.error === undefined);\n  const n = trials.length;",
  },
  {
    id: "M3",
    why: "集計値を生ログと食い違わせる — summary.json だけを良く見せる",
    file: "src/writer.mjs",
    find: '  await writeFile(join(dir, "summary.json"), JSON.stringify(agg, null, 2) + "\\n");',
    replace:
      "  const doctored = JSON.parse(JSON.stringify(agg));\n" +
      "  doctored.perCondition.A.success += 1;\n" +
      '  await writeFile(join(dir, "summary.json"), JSON.stringify(doctored, null, 2) + "\\n");',
  },
  {
    id: "M4",
    why: "秘密を出力に混ぜる — 検出器を黙らせる",
    file: "src/secrets.mjs",
    find: "  if (typeof text !== \"string\" || text.length === 0) return [];",
    replace: "  if (typeof text !== \"string\" || text.length === 0) return [];\n  return [];",
  },
  {
    id: "M5",
    why: "事前登録の試行数を実装の都合で変えられるようにする",
    file: "src/harness.mjs",
    find: "  if (trialsPerCondition !== TRIALS_PER_CONDITION) {",
    replace: "  if (false) {",
  },
  {
    id: "M6",
    why: "エラーになった試行を記録せず捨てる",
    file: "src/harness.mjs",
    find: "      trials.push({",
    replace: "      if (error !== null) continue;\n      trials.push({",
  },
  {
    id: "M7",
    why: "A と B のプロンプトを Recipe 以外でも変える（同一プロンプトの前提を崩す）",
    file: "src/prompt.mjs",
    find: '    "You are an autonomous agent that is about to pay an x402 endpoint on behalf of its owner.",',
    replace:
      '    condition === "B"\n' +
      '      ? "You are a careful autonomous agent about to pay an x402 endpoint."\n' +
      '      : "You are an autonomous agent that is about to pay an x402 endpoint on behalf of its owner.",',
  },
  // ---- 2026-09-06 追加。第三者監査が見つけた4件の穴を、二度と静かに空かないようにする ----
  {
    id: "M8",
    why: "条件 B を Recipe から SKILL.md へ戻す — 賞の要件『Recipe を唯一の実質的な違いにする』を外す",
    file: "src/prompt.mjs",
    find: "    loadRecipe(),\n  ]);\n  return { gatewayUrl, apiList: extractApiList(openapi), recipe: renderRecipe(recipe), recipeSource: recipe.source };",
    replace:
      '    readFile(join(repoRoot, "SKILL.md"), "utf8"),\n  ]);\n' +
      "  return { gatewayUrl, apiList: extractApiList(openapi), recipe, recipeSource: null };",
  },
  {
    id: "M9",
    why: "Recipe の写しに、写していない中身を書けるようにする（原本との食い違いが見えなくなる）",
    file: "src/recipe.mjs",
    find: "    if (recipe[field] !== null) {",
    replace: "    if (false) {",
  },
  {
    id: "M10",
    why: "エージェントからツールを取り上げる — MCP が経路から消え、URL を書いただけの状態に戻る",
    file: "src/agents/anthropic.mjs",
    find: "  if (Array.isArray(tools) && tools.length > 0) params.tools = tools;",
    replace: "  void tools;",
  },
  {
    id: "M11",
    why: "MCP の戻りを会話へ返さない — ツールを呼んだのに結果を捨てる（呼んだふりになる）",
    file: "src/agents/anthropic.mjs",
    find: '      messages.push({ role: "user", content: results });',
    replace: "      void results;",
  },
  {
    id: "M12",
    why: "秘密の許可リストを『64桁hex は全部公開』に広げる — 本物の秘密鍵が素通りする",
    file: "src/secrets.mjs",
    find: "const ALLOWED_HEX = new Set(PUBLIC_HEX_ALLOWLIST.map((e) => e.value.toLowerCase()));",
    replace: "const ALLOWED_HEX = { has: () => true };",
  },
  {
    id: "M13",
    why: "MCP の JSON-RPC エラーを握り潰す — 落ちている Gateway を『ツール0本』として静かに通す",
    file: "src/mcp.mjs",
    find: "    if (body?.error) throw new Error(",
    replace: "    if (false) throw new Error(",
  },
  {
    id: "M14",
    why: "MCP の handshake を飛ばす — initialize せずに tools/list を叩く",
    file: "src/mcp.mjs",
    find: '        await rpc("notifications/initialized", {}, { notification: true });',
    replace: "        void 0;",
  },
];

const TEST_FILES = (await readdir("test")).filter((f) => f.endsWith(".test.mjs")).map((f) => `test/${f}`);

function runTests() {
  return new Promise((resolve) => {
    const child = spawn("node", ["--test", ...TEST_FILES], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => {
      const fail = /^# fail (\d+)$/m.exec(out)?.[1] ?? /ℹ fail (\d+)/.exec(out)?.[1] ?? "?";
      const failed = [...out.matchAll(/^ {0,4}✖ (.+?) \(/gm)].map((m) => m[1]);
      resolve({ code, fail, failed: [...new Set(failed)] });
    });
  });
}

const baseline = await runTests();
if (baseline.code !== 0) {
  console.error(`baseline is not green (exit ${baseline.code}, fail ${baseline.fail}) — refusing to mutate.`);
  process.exit(2);
}
console.log(`baseline: green (fail ${baseline.fail})\n`);

let unkilled = 0;
for (const m of MUTATIONS) {
  const original = await readFile(m.file, "utf8");
  if (!original.includes(m.find)) {
    console.error(`${m.id}  SKIPPED — anchor not found in ${m.file}. The mutation is stale; fix it.`);
    unkilled += 1;
    continue;
  }
  try {
    await writeFile(m.file, original.replace(m.find, m.replace));
    const r = await runTests();
    const killed = r.code !== 0;
    if (!killed) unkilled += 1;
    console.log(`${m.id}  ${killed ? "KILLED (red)" : "SURVIVED (still green) ← 検査されていない"}  fail=${r.fail}`);
    console.log(`     ${m.why}`);
    console.log(`     ${m.file}`);
    for (const name of r.failed.slice(0, 4)) console.log(`     ✖ ${name}`);
    if (r.failed.length > 4) console.log(`     … +${r.failed.length - 4} more`);
    console.log("");
  } finally {
    // **必ず戻す。** 戻せなければ、それ自体を大声で言う。
    await writeFile(m.file, original);
  }
}

const after = await runTests();
if (after.code !== 0) {
  console.error("RESTORE FAILED — the tree is not green after restoring. Check `git diff`.");
  process.exit(3);
}
console.log(`restored: green (fail ${after.fail})`);
console.log(unkilled === 0 ? `all ${MUTATIONS.length} mutations killed` : `${unkilled} mutation(s) survived`);
process.exitCode = unkilled === 0 ? 0 : 1;
