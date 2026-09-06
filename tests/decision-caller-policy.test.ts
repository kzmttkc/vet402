// ============================================================
// /decision が**呼び手の policy** を受け取り、SDK と同じ語で答える（ETHOnline 2026・
// WINDOW_PLAN §16.3 の穴を製品側で閉じる・2026-09-07 Takeshi 採用）。
//
// §16.3 の実 A/B で、F4（上限超え）の正解 `price_above_ceiling` は**どのツールも返さなかった**。
// SDK の呼び手側 policy の語だったからで、Recipe に書いても「ツールに無い語は出てこない」。
// ここで固定するのは 4 つ:
//   1. クエリ `amount_usd` / `max_per_tx_usd` / `min_l1_deliveries` を受けると、応答に
//      `caller_policy` が付き、その `reason_codes` は SDK の `PayRefuseReason` と**1字違わず同じ語**
//   2. 順序も SDK と同じ: 上限超え → degraded → BLOCK → L1 の床。BLOCK / degraded は床を満たしても
//      policy ALLOW にならない（§3.2.1: BLOCK は遮断であって意見ではない）
//   3. `recommendation`（vet402 の判定）は書き換えない。policy は別欄
//   4. クエリが無ければ応答は**従来と完全一致**（`caller_policy` キーすら無い）
//
// DB は持ち込まない: decision-keyless-read.test.ts と同じフェイク（endpoint 1 行）を差し、
// 判定本体は decisionCache に種を撒いて decide() のキャッシュヒットで返す。
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

/** 種になる判定。facts.l1.n_delivered = 3 が床の比較対象。 */
const seeded = (over: Record<string, unknown> = {}) => ({
  recommendation: "ALLOW",
  reason_codes: ["l0_pass", "l1_delivered", "l2_undeclared"],
  facts: { l0: { status: "pass" }, l1: { n_delivered: 3, n_settled: 3, n_attempts: 3 }, l2: { status: "undeclared" } },
  evidence: [{ source: "vet402", level: "L1", url: "https://vet402.com/x" }],
  degraded: false,
  policy: "allow_only",
  rules_version: "test",
  ...over,
});

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
            assert.equal(table, ipRateLimits);
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

function call(query: string, opts: { rid?: string; key?: string; ip?: string } = {}) {
  const rid = opts.rid ?? RID;
  const headers: Record<string, string> = { "x-forwarded-for": opts.ip ?? "203.0.113.10" };
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  const qs = query ? `?${query}` : "";
  const req = new NextRequest(`http://localhost/api/v1/resources/${rid}/decision${qs}`, { headers });
  return GET(req, { params: Promise.resolve({ resourceId: rid }) });
}

function seed(result: Record<string, unknown>) {
  decisionCache.clear();
  decisionCache.set(`${OBS_ID}|payer|-|0|0|0`, { result, expiresAt: Date.now() + 60_000 });
}

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["PROXY_HEADER_SOURCE", "DEV_API_KEY", "DECISION_KEYLESS_READ", "DATABASE_URL"];

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.PROXY_HEADER_SOURCE = "generic";
  process.env.DEV_API_KEY = DEV_KEY;
  delete process.env.DECISION_KEYLESS_READ;
  __setDbForTests(fakeDb());
  seed(seeded());
});

