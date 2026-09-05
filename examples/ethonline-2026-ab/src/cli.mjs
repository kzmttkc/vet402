#!/usr/bin/env node
/**
 * A/B ハーネスの実行口。
 *
 *   node src/cli.mjs --agent mock          # 鍵不要。ハーネス自体を20試行で通す
 *   node src/cli.mjs --agent mock-flaky    # エラー経路と unparseable 経路も混ぜる
 *   node src/cli.mjs --agent anthropic     # **実 LLM。課金が発生する**
 *
 * 実行のたびに `results/<timestamp>/` へ書き、**過去の結果を上書きしない**。
 * 書いた直後に生ログから集計を数え直して突き合わせる（`verifyRunDir`）。
 */
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadResources, DEFAULT_GATEWAY_URL, REPO_ROOT } from "./prompt.mjs";
import { runAbHarness } from "./harness.mjs";
import { aggregate } from "./aggregate.mjs";
import { writeRun, verifyRunDir, renderSummaryMarkdown } from "./writer.mjs";
import { createMockAgent, MOCK_MODEL } from "./agents/mock.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const DEFAULT_OUT = join(HERE, "..", "results");

const AGENTS = ["mock", "mock-flaky", "anthropic"];

export function parseArgs(argv) {
  const out = { agent: "mock", gateway: DEFAULT_GATEWAY_URL, out: DEFAULT_OUT, model: null, effort: "high" };
  for (let i = 0; i < argv.length; i += 1) {
    const [k, v] = [argv[i], argv[i + 1]];
    if (k === "--agent") { out.agent = v; i += 1; }
    else if (k === "--gateway") { out.gateway = v; i += 1; }
    else if (k === "--out") { out.out = v; i += 1; }
    else if (k === "--model") { out.model = v; i += 1; }
    else if (k === "--effort") { out.effort = v; i += 1; }
    else throw new Error(`unknown flag: ${k}`);
  }
  if (!AGENTS.includes(out.agent)) throw new Error(`unknown agent: ${out.agent} (expected ${AGENTS.join(" | ")})`);
  return out;
}

async function makeAgent(args) {
  if (args.agent === "mock") return { runAgent: createMockAgent(), isMock: true };
  if (args.agent === "mock-flaky") return { runAgent: createMockAgent({ flaky: true }), isMock: true };
  const { createAnthropicAgent, DEFAULT_MODEL } = await import("./agents/anthropic.mjs");
  return { runAgent: await createAnthropicAgent({ model: args.model ?? DEFAULT_MODEL, effort: args.effort }), isMock: false };
}

export async function main(argv) {
  const args = parseArgs(argv);
  const resources = await loadResources({ repoRoot: REPO_ROOT, gatewayUrl: args.gateway });
  const { runAgent, isMock } = await makeAgent(args);

  const run = await runAbHarness({ runAgent, resources });
  run.meta.agentAdapter = args.agent;
  run.meta.isMock = isMock;
  run.meta.gatewayUrl = args.gateway;
  if (isMock) run.meta.mockModel = MOCK_MODEL;

  const dir = await writeRun(run, { baseDir: args.out });
  const verified = await verifyRunDir(dir);
  const report =
    renderSummaryMarkdown(run, aggregate(run)) +
    "\n" +
    (verified.ok
      ? `verify: OK — summary.json matches trials.jsonl (recounted from the raw log)\n`
      : `verify: FAILED\n${verified.mismatches.map((m) => `  - ${m}`).join("\n")}\n`) +
    `written: ${dir}\n`;

  return { args, run, dir, verified, report, exitCode: verified.ok ? 0 : 1 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = await main(process.argv.slice(2));
  process.stdout.write(r.report);
  process.exitCode = r.exitCode;
}
