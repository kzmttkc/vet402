// ============================================================
// 2026-09-29 監査 5 周目（支払いを狙う攻撃者の立場）の DB 無しの部分。
//
//  1. 売り手ごとの日次上限の値（budget.ts sellerDailyCapUnits）と受取先の正規化。
//  2. /decision の問い合わせの呼び手の単位（lookup-caller.ts）: 鍵 id か IP（IPv6 は /64）、日ごとに別の HMAC。
//  3. 判定の verified_terms（seller-facts verifiedTermsOf・buildDecision）。
//  4. L1 は https の出品・pay_to を宣言した出品だけ（isL1PurchasableListing）、safe-fetch の httpsOnly は
//     最初の要求にも転送先にも効く。
// DB を使う側（予約の同じ 1 文・候補 SQL・問い合わせの重複除去）は *.pg.test.ts。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { SELLER_DAILY_CAP_USD_DEFAULT, sellerDailyCapUnits } from "@/lib/observatory/budget";
import { isL1PurchasableListing, normalizedPayTo } from "@/lib/observatory/l1-runner";
import { ipCounterKey, lookupCallerHash, lookupCallerMaterial } from "@/lib/decision/lookup-caller";
import { verifiedTermsOf } from "@/lib/decision/seller-facts";
import { buildDecision, type DecisionSubject } from "@/lib/decision/decide";
import type { SellerFacts } from "@/lib/decision/types";
import { safeFetch, UnsafeTargetError } from "@/lib/net/safe-fetch";

function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

test("売り手ごとの日次上限: 既定 $2・環境変数で変更・壊れた値は既定・$25 で頭打ち", () => {
  assert.equal(SELLER_DAILY_CAP_USD_DEFAULT, 2);
  withEnv("L1_SELLER_DAILY_CAP_USD", undefined, () => assert.equal(sellerDailyCapUnits(), 2_000_000n));
  withEnv("L1_SELLER_DAILY_CAP_USD", "0", () => assert.equal(sellerDailyCapUnits(), 0n));
  withEnv("L1_SELLER_DAILY_CAP_USD", "0.5", () => assert.equal(sellerDailyCapUnits(), 500_000n));
  withEnv("L1_SELLER_DAILY_CAP_USD", "100", () => assert.equal(sellerDailyCapUnits(), 25_000_000n));
  for (const bad of ["-1", "abc", "NaN", " "]) {
    withEnv("L1_SELLER_DAILY_CAP_USD", bad, () => assert.equal(sellerDailyCapUnits(), 2_000_000n, bad));
  }
});

test("受取先の正規化: 0x は小文字・base58 と r アドレスは原文（小文字化すると別のアドレス）", () => {
  assert.equal(normalizedPayTo("0xABCDEF0000000000000000000000000000000001"), "0xabcdef0000000000000000000000000000000001");
  assert.equal(normalizedPayTo("0XABCDEF0000000000000000000000000000000001"), "0xabcdef0000000000000000000000000000000001");
  assert.equal(normalizedPayTo("EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd"), "EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd");
  assert.equal(normalizedPayTo("rMnHeutYALco8RYFVcmuU4BCgSzBpPEh32"), "rMnHeutYALco8RYFVcmuU4BCgSzBpPEh32");
});

test("L1 で買ってよい出品: https かつ pay_to を宣言している（http・pay_to 無し・空・読めない URL は買わない）", () => {
  const payTo = "0x" + "11".repeat(20);
  assert.equal(isL1PurchasableListing({ resourceUrl: "https://a.example/x", payTo }), true);
  assert.equal(isL1PurchasableListing({ resourceUrl: "HTTPS://a.example/x", payTo }), true);
  assert.equal(isL1PurchasableListing({ resourceUrl: "http://a.example/x", payTo }), false);
  assert.equal(isL1PurchasableListing({ resourceUrl: "https://a.example/x", payTo: null }), false);
  assert.equal(isL1PurchasableListing({ resourceUrl: "https://a.example/x", payTo: "  " }), false);
  assert.equal(isL1PurchasableListing({ resourceUrl: "not a url", payTo }), false);
  assert.equal(isL1PurchasableListing({ resourceUrl: "ftp://a.example/x", payTo }), false);
});

test("safe-fetch httpsOnly: http の最初の要求は 1 バイトも出さずに拒否", async () => {
  let calls = 0;
  await assert.rejects(
    safeFetch("http://seller.example/x", {}, {
      httpsOnly: true,
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async () => {
        calls++;
        return new Response("402", { status: 402 });
      },
    }),
    (e: unknown) => e instanceof UnsafeTargetError && e.reason === "unsafe_scheme",
  );
  assert.equal(calls, 0);
});

