// ============================================================
// docs/ethonline-2026/COMMITS_EN.md の鮮度関門（2026-09-09）。
//
// WHY. `scripts/ethonline-commits-en.mjs --check` は対訳の欠落と stale な ja しか見ていなかったので、
// ファイル本体が HEAD から 3 コミット遅れても緑だった（検証役の実測: HEAD 321 件・ファイル 318 件）。
// 今の --check は Generated 行の SHA から同じ内容を描き直して突き合わせる（refresh-numbers --check と同じ
// 考え方——正解の写しを持たず、文書が名乗る基準にピン留めして、その場で導出する）。
//
// 2段（同日、後刻）。最初の版は「その SHA より後のコミットがこのファイルを再生成していない」も exit 1 にした。
// すると main の全コミットが COMMITS_EN.md の再生成を同梱しないと root npm test が赤になり、無関係な
// 2 ブランチが数時間で詰まった。
//
// 対訳の欠落も同じ形で詰まった（2026-09-10）。d0346b3 が日本語件名を対訳なしで main に載せ、root npm test が
// 赤になり、リポの全セッションが push できなくなった。ハッカソン専用の索引がリポ全体を止めてはいけないので、
// 「索引が遅れている」側は2段とも note にし、赤は「文書が自分について嘘をついている」場合だけにした:
//   常に赤     — Generated 行が無い／名乗る SHA がコミットでない／ref の祖先でない／その SHA から描き直した
//                内容とファイルが一致しない（手編集・生成器の drift = ファイルが自分について嘘をついている）／
//                titles の ja が実際の件名と食い違う・en に CJK が残る（エントリが自分について嘘をついている）
//   --strict で赤 — 日本語件名に対訳が無い／ピン以後にこのファイルを再生成していないコミットがある
//                （単に遅れている。既定は stderr に note:）
// npm test は既定を走らせる。締切前の最終通しは生成器 → `--check --strict`（RELEASE_NOTES_SUBMISSION.md）。
// 審査員が読むのはその最終通しの後のファイルなので、対訳の欠落はそこで必ず赤になる。
//
// ここでやること:
//   1. 本物のファイルに対して --check が exit 0（＝ push-main の root npm test と CI の test ジョブで毎回走る）。
//      fresh でも stale (note) でもよい——後者は警告であって赤ではない
//   2. わざと古い写し（行を1つ落とす）は exit 1 で、理由に "regenerate" が出る（関門が見ているものの負の試験）
//   3. 実在しない SHA を名乗る写しも exit 1（Generated 行を手で直しても通らない）
//   4. ピンを「再生成しなかったコミットの1つ前」へ戻した写し（= 本当に遅れているファイル）は、既定では
//      exit 0 + "note: … stale"、--strict では exit 1（2段が実際に分かれていることの負の試験）
//   5. 対訳の無い日本語件名がある状態（titles から1件抜いた写しを --titles で読ませる）は、既定では
//      exit 0 + "note: … [untranslated]"、--strict では exit 1（同上）。件数は「素の件数 + 1」で見る——
//      main が対訳の遅れを抱えていてよいのが2段の趣旨なので、素を 0 と決め打つと試験自身が赤の原因になる
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

function run(args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" });
  return { code: r.status, text: (r.stdout ?? "") + (r.stderr ?? "") };
}
const check = (out?: string, ...more: string[]) => run(["--check", ...(out ? ["--out", out] : []), ...more]);
const TITLES = join(ROOT, "docs", "ethonline-2026", "commit-titles-en.json");
const git = (...args: string[]) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8" }).stdout.trim();

