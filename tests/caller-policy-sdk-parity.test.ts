// ============================================================
// /decision の `caller_policy` と SDK `payOrRefuse` の**既定値と順序の一致**を機械で止める
// （ETHOnline 2026・WINDOW_PLAN §16.3・2026-09-07 Takeshi 採用）。
//
// tests/decision-caller-policy.test.ts は HTTP 面で「SDK と同じ語・同じ順序」を固定しているが、
// 比べる相手の SDK 側の値は**手で書き写した数字**だった（`max_per_tx_usd` の既定を `1` と直書き）。
// SDK の既定が動けば、サーバは古い既定のまま緑で通る——「新しい面に SDK と違う既定が入る」事故は
// 片方を直書きしたテストでは止まらない。ここでは**両方の実装から値を読む**:
//   - 既定値: サーバ `DEFAULT_MAX_PER_TX_USD` / `parseCallerPolicy` の既定 と
//             SDK `DEFAULT_MAX_PER_TX_USD` / `payOrRefuse` の policy 省略時の挙動
//   - 順序:   同じ入力で「最初に落ちる語」が同じか——SDK は `payOrRefuse` を偽 fetch＋偽署名器で
//             本当に呼び、サーバは `evaluateCallerPolicy` を直接呼ぶ。語の順序を書いた表は持たない
//   - 語彙:   サーバが出し得る語の集合（`CALLER_POLICY_REASONS`）⊆ SDK の `PAY_REFUSE_REASONS`。
//             どちらの定数も、その実装が実際に `refuse(...)` へ渡している文字列を**全部**含む
//             （定数だけ揃えて実装が別の語を出す事故を止める）。openapi.yaml の enum とも突合
//
// 変異で赤になること（作業時に実測）: サーバの既定上限を 2 倍 / `require_vet402_allow` の既定を
// false / BLOCK より前に L1 の床を当てる。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_MAX_PER_TX_USD as SERVER_DEFAULT_MAX_PER_TX_USD,
  CALLER_POLICY_REASONS,
  parseCallerPolicy,
  evaluateCallerPolicy,
} from "@/lib/decision/caller-policy";
import type { DecisionResult } from "@/lib/decision/decide";
import { OBSERVATORY_VOCABULARY } from "@/lib/observatory/vocabulary";
import {
  DEFAULT_MAX_PER_TX_USD as SDK_DEFAULT_MAX_PER_TX_USD,
  PAY_REFUSE_REASONS,
  payOrRefuse,
  type PayPolicy,
} from "../packages/sdk/src/pay-or-refuse";

const RID = "a".repeat(64);
const PAYEE = "0x36038e1d712c5e39f35952164ec58ec2b96caee7";
const RESOURCE = "https://kronossignals.com/api/v1/price/btc";
const b64 = (o: unknown) => btoa(JSON.stringify(o));

/** 両実装に渡す同じ判定。facts.l1.n_delivered = 3 が床の比較対象。 */
function decision(over: Record<string, unknown> = {}): DecisionResult {
  return {
    subject: { type: "resource", id: RID },
    role: "payer",
    payer: null,
    recommendation: "ALLOW",
    reason_codes: ["l0_pass", "l1_delivered", "l2_undeclared"],
    facts: { l0: { status: "pass" }, l1: { n_delivered: 3, n_settled: 3, n_attempts: 3 }, l2: { status: "undeclared" } },
    evidence: [{ source: "vet402", level: "L1", url: "https://vet402.com/x" }],
    degraded: false,
    policy: "allow_only",
    rules_version: "test",
    ...over,
  } as unknown as DecisionResult;
}

/**
 * SDK 側: 偽 fetch（/decision は与えた判定を返す・売り手は payTo が別人の 402 を返す）＋
 * 偽署名器（署名へ触れたら throw——policy の比較で署名に到達してはいけない）。
 * 売り手の payTo を別人にしてあるので、policy を全部通った場合の SDK の拒否語は
 * `payee_mismatch`（サーバの語彙に無い）になり、「policy では落ちなかった」と読める。
 */
