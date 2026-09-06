import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, main } from "../src/cli.mjs";

test("既定は mock アダプタ", () => {
  assert.equal(parseArgs([]).agent, "mock");
});

test("--agent / --gateway / --out / --model / --effort / --mcp を読む", () => {
  const a = parseArgs(["--agent", "anthropic", "--gateway", "https://g", "--out", "/tmp/x", "--model", "m", "--effort", "max", "--mcp", "https://g/mcp"]);
  assert.deepEqual(a, { agent: "anthropic", gateway: "https://g", out: "/tmp/x", model: "m", effort: "max", mcp: "https://g/mcp" });
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

// ---- 2026-09-06 ----

test("--mcp で Bazantic Gateway の MCP の口を上書きできる（既定は Recipe の写しの値）", async () => {
  assert.equal(parseArgs([]).mcp, null);
  assert.equal(parseArgs(["--mcp", "https://x/mcp"]).mcp, "https://x/mcp");
});

test("実行のメタに Recipe の写しの出所が残る（審査員が原本と突き合わせられる）", async () => {
  const out = await mkdtemp(join(tmpdir(), "ab-cli-"));
  const r = await main(["--agent", "mock", "--out", out]);
  assert.equal(r.run.meta.recipeSource.platform, "bazantic.com");
  assert.equal(r.run.meta.recipeSource.mcpUrl, "https://2vjhqfgvw5dt5lja2zpjsjwrem.bazgateway.com/mcp");
  assert.match(r.run.meta.recipeSource.copiedAt, /^\d{4}-\d{2}-\d{2}$/);
  const meta = JSON.parse(await readFile(join(r.dir, "run.json"), "utf8")).meta;
  assert.deepEqual(meta.recipeSource, r.run.meta.recipeSource);
});

test("モックの実行では MCP を呼んでいないと明記される（呼んだふりをしない）", async () => {
  const out = await mkdtemp(join(tmpdir(), "ab-cli-"));
  const r = await main(["--agent", "mock", "--out", out]);
  assert.equal(r.run.meta.mcpUrl, null);
  const md = await readFile(join(r.dir, "summary.md"), "utf8");
  assert.match(md, /no MCP/i);
});
