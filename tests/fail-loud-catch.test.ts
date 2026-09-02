// ============================================================
// 失敗を握りつぶさない（2026-09-02 敵対的監査）。
//
// corrections（訂正ログ）と decision_lookups（問い合わせ回数）は「失敗しても主処理を
// 落とさない」が正しい——が、`.catch(() => null)` は落とさないだけでなく**見えなく**
// していた。5 週間の誤報（verify-the-instrument）と同じ形。主処理は守り、理由は
// logServerError へ出す。
// ============================================================
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { logAndSwallow } from "@/lib/util/log";

function captureConsoleError<T>(fn: () => Promise<T>): Promise<{ value: T; logged: string[] }> {
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  return fn()
    .then((value) => ({ value, logged }))
    .finally(() => {
      console.error = orig;
    });
}

test("logAndSwallow: 拒否を undefined に変えつつ文脈と理由をログに出す", async () => {
  const { value, logged } = await captureConsoleError(() =>
    Promise.reject(new Error("relation corrections does not exist")).catch(logAndSwallow("test.ctx")),
  );
  assert.equal(value, undefined);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /test\.ctx/);
  assert.match(logged[0], /relation corrections does not exist/);
});

test("recordDecisionLookup: DB の失敗は判定を落とさず、理由がログに出る", async () => {
  process.env.DATABASE_URL ??= "postgres://unused";
  const { __setDbForTests } = await import("@/lib/db/client");
  const { recordDecisionLookup } = await import("@/lib/decision/decide");
  __setDbForTests({ execute: async () => Promise.reject(new Error("ECONNREFUSED decision_lookups")) });
  try {
    const { logged } = await captureConsoleError(() => recordDecisionLookup("11111111-1111-4111-8111-111111111111"));
    assert.ok(logged.some((l) => l.includes("ECONNREFUSED decision_lookups")), `理由が出る: ${logged.join(" | ")}`);
  } finally {
    __setDbForTests(null);
  }
});

test("corrections / decision_lookups の呼び出し側に無言の catch が残っていない", () => {
  for (const f of [
    "src/lib/observatory/disputes.ts",
    "src/lib/observatory/settlement-verifier.ts",
    "src/lib/decision/decide.ts",
  ]) {
    const src = readFileSync(f, "utf8");
    assert.equal(/\.catch\(\(\) => (null|undefined)\)/.test(src), false, `${f} に .catch(() => null|undefined) が残っている`);
  }
});