afterEach(() => {
  __setDbForTests(null);
  decisionCache.clear();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

test("P0 クエリ無しの応答は従来と完全一致——caller_policy というキーすら無い", async () => {
  const res = await call("role=payer", { key: DEV_KEY });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const body = JSON.parse(text);
  assert.deepEqual(body, seeded(), "policy を頼まれていない応答に policy を混ぜてはいけない");
  assert.equal("caller_policy" in body, false);
});

test("P1 上限超え → caller_policy.verdict REFUSE・reason_codes は SDK の語 price_above_ceiling ただ1つ", async () => {
  const res = await call("role=payer&amount_usd=1.5&max_per_tx_usd=1");
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const body = JSON.parse(text);
  assert.equal(body.recommendation, "ALLOW", "vet402 の判定は書き換えない（policy は別欄）");
  assert.deepEqual(body.caller_policy, {
    applied: { amount_usd: 1.5, max_per_tx_usd: 1, min_l1_deliveries: 0 },
    verdict: "REFUSE",
    reason_codes: ["price_above_ceiling"],
    not_evaluated: ["min_subgraph_receipts"],
  });
  // 既存フィールドは不変
  const rest = { ...body };
  delete rest.caller_policy;
  assert.deepEqual(rest, seeded());
});

test("P2 上限内 → ALLOW・reason_codes 空。max_per_tx_usd 省略時の既定は SDK の DEFAULT_MAX_PER_TX_USD（$1）", async () => {
  const under = await (await call("amount_usd=0.5")).json();
  assert.equal(under.caller_policy.verdict, "ALLOW");
  assert.deepEqual(under.caller_policy.reason_codes, []);
  assert.equal(under.caller_policy.applied.max_per_tx_usd, 1);
  const over = await (await call("amount_usd=1.01")).json();
  assert.equal(over.caller_policy.verdict, "REFUSE");
  assert.deepEqual(over.caller_policy.reason_codes, ["price_above_ceiling"]);
  // ちょうど上限は通す（SDK: `amountUsd > maxPerTxUsd` で拒否）
  const exact = await (await call("amount_usd=1")).json();
  assert.equal(exact.caller_policy.verdict, "ALLOW");
});

test("P3 L1 の床: n_delivered=3 に対して 4 は未達 insufficient_delivery_evidence、3 は満たす", async () => {
  const short = await (await call("min_l1_deliveries=4")).json();
  assert.equal(short.caller_policy.verdict, "REFUSE");
  assert.deepEqual(short.caller_policy.reason_codes, ["insufficient_delivery_evidence"]);
  assert.equal(short.caller_policy.applied.min_l1_deliveries, 4);
  const met = await (await call("min_l1_deliveries=3")).json();
  assert.equal(met.caller_policy.verdict, "ALLOW");
  assert.deepEqual(met.caller_policy.reason_codes, []);
});

test("P4 amount_usd 無しで max_per_tx_usd だけ → 上限は当てられないので not_evaluated に載せ、黙って ALLOW にしない", async () => {
  const body = await (await call("max_per_tx_usd=0.05")).json();
  assert.equal(body.caller_policy.applied.amount_usd, null);
  assert.deepEqual(body.caller_policy.not_evaluated, ["max_per_tx_usd", "min_subgraph_receipts"]);
  assert.equal(body.caller_policy.verdict, "ALLOW");
});

test("P5 BLOCK は床を満たし上限内でも policy ALLOW にならない——payee_recommendation_block（§3.2.1）", async () => {
  seed(seeded({ recommendation: "BLOCK", reason_codes: ["l0_fail", "l1_delivered", "l2_undeclared"] }));
  const body = await (await call("amount_usd=0.01&min_l1_deliveries=1")).json();
  assert.equal(body.recommendation, "BLOCK", "vet402 の判定は不変");
  assert.equal(body.caller_policy.verdict, "REFUSE");
  assert.deepEqual(body.caller_policy.reason_codes, ["payee_recommendation_block"]);
});

test("P6 degraded は測れなかった——evidence_unavailable で REFUSE（床では埋まらない）", async () => {
  seed(seeded({ degraded: true }));
  const body = await (await call("amount_usd=0.01&min_l1_deliveries=1")).json();
  assert.equal(body.caller_policy.verdict, "REFUSE");
  assert.deepEqual(body.caller_policy.reason_codes, ["evidence_unavailable"]);
});

test("P7 順序は SDK と同じ: 上限超えが BLOCK より先（SDK は判定を引く前に上限を当てる）", async () => {
  seed(seeded({ recommendation: "BLOCK" }));
  const body = await (await call("amount_usd=5&max_per_tx_usd=1")).json();
  assert.deepEqual(body.caller_policy.reason_codes, ["price_above_ceiling"]);
});

test("P8 WARN は意見であって遮断ではない: 呼び手の関門を通れば policy ALLOW、recommendation は WARN のまま", async () => {
  seed(seeded({ recommendation: "WARN", reason_codes: ["l0_pass", "l1_not_attempted", "l2_undeclared"], facts: { l0: { status: "pass" }, l1: { n_delivered: 0, n_attempts: 0 }, l2: { status: "undeclared" } } }));
  const body = await (await call("amount_usd=0.01")).json();
  assert.equal(body.recommendation, "WARN");
  assert.equal(body.caller_policy.verdict, "ALLOW");
  // 床を宣言すれば、WARN でも床で落ちる
  const floored = await (await call("amount_usd=0.01&min_l1_deliveries=1")).json();
  assert.deepEqual(floored.caller_policy.reason_codes, ["insufficient_delivery_evidence"]);
});

test("P9 不正値は 400・語は SDK の呼び出し側エラーと同じ", async () => {
  const cases: [string, string][] = [
    ["amount_usd=abc", "invalid_amount_usd"],
    ["amount_usd=-1", "invalid_amount_usd"],
    ["amount_usd=Infinity", "invalid_amount_usd"],
    ["max_per_tx_usd=0", "invalid_policy"],
    ["max_per_tx_usd=x", "invalid_policy"],
    ["min_l1_deliveries=1.5", "invalid_evidence_policy"],
    ["min_l1_deliveries=-1", "invalid_evidence_policy"],
    // role=payee に売り手の床や価格の policy は当たらない（SDK は role=payer しか引かない）
    ["role=payee&payer=0x36038e1d712c5e39f35952164ec58ec2b96caee7&amount_usd=1", "invalid_policy"],
  ];
  for (const [q, word] of cases) {
    const res = await call(q, { key: DEV_KEY });
    assert.equal(res.status, 400, `${q}: ${res.status}`);
    assert.deepEqual(await res.json(), { error: word }, q);
  }
});

test("P10 カタログ外は policy があっても 404 not_found のまま（評価しない・I23 は SDK が受取人スコアで判定する）", async () => {
  const res = await call("amount_usd=5&max_per_tx_usd=1", { rid: UNKNOWN_RID });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "not_found" });
});

test("P11 鍵の有無で caller_policy を含む本文が変わらない", async () => {
  const anon = await (await call("amount_usd=2")).json();
  const keyed = await (await call("amount_usd=2", { key: DEV_KEY })).json();
  assert.deepEqual(anon, keyed);
  assert.deepEqual(anon.caller_policy.reason_codes, ["price_above_ceiling"]);
});