test("COMMITS_EN.md is what the script renders from the commit it names (a stale-but-honest file is a note, not red)", () => {
  const r = check();
  assert.equal(r.code, 0, `--check is red:\n${r.text.split("\n").filter((l) => !l.includes("note: translation")).join("\n")}`);
  assert.match(r.text, /file fresh|note: .*stale/);
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

test("a copy that is honestly behind (pinned before a commit that did not regenerate it) is a note by default and red under --strict", () => {
  // The newest commit in the window that did not touch COMMITS_EN.md; pin the copy to its parent so that
  // commit is "after the pin and did not regenerate". Render the copy from that parent with the real
  // generator, so the content check passes and only the stale check is exercised.
  const all = git("log", "--format=%H", "pre-ethonline-2026..HEAD").split("\n").filter(Boolean);
  const touched = new Set(git("log", "--format=%H", "pre-ethonline-2026..HEAD", "--", "docs/ethonline-2026/COMMITS_EN.md").split("\n").filter(Boolean));
  const lazy = all.find((sha) => !touched.has(sha));
  assert.ok(lazy, "every commit in the window regenerated COMMITS_EN.md — nothing to pin behind");
  const pin = git("rev-parse", `${lazy}^`);
  const dir = mkdtempSync(join(tmpdir(), "commits-en-"));
  const p = join(dir, "COMMITS_EN.md");
  const gen = run(["--ref", pin, "--out", p]);
  assert.equal(gen.code, 0, `generating from ${pin.slice(0, 7)} failed:\n${gen.text}`);
  assert.match(readFileSync(p, "utf8"), new RegExp(`\\| Generated \\| .* from \`${pin}\` \\|`));

  const soft = check(p);
  assert.equal(soft.code, 0, `expected exit 0 without --strict, got ${soft.code}:\n${soft.text}`);
  assert.match(soft.text, /note: .*stale — \d+ commit\(s\) since [0-9a-f]{7} did not regenerate it/);
  assert.match(soft.text, /file stale \(note\)/);

  const strict = check(p, "--strict");
  assert.equal(strict.code, 1, `expected exit 1 with --strict, got ${strict.code}:\n${strict.text}`);
  assert.match(strict.text, /stale — \d+ commit\(s\) since [0-9a-f]{7} did not regenerate it/);
  assert.match(strict.text, /file STALE/);
});

test("a Japanese subject with no translation is a note by default and red under --strict", () => {
  // Punch one hole in a *copy* of the titles file (never the real one — other tests read it), then render a
  // copy of the index from that. The rendered copy matches what the script renders from its own pin, so the
  // always-red content check passes and only the untranslated grade is exercised.
  //
  // Counted against a baseline, not against zero (2026-09-12). A gap on `main` is a note by design — that is
  // the whole point of the two grades — so `main` may carry any number of untranslated subjects. Asserting
  // the literal "1 untranslated" quietly made the repo's own backlog part of this fixture: on 2026-09-12 a
  // Japanese subject landed with no entry, the bare count became 1, the hole made it 2, the assertion missed,
  // root `npm test` went red and every session lost `push` — the same accident as d0346b3 on 2026-09-10, which
  // is exactly what the two grades exist to prevent. So measure the bare count first and assert bare + 1. The
  // meaning is unchanged: one hole must add exactly one untranslated row, and --strict must still be red.
  const dir = mkdtempSync(join(tmpdir(), "commits-en-"));

  // The bare count on this ref, asked of the generator itself (no --check — it only renders to a temp path).
  // No suffix in the summary means zero.
  const bare = run(["--out", join(dir, "baseline.md")]);
  assert.equal(bare.code, 0, `the generator is red on the real titles file:\n${bare.text}`);
  const baseline = Number(/, (\d+) untranslated \(note\)/.exec(bare.text)?.[1] ?? 0);
  const expected = baseline + 1;

  const titles = JSON.parse(readFileSync(TITLES, "utf8")) as { titles: Record<string, { ja: string; en: string }> };
  // The commit whose entry we drop must have a Japanese subject: the generator prints a non-CJK subject as is
  // and never looks the entry up, so dropping an English-subject entry would add no untranslated row at all.
  const CJK = /[぀-ヿ一-鿿！-｠]/; // identical to the one in scripts/ethonline-commits-en.mjs
  const subjects = new Map(
    git("log", "--format=%H%x1f%s", "pre-ethonline-2026..HEAD")
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("\x1f") as [string, string]),
  );
  const dropped = Object.keys(titles.titles).find((sha) => CJK.test(subjects.get(sha) ?? ""));
  assert.ok(dropped, "no translated Japanese subject inside the window to drop");
  delete titles.titles[dropped];
  const holed = join(dir, "commit-titles-en.json");
  writeFileSync(holed, JSON.stringify(titles, null, 2));
  const p = join(dir, "COMMITS_EN.md");

  // The generator must still write the file and exit 0 — a gap is a note, so a gap cannot block the runbook's
  // `generate && --check --strict` chain before the strict pass gets to speak. The count must be exactly one
  // more than the bare count: the hole added a row, and nothing else moved.
  const gen = run(["--titles", holed, "--out", p]);
  assert.equal(gen.code, 0, `generator went red on a missing translation:\n${gen.text}`);
  assert.match(gen.text, /\[untranslated\]/);
  assert.match(gen.text, new RegExp(`, ${expected} untranslated \\(note\\)`));
  assert.match(readFileSync(p, "utf8"), /\[untranslated\]/);

  const soft = check(p, "--titles", holed);
  assert.equal(soft.code, 0, `expected exit 0 without --strict, got ${soft.code}:\n${soft.text}`);
  assert.match(soft.text, new RegExp(`note: ${dropped.slice(0, 7)} \\[untranslated\\]`));
  assert.match(soft.text, new RegExp(`, ${expected} untranslated \\(note\\)`));
  assert.match(soft.text, /, 0 problem\(s\)/);

  const strict = check(p, "--titles", holed, "--strict");
  assert.equal(strict.code, 1, `expected exit 1 with --strict, got ${strict.code}:\n${strict.text}`);
  assert.match(strict.text, new RegExp(`^ethonline-commits-en: ${dropped.slice(0, 7)} \\[untranslated\\]`, "m"));
  assert.match(strict.text, new RegExp(`, ${expected} problem\\(s\\)`));
});
