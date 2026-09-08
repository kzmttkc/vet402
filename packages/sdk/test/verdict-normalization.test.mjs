// ============================================================
// **判定語と「測れたか」の欄は、サーバのシリアライズに依存せずに読む。**
//
// 中核の主張は「BLOCK と degraded は `requireVet402Allow: false` でも免除されない」。
// 2026-09-08 の第三者反証検査は、その主張が 2 つの入力で破れることを実測した:
//
//   1. `recommendation: " BLOCK "`（前後に空白）— `String(x).toUpperCase() === "BLOCK"` は
//      空白を落とさないので、`" BLOCK "` は BLOCK ではなくなり、免除経路へ落ちて**払う**
//   2. payee score 経路の `degraded: "true"`（文字列）/ `1`（数値）、
//      `signalsUnavailable: {a:1}`（配列でない）— `=== true` / `?.length ?? 0` を素通りして**払う**
//
// 2026-09-07 に `/decision` 経路へは `typeof !== "boolean"` を入れたが、payee score 経路へ
// 伝播していなかった（`spend-guard.ts` の 3 経路も同型）。
//
// ここが固定するのは 2 つだけ:
//   - 判定語の比較は **trim + 大文字化** してから行う（判定語そのものは増やさない）
//   - `degraded` / `signalsUnavailable` は **想定の型でなければ拒否**（測れたと言えない）
//
// 実ネットワーク・実署名なし。署名器は呼ばれた回数を数える。**要求は「refused かつ署名 0 回」。**
// ============================================================
import test from "node:test";
import assert from "node:assert/strict";
import { payOrRefuse, SpendGuard } from "../dist/index.js";

const PAYEE = "0x36038e1d712c5e39f35952164ec58ec2b96caee7";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RESOURCE = "https://kronossignals.com/api/v1/price/btc";
const GRAPH_KEY = "k".repeat(32);
const RID = "a".repeat(64);
const b64 = (o) => btoa(JSON.stringify(o));
const ACCEPT = {
  scheme: "exact",
  network: "eip155:8453",
  amount: "20000",
  asset: USDC,
  payTo: PAYEE,
  extra: { assetTransferMethod: "eip3009" },
};

/** 署名器。呼ばれた回数を数える（0 回であることがこのファイルの要求）。 */
function signer() {
  const state = { signs: 0 };
  return {
    state,
    account: {
      address: "0xDB62BD202914609830fA656F87996b91be3Aa673",
      signTypedData: async () => {
        state.signs++;
        return "0x" + "ab".repeat(32) + "1b";
      },
    },
  };
}

/** The Graph は常に「レシート 483 件」を返す（床は満たされている前提で判定語だけを問う）。 */
const SUBGRAPH_OK = {
  ok: true,
  status: 200,
  headers: new Map(),
  json: async () => ({
    data: {
      _meta: { block: { number: 51031370, timestamp: 1788852087 } },
      x402AddressSummaries: [{ address: PAYEE.toLowerCase(), role: "RECIPIENT", totalPayments: "483" }],
    },
  }),
};

const decisionBody = (over = {}) => ({
  subject: { type: "resource", id: RID },
  role: "payer",
  recommendation: "WARN",
  reason_codes: ["thin_history"],
  degraded: false,
  facts: { l0: { status: "pass" }, l1: { n_delivered: 5, n_attempts: 5 }, l2: { status: "undeclared" } },
  evidence: [],
  policy: "allow_only",
  rules_version: "2026-09-02.1",
  ...over,
});

/**
 * `/decision` を返すか 404 にするかを選べる fetch。404 なら 402 の payTo から
 * `/payees/{addr}/score` を引く経路（カタログ外）に落ちる。
 */
