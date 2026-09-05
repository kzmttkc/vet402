/**
 * 出力の**唯一の口**。この CLI が画面へ出す文字は、例外の本文とスタックも含めて
 * すべてここを通り、通る途中で {@link ./redact.ts} が掛かる。
 *
 * 呼び手が redact を忘れても効くようにするための設計で、`test/emit.test.mjs` は
 * 「`src/` の他のファイルが `console.*` や `process.stdout.write` を持たない」ことまで
 * 検査する——**忘れられる規律ではなく、迂回できない経路**にする。
 */
import { makeRedactor } from "./redact.ts";

export type Emitter = {
  line: (text?: string) => void;
  lines: (texts: string[]) => void;
  error: (error: unknown) => void;
};

export function createEmitter(options: { sink: (line: string) => void; secrets: string[] }): Emitter {
  const redact = makeRedactor(options.secrets);
  const write = (text: string): void => options.sink(redact(text));
  return {
    line: (text = "") => write(text),
    lines: (texts: string[]) => {
      for (const text of texts) write(text);
    },
    error: (error: unknown) => {
      if (error instanceof Error) {
        write(`error: ${error.message}`);
        if (typeof error.stack === "string") write(error.stack);
        return;
      }
      write(`error: ${String(error)}`);
    },
  };
}

/** 既定の口。**ここだけが標準出力を知っている。** */
export function stdoutSink(text: string): void {
  process.stdout.write(text + "\n");
}
