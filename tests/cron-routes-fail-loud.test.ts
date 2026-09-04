// ============================================================
// cron ルートは例外を握らずに 500 で返し、理由をログへ出す（2026-09-04 監査 D・P1）。
//
// try を持たない cron ルートが 8 本あった。lib が throw すると Next の既定 500（HTML）が
// 返り、uptime-cron / Vercel のログには「500」しか残らず、理由が消える。verify-the-
// instrument と同じ形——壊れたことは分かるが何が壊れたかが誰にも届かない。
// 全 cron ルートで { ok:false, error } を HTTP 500 で返し、logServerError に理由を残す。
// ============================================================
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { __setDbForTests } from "@/lib/db/client";

const CRON_DIR = join(process.cwd(), "src/app/api/cron");

// monitor-health は runDeepHealthChecks が内部で失敗を集約して 503 を決める設計（別系統）。
const EXEMPT = new Set(["monitor-health"]);

test("全 cron ルートが try/catch と logServerError を持つ", () => {
  const routes = readdirSync(CRON_DIR).filter((d) => !EXEMPT.has(d));
  assert.ok(routes.length >= 14, `cron ルートが見つからない: ${routes.length}`);
  for (const name of routes) {
    const src = readFileSync(join(CRON_DIR, name, "route.ts"), "utf8");
    assert.match(src, /try \{/, `${name}: try が無い——lib の throw が理由なしの 500 になる`);
    assert.match(src, /logServerError\(/, `${name}: logServerError が無い——理由がログに残らない`);
  }
});

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

test("purge-logs: DB が落ちたら {ok:false,error} を 500 で返し、理由がログに出る", async () => {
  process.env.CRON_SECRET = "test-cron-secret";
  process.env.DATABASE_URL ??= "postgres://unused";
  const { GET } = await import("@/app/api/cron/purge-logs/route");
  __setDbForTests({
    execute: async () => Promise.reject(new Error("ECONNREFUSED trust_events")),
    delete: () => ({ where: () => ({ returning: async () => [] }) }),
  });
  try {
    const req = new Request("http://localhost/api/cron/purge-logs", {
      headers: { authorization: "Bearer test-cron-secret" },
    });
    const { value: res, logged } = await captureConsoleError(() => GET(req as never));
    assert.equal(res.status, 500);
    const body = (await res.json()) as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.match(body.error, /ECONNREFUSED trust_events/);
    assert.ok(
      logged.some((l) => l.includes("cron.purge-logs") && l.includes("ECONNREFUSED trust_events")),
      `理由がログに出る: ${logged.join(" | ")}`,
    );
  } finally {
    __setDbForTests(null);
  }
});
