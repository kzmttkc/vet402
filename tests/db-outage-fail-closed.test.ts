// ============================================================
// 2026-09-29 敵対的監査 4 周目（障害対応・重要度 高）: DB 不通で 500。
//
// `getDb()` は DATABASE_URL があれば常に値を返す。ip-rate-limit の fail-closed 分岐は
// 「DB が設定されていない」ときにしか通らず、DB が**不通**のときは例外がそのまま投げられて、
// health・resolve・鍵なし decision・/rwa/[addr]・鍵あり（auth.ts の catch 内で再び DB を叩く）が
// 全部 500 で終わっていた。ここでは「全ての呼び出しが投げる DB」を差し込み、
// どの入口も 500 を返さず、503＋Retry-After で答えることを固定する。
// ============================================================
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { __setDbForTests } from "@/lib/db/client";
import { consumeIpRateLimit, IP_RATE_LIMIT_UNAVAILABLE_RETRY_AFTER_SEC } from "@/lib/api/ip-rate-limit";
import { GET as health } from "@/app/api/health/route";
import { GET as resolveRoute } from "@/app/api/v1/resolve/route";
import { GET as decisionRoute } from "@/app/api/v1/resources/[resourceId]/decision/route";
import { authenticateRequest } from "@/lib/api/auth";
import { applyRateLimit } from "@/lib/api/guard";
import { currentVerdict, getStatusHistory, STATUS_STALE_AFTER_MS } from "@/lib/health/snapshot";

/** どのメソッドを呼んでも接続拒否で投げる DB。drizzle のメソッド連鎖の先頭で落ちる。 */
function unreachableDb(): unknown {
  const fail = () => {
    throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
  };
  return new Proxy({}, { get: (_t, prop) => (prop === "then" ? undefined : fail) });
}

__setDbForTests(unreachableDb());
after(() => __setDbForTests(null));

const RESOURCE_ID = "a".repeat(64);

test("consumeIpRateLimit: DB が投げたら拒否（unavailable・短い Retry-After）。投げ返さない", async () => {
  const r = await consumeIpRateLimit("outage:test", 60, 86_400_000);
  assert.equal(r.allowed, false, "判定できないなら通さない（fail-closed）");
  assert.equal(r.unavailable, true);
  assert.equal(r.remaining, 0);
  assert.equal(r.retryAfter, IP_RATE_LIMIT_UNAVAILABLE_RETRY_AFTER_SEC, "窓の長さ（1日）ではなく短く");
});

test("/api/health: DB 不通は 503 {status:error}（500 でも 429 でもない）", async () => {
  const res = await health(new NextRequest("http://localhost/api/health"));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { status: "error" });
  assert.ok(res.headers.get("Retry-After"));
});

test("/api/v1/resolve: DB 不通は 503＋Retry-After", async () => {
  const res = await resolveRoute(new NextRequest("http://localhost/api/v1/resolve?q=example.com"));
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("Retry-After"), String(IP_RATE_LIMIT_UNAVAILABLE_RETRY_AFTER_SEC));
  assert.deepEqual(await res.json(), { error: "temporarily_unavailable" });
});

test("鍵なし decision: DB 不通は 503", async () => {
  const res = await decisionRoute(
    new NextRequest(`http://localhost/api/v1/resources/${RESOURCE_ID}/decision?role=payer`),
    { params: Promise.resolve({ resourceId: RESOURCE_ID }) },
  );
  assert.equal(res.status, 503);
  assert.ok(res.headers.get("Retry-After"));
});

test("鍵あり: verifyApiKey が投げ、catch 内の IP 枠も DB 不通 → 503 auth_unavailable（500 にしない）", async () => {
  const auth = await authenticateRequest(
    new Request("http://localhost/api/v1/x", { headers: { authorization: "Bearer vk_live_not_a_real_key_0000" } }),
  );
  assert.equal(auth.ok, false);
  assert.equal(auth.error?.status, 503);
  assert.equal((await auth.error!.json()).error, "auth_unavailable");
  assert.ok(auth.error?.headers.get("Retry-After"));
});

test("鍵あり: 月次枠の DB が投げたら 503 rate_limit_unavailable", async () => {
  const limited = await applyRateLimit({ apiKeyId: "key-under-outage", plan: "free" }, 1);
  assert.equal(limited.ok, false);
  if (limited.ok) return;
  assert.equal(limited.error.status, 503);
  assert.equal((await limited.error.json()).error, "rate_limit_unavailable");
  assert.ok(limited.error.headers.get("Retry-After"));
});

// ---- /status（監査4周目・重要度 高）: DB 障害が頁に出ない ----

test("getStatusHistory: DB が投げたら throw せず unreadable（ISR が直前の ok を出し続けない）", async () => {
  const h = await getStatusHistory(30);
  assert.equal(h.unreadable, true);
  assert.equal(h.current, null);
  assert.deepEqual(currentVerdict(h, new Date()), { kind: "unreadable" });
});

test("currentVerdict: 最後の行が閾値より古ければ ok と言わず stale", () => {
  const now = new Date("2026-09-29T12:00:00Z");
  const fresh = new Date(now.getTime() - (STATUS_STALE_AFTER_MS - 60_000));
  const old = new Date(now.getTime() - (STATUS_STALE_AFTER_MS + 60_000));
  const base = { days: [], monitoringSince: null };
  const f = currentVerdict({ ...base, current: { status: "ok", checkedAt: fresh } }, now);
  assert.equal(f.kind, "fresh");
  const s = currentVerdict({ ...base, current: { status: "ok", checkedAt: old } }, now);
  assert.equal(s.kind, "stale");
  assert.equal(s.kind === "stale" && s.lastStatus, "ok");
  assert.equal(currentVerdict({ ...base, current: null }, now).kind, "none");
});
