// 出力の**唯一の口**。ここを通らない書き出しがあると、redact が掛からない経路が生まれる。
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createEmitter } from "../src/emit.ts";

test("emit は書き出す直前に必ず伏せる", () => {
  const seen = [];
  const emit = createEmitter({ sink: (line) => seen.push(line), secrets: ["supersecretkey123"] });
  emit.line("token=supersecretkey123");
  assert.deepEqual(seen, ["token=<REDACTED>"]);
});

test("emit は例外の本文とスタックも伏せる", () => {
  const seen = [];
  const emit = createEmitter({ sink: (line) => seen.push(line), secrets: ["supersecretkey123"] });
  emit.error(new Error("fetch failed for https://x/api/supersecretkey123/y"));
  assert.equal(seen.join("\n").includes("supersecretkey123"), false);
  assert.match(seen.join("\n"), /<REDACTED>/);
});

// 「出さない」ではなく「出せない」にする。console.log を直接呼ぶ経路が1本でもあれば
// 上の2本は緑のまま漏れる——だから**書き出しの構文そのもの**を検査する。
test("src/ で標準出力へ直接書く場所は emit.ts だけ", () => {
  const dir = new URL("../src/", import.meta.url).pathname;
  const offenders = [];
  for (const name of readdirSync(dir)) {
    if (name === "emit.ts" || !name.endsWith(".ts")) continue;
    const body = readFileSync(join(dir, name), "utf8");
    if (/console\.(log|info|warn|error)\s*\(|process\.(stdout|stderr)\.write\s*\(/.test(body)) {
      offenders.push(name);
    }
  }
  assert.deepEqual(offenders, [], `emit.ts を迂回して書き出している: ${offenders.join(", ")}`);
});
