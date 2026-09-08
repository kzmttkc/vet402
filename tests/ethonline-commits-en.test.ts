// ============================================================
// docs/ethonline-2026/COMMITS_EN.md の鮮度関門（2026-09-09）。
//
// WHY. `scripts/ethonline-commits-en.mjs --check` は対訳の欠落と stale な ja しか見ていなかったので、
// ファイル本体が HEAD から 3 コミット遅れても緑だった（検証役の実測: HEAD 321 件・ファイル 318 件）。
// 今の --check は Generated 行の SHA から同じ内容を描き直して突き合わせ、その SHA より後のコミットが
// このファイルを再生成していなければ赤にする（refresh-numbers --check と同じ考え方——正解の写しを持たず、
// 文書が名乗る基準にピン留めして、その場で導出する）。
//
// ここでやること:
//   1. 本物のファイルに対して --check が exit 0（＝ push-main の root npm test と CI の test ジョブで毎回走る）
//   2. わざと古い写しに対しては exit 1 で、理由に "regenerate" が出る（関門が見ているものの負の試験）
//   3. 実在しない SHA を名乗る写しも exit 1（Generated 行を手で直しても通らない）
//
// 前提: リポに tag pre-ethonline-2026 と全履歴がある（CI の test ジョブは fetch-depth: 0。depth 1 では走らない）。
// ============================================================
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const ROOT = process.cwd();
const SCRIPT = join(ROOT, "scripts", "ethonline-commits-en.mjs");
const FILE = join(ROOT, "docs", "ethonline-2026", "COMMITS_EN.md");

function check(out?: string) {
  const args = [SCRIPT, "--check", ...(out ? ["--out", out] : [])];
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8" });
  return { code: r.status, text: (r.stdout ?? "") + (r.stderr ?? "") };
}

test("COMMITS_EN.md is what the script renders from the commit it names, and nothing after that commit forgot to regenerate it", () => {
  const r = check();
  assert.equal(r.code, 0, `--check is red:\n${r.text.split("\n").filter((l) => !l.includes("note: translation")).join("\n")}`);
  assert.match(r.text, /file fresh/);
});

test("a stale copy (one row dropped) is red with 'regenerate'", () => {
  const dir = mkdtempSync(join(tmpdir(), "commits-en-"));
  const body = readFileSync(FILE, "utf8");
  const rows = body.split("\n");
  const last = rows.map((l, i) => (l.startsWith("| [`") ? i : -1)).filter((i) => i >= 0).pop();
  assert.ok(last !== undefined && last > 0, "no table row found in COMMITS_EN.md");
  rows.splice(last, 1);
  const stale = join(dir, "COMMITS_EN.md");
  writeFileSync(stale, rows.join("\n"));
  const r = check(stale);
  assert.equal(r.code, 1, `expected exit 1 for the stale copy, got ${r.code}:\n${r.text}`);
  assert.match(r.text, /not what the script renders from [0-9a-f]{7}/);
  assert.match(r.text, /regenerate/);
  assert.match(r.text, /file STALE/);
});

test("a copy whose Generated row names a SHA that is not a commit is red", () => {
  const dir = mkdtempSync(join(tmpdir(), "commits-en-"));
  const body = readFileSync(FILE, "utf8");
  const forged = body.replace(/(\| Generated \| .* from `)[0-9a-f]{40}(` \|)/, `$1${"0".repeat(40)}$2`);
  assert.notEqual(forged, body, "Generated row not found");
  const p = join(dir, "COMMITS_EN.md");
  writeFileSync(p, forged);
  const r = check(p);
  assert.equal(r.code, 1, `expected exit 1, got ${r.code}:\n${r.text}`);
  assert.match(r.text, /is not a commit here/);
});