test("safe-fetch httpsOnly: https から http への転送も追わない（資格情報を平文へ運ばない）", async () => {
  const hops: string[] = [];
  await assert.rejects(
    safeFetch("https://seller.example/x", { headers: { "PAYMENT-SIGNATURE": "sig" } }, {
      httpsOnly: true,
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async (url) => {
        hops.push(url);
        return new Response(null, { status: 307, headers: { location: "http://seller.example/x" } });
      },
    }),
    (e: unknown) => e instanceof UnsafeTargetError && e.reason === "unsafe_scheme",
  );
  assert.deepEqual(hops, ["https://seller.example/x"], "転送先の http には出ない");
});

test("safe-fetch: httpsOnly の既定は off（L0 は http の出品も観測する）", async () => {
  const res = await safeFetch("http://seller.example/x", {}, {
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImpl: async () => new Response("ok", { status: 200 }),
  });
  assert.equal(res.status, 200);
});

test("問い合わせの呼び手: 鍵ありは鍵 id、鍵なしは IP。IPv6 は /64 に丸める（下位 64 bit を回しても同じ呼び手）", () => {
  // 独立レビュー（2026-09-29）: 鍵ありは鍵の持ち主で数える。
  assert.equal(lookupCallerMaterial({ apiKeyId: "k1", ownerId: "u1", ip: "1.2.3.4" }), "owner:u1");
  // 2026-09-29 監査 6 周目: 鍵なしは数えない（材料 null）。IPv6 の /64 の丸めは ipCounterKey として残る（IP の枠と共用）。
  assert.equal(lookupCallerMaterial({ apiKeyId: null, ip: "1.2.3.4" }), null);
  assert.equal(lookupCallerMaterial({}), null);
  assert.equal(ipCounterKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
  assert.equal(ipCounterKey("2001:db8:1:2::1"), "2001:db8:1:2::/64");
  assert.equal(ipCounterKey("2001:DB8:1:2:ffff::9"), "2001:db8:1:2::/64");
  assert.equal(ipCounterKey("[2001:db8:0001:0002::5]"), "2001:db8:1:2::/64");
  assert.equal(ipCounterKey("::ffff:10.0.0.1"), "10.0.0.1");
  assert.equal(ipCounterKey(" 1.2.3.4 "), "1.2.3.4");
  assert.notEqual(ipCounterKey("2001:db8:1:2::1"), ipCounterKey("2001:db8:1:3::1"), "別の /64 は別の呼び手");
});

test("問い合わせの呼び手の HMAC: 同じ日・同じ呼び手は同じ値、日が変われば別の値、生の材料を含まない", () => {
  withEnv("API_KEY_PEPPER", "p".repeat(40), () => {
    const a = lookupCallerHash("ip:1.2.3.4", "2026-09-29");
    assert.equal(a, lookupCallerHash("ip:1.2.3.4", "2026-09-29"));
    assert.notEqual(a, lookupCallerHash("ip:1.2.3.4", "2026-09-30"));
    assert.notEqual(a, lookupCallerHash("ip:1.2.3.5", "2026-09-29"));
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.ok(!a.includes("1.2.3.4"));
    const other = withEnv("API_KEY_PEPPER", "q".repeat(40), () => lookupCallerHash("ip:1.2.3.4", "2026-09-29"));
    assert.notEqual(a, other, "鍵が違えば値も違う（HMAC）");
  });
});

test("verified_terms: 配達を確かめた行 → 払った条件。EVM は小文字・network は CAIP-2・MPP は charge", () => {
  const t = verifiedTermsOf({
    tx_hash: "0xABCD",
    pay_to: "0xAbCd000000000000000000000000000000000001",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    amount_units: "10000",
    network: "base",
    attempted_at: "2026-09-27 12:00:41.102+00",
    is_mpp: false,
  });
  assert.deepEqual(t, {
    purchase_id: "eip155:8453:0xabcd",
    pay_to: "0xabcd000000000000000000000000000000000001",
    asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    amount: "10000",
    decimals: 6,
    network: "eip155:8453",
    scheme: "exact",
    protocol: "x402",
    verified_at: "2026-09-27T12:00:41.102Z",
  });
  const mpp = verifiedTermsOf({ tx_hash: null, pay_to: "0x" + "22".repeat(20), asset: "0x" + "33".repeat(20), amount_units: "5000", network: "eip155:4217", attempted_at: "2026-09-27 12:00:00+00", is_mpp: true });
  assert.equal(mpp?.scheme, "charge");
  assert.equal(mpp?.protocol, "mpp");
  assert.equal(mpp?.purchase_id, null, "tx の無い行は purchase_id が null");
  const sol = verifiedTermsOf({ tx_hash: "5Sig", pay_to: "EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", amount_units: "4000", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", attempted_at: "2026-09-27 12:00:00+00", is_mpp: false });
  assert.equal(sol?.pay_to, "EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd", "base58 は原文");
});

test("verified_terms: 欠けた列・読めない額・行なしは null（照合の材料を作らない）", () => {
  const ok = { tx_hash: "0x1", pay_to: "0x" + "11".repeat(20), asset: "0x" + "22".repeat(20), amount_units: "1", network: "eip155:8453", attempted_at: "2026-09-27 12:00:00+00", is_mpp: false };
  assert.equal(verifiedTermsOf(null), null);
  for (const k of ["pay_to", "asset", "amount_units", "network", "attempted_at"] as const) {
    assert.equal(verifiedTermsOf({ ...ok, [k]: null }), null, k);
  }
  assert.equal(verifiedTermsOf({ ...ok, amount_units: "1.5" }), null);
  assert.equal(verifiedTermsOf({ ...ok, amount_units: "-1" }), null);
});

test("buildDecision: role=payer は verified_terms を載せ（省略は null）、role=payee は常に null", () => {
  const subject: DecisionSubject = { type: "resource", id: "r".repeat(64), endpoint_id: "e".repeat(64), observatory_id: "00000000-0000-0000-0000-000000000001", canonical_url: "https://e.com/x", method: "GET" };
  const facts: SellerFacts = {
    l0: { status: "pass", observed_at: "2026-09-02T00:00:00Z", dialect: "v2", fail_reason: null },
    l1: { n_delivered: 1, n_settled: 1, n_attempts: 1, n_inconclusive: 0, n_probe_error: 0, p50_ms: 1, p95_ms: 1, last_purchase_id: "eip155:8453:0x1", observed_at: "2026-09-01T00:00:00Z", last_attempt_at: null },
    l2: { status: "conform", declaration_hash: "d", response_hash: "r", diff_hash: null, missing_keys: null, observed_at: "2026-09-01T00:00:00Z" },
    availability_7d: 1,
    availability_30d: 1,
    offer_stability: "stable",
    payees: ["eip155:8453:0xb"],
    settlement_30d_real: 1,
    settlement_30d_raw: 1,
    settlement_30d_test: 0,
    unique_payers_30d_real: 1,
    wash_dominated: false,
  };
  const terms = verifiedTermsOf({ tx_hash: "0x1", pay_to: "0x" + "11".repeat(20), asset: "0x" + "22".repeat(20), amount_units: "10000", network: "eip155:8453", attempted_at: "2026-09-01 00:00:00+00", is_mpp: false });
  const now = new Date("2026-09-02T00:00:00Z");
  const withTerms = buildDecision({ role: "payer", subject, facts, options: {}, score: null, registry: { status: "off", tx_hash: null }, verifiedTerms: terms, now });
  assert.deepEqual(withTerms.verified_terms, terms);
  const without = buildDecision({ role: "payer", subject, facts, options: {}, score: null, registry: { status: "off", tx_hash: null }, now });
  assert.equal(without.verified_terms, null);
  assert.ok("verified_terms" in without, "キーは常にある（null）");
  const payee = buildDecision({
    role: "payee",
    subject,
    payer: "eip155:8453:0x" + "33".repeat(20),
    facts: { settled_count_30d: 0, unique_payees_30d: 0, retry_burst_rate: 0, sybil: { multi_agent_owner: false, shared_funder: false, cluster_id: null, unavailable: [] }, erc8004: { agent_id: null, feedback_with_payment_proof_ratio: null }, first_seen: null, last_seen: null },
    operatorBlacklist: false,
    registry: { status: "off", tx_hash: null },
    now,
  });
  assert.equal(payee.verified_terms, null);
});

test("verified_terms: XRPL は発行者が無いので返さない・0x の資産は小文字（2026-09-29 独立レビュー）", () => {
  const base = { pay_to: "0xAbC0000000000000000000000000000000000001", amount_units: "1000", attempted_at: "2026-09-28T00:00:00Z", tx_hash: null };
  assert.equal(verifiedTermsOf({ ...base, asset: "RLUSD", network: "xrpl:0", pay_to: "rXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" }), null);
  const t = verifiedTermsOf({ ...base, asset: "0x20C0000000000000000000000000000000000000", network: "eip155:4217" });
  assert.equal(t?.asset, "0x20c0000000000000000000000000000000000000");
});
