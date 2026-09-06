// 提出物に載る数字は全部 `npm run metrics -- <results dir>` が印字する。
// 手で数えた数字（2026-09-07 に 6%/31% と過小評価した）を構造で消すための計器なので、
// **summary.json を信じない・語彙集合をハードコードしない** ことをここで固定する。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { grade } from "../src/grade.mjs";
import { computeMetrics, loadVocabulary, readResultsDir, renderMarkdown } from "../src/metrics.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CLI = join(HERE, "..", "src", "metrics.mjs");

// 実走と同じ 4 フィクスチャ × (3,3,2,2) の並び。正解は偽物（語彙のテストで集合を制御するため）。
const FIXTURES = {
  F1: { verdict: "proceed", reasonCodes: ["alpha"] },
  F2: { verdict: "refuse", reasonCodes: ["epsilon"] },
  F3: { verdict: "refuse", reasonCodes: ["epsilon"] },
  F4: { verdict: "refuse", reasonCodes: ["epsilon"] },
};
const ORDER = ["F1", "F2", "F3", "F4"];

function bridge(status, txHash) {
  return { settled: status === 200, txHash, payTo: "0xpayee", amount: "0", resource: "/x", responseStatus: status };
}

/**
 * 偽の results dir を書く。`answerFor(condition, fixtureId)` が答えを、`toolCallsFor` がツール呼び出しを決める。
 * `doctorSummary` で summary.json だけを改竄できる（計器がそれを読まないことを見るため）。
 */
