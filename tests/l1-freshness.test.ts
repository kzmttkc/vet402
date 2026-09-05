// ============================================================
// vet402 — L1 の鮮度と支出停止フラグの公開（2026-09-05）。
//
// WHY. 09-05 に実行時キルスイッチ（runtime_flags.l1_spending_halt）が入り、
// 停止中は L1 の事実が **更新されない**。ところが公開面は「いつ最後に試したか」も
// 「いま止めているか」も出していなかったので、読み手には
//   (a) この売り手はまだ測っていない
//   (b) 我々が支出を止めているので測れていない
//   (c) 昔測ったきり古くなっている
// の区別がつかない。どれも `l1_not_attempted` / L1 0 件として同じ顔で出る。
//
// これは「新鮮さを装う」ことであり、同時に **我々の都合を売り手の記録にする**
// ことでもある（`fix(l1): 計器の故障を売り手の罪として恒久記録していた` と
// S-4「持っていない証拠で refuted にしない」と同じ形）。
//
// この関門が守るのは 4 つ:
//   1. /decision が `facts.l1.last_attempt_at`（ISO8601 UTC）と
//      トップレベル `spending_halted` を出す
//   2. `not_attempted_reason` は **判別できる値だけ** 出す。判別できないときは
//      null（"not_yet_scheduled" のような、我々が確かめていない理由を作らない）
//   3. 既存の reason_codes は壊さない（`l1_not_attempted` は今までどおり載る）
//   4. state 面は `l1.lastAttemptAt` と `spendingHalted` を出し、
//      **`spendingHalted` は読み取りキャッシュを通らない**（止めた事実は即時に見える）
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { buildDecision, type DecisionSubject } from "@/lib/decision/decide";
import { assembleSellerFacts, type SellerFactsInput } from "@/lib/decision/seller-facts";
import type { BuyerFacts, SellerFacts } from "@/lib/decision/types";
import { getObservatoryStats } from "@/lib/observatory/reader";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const subject: DecisionSubject = {
  type: "resource",
  id: "r".repeat(64),
  endpoint_id: "e".repeat(64),
  observatory_id: "00000000-0000-0000-0000-000000000001",
  canonical_url: "https://e.com/x",
  method: "GET",
};

const sellerNoL1: SellerFacts = {
  l0: { status: "pass", observed_at: "2026-09-05T00:00:00.000Z", dialect: "v2", fail_reason: null },
  l1: {
    n_delivered: 0,
    n_settled: 0,
    n_attempts: 0,
    n_probe_error: 0,
    p50_ms: null,
    p95_ms: null,
    last_purchase_id: null,
    observed_at: null,
    last_attempt_at: null,
  },
  l2: { status: "undeclared", declaration_hash: null, response_hash: null, diff_hash: null, missing_keys: null, observed_at: null },
  availability_7d: 1,
  availability_30d: 1,
  offer_stability: "stable",
  payees: [],
  settlement_30d_real: 0,
  settlement_30d_raw: 0,
  settlement_30d_test: 0,
  unique_payers_30d_real: 0,
  wash_dominated: false,
};

const buyer: BuyerFacts = {
  settled_count_30d: 5,
  unique_payees_30d: 2,
  retry_burst_rate: 0,
  sybil: { multi_agent_owner: false, shared_funder: false, cluster_id: null, unavailable: [] },
  erc8004: { agent_id: null, feedback_with_payment_proof_ratio: null },
  first_seen: "2026-07-01T00:00:00.000Z",
  last_seen: "2026-09-01T00:00:00.000Z",
};

const registry = { status: "off" as const, tx_hash: null };

// ------------------------------------------------------------------
// 1. facts.l1.last_attempt_at
// ------------------------------------------------------------------

function factsInput(over: Partial<SellerFactsInput> = {}): SellerFactsInput {
  return {
    probes: [],
    purchases: [],
    settlements30d: { raw: 0, real: 0, test: 0, uniquePayersReal: 0 },
    payees: [],
    declaredSchema: null,
    lastAttemptAt: null,
    ...over,
  };
}

test("last_attempt_at は渡された最終試行時刻をそのまま出し、無ければ null", () => {
  const none = assembleSellerFacts(factsInput());
  assert.equal(none.l1.last_attempt_at, null, "一度も試していないなら null。0 でも空文字でもない");

  const some = assembleSellerFacts(factsInput({ lastAttemptAt: "2026-09-04T19:02:29.789Z" }));
  assert.equal(some.l1.last_attempt_at, "2026-09-04T19:02:29.789Z");
});

test("last_attempt_at は observed_at と別物——署名していない試行でも時刻が立つ", () => {
  // no_eligible_accept は「壁が機械的に払える accept を出さなかった」＝署名していない。
  // observed_at（＝最後に払った時刻）は null のまま、last_attempt_at だけが立つ。
  const f = assembleSellerFacts(
    factsInput({
      purchases: [
        {
          attemptedAt: "2026-09-04T19:01:49.698Z",
          status: "no_eligible_accept",
          latencyMs: null,
          httpStatusPaid: null,
          payloadNonEmpty: null,
          l2Schema: null,
          txHash: null,
          network: null,
        },
      ],
      lastAttemptAt: "2026-09-04T19:01:49.698Z",
    }),
  );
  assert.equal(f.l1.n_attempts, 0, "署名していないので試行数は 0 のまま");
  assert.equal(f.l1.observed_at, null, "払っていないので観測時刻は立たない");
  assert.equal(f.l1.last_attempt_at, "2026-09-04T19:01:49.698Z", "だが「いつ見に行ったか」は答えられる");
});

// ------------------------------------------------------------------
// 2. spending_halted と not_attempted_reason
// ------------------------------------------------------------------