function harness({ decision404 = false, decision = null, score = null } = {}) {
  return async (url, init) => {
    const u = String(url);
    if (u.includes("gateway.thegraph.com")) return SUBGRAPH_OK;
    if (u.includes("/decision")) {
      return decision404
        ? { ok: false, status: 404, headers: new Map(), json: async () => ({ error: "not_found" }) }
        : { ok: true, status: 200, headers: new Map(), json: async () => decision };
    }
    if (u.includes("/payees/")) return { ok: true, status: 200, headers: new Map(), json: async () => score };
    if (u.includes("/payments/x402")) return { ok: true, status: 200, headers: new Map(), json: async () => ({ ok: true }) };
    if (u.startsWith("https://kronossignals.com")) {
      const h = init?.headers ?? {};
      const raw = h["PAYMENT-SIGNATURE"] ?? h["payment-signature"];
      return raw
        ? {
            ok: true,
            status: 200,
            headers: new Map([
              ["payment-response", b64({ success: true, transaction: "0x" + "cd".repeat(32), network: "eip155:8453", payer: "0x0" })],
            ]),
            json: async () => ({ data: "ok" }),
          }
        : { ok: false, status: 402, headers: new Map([["payment-required", b64({ x402Version: 2, accepts: [ACCEPT] })]]), json: async () => ({}) };
    }
    throw new Error("unexpected fetch " + u);
  };
}

/** vet402 の判定を免除し、代わりに自社台帳の床（L1 1 件）を置いた呼び手。 */
const WAIVE_VET402 = { maxPerTxUsd: 1, requireVet402Allow: false, evidence: { minL1Deliveries: 1, source: "vet402" } };
/** 同じく免除し、床を The Graph のレシートに置いた呼び手（カタログ外経路で使う）。 */
const WAIVE_SUBGRAPH = {
  maxPerTxUsd: 1,
  requireVet402Allow: false,
  evidence: { minSubgraphReceipts: 1, source: "subgraph", graphApiKey: GRAPH_KEY },
};

async function run(cfg, policy) {
  const s = signer();
  const r = await payOrRefuse({
    payee: PAYEE,
    resource: RESOURCE,
    amountUsd: 0.02,
    account: s.account,
    fetch: harness(cfg),
    policy,
    ...(cfg.decision404 ? {} : { resourceId: RID }),
  });
  return { r, signs: s.state.signs };
}

/** 「拒否された」の意味を 1 箇所に置く: status が refused で、署名器は 1 度も触れられていない。 */
function assertRefused({ r, signs }, code, label) {
  assert.equal(signs, 0, `${label}: 署名器が ${signs} 回呼ばれた（0 でなければならない）`);
  assert.equal(r.status, "refused", `${label}: status=${r.status} codes=[${r.decision?.reason_codes}]`);
  assert.ok(
    r.decision.reason_codes.includes(code),
    `${label}: 理由語に ${code} が無い（[${r.decision.reason_codes}]）`,
  );
}

// ---------- 1. 判定語は trim してから読む ----------

for (const [label, word] of [
  ["前後に空白", " BLOCK "],
  ["改行とタブ", "\tBLOCK\n"],
  ["小文字＋空白", " block "],
]) {
  test(`N1 /decision の recommendation "${word.replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"（${label}）は BLOCK として止まる`, async () => {
    const out = await run({ decision: decisionBody({ recommendation: word }) }, WAIVE_VET402);
    assertRefused(out, "payee_recommendation_block", `/decision ${label}`);
  });

  test(`N2 payee score の recommendation "${word.replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"（${label}）は BLOCK として止まる`, async () => {
    const out = await run(
      { decision404: true, score: { recommendation: word, score: 20, degraded: false, signalsUnavailable: [] } },
      WAIVE_SUBGRAPH,
    );
    assertRefused(out, "payee_recommendation_block", `payee score ${label}`);
  });
}

test("N3 対照: 空白なしの \"BLOCK\" は従来どおり止まる（両経路）", async () => {
  assertRefused(await run({ decision: decisionBody({ recommendation: "BLOCK" }) }, WAIVE_VET402), "payee_recommendation_block", "/decision BLOCK");
  assertRefused(
    await run({ decision404: true, score: { recommendation: "BLOCK", score: 20, degraded: false, signalsUnavailable: [] } }, WAIVE_SUBGRAPH),
    "payee_recommendation_block",
    "payee score BLOCK",
  );
});