async function makeResultsDir({
  answerFor = (_c, id) => ({ verdict: FIXTURES[id].verdict, reasonCodes: [...FIXTURES[id].reasonCodes] }),
  toolCallsFor = () => [],
  meta = {},
  doctorSummary = null,
  storedGradeFor = null,
} = {}) {
  const base = await mkdtemp(join(tmpdir(), "ab-metrics-"));
  const dir = join(base, "2026-01-01T000000Z");
  await mkdir(dir);
  const trials = [];
  for (const condition of ["A", "B"]) {
    for (let i = 0; i < 10; i += 1) {
      const fixtureId = ORDER[i % 4];
      const oracle = { ...FIXTURES[fixtureId], reasonCodes: [...FIXTURES[fixtureId].reasonCodes], measured: true };
      const a = answerFor(condition, fixtureId, i);
      const answer = { verdict: a.verdict, reasonCodes: a.reasonCodes, explanation: null, unparseable: a.unparseable === true };
      const g = grade(answer, oracle);
      trials.push({
        trialIndex: trials.length,
        condition,
        cycle: Math.floor(i / 4),
        fixtureId,
        model: "fake-model",
        temperature: null,
        prompt: "p",
        rawResponse: JSON.stringify(a),
        raw: { effort: "high", mcpUrl: "https://mcp.invalid/mcp", toolNames: ["t"], toolCalls: toolCallsFor(condition, fixtureId, i) },
        answer,
        oracle,
        grade: storedGradeFor ? storedGradeFor(g, condition, fixtureId) : g,
        durationMs: 1,
        error: null,
      });
    }
  }
  const runMeta = {
    preRegistration: "fake",
    conditions: ["A", "B"],
    trialsPerCondition: 10,
    totalTrials: 20,
    startedAt: "2026-01-01T00:00:00.000Z",
    model: "fake-model",
    modelsSeen: ["fake-model"],
    singleModel: true,
    temperature: null,
    temperaturesSeen: [null],
    singleTemperature: true,
    isMock: false,
    mcpUrl: "https://mcp.invalid/mcp",
    ...meta,
  };
  // summary.json は**わざと**信用ならない値にできる。
  const summary = doctorSummary ? doctorSummary() : { note: "not derived" };
  await writeFile(join(dir, "trials.jsonl"), trials.map((t) => JSON.stringify(t)).join("\n") + "\n");
  await writeFile(join(dir, "run.json"), JSON.stringify({ meta: runMeta }, null, 2) + "\n");
  await writeFile(join(dir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  await writeFile(join(dir, "summary.md"), "# fake\n");
  return dir;
}

/** 偽の語彙ファイル 2 本（vocabulary.ts と pay-or-refuse.ts の形だけ真似る）。 */
async function makeVocabularyFiles() {
  const base = await mkdtemp(join(tmpdir(), "ab-vocab-"));
  const vocabularyPath = join(base, "vocabulary.ts");
  const sdkPath = join(base, "pay-or-refuse.ts");
  await writeFile(
    vocabularyPath,
    [
      "export const OBSERVATORY_VOCABULARY: VocabularyTerm[] = [",
      '  { term: "alpha", group: "l0", definition: "alpha is a." },',
      '  { term: "beta_gamma", group: "policy", definition: "beta is b." },',
      "];",
      "",
    ].join("\n"),
  );
  await writeFile(
    sdkPath,
    [
      "export type PayRefuseReason =",
      '  | "beta_gamma"',
      '  | "delta";',
      "",
      'export type PayEvidenceSource = "vet402" | "subgraph";',
      "",
    ].join("\n"),
  );
  return { vocabularyPath, sdkPath };
}

test("(a) 採点値は trials.jsonl の答えと正解から再計算する — summary.json の値を使わない", async () => {
  const dir = await makeResultsDir({
    doctorSummary: () => ({
      perCondition: { A: { trials: 10, success: 3 }, B: { trials: 10, success: 1 } },
      overall: { trials: 20, success: 4 },
    }),
  });
  const vocabulary = await loadVocabulary(await makeVocabularyFiles());
  const m = computeMetrics(await readResultsDir(dir), { vocabulary });
  // 答え＝正解にしてあるので、生ログからは全 20 試行が success。
  assert.equal(m.scoring.perCondition.A.success, 10);
  assert.equal(m.scoring.perCondition.B.success, 10);
  assert.equal(m.scoring.perCondition.A.trials, 10);
  assert.equal(m.scoring.perConditionFixture.A.F2.success, 3);
  assert.equal(m.scoring.perConditionFixture.B.F4.trials, 2);
});

test("(a2) 保存済みの grade.* も信じない — 事前登録の規則で答えと正解から grade し直し、食い違いを数える", async () => {
  // 保存された grade は「全部 success」に改竄。答えは全部 refuse + 捏造コード。
  const dir = await makeResultsDir({
    answerFor: () => ({ verdict: "refuse", reasonCodes: ["made_up"] }),
    storedGradeFor: (g) => ({ ...g, success: true, reasonSubset: true, fabricatedReasonCodes: [] }),
  });
  const vocabulary = await loadVocabulary(await makeVocabularyFiles());
  const m = computeMetrics(await readResultsDir(dir), { vocabulary });
  assert.equal(m.scoring.perCondition.A.success, 0);
  assert.equal(m.scoring.perCondition.A.fabricatedReasonTrials, 10);
  assert.equal(m.scoring.storedGradeDrift, 20, "改竄された grade は 20 件すべて再採点と食い違う");
});

test("(b) 語彙率 2 種 — (i) vocabulary.ts＋SDK の語、(ii) それに oracle の返した語を加えた集合。集合の大きさも出す", async () => {
  const dir = await makeResultsDir({
    // A: 半分が実在（alpha）・半分が画面語。B: 半分が SDK 語（delta）・半分が oracle だけの語（epsilon）。
    answerFor: (c, id) => ({
      verdict: FIXTURES[id].verdict,
      reasonCodes: c === "A" ? ["alpha", "WARN"] : ["delta", "epsilon"],
    }),
  });
  const vocabulary = await loadVocabulary(await makeVocabularyFiles());
  assert.deepEqual([...vocabulary.terms].sort(), ["alpha", "beta_gamma", "delta"], "zeta のような別の型の文字列を拾わない");
  const m = computeMetrics(await readResultsDir(dir), { vocabulary });
  const v = m.exploratory.vocabulary;
  assert.equal(v.setSizes.repoOnly, 3);
  assert.equal(v.setSizes.repoPlusOracle, 4, "alpha, beta_gamma, delta + epsilon");
  assert.deepEqual(v.perCondition.A.repoOnly, { inSet: 10, codes: 20 });
  assert.deepEqual(v.perCondition.A.repoPlusOracle, { inSet: 10, codes: 20 });
  assert.deepEqual(v.perCondition.B.repoOnly, { inSet: 10, codes: 20 });
  assert.deepEqual(v.perCondition.B.repoPlusOracle, { inSet: 20, codes: 20 });
  // 「全コードが実在の試行」も (ii) で数える。
  assert.equal(v.perCondition.A.trialsAllInRepoPlusOracle, 0);
  assert.equal(v.perCondition.B.trialsAllInRepoPlusOracle, 10);
  assert.equal(v.exploratory, true, "採点に使わない事後指標であることを出力自身が名乗る");
});

test("(b2) 語彙集合はリポの実ファイルから読める（既定パス）", async () => {
  const vocabulary = await loadVocabulary();
  assert.ok(vocabulary.terms.has("l1_not_attempted"), "vocabulary.ts の語");
  assert.ok(vocabulary.terms.has("resource_uncatalogued"), "pay-or-refuse.ts の PayRefuseReason");
  assert.ok(!vocabulary.terms.has("vet402"), "PayEvidenceSource の値は理由コードではない");
  assert.equal(vocabulary.sources.length, 2);
});

test("(c) 橋 — ツール呼び出し総数・settled 数・ユニーク tx 数・未決済の HTTP ステータス内訳", async () => {
  const dir = await makeResultsDir({
    toolCallsFor: (c, _id, i) => {
      // 各試行 3 回呼ぶ: 200（tx あり）・404・400。A の i=0 と i=1 は同じ tx ハッシュを持つ（重複）。
      const tx = c === "A" && i < 2 ? "0xsame" : `0x${c}${i}`;
      return [
        { name: "t", input: {}, ok: true, x402Bridge: bridge(200, tx) },
        { name: "t", input: {}, ok: true, x402Bridge: bridge(404, null) },
        { name: "t", input: {}, ok: true, x402Bridge: bridge(400, null) },
      ];
    },
  });
  const vocabulary = await loadVocabulary(await makeVocabularyFiles());
  const m = computeMetrics(await readResultsDir(dir), { vocabulary });
  assert.equal(m.bridge.toolCalls, 60);
  assert.equal(m.bridge.settled, 20);
  assert.equal(m.bridge.uniqueTx, 19, "20 件 settled のうち 2 件が同じ tx");
  assert.deepEqual(m.bridge.unsettledByStatus, { 400: 20, 404: 20 });
  assert.equal(m.bridge.unsettled, 40);
});

test("(d) isMock の run は出力の 1 行目に mock と出る", async () => {
  const dir = await makeResultsDir({ meta: { isMock: true, model: "mock-scripted-v1", mcpUrl: null } });
  const vocabulary = await loadVocabulary(await makeVocabularyFiles());
  const m = computeMetrics(await readResultsDir(dir), { vocabulary });
  const md = renderMarkdown(m);
  assert.match(md.split("\n")[0], /mock/i);
  assert.equal(m.meta.isMock, true);
  // 実走の出力は mock を名乗らない。
  const live = await makeResultsDir();
  const md2 = renderMarkdown(computeMetrics(await readResultsDir(live), { vocabulary }));
  assert.doesNotMatch(md2.split("\n")[0], /mock/i);
});

test("(d2) メタ — model・effort・temperature（null は not sent）・mcpUrl", async () => {
  const dir = await makeResultsDir();
  const vocabulary = await loadVocabulary(await makeVocabularyFiles());
  const m = computeMetrics(await readResultsDir(dir), { vocabulary });
  assert.equal(m.meta.model, "fake-model");
  assert.deepEqual(m.meta.effort, ["high"]);
  assert.equal(m.meta.temperature, "not sent");
  assert.equal(m.meta.mcpUrl, "https://mcp.invalid/mcp");
  const md = renderMarkdown(m);
  assert.match(md, /not sent/);
  assert.match(md, /fake-model/);
});

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("(e) 存在しない dir は stderr 1 行で exit 1", async () => {
  const r = await runCli(["/nonexistent/results/dir"]);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr.trim().split("\n").length, 1, r.stderr);
  assert.match(r.stderr, /nonexistent\/results\/dir/);
});

test("(e2) CLI は Markdown を印字し、--json で同じ数字を JSON で出す", async () => {
  const dir = await makeResultsDir();
  const md = await runCli([dir]);
  assert.equal(md.code, 0, md.stderr);
  assert.match(md.stdout, /\| A \| 10 \| 10 \|/);
  const js = await runCli([dir, "--json"]);
  assert.equal(js.code, 0, js.stderr);
  const parsed = JSON.parse(js.stdout);
  assert.equal(parsed.scoring.perCondition.A.success, 10);
  assert.equal(parsed.bridge.toolCalls, 0);
});
