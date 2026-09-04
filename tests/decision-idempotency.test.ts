// ============================================================
// /decision の Idempotency-Key は保存した応答を再送する（2026-09-04 監査 B・P2）。
//
// 従来はプロセス内 Map に「見た」ことだけを覚え、再送はレート単位を返金しつつ毎回再計算
// していた。Vercel は複数インスタンスなので別インスタンスへ落ちた再送は初回扱いになり、
// 同じキーで違う応答が返り得る。ip_rate_limits と同じ DB 表 decision_idempotency に
// 応答本体を 10 分保存し、再送はそれをそのまま返す。
// ============================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { __setDbForTests } from "@/lib/db/client";
import { getIdempotentResponse, idempotencyKeyHash, saveIdempotentResponse } from "@/lib/api/idempotency";

type Captured = { text: string; params: unknown[] };

/** db.execute(sql`...`) を捕まえ、決めた rows を返すフェイク。 */
function fakeDb(rows: unknown[] | Error, captured: Captured[]) {
  return {
    execute: async (q: { toSQL?: () => { sql: string; params: unknown[] }; queryChunks?: unknown[] }) => {
      const text = JSON.stringify(q.queryChunks ?? q);
      const params: unknown[] = [];
      // drizzle の sql テンプレートは束縛値（string / Date / number）を生のまま chunk に並べる。
      for (const c of q.queryChunks ?? []) {
        if (c instanceof Date || typeof c === "string" || typeof c === "number") params.push(c);
      }
      captured.push({ text, params });
      if (rows instanceof Error) throw rows;
      return { rows };
    },
  };
}

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

test("idempotencyKeyHash: sha256 hex・同じ材料なら同じ・材料が違えば違う", () => {
  const a = idempotencyKeyHash(["key1", "res", "payer", "-", "abc"]);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, idempotencyKeyHash(["key1", "res", "payer", "-", "abc"]));
  assert.notEqual(a, idempotencyKeyHash(["key2", "res", "payer", "-", "abc"]));
  // 区切りの曖昧さ（"a|b","c" と "a","b|c"）で衝突しない
  assert.notEqual(idempotencyKeyHash(["a|b", "c"]), idempotencyKeyHash(["a", "b|c"]));
});

test("getIdempotentResponse: 行が無ければ null、あれば保存した body を返す", async () => {
  process.env.DATABASE_URL ??= "postgres://unused";
  const captured: Captured[] = [];
  __setDbForTests(fakeDb([], captured));
  try {
    assert.equal(await getIdempotentResponse("k".repeat(64)), null);
    assert.match(captured[0].text, /decision_idempotency/);
    assert.match(captured[0].text, /expires_at > now\(\)/);
  } finally {
    __setDbForTests(null);
  }
  const body = { recommendation: "ALLOW", facts: { l0: "pass" } };
  __setDbForTests(fakeDb([{ body }], []));
  try {
    assert.deepEqual(await getIdempotentResponse("k".repeat(64)), body);
  } finally {
    __setDbForTests(null);
  }
});

test("saveIdempotentResponse: 単一文で期限切れを掃きつつ upsert する（読んでから書かない）", async () => {
  process.env.DATABASE_URL ??= "postgres://unused";
  const captured: Captured[] = [];
  __setDbForTests(fakeDb([], captured));
  try {
    const before = Date.now();
    await saveIdempotentResponse("h".repeat(64), { ok: true }, 10 * 60_000);
    assert.equal(captured.length, 1, "1 文で済ませる");
    assert.match(captured[0].text, /INSERT INTO decision_idempotency/);
    assert.match(captured[0].text, /DELETE FROM decision_idempotency WHERE expires_at <= now\(\)/);
    assert.match(captured[0].text, /ON CONFLICT \(key_hash\) DO NOTHING/);
    const exp = captured[0].params.find((p) => p instanceof Date) as Date | undefined;
    assert.ok(exp, "expires_at が渡っていない");
    assert.ok(exp.getTime() - before >= 10 * 60_000 - 50 && exp.getTime() - before <= 10 * 60_000 + 5_000);
  } finally {
    __setDbForTests(null);
  }
});

test("DB が落ちても判定を止めない: get は null、save は投げない、理由はログに出る", async () => {
  process.env.DATABASE_URL ??= "postgres://unused";
  __setDbForTests(fakeDb(new Error("relation decision_idempotency does not exist"), []));
  try {
    const { value, logged } = await captureConsoleError(async () => {
      const got = await getIdempotentResponse("z".repeat(64));
      await saveIdempotentResponse("z".repeat(64), { x: 1 }, 1000);
      return got;
    });
    assert.equal(value, null);
    assert.equal(logged.length, 2);
    assert.ok(logged.every((l) => l.includes("relation decision_idempotency does not exist")), logged.join(" | "));
  } finally {
    __setDbForTests(null);
  }
});

test("decision route: プロセス内 Map を捨て、保存応答の再送に切り替わっている", () => {
  const src = readFileSync(join(process.cwd(), "src/app/api/v1/resources/[resourceId]/decision/route.ts"), "utf8");
  assert.doesNotMatch(src, /new Map<string, number>\(\)/, "プロセス内 Map が残っている");
  assert.match(src, /getIdempotentResponse\(/);
  assert.match(src, /saveIdempotentResponse\(/);
  assert.match(src, /Idempotent-Replay/, "再送であることを応答ヘッダで示す");
});
