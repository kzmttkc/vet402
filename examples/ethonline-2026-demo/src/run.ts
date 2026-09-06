#!/usr/bin/env node
/**
 * ETHOnline 2026 のデモで**実際に映す CLI**（WINDOW_PLAN §6 の 0:45–1:15 / 1:15–1:30 / 1:30–2:05）。
 *
 *   node src/run.ts refuse          2つの独立した源を並べて、署名の前に拒む
 *   node src/run.ts pay             何に署名するはずだったかを出す（**空撃ち・既定**）
 *   node src/run.ts pay --live      実際に署名して $0.01 を送る（**人間が明示したときだけ**）
 *   node src/run.ts judge <url>     審査員の 402 URL を同じ画で見て、**署名なし**の判定を出す
 *
 * 鍵は環境変数からしか読まない（`GRAPH_API_KEY` / `VOUCH_API_KEY` / `DEMO_PAYER_PRIVATE_KEY`）。
 * 出力は必ず `./emit.ts` を通り、そこで伏せられる——**この画面は撮影で映る**。
 */
import { realpathSync } from "node:fs";
import { createEmitter, stdoutSink } from "./emit.ts";
import { ExpectedFailure } from "./probe.ts";
import { collectSecrets } from "./redact.ts";
import { runRefuse } from "./refuse.ts";
import { runPay } from "./pay.ts";
import { parseJudgeArgs, runJudge } from "./judge.ts";

export const USAGE = [
  "",
  " vet402 · ETHOnline 2026 demo",
  "",
  "   node src/run.ts refuse         refuse before a signature can exist (two sources, side by side)",
  "   node src/run.ts pay            dry run: what would have been signed. Nothing is signed.",
  "   node src/run.ts pay --live     actually sign and send $0.01 to The Graph. A human decision.",
  "   node src/run.ts judge <url>    your own x402 URL: same picture, dry-run verdict. No signing path.",
  "        [--method POST] [--body '<json>'] [--policy vet402|subgraph|both]",
  "        [--min-subgraph-receipts N] [--min-l1-deliveries N] [--ceiling-usd X]",
  "        a floor >= 1 waives vet402's verdict (as `pay` does); BLOCK and degraded never waive.",
  "",
  "   --color                        add ANSI emphasis (meaning never depends on it)",
  "",
  " env  GRAPH_API_KEY, VOUCH_API_KEY   (refuse, pay; judge needs GRAPH_API_KEY only with --policy subgraph|both)",
  "      DEMO_PAYER_PRIVATE_KEY         (pay --live only)",
  " Values are never printed.",
  "",
];

export type Parsed = { command: "refuse" | "pay" | "judge" | null; live: boolean; color: boolean };

/**
 * `--live` は**綴りが完全一致したときにだけ**立つ。事故で払わないための唯一の関門。
 * `judge` の残りの引数は `parseJudgeArgs`（`--live` はそこで拒まれる）。
 */
export function parseArgv(argv: string[]): Parsed {
  const first = argv[0];
  const command = first === "refuse" || first === "pay" || first === "judge" ? first : null;
  return {
    command,
    live: argv.includes("--live"),
    color: argv.includes("--color"),
  };
}

/**
 * 落ちたときに画面へ出す行。**鍵が無い・402 でない URL・引数の誤りは想定内**なので整形済み1行だけ
 * （審査員が最初に踏む場所で 7行のスタックは「壊れている」と読まれる）。
 * それ以外は原因を隠さないためスタックを残す。
 */
export function failureLines(error: unknown): string[] {
  if (error instanceof ExpectedFailure) return [`error: ${error.message}`];
  if (error instanceof Error) {
    return typeof error.stack === "string" ? [`error: ${error.message}`, error.stack] : [`error: ${error.message}`];
  }
  return [`error: ${String(error)}`];
}

async function main(): Promise<void> {
  const parsed = parseArgv(process.argv.slice(2));
  const emit = createEmitter({ sink: stdoutSink, secrets: collectSecrets(process.env) });
  if (parsed.command === null) {
    emit.lines(USAGE);
    process.exitCode = 1;
    return;
  }
  try {
    if (parsed.command === "refuse") {
      await runRefuse({ env: process.env, fetch: globalThis.fetch, emit, color: parsed.color });
      return;
    }
    if (parsed.command === "judge") {
      const args = parseJudgeArgs(process.argv.slice(3));
      await runJudge({ ...args, env: process.env, fetch: globalThis.fetch, emit });
      return;
    }
    await runPay({ live: parsed.live, env: process.env, fetch: globalThis.fetch, emit, color: parsed.color });
  } catch (error) {
    emit.lines(failureLines(error));
    process.exitCode = 1;
  }
}

// テストから import されたときは走らせない（このファイルが直接起動されたときだけ走る）。
const invoked = process.argv[1] === undefined ? "" : realpathSync(process.argv[1]);
if (invoked !== "" && invoked === realpathSync(import.meta.filename)) {
  await main();
}
