import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, main } from "../src/cli.mjs";

test("既定は mock アダプタ", () => {
  assert.equal(parseArgs([]).agent, "mock");
});

test("--agent / --gateway / --out / --model / --effort を読む", () => {
  const a = parseArgs(["--agent", "anthropic", "--gateway", "https://g", "--out", "/tmp/x", "--model", "m", "--effort", "max"]);
  assert.deepEqual(a, { agent: "anthropic", gateway: "https://g", out: "/tmp/x", model: "m", effort: "max" });
});

test("知らないアダプタは投げる", () => {
  assert.throws(() => parseArgs(["--agent", "gpt"]), /unknown agent/);
});

test("mock で20試行を通し、書いて、検算して、集計表を返す", async () => {
  const out = await mkdtemp(join(tmpdir(), "ab-cli-"));
  const r = await main(["--agent", "mock", "--out", out]);
  assert.equal(r.run.trials.length, 20);
  assert.equal(r.verified.ok, true);
  assert.equal(r.run.meta.isMock, true);
  assert.equal(r.run.meta.agentAdapter, "mock");
  const md = await readFile(join(r.dir, "summary.md"), "utf8");
  assert.match(md, /MOCK/);
  assert.match(r.report, /\| A \|/);
});

test("検算に失敗したら 0 で終われない（exitCode を立てる）", async () => {
  const out = await mkdtemp(join(tmpdir(), "ab-cli-"));
  const r = await main(["--agent", "mock", "--out", out]);
  assert.equal(r.exitCode, 0);
  assert.equal(r.verified.ok, true);
});
