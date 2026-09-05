#!/usr/bin/env node
/**
 * ETHOnline 2026 のデモで**実際に映す CLI**（WINDOW_PLAN §6 の 0:45–1:15 / 1:15–1:30 / 1:30–2:05）。
 *
 *   node src/run.ts refuse          2つの独立した源を並べて、署名の前に拒む
 *   node src/run.ts pay             何に署名するはずだったかを出す（**空撃ち・既定**）
 *   node src/run.ts pay --live      実際に署名して $0.01 を送る（**人間が明示したときだけ**）
 *
 * 鍵は環境変数からしか読まない（`GRAPH_API_KEY` / `VOUCH_API_KEY` / `DEMO_PAYER_PRIVATE_KEY`）。
 * 出力は必ず `./emit.ts` を通り、そこで伏せられる——**この画面は撮影で映る**。
 */
import { realpathSync } from "node:fs";
import { createEmitter, stdoutSink } from "./emit.ts";
import { collectSecrets } from "./redact.ts";
import { runRefuse } from "./refuse.ts";
import { runPay } from "./pay.ts";

export const USAGE = [
  "",
  " vet402 · ETHOnline 2026 demo",
  "",
  "   node src/run.ts refuse         refuse before a signature can exist (two sources, side by side)",
  "   node src/run.ts pay            dry run: what would have been signed. Nothing is signed.",
  "   node src/run.ts pay --live     actually sign and send $0.01 to The Graph. A human decision.",
  "",
  "   --color                        add ANSI emphasis (meaning never depends on it)",
  "",
  " env  GRAPH_API_KEY, VOUCH_API_KEY   (both commands)",
  "      DEMO_PAYER_PRIVATE_KEY         (--live only)",
  " Values are never printed.",
  "",
];

export type Parsed = { command: "refuse" | "pay" | null; live: boolean; color: boolean };

/** `--live` は**綴りが完全一致したときにだけ**立つ。事故で払わないための唯一の関門。 */
export function parseArgv(argv: string[]): Parsed {
  const first = argv[0];
  const command = first === "refuse" || first === "pay" ? first : null;
  return {
    command,
    live: argv.includes("--live"),
    color: argv.includes("--color"),
  };
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
    await runPay({ live: parsed.live, env: process.env, fetch: globalThis.fetch, emit, color: parsed.color });
  } catch (error) {
    emit.error(error);
    process.exitCode = 1;
  }
}

// テストから import されたときは走らせない（このファイルが直接起動されたときだけ走る）。
const invoked = process.argv[1] === undefined ? "" : realpathSync(process.argv[1]);
if (invoked !== "" && invoked === realpathSync(import.meta.filename)) {
  await main();
}