async function sdkFirstPolicyReason(
  amountUsd: number,
  policy: PayPolicy | undefined,
  body: DecisionResult,
): Promise<string | null> {
  const someoneElse = "0xDB62BD202914609830fA656F87996b91be3Aa673";
  const accept = { scheme: "exact", network: "eip155:8453", amount: "20000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: someoneElse };
  const fetchFn = (async (url: unknown) => {
    const u = String(url);
    if (u.includes("/decision")) return { ok: true, status: 200, json: async () => body, headers: new Map() };
    if (u.startsWith(RESOURCE)) {
      return { ok: false, status: 402, json: async () => ({}), headers: new Map([["payment-required", b64({ x402Version: 2, accepts: [accept] })]]) };
    }
    throw new Error(`unexpected fetch in policy parity: ${u}`);
  }) as unknown as typeof fetch;
  const account = new Proxy(
    { address: someoneElse },
    {
      get(t, p) {
        if (String(p).startsWith("sign")) throw new Error("policy parity must not reach the signer");
        return Reflect.get(t, p);
      },
    },
  );
  const r = await payOrRefuse({ payee: PAYEE, resource: RESOURCE, resourceId: RID, amountUsd, fetch: fetchFn, account: account as never, policy });
  const serverWords = new Set<string>(CALLER_POLICY_REASONS);
  return r.decision.reason_codes.find((c) => serverWords.has(c)) ?? null;
}

/** サーバ側: クエリを parse → 判定に当てる。最初に落ちた語（ALLOW なら null）。 */
function serverFirstPolicyReason(query: string, body: DecisionResult): string | null {
  const parsed = parseCallerPolicy(new URLSearchParams(query));
  assert.equal(parsed.ok, true, `parse failed for ${query}: ${JSON.stringify(parsed)}`);
  if (!parsed.ok || parsed.input === null) throw new Error("query must carry at least one policy key");
  const cp = evaluateCallerPolicy(body, parsed.input);
  return cp.reason_codes[0] ?? null;
}

// ---------- 既定値 ----------

test("D1 1 件あたりの既定上限: サーバとSDK の定数が同値で、両方とも省略時にその値で上限超えを落とす", async () => {
  assert.equal(SERVER_DEFAULT_MAX_PER_TX_USD, SDK_DEFAULT_MAX_PER_TX_USD);
  const over = SDK_DEFAULT_MAX_PER_TX_USD * 1.5;
  const exact = SDK_DEFAULT_MAX_PER_TX_USD;
  // サーバ: max_per_tx_usd を書かない。SDK: policy を渡さない。
  assert.equal(serverFirstPolicyReason(`amount_usd=${over}`, decision()), "price_above_ceiling");
  assert.equal(await sdkFirstPolicyReason(over, undefined, decision()), "price_above_ceiling");
  assert.equal(serverFirstPolicyReason(`amount_usd=${exact}`, decision()), null, "ちょうど上限は両方とも通す");
  assert.equal(await sdkFirstPolicyReason(exact, undefined, decision()), null);
  const parsed = parseCallerPolicy(new URLSearchParams(`amount_usd=${exact}`));
  assert.ok(parsed.ok && parsed.input);
  assert.equal(parsed.input.maxPerTxUsd, SDK_DEFAULT_MAX_PER_TX_USD, "parse の既定は SDK の定数そのもの");
});

test("D2 require_vet402_allow の既定: サーバは true、SDK も policy 省略時は WARN を payee_recommendation_not_allow で落とす", async () => {
  const parsed = parseCallerPolicy(new URLSearchParams("amount_usd=0.02"));
  assert.ok(parsed.ok && parsed.input);
  assert.equal(parsed.input.requireVet402Allow, true);
  const warn = decision({ recommendation: "WARN", reason_codes: ["l0_pass", "l1_delivered", "l2_undeclared", "l1_stale"] });
  const sdk = await sdkFirstPolicyReason(0.02, undefined, warn);
  assert.equal(sdk, "payee_recommendation_not_allow", "SDK の既定は requireVet402Allow: true");
  assert.equal(serverFirstPolicyReason("amount_usd=0.02", warn), sdk);
});

// ---------- 順序（同じ入力で同じ最初の語） ----------

type Case = { name: string; amount: number; query: string; policy: PayPolicy | undefined; body: DecisionResult };
const BLOCK = { recommendation: "BLOCK", reason_codes: ["l0_fail"] };
const WARN = { recommendation: "WARN", reason_codes: ["l0_pass", "l1_stale"] };
const floor = (n: number): PayPolicy => ({ evidence: { source: "vet402", minL1Deliveries: n } });
const cases: Case[] = [
  { name: "上限超え＋BLOCK → 上限が先", amount: 1.5, query: "amount_usd=1.5", policy: undefined, body: decision(BLOCK) },
  { name: "WARN＋床未達（既定）→ WARN が先", amount: 0.02, query: "amount_usd=0.02&min_l1_deliveries=5", policy: floor(5), body: decision(WARN) },
  { name: "degraded＋上限超え → 上限が先", amount: 1.5, query: "amount_usd=1.5", policy: undefined, body: decision({ degraded: true }) },
  { name: "degraded＋BLOCK → degraded が先", amount: 0.02, query: "amount_usd=0.02", policy: undefined, body: decision({ ...BLOCK, degraded: true }) },
  { name: "BLOCK＋床未達 → BLOCK が先", amount: 0.02, query: "amount_usd=0.02&min_l1_deliveries=5", policy: floor(5), body: decision(BLOCK) },
  {
    name: "WARN＋require=false＋床未達 → 床で落ちる",
    amount: 0.02,
    query: "amount_usd=0.02&min_l1_deliveries=5&require_vet402_allow=false",
    policy: { ...floor(5), requireVet402Allow: false },
    body: decision(WARN),
  },
  {
    name: "WARN＋require=false＋床を満たす → policy では落ちない",
    amount: 0.02,
    query: "amount_usd=0.02&min_l1_deliveries=3&require_vet402_allow=false",
    policy: { ...floor(3), requireVet402Allow: false },
    body: decision(WARN),
  },
  { name: "ALLOW＋床を満たす → policy では落ちない", amount: 0.02, query: "amount_usd=0.02&min_l1_deliveries=3", policy: floor(3), body: decision() },
];

for (const c of cases) {
  test(`O 順序: ${c.name}`, async () => {
    const sdk = await sdkFirstPolicyReason(c.amount, c.policy, c.body);
    const server = serverFirstPolicyReason(c.query, c.body);
    assert.equal(server, sdk, `server=${server} sdk=${sdk}`);
  });
}

// ---------- 語彙 ----------

const serverSrc = readFileSync("src/lib/decision/caller-policy.ts", "utf8");
const sdkSrc = readFileSync("packages/sdk/src/pay-or-refuse.ts", "utf8");
const literalsIn = (src: string, re: RegExp): Set<string> => {
  const out = new Set<string>();
  for (const m of src.matchAll(re)) for (const w of m[1].matchAll(/"([a-z0-9_]+)"/g)) out.add(w[1]);
  return out;
};

test("V1 サーバが出し得る policy 語 ⊆ SDK の PayRefuseReason", () => {
  const sdk = new Set<string>(PAY_REFUSE_REASONS);
  const missing = CALLER_POLICY_REASONS.filter((w) => !sdk.has(w));
  assert.deepEqual(missing, [], "サーバだけが持つ語。SDK の呼び手はこの語を読めない");
});

test("V1b price_above_declared は SDK だけの語——サーバは 402 を見ないので出せない（意図した非対称・2026-09-07 A3）", async () => {
  // 402 の額（USDC 6 桁）が呼び手の名乗り amountUsd を超えたとき、SDK は署名の前にこの語で止まる。
  // サーバの caller_policy は amount_usd（呼び手の名乗り）しか知らず 402 を読まないので、この語は
  // CALLER_POLICY_REASONS に**入れない**。入れれば「サーバも 402 を照合している」と読まれる。
  assert.ok(PAY_REFUSE_REASONS.includes("price_above_declared"));
  assert.equal((CALLER_POLICY_REASONS as readonly string[]).includes("price_above_declared"), false);
  const acceptAmount = "20001"; // 名乗り $0.02 より 1 単位高い
  const fetchFn = (async (url: unknown) => {
    const u = String(url);
    if (u.includes("/decision")) return { ok: true, status: 200, json: async () => decision(), headers: new Map() };
    if (u.startsWith(RESOURCE)) {
      const accept = { scheme: "exact", network: "eip155:8453", amount: acceptAmount, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAYEE };
      return { ok: false, status: 402, json: async () => ({}), headers: new Map([["payment-required", b64({ x402Version: 2, accepts: [accept] })]]) };
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as unknown as typeof fetch;
  const account = new Proxy(
    { address: PAYEE },
    { get(t, p) { if (String(p).startsWith("sign")) throw new Error("must not reach the signer"); return Reflect.get(t, p); } },
  );
  const r = await payOrRefuse({ payee: PAYEE, resource: RESOURCE, resourceId: RID, amountUsd: 0.02, fetch: fetchFn, account: account as never });
  assert.equal(r.status, "refused");
  assert.ok(r.decision.reason_codes.includes("price_above_declared"), r.decision.reason_codes.join(","));
  // 同じ名乗りをサーバに当てても、サーバは上限（既定 $1）内なので何も言わない。
  assert.equal(serverFirstPolicyReason("amount_usd=0.02", decision()), null);
});

test("V2 サーバの refuse(...) に渡る文字列は全部 CALLER_POLICY_REASONS にある（定数が実装より狭くない）", () => {
  const used = literalsIn(serverSrc, /refuse\(("[^"]+")\)/g);
  assert.ok(used.size >= 4, `refuse の呼び出しが見つからない: ${[...used]}`);
  const declared = new Set<string>(CALLER_POLICY_REASONS);
  assert.deepEqual([...used].filter((w) => !declared.has(w)), []);
  assert.deepEqual(CALLER_POLICY_REASONS.filter((w) => !used.has(w)), [], "宣言だけあって実装が出さない語");
});

test("V3 SDK の refuse([...]) に渡る文字列は全部 PAY_REFUSE_REASONS にある（型と実装が食い違わない）", () => {
  const used = literalsIn(sdkSrc, /refuse\(\s*\[([^\]]*)\]/g);
  assert.ok(used.size >= 6, `refuse の呼び出しが見つからない: ${[...used]}`);
  const declared = new Set<string>(PAY_REFUSE_REASONS);
  assert.deepEqual([...used].filter((w) => !declared.has(w)), []);
});

test("V5 語彙表（vocabulary.ts）の group=policy の語はサーバの集合と一致", () => {
  const policyTerms = OBSERVATORY_VOCABULARY.filter((t) => t.group === "policy").map((t) => t.term).sort();
  assert.deepEqual(policyTerms, [...CALLER_POLICY_REASONS].sort());
});

test("V4 openapi.yaml の caller_policy.reason_codes の enum はサーバの集合と一致", () => {
  const yaml = readFileSync("docs/openapi.yaml", "utf8");
  const m = yaml.match(/enum: \[(price_above_ceiling[^\]]*)\]/);
  assert.ok(m, "openapi.yaml に reason_codes の enum が無い");
  const enumWords = m[1].split(",").map((s) => s.trim()).sort();
  assert.deepEqual(enumWords, [...CALLER_POLICY_REASONS].sort());
});
