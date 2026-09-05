/**
 * 出力。**実行のたびに新しいタイムスタンプ付きディレクトリへ書き、過去を上書きしない**（厳守2）。
 * 「良い結果が出るまで回し直す」を規律ではなく**書き込み経路**で塞ぐ。
 *
 * 出す4ファイル:
 *   - `trials.jsonl`  生ログ。1行1試行（プロンプト全文・生応答・判定・理由・所要時間）
 *   - `run.json`      メタ（モデル・temperature・課題文・事前登録の参照・フィクスチャの未確定）
 *   - `summary.json`  **生ログから導いた**集計。`verifyRunDir` が毎回数え直して一致を確かめる
 *   - `summary.md`    人が読む表
 *
 * §16 は「生ログを `docs/ethonline-2026/ab/` に置く」と書いているが、**この作業は `docs/` を触らない**
 * 取り決めなので `results/` に出す。移すのは依頼元（README に明記）。
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { aggregate } from "./aggregate.mjs";
import { assertNoSecrets } from "./secrets.mjs";

/** `2026-09-05T10:15:30Z` → `2026-09-05T101530Z`（ファイル名に使える形） */
export function runDirName(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "");
}

function pct(x) {
  return `${(x * 100).toFixed(0)}%`;
}

/** 集計の突合に使う平坦なキー空間。ここに出ないフィールドは検算されない。 */
function flattenForCompare(agg) {
  const out = {};
  for (const [c, t] of Object.entries(agg.perCondition)) {
    for (const [k, v] of Object.entries(t)) out[`perCondition.${c}.${k}`] = v;
  }
  for (const [c, byFixture] of Object.entries(agg.perConditionFixture)) {
    for (const [f, t] of Object.entries(byFixture)) {
      for (const [k, v] of Object.entries(t)) out[`perConditionFixture.${c}.${f}.${k}`] = v;
    }
  }
  for (const [k, v] of Object.entries(agg.overall)) out[`overall.${k}`] = v;
  for (const [k, v] of Object.entries(agg.delta)) out[`delta.${k}`] = v;
  return out;
}

export function renderSummaryMarkdown(run, agg) {
  const L = [];
  L.push(`# A/B run — ${run.meta.startedAt}`);
  L.push("");
  if (run.meta.isMock === true) {
    L.push("> **MOCK RUN — this is not a measurement of any model.**");
    L.push("> The agent was a scripted stub used to exercise the harness. No LLM was called.");
    L.push("");
  }
  const readiness = run.meta.fixtureReadiness;
  if (readiness && readiness.liveReady === false) {
    L.push("> **PROVISIONAL / 暫定** — some fixture oracles are not first-hand measurements yet.");
    for (const b of readiness.blockers) L.push(`> - ${b}`);
    L.push("");
  }
  if (run.meta.singleModel === false) L.push(`> **模型が試行間で変わった**: ${run.meta.modelsSeen.join(", ")}`);
  if (run.meta.singleTemperature === false) L.push(`> **temperature が試行間で変わった**: ${run.meta.temperaturesSeen.join(", ")}`);
  L.push("");
  L.push(`- pre-registration: \`${run.meta.preRegistration}\``);
  L.push(`- model: \`${run.meta.model ?? "(mixed)"}\` · temperature: \`${run.meta.temperature ?? "(mixed)"}\``);
  L.push(`- trials: ${run.meta.totalTrials} (${run.meta.trialsPerCondition} per condition)`);
  L.push("");
  L.push("## Success = verdict matches AND reason codes are a subset (WINDOW_PLAN §16)");
  L.push("");
  L.push("| condition | trials | success | successRate | verdictMatch | reasonSubset | fabricated | errors | unparseable |");
  L.push("|---|---|---|---|---|---|---|---|---|");
  for (const c of run.meta.conditions) {
    const t = agg.perCondition[c];
    L.push(
      `| ${c} | ${t.trials} | ${t.success} | ${pct(t.successRate)} | ${t.verdictMatch} | ${t.reasonSubset} | ` +
        `${t.fabricatedReasonTrials} | ${t.errors} | ${t.unparseable} |`,
    );
  }
  L.push("");
  L.push(`**delta (${agg.delta.of})**: success ${agg.delta.success >= 0 ? "+" : ""}${agg.delta.success} · ` +
    `successRate ${agg.delta.successRate >= 0 ? "+" : ""}${(agg.delta.successRate * 100).toFixed(0)}pt`);
  L.push("");
  L.push("## Per fixture");
  L.push("");
  const ids = [...new Set(run.trials.map((t) => t.fixtureId))];
  L.push(`| condition | ${ids.join(" | ")} |`);
  L.push(`|---|${ids.map(() => "---").join("|")}|`);
  for (const c of run.meta.conditions) {
    const cells = ids.map((id) => {
      const t = agg.perConditionFixture[c]?.[id];
      return t ? `${t.success}/${t.trials}` : "–";
    });
    L.push(`| ${c} | ${cells.join(" | ")} |`);
  }
  L.push("");
  L.push("Counts are recomputed from `trials.jsonl` on every read (`verifyRunDir`). ");
  L.push("Non-scoring note: successes whose reason_codes were empty — " +
    run.meta.conditions.map((c) => `${c}: ${agg.perCondition[c].successWithEmptyReasonCodes}`).join(", ") + ".");
  L.push("");
  return L.join("\n");
}

/**
 * @param {{meta: object, trials: object[]}} run
 * @returns {Promise<string>} 書いたディレクトリ
 */
export async function writeRun(run, { baseDir, now = () => new Date(), env = process.env } = {}) {
  // **書く前に秘密を検める。** 1つでも見つかったらファイルを作らない。
  assertNoSecrets(run, env);

  const agg = aggregate(run);
  const dir = join(baseDir, runDirName(now()));
  // `recursive: false` なので、既にあれば EEXIST で落ちる＝過去の結果を上書きできない。
  await mkdir(baseDir, { recursive: true });
  try {
    await mkdir(dir);
  } catch (e) {
    if (e?.code === "EEXIST") {
      throw new Error(`run directory already exists: ${dir} — runs are never overwritten. Wait a second and re-run.`);
    }
    throw e;
  }

  await writeFile(join(dir, "trials.jsonl"), run.trials.map((t) => JSON.stringify(t)).join("\n") + "\n");
  await writeFile(join(dir, "run.json"), JSON.stringify({ meta: run.meta }, null, 2) + "\n");
  await writeFile(join(dir, "summary.json"), JSON.stringify(agg, null, 2) + "\n");
  await writeFile(join(dir, "summary.md"), renderSummaryMarkdown(run, agg));
  return dir;
}

/**
 * 保存済みの集計を**信用せず、生ログから数え直して**突き合わせる。
 * 集計値と生ログが食い違ったら、それが分かる唯一の場所がここ。
 */
export async function verifyRunDir(dir) {
  const meta = JSON.parse(await readFile(join(dir, "run.json"), "utf8")).meta;
  const trials = (await readFile(join(dir, "trials.jsonl"), "utf8"))
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
  const stored = JSON.parse(await readFile(join(dir, "summary.json"), "utf8"));

  let recomputed;
  try {
    recomputed = aggregate({ meta, trials });
  } catch (e) {
    return { ok: false, mismatches: [`raw log cannot be aggregated: ${e.message}`] };
  }

  const a = flattenForCompare(stored);
  const b = flattenForCompare(recomputed);
  const mismatches = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[key] !== b[key]) mismatches.push(`${key}: summary.json=${a[key]} rawlog=${b[key]}`);
  }
  return { ok: mismatches.length === 0, mismatches };
}
