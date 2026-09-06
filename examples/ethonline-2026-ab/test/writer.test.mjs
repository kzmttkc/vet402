// 厳守2「実行のたびにタイムスタンプ付きの新しいディレクトリへ書き、過去の結果を上書きしない」
// 厳守3「秘密を出力に出さない」
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRun, verifyRunDir } from "../src/writer.mjs";
import { runAbHarness } from "../src/harness.mjs";
import { aggregate } from "../src/aggregate.mjs";

const resources = { gatewayUrl: "https://example.invalid", apiList: "GET /a — a", recipe: "Recipe: x402-payee-verification\nbody" };
const AT = new Date("2026-09-05T10:15:30Z");

async function makeRun(text = '{"verdict":"refuse","reason_codes":[]}') {
  return runAbHarness({ runAgent: async () => ({ text, model: "mock", temperature: 0 }), resources });
}
async function tmp() {
  return mkdtemp(join(tmpdir(), "ab-writer-"));
}

test("タイムスタンプ付きディレクトリへ4ファイルを書く", async () => {
  const base = await tmp();
  const dir = await writeRun(await makeRun(), { baseDir: base, now: () => AT, env: {} });
  assert.ok(dir.endsWith("2026-09-05T101530Z"), dir);
  assert.deepEqual((await readdir(dir)).sort(), ["run.json", "summary.json", "summary.md", "trials.jsonl"]);
});

test("同じディレクトリへ2回書けない（良い結果が出るまで回し直せない形にする）", async () => {
  const base = await tmp();
  await writeRun(await makeRun(), { baseDir: base, now: () => AT, env: {} });
  const second = await makeRun();
  await assert.rejects(() => writeRun(second, { baseDir: base, now: () => AT, env: {} }), /already exists/);
});

test("trials.jsonl は1行1試行の生ログ（20行・プロンプト全文つき）", async () => {
  const base = await tmp();
  const dir = await writeRun(await makeRun(), { baseDir: base, now: () => AT, env: {} });
  const lines = (await readFile(join(dir, "trials.jsonl"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 20);
  const first = JSON.parse(lines[0]);
  assert.ok(first.prompt.length > 100);
  assert.equal(typeof first.rawResponse, "string");
  assert.equal(typeof first.grade.success, "boolean");
});

test("summary.json は生ログから導いた値で、verifyRunDir が数え直して一致を確かめる", async () => {
  const base = await tmp();
  const dir = await writeRun(await makeRun(), { baseDir: base, now: () => AT, env: {} });
  const v = await verifyRunDir(dir);
  assert.equal(v.ok, true);
  assert.deepEqual(v.mismatches, []);
});

test("summary.json を生ログと食い違わせたら verifyRunDir が赤くなる", async () => {
  const base = await tmp();
  const dir = await writeRun(await makeRun(), { baseDir: base, now: () => AT, env: {} });
  const summary = JSON.parse(await readFile(join(dir, "summary.json"), "utf8"));
  summary.perCondition.A.success += 1;
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(dir, "summary.json"), JSON.stringify(summary, null, 2));
  const v = await verifyRunDir(dir);
  assert.equal(v.ok, false);
  assert.ok(v.mismatches.some((m) => m.includes("perCondition.A.success")));
});

test("生ログから1行消したら verifyRunDir が赤くなる", async () => {
  const base = await tmp();
  const dir = await writeRun(await makeRun(), { baseDir: base, now: () => AT, env: {} });
  const { writeFile } = await import("node:fs/promises");
  const lines = (await readFile(join(dir, "trials.jsonl"), "utf8")).trim().split("\n");
  await writeFile(join(dir, "trials.jsonl"), lines.slice(1).join("\n") + "\n");
  const v = await verifyRunDir(dir);
  assert.equal(v.ok, false);
});

test("秘密が混ざっていたら書く前に投げる（ファイルを1つも作らない）", async () => {
  const base = await tmp();
  const env = { VOUCH_API_KEY: "vk_live_0123456789abcdef" };
  const run = await makeRun(`{"verdict":"refuse","reason_codes":[],"explanation":"used ${env.VOUCH_API_KEY}"}`);
  await assert.rejects(() => writeRun(run, { baseDir: base, now: () => AT, env }), /VOUCH_API_KEY/);
  assert.deepEqual(await readdir(base), [], "何も書かれていないこと");
});

test("summary.md にモックの断り書きが出る（モックの緑を本物に見せない）", async () => {
  const base = await tmp();
  const run = await makeRun();
  run.meta.agentAdapter = "mock";
  run.meta.isMock = true;
  const dir = await writeRun(run, { baseDir: base, now: () => AT, env: {} });
  const md = await readFile(join(dir, "summary.md"), "utf8");
  assert.match(md, /MOCK/);
  assert.match(md, /not a measurement of any model/i);
});

test("summary.md の暫定警告は blockers があるときだけ出る——**両方向に**", async () => {
  const base = await tmp();
  // (a) blockers あり → 警告が出る
  const run = await makeRun();
  const provisional = {
    ...run,
    meta: { ...run.meta, fixtureReadiness: { liveReady: false, blockers: ["F3: oracle が未測定（derived）"] } },
  };
  const d1 = await writeRun(provisional, { baseDir: base, now: () => AT, env: {} });
  const md1 = await readFile(join(d1, "summary.md"), "utf8");
  assert.match(md1, /PROVISIONAL|暫定/);
  assert.match(md1, /F3/);

  // (b) blockers なし → **警告を出さない**（無い問題を警告し続けると、本物の警告が読まれなくなる）
  const ready = { ...run, meta: { ...run.meta, fixtureReadiness: { liveReady: true, blockers: [] } } };
  const d2 = await writeRun(ready, { baseDir: base, now: () => new Date(AT.getTime() + 1000), env: {} });
  const md2 = await readFile(join(d2, "summary.md"), "utf8");
  assert.doesNotMatch(md2, /PROVISIONAL|暫定/);
});

test("summary.md に §16 の集計表（A/B・成功・判定一致・理由部分集合）が出る", async () => {
  const base = await tmp();
  const dir = await writeRun(await makeRun(), { baseDir: base, now: () => AT, env: {} });
  const md = await readFile(join(dir, "summary.md"), "utf8");
  for (const s of ["| A |", "| B |", "success", "verdictMatch", "reasonSubset"]) {
    assert.ok(md.includes(s), `summary.md に ${s} が無い`);
  }
});
