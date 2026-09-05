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
