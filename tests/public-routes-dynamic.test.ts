// ============================================================
// 公開ルートは全て force-dynamic（2026-09-02 監査指摘）。
//
// 2026-08-22 に /api/transparency/operator-overrides で同じ欠陥を直している
// （09c1fa0: 静的化された route handler が prerender から返り、レート制限も
// 鮮度も効かない）。同じ形が公開ルート 37 本に残っていた。
//
// Next.js は request を読まない GET handler を静的化しうる。判定・観測結果・
// 台帳を返すルートがビルド時の値を返し続けるのは、「払う前に、測った事実を
// 返す」製品として致命的なので、明示で塞ぐ。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

function routes(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) routes(p, out);
    else if (e.name === "route.ts") out.push(p);
  }
  return out;
}

test("公開ルートは全て `export const dynamic = \"force-dynamic\"` を持つ", () => {
  const targets = [
    ...routes(join(ROOT, "src/app/api/v1")),
    ...routes(join(ROOT, "src/app/api/badge")),
    join(ROOT, "src/app/api/health/route.ts"),
  ];
  assert.ok(targets.length >= 30, `対象が少なすぎる: ${targets.length}`);
  const missing = targets
    .filter((f) => !/export const dynamic = "force-dynamic";/.test(readFileSync(f, "utf8")))
    .map((f) => f.slice(ROOT.length));
  assert.deepEqual(missing, []);
});
