// ============================================================
// l0 = unverified の BLOCK に「何が測れなかったか」の下位コードを添える（2026-09-29 再監査）。
//
// biosfera.46-62-215-147.sslip.io/o/public-holidays: /decision は BLOCK、reason_codes は
// ["l0_unverified", "l1_not_attempted", "l2_undeclared"] だけだった。直近の L0 プローブは TLS で
// 届かず unverified（observatory/e の頁には reason: tls と出ている）だが、判定の本文からは読めず、
// /sellers は同じ売り手に「Nothing for you to fix」（L1 の vet402 側の失敗について）と出していた。
//
// 固定すること:
//   1. 原因の取り出し（l0UnverifiedCauseOf）: not_probed / single_fail / 記録された理由 / unrecorded
//   2. 判定は変わらない（recommendation は下位コードの有無で同じ）。下位コードは unverified のときだけ
//   3. SDK の payOrRefuse は reason_codes を文字列のまま透過する（新しい語で壊れない・落とさない）
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { decidePayer, L0_UNVERIFIED_CAUSE_PREFIX } from "@/lib/decision/rules";
import { buildDecision, type DecisionResult } from "@/lib/decision/decide";
import { l0UnverifiedCauseOf, type ProbeInput } from "@/lib/decision/seller-facts";
import type { SellerFacts } from "@/lib/decision/types";
import { payOrRefuse } from "../packages/sdk/src/pay-or-refuse";

const probe = (verdict: string, failReason: string | null = null): ProbeInput => ({
  probedAt: "2026-09-28 22:40:29+00",
  verdict,
  dialect: null,
  failReason,
  priceAmount: "declared",
  priceAsset: null,
  payTo: "declared",
});

const unverified: SellerFacts = {
  l0: { status: "unverified", observed_at: "2026-09-28T22:40:29Z", dialect: null, fail_reason: null },
  l1: { n_delivered: 0, n_settled: 0, n_attempts: 0, n_inconclusive: 0, n_probe_error: 0, p50_ms: null, p95_ms: null, last_purchase_id: null, observed_at: null, last_attempt_at: "2026-09-28T21:32:27.515Z" },
  l2: { status: "undeclared", declaration_hash: null, response_hash: null, diff_hash: null, missing_keys: null, observed_at: null },
  availability_7d: 0.67,
  availability_30d: 0.67,
  offer_stability: "stable",
  payees: ["eip155:8453:0xad2294a042266a143234c374cd8985b9b5c1a9a6"],
  settlement_30d_real: 0,
  settlement_30d_raw: 0,
  settlement_30d_test: 0,
  unique_payers_30d_real: 0,
  wash_dominated: false,
};

test("原因: 直近が unverified ならその記録された理由（biosfera の形: tls の後に pass が 2 本）", () => {
  assert.equal(l0UnverifiedCauseOf([probe("unverified", "tls"), probe("pass"), probe("pass")]), "tls");
  assert.equal(l0UnverifiedCauseOf([probe("unverified", "path_template")]), "path_template");
  assert.equal(l0UnverifiedCauseOf([probe("unverified", null)]), "unrecorded");
  assert.equal(l0UnverifiedCauseOf([probe("unverified", "Weird Reason!")]), "weird_reason");
});

test("原因: 1 回だけの fail は公開ゲート未満（single_fail）、プローブ無しは not_probed", () => {
  assert.equal(l0UnverifiedCauseOf([probe("fail", "no_402"), probe("pass")]), "single_fail");
  assert.equal(l0UnverifiedCauseOf([]), "not_probed");
});

test("原因: 公開判定が pass / fail なら null（下位コードを作らない）", () => {
  assert.equal(l0UnverifiedCauseOf([probe("pass"), probe("unverified", "tls")]), null);
  assert.equal(l0UnverifiedCauseOf([probe("fail", "no_402"), probe("fail", "no_402")]), null);
});

