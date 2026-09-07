// ============================================================
// scripts/skill-live-check.mjs（2026-09-08）——SKILL.md の「本番向けコードブロック」を毎日本番で実走する関門。
//
// 09-07 の監査で、SKILL.md の curl（`jq '.resources[0].resource_id'`）が本番では null を返すのに
// 文書は緑の顔をしていた。文書が未来を書き、誰も再実行しなかった。
// ここでは印（```bash フェンス直後の `# live: expect <jq>`）の付いたブロックだけを抽出し、実行し、
// stdout を `jq -s` で束ねて式が true になるかを見る。1 つでも不一致なら exit 1。
//
// このテストは本番を叩かない。fixture の Markdown に echo / false / touch を書き、
//   抽出が正しいブロックだけを拾う／期待不一致で非 0／鍵が無いと skip／--dry-run は実行しない／
//   壊れた印と印ゼロは赤、を見る。
// ============================================================
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const SCRIPT = join(process.cwd(), "scripts", "skill-live-check.mjs");

function fixture(md: string) {
  const root = mkdtempSync(join(tmpdir(), "skill-live-"));
  writeFileSync(join(root, "SKILL.md"), md);
  return root;
}

function run(root: string, args: string[] = [], env: Record<string, string | undefined> = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args, "--root", root, "--doc", "SKILL.md"], {
    encoding: "utf8",
    env: { ...process.env, SKILL_LIVE_TEST_KEY: undefined, ...env },
  });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

const fence = (lang: string, body: string) => "```" + lang + "\n" + body + "\n```\n";

const DOC = [
  "# SKILL",
  "",
  "## A. marked, matches",
  "",
  fence("bash", `# live: expect .[0].a == 1 and .[1] == false\necho '{"a":1}'\necho false`),
  "",
  "## B. unmarked bash — never run",
  "",
  fence("bash", `touch unmarked-ran`),
  "",
  "## C. marked but not a bash fence — never run",
  "",
  fence("json", `# live: expect true\n{"x":1}`),
  "",
  "### D. marker not on the first line — never run",
  "",
  fence("bash", `echo 1\n# live: expect .[0] == 1\ntouch late-marker-ran`),
].join("\n");

test("--list prints only the bash blocks whose first line is a `# live:` marker, with their heading and expectation", () => {
  const root = fixture(DOC);
  const r = run(root, ["--list"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /A\. marked, matches/);
  assert.match(r.out, /\.\[0\]\.a == 1 and \.\[1\] == false/);
  assert.doesNotMatch(r.out, /unmarked bash/);
  assert.doesNotMatch(r.out, /not a bash fence/);
  assert.doesNotMatch(r.out, /marker not on the first line/);
  assert.match(r.out, /1 block/);
  assert.ok(!existsSync(join(root, "unmarked-ran")), "--list must not execute anything");
});

test("a marked block whose stdout satisfies the jq expectation is ok and the run exits 0", () => {
  const root = fixture(DOC);
  const r = run(root);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ok\s+A\. marked, matches/);
  assert.match(r.out, /1 ok, 0 fail, 0 skip/);
  assert.ok(!existsSync(join(root, "unmarked-ran")), "unmarked blocks must not run");
  assert.ok(!existsSync(join(root, "late-marker-ran")), "a marker below line 1 is not a marker");
});

test("a marked block whose stdout does not satisfy the expectation is FAIL and the run exits 1", () => {
  const root = fixture(["## resolve", fence("bash", `# live: expect .[0].resource_id != null\necho '{"resource_id":null}'`)].join("\n"));
  const r = run(root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FAIL\s+resolve/);
  assert.match(r.out, /0 ok, 1 fail, 0 skip/);
});

test("a block whose command exits non-zero is FAIL even if stdout would satisfy the expectation", () => {
  const root = fixture(["## exits 7", fence("bash", `# live: expect .[0] == 1\necho 1\nexit 7`)].join("\n"));
  const r = run(root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FAIL\s+exits 7/);
  assert.match(r.out, /exit 7/);
});

test("a block whose stdout is not JSON is FAIL, and says so", () => {
  const root = fixture(["## html", fence("bash", `# live: expect .[0] != null\necho '<html>'`)].join("\n"));
  const r = run(root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FAIL\s+html/);
  assert.match(r.out, /not JSON/i);
});

test("`needs VAR` skips the block when VAR is unset, counts it as skip, and does not fail the run", () => {
  const root = fixture(["## keyed", fence("bash", `# live: needs SKILL_LIVE_TEST_KEY expect .[0] == "ran"\ntouch keyed-ran\necho '"ran"'`)].join("\n"));
  const r = run(root, [], { SKILL_LIVE_TEST_KEY: undefined });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /skip\s+keyed/);
  assert.match(r.out, /SKILL_LIVE_TEST_KEY/);
  assert.match(r.out, /0 ok, 0 fail, 1 skip/);
  assert.ok(!existsSync(join(root, "keyed-ran")), "a skipped block must not run");
});

test("`needs VAR` runs the block when VAR is set", () => {
  const root = fixture(["## keyed", fence("bash", `# live: needs SKILL_LIVE_TEST_KEY expect .[0] == "ran"\necho '"ran"'`)].join("\n"));
  const r = run(root, [], { SKILL_LIVE_TEST_KEY: "x" });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /1 ok, 0 fail, 0 skip/);
});

test("--dry-run lists what would run and executes nothing", () => {
  const root = fixture(["## side effect", fence("bash", `# live: expect .[0] == 1\ntouch dry-ran\necho 1`)].join("\n"));
  const r = run(root, ["--dry-run"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /side effect/);
  assert.ok(!existsSync(join(root, "dry-ran")), "--dry-run must not execute");
});

test("a malformed marker is an error (exit 1), not a silently ignored block", () => {
  const root = fixture(["## bad", fence("bash", `# live: expekt .[0] == 1\necho 1`)].join("\n"));
  const r = run(root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /malformed/i);
});

test("a document with zero marked blocks exits 1 — a green run that checked nothing is not green", () => {
  const root = fixture(["## nothing", fence("bash", `echo 1`)].join("\n"));
  const r = run(root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no marked blocks/i);
});
