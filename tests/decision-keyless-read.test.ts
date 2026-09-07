// ============================================================
// /decision の鍵なし読み取り枠（AQ-053・2026-09-07 Takeshi 承認）。
//
// 審査員が SKILL.md を鍵 1 本（Graph）で歩けるように、GET /api/v1/resources/{id}/decision
// は Authorization 無しでも答える。枠は IP ごと 10 回/分（census/summary と同じ
// publicRateLimit 部品・語彙は既存の `rate_limited`）。本文は鍵ありと同一。
// 鍵ありは従来どおり月次プラン枠で、この IP 枠には掛からない。
// DECISION_KEYLESS_READ=0 で従来の 401 に戻せる。
//
// DB は持ち込まない: __setDbForTests に、endpoint 1 行・runtime_flags 無し・
// ip_rate_limits の upsert 意味論（consumeDbIpRateLimit と同じ「count > limit で拒否」）
// だけを持つフェイクを差す。判定本体は decisionCache に種を撒いて decide() のキャッシュ
// ヒットで返す——ここで検査したいのは認可と枠であって判定規則ではない。
// ============================================================
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { __setDbForTests } from "@/lib/db/client";
import { ipRateLimits } from "@/lib/db/schema";
import { decisionCache } from "@/lib/decision/cache";
import { GET } from "@/app/api/v1/resources/[resourceId]/decision/route";

const RID = "a".repeat(64);
const UNKNOWN_RID = "b".repeat(64);
const OBS_ID = "11111111-2222-4333-8444-555555555555";
const DEV_KEY = "dev_local_test_key";
const SEEDED_RESULT = {
  recommendation: "ALLOW",
  reason_codes: [],
  facts: { l0: { status: "up" } },
  evidence: [{ source: "vet402", kind: "l0_probe" }],
  rules_version: "test",
};

/** 常に自分自身を返し、await すると rows になる drizzle 風の鎖（select 用）。 */
function chain(rows: unknown[]): unknown {
  const proxy: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (resolve: (v: unknown[]) => void) => resolve(rows);
      return () => proxy;
    },
    apply() {
      return proxy;
    },
  });
  return proxy;
}

type Bucket = { count: number; resetAt: Date };

function fakeDb() {
  const buckets = new Map<string, Bucket>();
  return {
    execute: async (q: { queryChunks?: unknown[] }) => {
      const text = JSON.stringify(q.queryChunks ?? q);
      // refundIpRateLimit（ip-rate-limit.ts）の UPDATE … SET count = GREATEST(count - 1, 0) WHERE bucket_key = $1
      if (text.includes("ip_rate_limits") && text.includes("GREATEST")) {
        const key = /"(decision:[^"]+)"/.exec(text)?.[1];
        const cur = key ? buckets.get(key) : undefined;
        if (cur && cur.resetAt.getTime() > Date.now() && cur.count > 0) cur.count -= 1;
        return { rows: [] };
      }
      if (text.includes("x402_endpoints")) {
        if (!text.includes(RID)) return { rows: [] };
        return {
          rows: [
            {
              observatory_id: OBS_ID,
              endpoint_hash: "c".repeat(64),
              resource_id: RID,
              canonical_url: "https://example.com/x402/thing",
              method: "GET",
              payee_id: null,
              status: "active",
              first_seen: null,
              last_seen: null,
            },
          ],
        };
      }
      return { rows: [] };
    },
    select: () => chain([]),
    update: () => chain([]),
    insert: (table: unknown) => ({
      values: (v: { bucketKey: string; count: number; resetAt: Date }) => ({
        onConflictDoUpdate: () => ({
          returning: async () => {
            assert.equal(table, ipRateLimits, "フェイクは ip_rate_limits の upsert しか知らない");
            const now = Date.now();
            const cur = buckets.get(v.bucketKey);
            const next: Bucket =
              !cur || cur.resetAt.getTime() <= now ? { count: 1, resetAt: v.resetAt } : { count: cur.count + 1, resetAt: cur.resetAt };
            buckets.set(v.bucketKey, next);
            return [{ bucketKey: v.bucketKey, count: next.count, resetAt: next.resetAt }];
          },
        }),
      }),
    }),
  };
}