test("判定は変わらず（2026-09-29.4 から WARN）、l0_unverified_<cause> が添えられる", () => {
  const without = decidePayer(unverified);
  const withCause = decidePayer(unverified, { l0UnverifiedCause: "tls" });
  assert.equal(without.recommendation, "WARN");
  assert.equal(withCause.recommendation, without.recommendation, "下位コードは判定に効かない");
  assert.deepEqual(withCause.reason_codes, ["l0_unverified", `${L0_UNVERIFIED_CAUSE_PREFIX}tls`, "l1_not_attempted", "l2_undeclared"]);
  assert.deepEqual(without.reason_codes, ["l0_unverified", "l1_not_attempted", "l2_undeclared"]);
});

test("下位コードは l0 = unverified のときだけ・形の崩れた原因は載せない", () => {
  const pass = decidePayer({ ...unverified, l0: { ...unverified.l0, status: "pass" } }, { l0UnverifiedCause: "tls" });
  assert.ok(!pass.reason_codes.some((c) => c.startsWith(L0_UNVERIFIED_CAUSE_PREFIX)));
  const bad = decidePayer(unverified, { l0UnverifiedCause: "tls; drop table" });
  assert.ok(!bad.reason_codes.some((c) => c.startsWith(L0_UNVERIFIED_CAUSE_PREFIX)));
});

test("buildDecision は options の原因を reason_codes まで運び、degraded は従来どおり", () => {
  const d = buildDecision({
    role: "payer",
    subject: { type: "resource", id: "0".repeat(64), endpoint_id: "e", observatory_id: "4e06538c-77c1-44b8-9ccd-98c8f3deef59", canonical_url: "https://biosfera.46-62-215-147.sslip.io/o/public-holidays", method: "GET" },
    facts: unverified,
    options: { l0UnverifiedCause: "tls" },
    score: null,
    registry: { status: "off", tx_hash: null },
    spendingHalted: false,
  } as Parameters<typeof buildDecision>[0]);
  assert.equal(d.recommendation, "WARN");
  assert.ok(d.reason_codes.includes("l0_unverified_tls"));
  assert.equal(d.degraded, true);
});

test("SDK payOrRefuse は新しい理由コードを文字列のまま透過する（拒否は従来どおり）", async () => {
  const RID = "a".repeat(64);
  const PAYEE = "0xad2294a042266a143234c374cd8985b9b5c1a9a6";
  const RESOURCE = "https://biosfera.46-62-215-147.sslip.io/o/public-holidays";
  const body = {
    subject: { type: "resource", id: RID },
    role: "payer",
    payer: null,
    recommendation: "BLOCK",
    reason_codes: ["l0_unverified", "l0_unverified_tls", "l1_not_attempted", "l2_undeclared"],
    facts: unverified,
    evidence: [{ source: "vet402", level: "L0", url: "https://vet402.com/observatory/e/x" }],
    degraded: true,
    policy: "allow_only",
    rules_version: "test",
  } as unknown as DecisionResult;
  const fetchFn = (async (url: unknown) => {
    const u = String(url);
    if (u.includes("/decision")) return { ok: true, status: 200, json: async () => body, headers: new Map() };
    throw new Error(`a BLOCK must refuse before touching the seller: ${u}`);
  }) as unknown as typeof fetch;
  const account = new Proxy(
    { address: "0xDB62BD202914609830fA656F87996b91be3Aa673" },
    {
      get(t, p) {
        if (String(p).startsWith("sign")) throw new Error("a BLOCK must not reach the signer");
        return Reflect.get(t, p);
      },
    },
  );
  const r = await payOrRefuse({ payee: PAYEE, resource: RESOURCE, resourceId: RID, amountUsd: 0.01, fetch: fetchFn, account: account as never });
  assert.equal(r.status, "refused");
  assert.equal(r.signed, false);
  assert.equal(r.decision.recommendation, "REFUSE");
  assert.ok(r.decision.reason_codes.includes("l0_unverified_tls" as never), JSON.stringify(r.decision.reason_codes));
  assert.ok(r.decision.reason_codes.includes("l0_unverified" as never));
});
