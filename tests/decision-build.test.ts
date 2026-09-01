// §9.1 /decision の応答規範（純関数 buildDecision）
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDecision, DECISION_DISCLAIMER, type DecisionSubject } from "@/lib/decision/decide";
import { DECISION_RULES_VERSION } from "@/lib/decision/rules";
import type { SellerFacts, BuyerFacts } from "@/lib/decision/types";

const subject: DecisionSubject = {
  type: "resource",
  id: "r".repeat(64),
  endpoint_id: "e".repeat(64),
  observatory_id: "00000000-0000-0000-0000-000000000001",
  canonical_url: "https://e.com/x",
  method: "GET",
};
const seller: SellerFacts = {
  l0: { status: "pass", observed_at: "2026-09-02T00:00:00Z", dialect: "v2", fail_reason: null },
  l1: { n_delivered: 1, n_settled: 1, n_attempts: 1, p50_ms: 1, p95_ms: 1, last_purchase_id: "eip155:8453:0x1", observed_at: "2026-09-01T00:00:00Z" },
  l2: { status: "conform", declaration_hash: "d", diff_hash: null, observed_at: "2026-09-01T00:00:00Z" },
  availability_7d: 1,
  availability_30d: 1,
  offer_stability: "stable",
  payees: ["eip155:8453:0xb"],
  settlement_30d_real: 1,
  settlement_30d_raw: 2,
  unique_payers_30d_real: 1,
  wash_dominated: false,
};
const buyer: BuyerFacts = {
  settled_count_30d: 5,
  unique_payees_30d: 2,
  retry_burst_rate: 0,
  sybil: { multi_agent_owner: false, shared_funder: false, cluster_id: null, unavailable: [] },
  erc8004: { agent_id: null, feedback_with_payment_proof_ratio: null },
  first_seen: "2026-07-01T00:00:00Z",
  last_seen: "2026-09-01T00:00:00Z",
};

test("role=payer: facts と recommendation が同居し、freshness / evidence / 版 / disclaimer が付く", () => {
  const d = buildDecision({ role: "payer", subject, facts: seller, options: {}, score: { trustScore: 78, recommendation: "WARN" }, registry: { status: "off", tx_hash: null } });
  assert.equal(d.recommendation, "ALLOW");
  assert.ok("facts" in d && d.facts);
  assert.deepEqual(d.freshness, { l0: seller.l0.observed_at, l1: seller.l1.observed_at, l2: seller.l2.observed_at });
  assert.equal(d.evidence.find((e) => e.level === "L1")?.purchase_id, "eip155:8453:0x1");
  assert.equal(d.rules_version, DECISION_RULES_VERSION);
  assert.equal(d.policy, "allow_only");
  assert.equal(d.disclaimer, DECISION_DISCLAIMER);
  assert.equal(d.registry.status, "off");
});

test("score は deprecated 併記。facts の中には入らない", () => {
  const d = buildDecision({ role: "payer", subject, facts: seller, options: {}, score: { trustScore: 78, recommendation: "WARN" }, registry: { status: "off", tx_hash: null } });
  assert.deepEqual(d.score, { trustScore: 78, recommendation: "WARN", deprecated: true });
  assert.equal("trustScore" in (d.facts as object), false);
  const none = buildDecision({ role: "payer", subject, facts: seller, options: {}, score: null, registry: { status: "off", tx_hash: null } });
  assert.equal(none.score, null);
  assert.equal(none.recommendation, "ALLOW", "スコアが取れなくても判定は落ちない");
});

test("l0 unverified は degraded かつ BLOCK", () => {
  const d = buildDecision({ role: "payer", subject, facts: { ...seller, l0: { ...seller.l0, status: "unverified" } }, options: {}, score: null, registry: { status: "off", tx_hash: null } });
  assert.equal(d.degraded, true);
  assert.equal(d.recommendation, "BLOCK");
});

test("role=payee: payer が載り、score は無く、degraded は sybil.unavailable から", () => {
  const d = buildDecision({ role: "payee", subject, payer: "eip155:8453:0xa", facts: buyer, operatorBlacklist: false, registry: { status: "off", tx_hash: null } });
  assert.equal(d.role, "payee");
  assert.equal(d.payer, "eip155:8453:0xa");
  assert.equal(d.recommendation, "ALLOW");
  assert.equal(d.score, null);
  assert.equal(d.degraded, false);
  const deg = buildDecision({ role: "payee", subject, payer: "eip155:8453:0xa", facts: { ...buyer, sybil: { ...buyer.sybil, unavailable: ["erc8004"] } }, operatorBlacklist: false, registry: { status: "off", tx_hash: null } });
  assert.equal(deg.degraded, true);
  assert.equal(deg.recommendation, "BLOCK");
});

test("cacheExpiresAt は scoredAt + 5 分", () => {
  const now = new Date("2026-09-02T00:00:00Z");
  const d = buildDecision({ role: "payer", subject, facts: seller, options: {}, score: null, registry: { status: "off", tx_hash: null }, now });
  assert.equal(d.scoredAt, now.toISOString());
  assert.equal(Date.parse(d.cacheExpiresAt) - Date.parse(d.scoredAt), 5 * 60_000);
});