// **正規化は片道**。BLOCK（拒否）の側にだけ効かせ、ALLOW（許可）の側には効かせない。
// `" ALLOW "` を ALLOW と読むのは「よく分からないシリアライズを許可として採る」ことで、
// これは緩める方向の変更にあたる。fail-closed の側だけ広げる。
test("N4 ALLOW の前後空白は ALLOW として読まない（正規化は拒否の側にだけ効く）", async () => {
  const s = signer();
  const r = await payOrRefuse({
    payee: PAYEE,
    resource: RESOURCE,
    amountUsd: 0.02,
    account: s.account,
    fetch: harness({ decision: decisionBody({ recommendation: " ALLOW " }) }),
    resourceId: RID,
    policy: { maxPerTxUsd: 1 }, // requireVet402Allow は既定 true
  });
  assert.equal(s.state.signs, 0, `署名器が ${s.state.signs} 回呼ばれた`);
  assert.equal(r.status, "refused", `status=${r.status}`);
  assert.ok(r.decision.reason_codes.includes("payee_recommendation_not_allow"), `[${r.decision.reason_codes}]`);
});

test("N4b 対照: 空白なしの \"ALLOW\" は従来どおり通り、免除の記録は付かない", async () => {
  const out = await run({ decision: decisionBody({ recommendation: "ALLOW" }) }, WAIVE_VET402);
  assert.equal(out.r.status, "paid", JSON.stringify(out.r.decision.reason_codes));
  assert.equal(out.r.decision.verdict_source, "decision", "ALLOW なら呼び手の規則で通したことにしない");
  assert.equal(out.r.decision.policy_override, null, "ALLOW に免除の記録は付かない");
});

// ---------- 2. degraded / signalsUnavailable は型が違えば拒否 ----------

for (const [label, value] of [
  ['文字列 "true"', "true"],
  ['文字列 "false"', "false"],
  ["数値 1", 1],
  ["数値 0", 0],
  ["null", null],
  ["object", {}],
]) {
  test(`N5 payee score の degraded が boolean でない（${label}）なら払わない`, async () => {
    const out = await run(
      { decision404: true, score: { recommendation: "WARN", score: 60, degraded: value, signalsUnavailable: [] } },
      WAIVE_SUBGRAPH,
    );
    assertRefused(out, "evidence_unavailable", `payee score degraded ${label}`);
  });
}

for (const [label, value] of [
  ["object", { a: 1 }],
  ['文字列 ""', ""],
  ['文字列 "none"', "none"],
  ["数値 0", 0],
]) {
  test(`N6 payee score の signalsUnavailable が配列でない（${label}）なら払わない`, async () => {
    const out = await run(
      { decision404: true, score: { recommendation: "WARN", score: 60, degraded: false, signalsUnavailable: value } },
      WAIVE_SUBGRAPH,
    );
    assertRefused(out, "evidence_unavailable", `payee score signalsUnavailable ${label}`);
  });
}

test("N7 対照: degraded=false(bool) / signalsUnavailable=[] / WARN は従来どおり免除で通る", async () => {
  const out = await run(
    { decision404: true, score: { recommendation: "WARN", score: 60, degraded: false, signalsUnavailable: [] } },
    WAIVE_SUBGRAPH,
  );
  assert.equal(out.r.status, "paid", JSON.stringify(out.r.decision.reason_codes));
  assert.equal(out.r.decision.verdict_source, "caller_policy");
  assert.equal(out.r.signs ?? 1, out.r.signs ?? 1);
});

test("N8 対照: signalsUnavailable の欄が無い（undefined）ときは従来どおり「空」と読む", async () => {
  const out = await run(
    { decision404: true, score: { recommendation: "WARN", score: 60, degraded: false } },
    WAIVE_SUBGRAPH,
  );
  assert.equal(out.r.status, "paid", JSON.stringify(out.r.decision.reason_codes));
});

// ---------- 3. SpendGuard も同じ規律 ----------

const baseScore = (over = {}) => ({
  payee: PAYEE,
  score: 80,
  recommendation: "ALLOW",
  dataDepth: "moderate",
  degraded: false,
  signalsUnavailable: [],
  signals: {
    receiving: { paymentCount: 5, uniqueDays: 3, distinctPayers: 2, l1DeliveryCount: 5, l1DistinctBuyers: 3, score: 68 },
    walletHealth: { ageDays: 120, txCount: 300, isBurner: false, score: 85 },
    drainPattern: { detected: false, drainRatio: 0.1, outgoingCount: 3, incomingCount: 8, score: 85 },
    outcomeHistory: { types: [], adjustment: 0 },
    flags: [],
  },
  scoredAt: new Date().toISOString(),
  cacheExpiresAt: new Date(Date.now() + 300000).toISOString(),
  disclaimer: "test",
  ...over,
});