function req(rid: string, opts: { ip?: string; key?: string } = {}) {
  const headers: Record<string, string> = { "x-forwarded-for": opts.ip ?? "203.0.113.10" };
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  return new NextRequest(`http://localhost/api/v1/resources/${rid}/decision?role=payer`, { headers });
}

function call(rid: string, opts: { ip?: string; key?: string } = {}) {
  return GET(req(rid, opts), { params: Promise.resolve({ resourceId: rid }) });
}

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["PROXY_HEADER_SOURCE", "DEV_API_KEY", "DECISION_KEYLESS_READ", "DATABASE_URL"];

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.PROXY_HEADER_SOURCE = "generic";
  process.env.DEV_API_KEY = DEV_KEY;
  delete process.env.DECISION_KEYLESS_READ;
  __setDbForTests(fakeDb());
  decisionCache.clear();
  // decide() のキー: `${observatoryId}|payer|${dialect ?? "-"}|${allowWithoutL1}|${operatorBlacklist}|${halted}`
  decisionCache.set(`${OBS_ID}|payer|-|0|0|0`, { result: SEEDED_RESULT, expiresAt: Date.now() + 60_000 });
});

afterEach(() => {
  __setDbForTests(null);
  decisionCache.clear();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

test("(a) 鍵なしでも 200・本文は鍵ありと同一（recommendation / facts / evidence を削らない）", async () => {
  const anon = await call(RID);
  const anonText = await anon.text();
  assert.equal(anon.status, 200, anonText);
  const anonBody = JSON.parse(anonText);
  assert.equal(anonBody.recommendation, "ALLOW");
  assert.ok(anonBody.facts && Array.isArray(anonBody.evidence), "facts / evidence が落ちている");
  assert.equal(anon.headers.get("RateLimit-Limit"), "10", "枠の天井を線上に出す");

  const keyed = await call(RID, { key: DEV_KEY });
  assert.equal(keyed.status, 200);
  assert.deepEqual(anonBody, await keyed.json(), "鍵の有無で本文が変わってはいけない");
});

test("(b) 同一 IP の 11 回目は 429・Retry-After 付き・語彙は rate_limited", async () => {
  for (let i = 1; i <= 10; i++) {
    const res = await call(RID);
    assert.equal(res.status, 200, `${i} 回目が ${res.status}`);
  }
  const eleventh = await call(RID);
  assert.equal(eleventh.status, 429);
  assert.ok(eleventh.headers.get("Retry-After"), "いつ戻ればよいかを言う");
  assert.equal(eleventh.headers.get("RateLimit-Remaining"), "0");
  assert.deepEqual(await eleventh.json(), { error: "rate_limited" });
});

test("(c) 別 IP のバケツは独立（全員同じバケツにしない）", async () => {
  for (let i = 0; i < 10; i++) await call(RID, { ip: "203.0.113.10" });
  assert.equal((await call(RID, { ip: "203.0.113.10" })).status, 429);
  const other = await call(RID, { ip: "198.51.100.7" });
  assert.equal(other.status, 200, await other.text());
});

test("(d) DECISION_KEYLESS_READ=0 なら鍵なしは従来どおり 401 missing_api_key", async () => {
  process.env.DECISION_KEYLESS_READ = "0";
  const res = await call(RID);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "missing_api_key");
});

test("(e) 鍵ありには IP 枠が効かない: 同一 IP から 12 回全部 200", async () => {
  for (let i = 1; i <= 12; i++) {
    const res = await call(RID, { key: DEV_KEY });
    assert.equal(res.status, 200, `${i} 回目が ${res.status}: ${await res.text()}`);
    assert.equal(res.headers.get("RateLimit-Limit"), null, "鍵ありの応答に IP 枠のヘッダを混ぜない");
    assert.ok(res.headers.get("X-RateLimit-Limit"), "鍵ありは従来の月次枠ヘッダのまま");
  }
});

test("(f) カタログ外は鍵なしでも 404 not_found——鍵の有無で漏れる情報が変わらない", async () => {
  const anon = await call(UNKNOWN_RID);
  assert.equal(anon.status, 404);
  const anonBody = await anon.json();
  assert.deepEqual(anonBody, { error: "not_found" });
  const keyed = await call(UNKNOWN_RID, { key: DEV_KEY });
  assert.equal(keyed.status, 404);
  assert.deepEqual(await keyed.json(), anonBody);
});

test("間違った鍵は匿名扱いに落ちず 401 のまま（顧客の WL/BL が黙って外れない）", async () => {
  const res = await call(RID, { key: "not_the_dev_key" });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "invalid_api_key");
});

