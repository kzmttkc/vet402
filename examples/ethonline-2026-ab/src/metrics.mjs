#!/usr/bin/env node
/**
 * 提出物に載る**すべての数字**を、この 1 本が results dir から印字する。
 *
 *   npm run metrics -- <results dir>          # Markdown
 *   npm run metrics -- <results dir> --json   # JSON（同じ数字）
 *
 * なぜあるか: 2026-09-07 に語彙率を手で数えて 6%/31% と過小評価した（oracle が返す階層コードを
 * 集合から落としていた）。数字を手で書く経路を無くし、文書はこのコマンドの出力を引用する。
 *
 * 信じないもの:
 *   - `summary.json` — 読まない。採点値は `trials.jsonl` の答えと正解から、事前登録の規則
 *     （`grade.mjs`）で **grade し直して** 数える。保存済みの `grade.*` と食い違えば件数を出す。
 *   - 語彙のハードコード — 語彙集合はリポの `vocabulary.ts` と `pay-or-refuse.ts` から読む。
 *     この場所に語を書き足せる形にしない。
 */
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { grade } from "./grade.mjs";
import { aggregate } from "./aggregate.mjs";
import { CONDITIONS } from "./harness.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..", "..");
export const DEFAULT_VOCABULARY_PATH = join(REPO_ROOT, "src", "lib", "observatory", "vocabulary.ts");
export const DEFAULT_SDK_PATH = join(REPO_ROOT, "packages", "sdk", "src", "pay-or-refuse.ts");

/** 採点と同じ正規化（`grade.mjs` の normCodes）。語彙率も同じ目で数える。 */
function norm(code) {
  return typeof code === "string" ? code.trim().toLowerCase() : null;
}

/**
 * 語彙集合 (i) をリポのファイルから読む。
 *   - `vocabulary.ts`: `term: "..."` の全部
 *   - `pay-or-refuse.ts`: `export type PayRefuseReason = | "..." | "...";` の文字列リテラルだけ
 *     （同じファイルの他の型 — `PayEvidenceSource` など — は理由コードではないので拾わない）
 */
