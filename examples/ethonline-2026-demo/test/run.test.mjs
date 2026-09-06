// CLI の入口。**`--live` は事故で立ってはいけない**ので、解釈をここで固定する。
import test from "node:test";
import assert from "node:assert/strict";
import { parseArgv, USAGE } from "../src/run.ts";

test("`refuse` と `pay` だけを受け取る", () => {
  assert.equal(parseArgv(["refuse"]).command, "refuse");
  assert.equal(parseArgv(["pay"]).command, "pay");
  assert.equal(parseArgv([]).command, null);
  assert.equal(parseArgv(["settle"]).command, null);
});

test("--live は明示されたときにだけ立つ", () => {
  assert.equal(parseArgv(["pay"]).live, false);
  assert.equal(parseArgv(["pay", "--dry-run"]).live, false);
  assert.equal(parseArgv(["pay", "--live"]).live, true);
  // 似ているだけの綴りでは立たない。
  assert.equal(parseArgv(["pay", "--live=false"]).live, false);
  assert.equal(parseArgv(["pay", "--livewire"]).live, false);
  assert.equal(parseArgv(["pay", "live"]).live, false);
});

test("refuse に --live は無い（署名の経路が最初から無い）", () => {
  assert.equal(parseArgv(["refuse", "--live"]).command, "refuse");
  assert.match(USAGE.join("\n"), /refuse/);
  assert.match(USAGE.join("\n"), /--live/);
});

test("色は既定で切っている（動画の圧縮で色は死ぬ）", () => {
  assert.equal(parseArgv(["refuse"]).color, false);
  assert.equal(parseArgv(["refuse", "--color"]).color, true);
});

// 鍵が無いときの落ち方。**整形済み1行＋exit 1** で止まり、スタックは出さない
// （審査員が最初に踏むのはここ。7行の `at …` は「壊れている」と読まれる）。
// 予期しない例外は逆にスタックを残す——原因を隠さないため。
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { failureLines } from "../src/run.ts";
import { MissingEnvError } from "../src/probe.ts";

const DEMO_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

test("鍵欠落: 整形済み `error:` 1行と exit 1 だけ。`at ` 行は無い", () => {
  const env = { ...process.env };
  delete env.GRAPH_API_KEY;
  delete env.VOUCH_API_KEY;
  const r = spawnSync(process.execPath, [join(DEMO_DIR, "src/run.ts"), "refuse"], { env, encoding: "utf8" });
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 1, out);
  assert.match(out, /^error: missing environment variable\(s\): GRAPH_API_KEY, VOUCH_API_KEY\./m);
  assert.doesNotMatch(out, /^\s+at /m, `stack trace leaked:\n${out}`);
  assert.equal(out.trim().split("\n").length, 1, `expected exactly one line:\n${out}`);
});

test("failureLines: MissingEnvError は1行、それ以外の Error はスタックを残す（両方向）", () => {
  const missing = failureLines(new MissingEnvError("missing environment variable(s): X"));
  assert.deepEqual(missing, ["error: missing environment variable(s): X"]);

  const unexpected = failureLines(new Error("boom"));
  assert.equal(unexpected[0], "error: boom");
  assert.match(unexpected.join("\n"), /^\s+at /m, "unexpected errors must keep their stack");

  assert.deepEqual(failureLines("plain string"), ["error: plain string"]);
});