test("停止中は spending_halted=true と not_attempted_reason=spending_halted を出す（reason_codes は壊さない）", () => {
  const d = buildDecision({
    role: "payer",
    subject,
    facts: sellerNoL1,
    options: {},
    score: null,
    registry,
    spendingHalted: true,
    notAttemptedReason: "spending_halted",
  });
  assert.equal(d.spending_halted, true);
  assert.equal(d.not_attempted_reason, "spending_halted");
  assert.ok(d.reason_codes.includes("l1_not_attempted"), "既存の理由コードは追加のみで壊さない");
});

test("停止していなければ spending_halted=false・判別できない理由は null（作らない）", () => {
  const d = buildDecision({ role: "payer", subject, facts: sellerNoL1, options: {}, score: null, registry, spendingHalted: false });
  assert.equal(d.spending_halted, false);
  assert.equal(d.not_attempted_reason, null, "我々が確かめていない理由を埋めない");
});

test("no_eligible_accept は判別できるので下位コードに出す", () => {
  const d = buildDecision({
    role: "payer",
    subject,
    facts: sellerNoL1,
    options: {},
    score: null,
    registry,
    spendingHalted: false,
    notAttemptedReason: "no_eligible_accept",
  });
  assert.equal(d.not_attempted_reason, "no_eligible_accept");
});

test("既に試行がある相手には not_attempted_reason を付けない——停止は過去の記録を書き換えない", () => {
  const attempted: SellerFacts = { ...sellerNoL1, l1: { ...sellerNoL1.l1, n_attempts: 3, n_settled: 3, n_delivered: 3, last_attempt_at: "2026-09-04T19:02:29.789Z" } };
  const d = buildDecision({
    role: "payer",
    subject,
    facts: attempted,
    options: {},
    score: null,
    registry,
    spendingHalted: true,
    notAttemptedReason: "spending_halted",
  });
  assert.equal(d.spending_halted, true, "停止は全体の事実なので出る");
  assert.equal(d.not_attempted_reason, null, "l1_not_attempted が立っていない相手には下位コードを付けない");
  assert.equal(d.reason_codes.includes("l1_not_attempted"), false);
});

test("role=payee にも spending_halted は載る（全体の事実であって subject の事実ではない）", () => {
  const d = buildDecision({ role: "payee", subject, payer: "eip155:8453:0xa", facts: buyer, operatorBlacklist: false, registry, spendingHalted: true });
  assert.equal(d.spending_halted, true);
  assert.equal(d.not_attempted_reason, null);
});

test("spending_halted は facts の中に入らない（売り手の記録にしない）", () => {
  const d = buildDecision({ role: "payer", subject, facts: sellerNoL1, options: {}, score: null, registry, spendingHalted: true });
  assert.equal("spending_halted" in (d.facts as object), false);
  assert.equal("not_attempted_reason" in (d.facts as object), false);
});

test("本番経路は spendingHalted を必ず渡す（既定値 false に落ちない）", () => {
  // BuildInput の spendingHalted は省略可能にしてある（既存フィクスチャを壊さないため）。
  // 省略＝false は「止まっていない」という主張なので、**本番の呼び手が省略していないこと**を
  // ソースで固定する。ここが緑でなければ、止めている最中に「止めていない」と答え得る。
  const src = read("src/lib/decision/decide.ts");
  const calls = src.split("buildDecision({").slice(1);
  assert.equal(calls.length, 2, "decide() の buildDecision 呼び出しは payer / payee の 2 本");
  for (const [i, call] of calls.entries()) {
    assert.match(call.slice(0, 600), /spendingHalted/, `${i} 本目の buildDecision が spendingHalted を渡していない`);
  }
  assert.match(src, /isSpendingHalted/, "decide() が停止フラグを読んでいない");
});

// ------------------------------------------------------------------
// 3. state 面
// ------------------------------------------------------------------

test("state API は l1.lastAttemptAt と spendingHalted を出す", async () => {
  const { GET } = await import("@/app/api/v1/observatory/state/route");
  const res = await GET(new NextRequest("http://localhost/api/v1/observatory/state"));
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.ok(
    body.l1.lastAttemptAt === null || typeof body.l1.lastAttemptAt === "string",
    "lastAttemptAt は ISO8601 文字列か null。0 件を「時刻 0」で埋めない",
  );
  if (typeof body.l1.lastAttemptAt === "string") {
    assert.equal(new Date(body.l1.lastAttemptAt).toISOString(), body.l1.lastAttemptAt, "ISO8601 UTC で出す");
  }
  assert.equal(typeof body.spendingHalted, "boolean", "止めているかどうかは bool で答える");
  assert.equal("spendingHaltedSource" in body, false, "何を読んで決めたかは公開面に出さない");
});

test("spendingHalted は集計キャッシュに載らない（止めた事実は即時に見える）", async () => {
  // 集計 (ObservatoryStats) は公開頁で 300 秒キャッシュされる。停止フラグを
  // そこへ入れると、止めた後 5 分間「止まっていない」と表示し得る。
  const stats = await getObservatoryStats();
  assert.equal(
    JSON.stringify(stats).includes("spendingHalted"),
    false,
    "ObservatoryStats に spendingHalted を入れてはいけない（cached-reads の対象だから）",
  );
  assert.equal(
    read("src/lib/observatory/cached-reads.ts").includes("SpendingHalt"),
    false,
    "読み取りキャッシュ側で停止フラグを包まない",
  );
  assert.match(
    read("src/app/api/v1/observatory/state/route.ts"),
    /isSpendingHalted/,
    "state ルートが毎回フラグを読み直していない",
  );
});