export async function loadVocabulary({ vocabularyPath = DEFAULT_VOCABULARY_PATH, sdkPath = DEFAULT_SDK_PATH } = {}) {
  const vocabularySrc = await readFile(vocabularyPath, "utf8");
  const sdkSrc = await readFile(sdkPath, "utf8");

  const fromVocabulary = [...vocabularySrc.matchAll(/term:\s*"([^"]+)"/g)].map((m) => m[1]);

  const start = sdkSrc.indexOf("export type PayRefuseReason =");
  if (start === -1) throw new Error(`loadVocabulary: "export type PayRefuseReason =" not found in ${sdkPath}`);
  const end = sdkSrc.indexOf(";", start);
  const union = sdkSrc.slice(start, end === -1 ? undefined : end);
  const fromSdk = [...union.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

  if (fromVocabulary.length === 0) throw new Error(`loadVocabulary: no term: "..." entries in ${vocabularyPath}`);
  if (fromSdk.length === 0) throw new Error(`loadVocabulary: PayRefuseReason has no string literals in ${sdkPath}`);

  const terms = new Set([...fromVocabulary, ...fromSdk].map(norm));
  return {
    terms,
    sources: [
      { path: vocabularyPath, terms: fromVocabulary.length },
      { path: sdkPath, terms: fromSdk.length },
    ],
  };
}

/** results dir を読む。無ければ投げる（CLI は 1 行で exit 1 にする）。 */
export async function readResultsDir(dir) {
  const abs = resolve(dir);
  try {
    const s = await stat(abs);
    if (!s.isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`results dir not found: ${abs}`);
  }
  const meta = JSON.parse(await readFile(join(abs, "run.json"), "utf8")).meta;
  const trials = (await readFile(join(abs, "trials.jsonl"), "utf8"))
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
  return { dir: abs, meta, trials };
}

function sameGrade(a, b) {
  if (!a || typeof a !== "object") return false;
  return (
    a.success === b.success &&
    a.verdictMatch === b.verdictMatch &&
    a.reasonSubset === b.reasonSubset &&
    JSON.stringify([...(a.fabricatedReasonCodes ?? [])].sort()) === JSON.stringify([...b.fabricatedReasonCodes].sort())
  );
}

/** 採点値: trials の答えと正解から grade し直し、aggregate で数える。summary.json は読まない。 */
function scoring(meta, trials) {
  let storedGradeDrift = 0;
  const regraded = trials.map((t) => {
    const g = grade(t.answer, t.oracle);
    if (!sameGrade(t.grade, g)) storedGradeDrift += 1;
    return { ...t, grade: g };
  });
  // 採点値の集計は生ログ（trials）だけから。
  const agg = aggregate({ meta, trials: regraded });
  return {
    rule: "WINDOW_PLAN §16 as amended 2026-09-05 10:55 — verdictMatch ∧ reasonSubset ∧ (non-empty when refuse); regraded from answer+oracle",
    storedGradeDrift,
    overall: agg.overall,
    perCondition: agg.perCondition,
    perConditionFixture: agg.perConditionFixture,
    delta: agg.delta,
  };
}

/** 事後の探索指標（採点に使わない・事前登録に無い）: 語彙率 2 種。 */
function vocabularyMetric(trials, vocabulary) {
  const oracleCodes = new Set(trials.flatMap((t) => (t.oracle?.reasonCodes ?? []).map(norm)));
  const repoOnly = new Set(vocabulary.terms);
  const repoPlusOracle = new Set([...repoOnly, ...oracleCodes]);
  const perCondition = {};
  for (const c of CONDITIONS) {
    const ofC = trials.filter((t) => t.condition === c);
    const codes = ofC.flatMap((t) => (Array.isArray(t.answer?.reasonCodes) ? t.answer.reasonCodes : []).map(norm).filter(Boolean));
    const count = (set) => ({ inSet: codes.filter((r) => set.has(r)).length, codes: codes.length });
    const allIn = (set) =>
      ofC.filter((t) => {
        const cs = (Array.isArray(t.answer?.reasonCodes) ? t.answer.reasonCodes : []).map(norm).filter(Boolean);
        return cs.length > 0 && cs.every((r) => set.has(r));
      }).length;
    perCondition[c] = {
      repoOnly: count(repoOnly),
      repoPlusOracle: count(repoPlusOracle),
      trialsAllInRepoOnly: allIn(repoOnly),
      trialsAllInRepoPlusOracle: allIn(repoPlusOracle),
      trials: ofC.length,
    };
  }
  return {
    exploratory: true,
    normalization: "trim + lowercase (same as grade.mjs)",
    sources: vocabulary.sources,
    setSizes: { repoOnly: repoOnly.size, oracleReturned: oracleCodes.size, repoPlusOracle: repoPlusOracle.size },
    oracleReturned: [...oracleCodes].sort(),
    perCondition,
  };
}

/** 橋: ツール呼び出し総数・settled・ユニーク tx・未決済の HTTP ステータス内訳。 */
function bridgeMetric(trials) {
  const calls = trials.flatMap((t) => (Array.isArray(t.raw?.toolCalls) ? t.raw.toolCalls : []));
  const bridges = calls.map((c) => c?.x402Bridge ?? null);
  const settledCalls = bridges.filter((b) => b && b.settled === true);
  const unsettledByStatus = {};
  let noBridge = 0;
  for (const b of bridges) {
    if (b === null) {
      noBridge += 1;
      continue;
    }
    if (b.settled === true) continue;
    const k = String(b.responseStatus ?? "unknown");
    unsettledByStatus[k] = (unsettledByStatus[k] ?? 0) + 1;
  }
  const toolNames = new Set(trials.flatMap((t) => (Array.isArray(t.raw?.toolNames) ? t.raw.toolNames : [])));
  return {
    toolCalls: calls.length,
    settled: settledCalls.length,
    uniqueTx: new Set(settledCalls.map((b) => b.txHash).filter((h) => typeof h === "string" && h.length > 0)).size,
    unsettled: bridges.length - settledCalls.length - noBridge,
    unsettledByStatus,
    callsWithoutBridge: noBridge,
    toolsListed: toolNames.size,
    perCondition: Object.fromEntries(
      CONDITIONS.map((c) => [
        c,
        trials.filter((t) => t.condition === c).reduce((n, t) => n + (Array.isArray(t.raw?.toolCalls) ? t.raw.toolCalls.length : 0), 0),
      ]),
    ),
  };
}

function metaMetric(meta, trials) {
  const efforts = [...new Set(trials.map((t) => t.raw?.effort).filter((e) => e !== undefined && e !== null))];
  return {
    isMock: meta.isMock === true,
    model: meta.model ?? (Array.isArray(meta.modelsSeen) && meta.modelsSeen.length ? `(mixed: ${meta.modelsSeen.join(", ")})` : null),
    effort: efforts,
    temperature: meta.singleTemperature === false ? "(mixed)" : meta.temperature === null || meta.temperature === undefined ? "not sent" : String(meta.temperature),
    mcpUrl: meta.mcpUrl ?? null,
    agentAdapter: meta.agentAdapter ?? null,
    startedAt: meta.startedAt ?? null,
    finishedAt: meta.finishedAt ?? null,
    totalTrials: trials.length,
    preRegistration: meta.preRegistration ?? null,
  };
}

/**
 * @param {{dir?: string, meta: object, trials: object[]}} run
 * @param {{vocabulary: {terms: Set<string>, sources: object[]}}} deps
 */
export function computeMetrics(run, { vocabulary }) {
  if (!vocabulary || !(vocabulary.terms instanceof Set)) throw new Error("computeMetrics: vocabulary is required (loadVocabulary())");
  const { meta, trials } = run;
  return {
    dir: run.dir ?? null,
    meta: metaMetric(meta, trials),
    scoring: scoring(meta, trials),
    exploratory: { vocabulary: vocabularyMetric(trials, vocabulary) },
    bridge: bridgeMetric(trials),
  };
}

function pct(inSet, n) {
  return n === 0 ? "–" : `${((inSet / n) * 100).toFixed(0)}%`;
}

export function renderMarkdown(m) {
  const L = [];
  if (m.meta.isMock) {
    L.push("> **MOCK RUN — not a measurement of any model.** The agent was a scripted stub; no LLM was called.");
  } else {
    L.push(`# A/B metrics — ${m.dir ?? "(in-memory run)"}`);
  }
  L.push("");
  L.push("## Meta");
  L.push("");
  L.push(`- model: \`${m.meta.model ?? "(unknown)"}\` · effort: \`${m.meta.effort.length ? m.meta.effort.join(", ") : "(not recorded)"}\` · temperature: \`${m.meta.temperature}\``);
  L.push(`- mcpUrl: ${m.meta.mcpUrl ? `\`${m.meta.mcpUrl}\`` : "**none — no MCP server in the path**"} · isMock: \`${m.meta.isMock}\` · adapter: \`${m.meta.agentAdapter ?? "(unknown)"}\``);
  L.push(`- trials: ${m.meta.totalTrials} · started ${m.meta.startedAt ?? "?"} · finished ${m.meta.finishedAt ?? "?"}`);
  L.push(`- pre-registration: \`${m.meta.preRegistration ?? "(none)"}\``);
  L.push("");
  L.push("## Scoring (pre-registered rule, regraded from trials.jsonl; summary.json is not read)");
  L.push("");
  L.push(`Rule: ${m.scoring.rule}.`);
  L.push(
    m.scoring.storedGradeDrift === 0
      ? "Stored `grade.*` agrees with the regrade on every trial."
      : `**WARNING: stored \`grade.*\` disagrees with the regrade on ${m.scoring.storedGradeDrift} trial(s).** The numbers below are the regrade.`,
  );
  L.push("");
  L.push("| condition | trials | success | successRate | verdictMatch | reasonSubset | fabricated | errors | unparseable |");
  L.push("|---|---|---|---|---|---|---|---|---|");
  for (const c of CONDITIONS) {
    const t = m.scoring.perCondition[c];
    L.push(
      `| ${c} | ${t.trials} | ${t.success} | ${pct(t.success, t.trials)} | ${t.verdictMatch} | ${t.reasonSubset} | ${t.fabricatedReasonTrials} | ${t.errors} | ${t.unparseable} |`,
    );
  }
  L.push("");
  L.push(`delta (${m.scoring.delta.of}): success ${m.scoring.delta.success >= 0 ? "+" : ""}${m.scoring.delta.success} · verdictMatch ${m.scoring.delta.verdictMatch >= 0 ? "+" : ""}${m.scoring.delta.verdictMatch} · reasonSubset ${m.scoring.delta.reasonSubset >= 0 ? "+" : ""}${m.scoring.delta.reasonSubset}`);
  L.push("");
  const ids = [...new Set(Object.values(m.scoring.perConditionFixture).flatMap((byF) => Object.keys(byF)))];
  L.push("### Per fixture (success/trials)");
  L.push("");
  L.push(`| condition | ${ids.join(" | ")} |`);
  L.push(`|---|${ids.map(() => "---").join("|")}|`);
  for (const c of CONDITIONS) {
    L.push(`| ${c} | ${ids.map((id) => { const t = m.scoring.perConditionFixture[c]?.[id]; return t ? `${t.success}/${t.trials}` : "–"; }).join(" | ")} |`);
  }
  L.push("");
  L.push("Non-scoring: success under the ORIGINAL (pre-amendment) rule — " + CONDITIONS.map((c) => `${c}: ${m.scoring.perCondition[c].successUnderOriginalRule}`).join(", ") + ".");
  L.push("");
  const v = m.exploratory.vocabulary;
  L.push("## Exploratory: vocabulary rate (NOT pre-registered, NOT used for scoring)");
  L.push("");
  L.push(`Share of reason codes the agent gave that are real vet402 identifiers. Normalization: ${v.normalization}.`);
  L.push(`- set (i) repo only = ${v.sources.map((s) => `\`${s.path.replace(REPO_ROOT + "/", "")}\` (${s.terms})`).join(" + ")} → **${v.setSizes.repoOnly} terms**`);
  L.push(`- set (ii) = (i) + codes the oracle returned in this run (${v.setSizes.oracleReturned}: ${v.oracleReturned.map((c) => `\`${c}\``).join(", ")}) → **${v.setSizes.repoPlusOracle} terms**`);
  L.push("");
  L.push("| condition | codes given | in set (i) | in set (ii) | trials all in (i) | trials all in (ii) |");
  L.push("|---|---|---|---|---|---|");
  for (const c of CONDITIONS) {
    const p = v.perCondition[c];
    L.push(
      `| ${c} | ${p.repoOnly.codes} | ${p.repoOnly.inSet}/${p.repoOnly.codes} (${pct(p.repoOnly.inSet, p.repoOnly.codes)}) | ${p.repoPlusOracle.inSet}/${p.repoPlusOracle.codes} (${pct(p.repoPlusOracle.inSet, p.repoPlusOracle.codes)}) | ${p.trialsAllInRepoOnly}/${p.trials} | ${p.trialsAllInRepoPlusOracle}/${p.trials} |`,
    );
  }
  L.push("");
  const b = m.bridge;
  L.push("## Bridge (x402 402 → $0 signed REST re-send)");
  L.push("");
  L.push(`- tool calls: **${b.toolCalls}** (A ${b.perCondition.A ?? 0}, B ${b.perCondition.B ?? 0}) · tools listed by MCP: ${b.toolsListed}`);
  L.push(`- settled (\`x402Bridge.settled\`): **${b.settled}** · unique tx hashes: **${b.uniqueTx}**`);
  const statuses = Object.entries(b.unsettledByStatus).sort();
  L.push(`- unsettled: **${b.unsettled}**${statuses.length ? ` (${statuses.map(([s, n]) => `${n} × HTTP ${s}`).join(", ")})` : ""} · calls without bridge record: ${b.callsWithoutBridge}`);
  L.push("");
  return L.join("\n");
}

export function parseArgs(argv) {
  const out = { dir: null, json: false };
  for (const a of argv) {
    if (a === "--json") out.json = true;
    else if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
    else if (out.dir === null) out.dir = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  if (out.dir === null) throw new Error("usage: metrics.mjs <results dir> [--json]");
  return out;
}

export async function main(argv) {
  const args = parseArgs(argv);
  const run = await readResultsDir(args.dir);
  const vocabulary = await loadVocabulary();
  const m = computeMetrics(run, { vocabulary });
  return args.json ? JSON.stringify(m, null, 2) + "\n" : renderMarkdown(m) + "\n";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(await main(process.argv.slice(2)));
  } catch (e) {
    process.stderr.write(`metrics: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  }
}