/** 3 つの fail-closed 方針。`custom` は 0.2.0 以前の opt-out なので degraded 検査を持たない（意図的）。 */
const FAIL_CLOSED = [
  ["allow-only", { maxPerTxUsd: 10, trustPolicy: "allow-only" }],
  ["block-only", { maxPerTxUsd: 10, trustPolicy: "block-only" }],
  ["evidence", { maxPerTxUsd: 10, trustPolicy: "evidence", requireEvidence: { minL1Deliveries: 1 } }],
];

const guardFor = (policy, over) => new SpendGuard(policy, async () => baseScore(over));

for (const [label, policy] of FAIL_CLOSED) {
  test(`N9 SpendGuard(${label}) は degraded が boolean でなければ拒否する`, async () => {
    for (const bad of ["true", "false", 1, 0, null, {}]) {
      const d = await guardFor(policy, { degraded: bad }).evaluate({ payee: PAYEE, amountUsd: 1 });
      assert.equal(d.allow, false, `${label} degraded=${JSON.stringify(bad)} を通した（reasons=[${d.reasons}]）`);
      assert.ok(d.reasons.includes("payee_score_degraded"), `${label} reasons=[${d.reasons}]`);
    }
  });

  test(`N10 SpendGuard(${label}) は " BLOCK " を BLOCK として拒否する`, async () => {
    const d = await guardFor(policy, { recommendation: " BLOCK ", score: 10 }).evaluate({ payee: PAYEE, amountUsd: 1 });
    assert.equal(d.allow, false, `${label} " BLOCK " を通した`);
    if (label !== "allow-only") {
      // allow-only は「ALLOW でない」で既に落ちるので語は not_allow のまま（既存の主張を変えない）。
      assert.ok(d.reasons.includes("payee_recommendation_block"), `${label} reasons=[${d.reasons}]`);
    }
  });

  // 配列でない `signalsUnavailable` は「読めない形」であって「一部測れなかった」ではない。
  // `block-only` は**読めた**部分測定を意図的に許すが、読めない形は 3 方針とも拒否する。
  test(`N11 SpendGuard(${label}) は signalsUnavailable が配列でなければ拒否する`, async () => {
    for (const bad of [{ a: 1 }, "", "none", 0]) {
      const d = await guardFor(policy, { signalsUnavailable: bad }).evaluate({ payee: PAYEE, amountUsd: 1 });
      assert.equal(d.allow, false, `${label} signalsUnavailable=${JSON.stringify(bad)} を通した（reasons=[${d.reasons}]）`);
      assert.ok(d.reasons.includes("payee_score_degraded"), `${label} reasons=[${d.reasons}]`);
    }
  });

  test(`N11b 対照: SpendGuard(${label}) の「読めた部分測定」の扱いは変わらない`, async () => {
    const d = await guardFor(policy, { signalsUnavailable: ["native_drain"] }).evaluate({ payee: PAYEE, amountUsd: 1 });
    // block-only は部分測定を許す（従来どおり）。allow-only / evidence は拒否する。
    assert.equal(d.allow, label === "block-only", `${label} reasons=[${d.reasons}]`);
  });

  test(`N12 対照: SpendGuard(${label}) は正しい形の ALLOW を通す`, async () => {
    const d = await guardFor(policy, {}).evaluate({ payee: PAYEE, amountUsd: 1 });
    assert.equal(d.allow, true, `${label} reasons=[${d.reasons}]`);
  });
}

test('N13 SpendGuard(custom, blockOnRecommendation) も " BLOCK " を BLOCK として拒否する', async () => {
  const guard = guardFor({ maxPerTxUsd: 10, trustPolicy: "custom", blockOnRecommendation: true }, { recommendation: " BLOCK ", score: 10 });
  const d = await guard.evaluate({ payee: PAYEE, amountUsd: 1 });
  assert.equal(d.allow, false, `custom " BLOCK " を通した（reasons=[${d.reasons}]）`);
  assert.ok(d.reasons.includes("payee_recommendation_block"), `reasons=[${d.reasons}]`);
});