// ---- 2026-09-07 第三者監査 A7 ＋ 追加3: admit 以降の早期 return（400 / 404 / 503）も finish() を通す ----
//
// HEAD 0ebec74 では 404 not_found（:157-159, :170-172）と 400 invalid_resource_id（:83-84）等が
// finish() を通らず返っていた。鍵なしでは RateLimit-* ヘッダが無く、枠だけ消費される（鍵ありは
// refund で月次単位を戻すが、鍵なしには戻す経路が無かった）。規則は鍵ありに揃える:
// 早期 return でも枠のヘッダを付け、消費した 1 回分を戻す。

test("(g) 鍵なしの 404 not_found にも RateLimit-* ヘッダが付き、IP 枠は消費されない（鍵ありの refund と同じ規則）", async () => {
  for (let i = 1; i <= 10; i++) {
    const res = await call(UNKNOWN_RID);
    assert.equal(res.status, 404, `${i} 回目が ${res.status}`);
    assert.equal(res.headers.get("RateLimit-Limit"), "10", `${i} 回目の 404 に枠の天井が無い`);
    assert.ok(res.headers.get("RateLimit-Remaining") !== null, `${i} 回目の 404 に残数が無い`);
  }
  // 404 を 10 回踏んでも枠は戻っているので、11 回目の本物の照会は 200。
  const real = await call(RID);
  assert.equal(real.status, 200, `404 が枠を消費している: ${await real.text()}`);
});

test("(h) 鍵なしの 400 invalid_resource_id にも RateLimit-* ヘッダが付き、IP 枠は消費されない", async () => {
  for (let i = 1; i <= 10; i++) {
    const res = await call("not-a-resource-id");
    assert.equal(res.status, 400, `${i} 回目が ${res.status}`);
    assert.deepEqual(await res.json(), { error: "invalid_resource_id" });
    assert.equal(res.headers.get("RateLimit-Limit"), "10", `${i} 回目の 400 に枠の天井が無い`);
  }
  const real = await call(RID);
  assert.equal(real.status, 200, `400 が枠を消費している: ${await real.text()}`);
});

test("(i) 鍵ありの 404 / 400 にも従来の X-RateLimit-* ヘッダが付く（早期 return が finish を通る）", async () => {
  const notFound = await call(UNKNOWN_RID, { key: DEV_KEY });
  assert.equal(notFound.status, 404);
  assert.ok(notFound.headers.get("X-RateLimit-Limit"), "鍵ありの 404 に月次枠のヘッダが無い");
  assert.equal(notFound.headers.get("RateLimit-Limit"), null, "鍵ありの応答に IP 枠のヘッダを混ぜない");
  const bad = await call("not-a-resource-id", { key: DEV_KEY });
  assert.equal(bad.status, 400);
  assert.ok(bad.headers.get("X-RateLimit-Limit"), "鍵ありの 400 に月次枠のヘッダが無い");
});
