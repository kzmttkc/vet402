// §8.3 判定関数（純関数・版固定）
import { test } from "node:test";
import assert from "node:assert/strict";
import { decidePayer, decidePayee, DECISION_RULES_VERSION } from "@/lib/decision/rules";
import type { SellerFacts, BuyerFacts } from "@/lib/decision/types";

const ok: SellerFacts = {
  l0: { status: "pass", observed_at: "2026-09-02T00:00:00Z", dialect: "v2", fail_reason: null },
  l1: { n_delivered: 1, n_settled: 1, n_attempts: 1, n_probe_error: 0, p50_ms: 300, p95_ms: 300, last_purchase_id: "eip155:8453:0x1", observed_at: "2026-09-01T00:00:00Z" },
  l2: { status: "undeclared", declaration_hash: null, diff_hash: null, observed_at: null },
  availability_7d: 1,
  availability_30d: 1,
  offer_stability: "stable",
  payees: ["eip155:8453:0xb"],
  settlement_30d_real: 3,
  settlement_30d_raw: 5,
  unique_payers_30d_real: 2,
  wash_dominated: false,
};

test("版が固定されている", () => assert.equal(DECISION_RULES_VERSION, "2026-09-02.1"));

test("ALLOW: l0 pass ∧ n_delivered ≥ 1 ∧ l2 ≠ mismatch。l2_undeclared は reason に載るが ALLOW を妨げない", () => {
  const d = decidePayer(ok);
  assert.equal(d.recommendation, "ALLOW");
  assert.ok(d.reason_codes.includes("l0_pass"));
  assert.ok(d.reason_codes.includes("l1_delivered"));
  assert.ok(d.reason_codes.includes("l2_undeclared"));
});

test("BLOCK: l0 fail / unverified（fail-closed）", () => {
  assert.equal(decidePayer({ ...ok, l0: { ...ok.l0, status: "fail" } }).recommendation, "BLOCK");
  assert.equal(decidePayer({ ...ok, l0: { ...ok.l0, status: "unverified" } }).recommendation, "BLOCK");
});

test("BLOCK: 3 回以上試して 1 件も届かない。2 回なら WARN", () => {
  assert.equal(decidePayer({ ...ok, l1: { ...ok.l1, n_delivered: 0, n_settled: 0, n_attempts: 3 } }).recommendation, "BLOCK");
  const two = decidePayer({ ...ok, l1: { ...ok.l1, n_delivered: 0, n_settled: 0, n_attempts: 2 } });
  assert.equal(two.recommendation, "WARN");
  assert.ok(two.reason_codes.includes("l1_never_delivered"));
});

test("BLOCK: l2 mismatch / wash_dominated / operator_blacklist", () => {
  assert.equal(decidePayer({ ...ok, l2: { ...ok.l2, status: "mismatch" } }).recommendation, "BLOCK");
  assert.equal(decidePayer({ ...ok, wash_dominated: true }).recommendation, "BLOCK");
  assert.equal(decidePayer(ok, { operatorBlacklist: true }).recommendation, "BLOCK");
});

test("WARN: L1 未実施（既定）、オプトインで ALLOW", () => {
  const noL1 = { ...ok, l1: { ...ok.l1, n_delivered: 0, n_settled: 0, n_attempts: 0, last_purchase_id: null } };
  const d = decidePayer(noL1);
  assert.equal(d.recommendation, "WARN");
  assert.ok(d.reason_codes.includes("l1_not_attempted"));
  const opt = decidePayer(noL1, { allowWithoutL1: true });
  assert.equal(opt.recommendation, "ALLOW");
  assert.ok(opt.reason_codes.includes("l1_waived_by_operator"));
});

test("WARN: drifting / thin / 方言不一致。both・unpayable は不一致にしない", () => {
  assert.equal(decidePayer({ ...ok, offer_stability: "drifting" }).recommendation, "WARN");
  assert.equal(decidePayer(ok, { dataDepth: "thin" }).recommendation, "WARN");
  assert.equal(decidePayer({ ...ok, l0: { ...ok.l0, dialect: "v2" } }, { callerDialect: "v1" }).recommendation, "WARN");
  assert.equal(decidePayer({ ...ok, l0: { ...ok.l0, dialect: "both" } }, { callerDialect: "v1" }).recommendation, "ALLOW");
  assert.equal(decidePayer({ ...ok, l0: { ...ok.l0, dialect: "v1" } }, { callerDialect: "v1" }).recommendation, "ALLOW");
});

test("順序: BLOCK 条件は WARN/ALLOW 条件に勝つ", () => {
  assert.equal(decidePayer({ ...ok, offer_stability: "drifting", l2: { ...ok.l2, status: "mismatch" } }).recommendation, "BLOCK");
});

test("L3（quality）を混ぜても判定は変わらない（型に無い入力は無視される）", () => {
  const withL3 = { ...ok, quality: { score: 0 } } as unknown as SellerFacts;
  assert.equal(decidePayer(withL3).recommendation, decidePayer(ok).recommendation);
  const withL3b = { ...ok, l0: { ...ok.l0, status: "fail" }, quality: { score: 100 } } as unknown as SellerFacts;
  assert.equal(decidePayer(withL3b).recommendation, "BLOCK");
});

const now = new Date("2026-09-02T00:00:00Z");
const buyer: BuyerFacts = {
  settled_count_30d: 12,
  unique_payees_30d: 4,
  retry_burst_rate: 0.05,
  sybil: { multi_agent_owner: false, shared_funder: false, cluster_id: null, unavailable: [] },
  erc8004: { agent_id: null, feedback_with_payment_proof_ratio: null },
  first_seen: "2026-07-01T00:00:00Z",
  last_seen: "2026-09-01T00:00:00Z",
};

test("payee 判定: 既定 ALLOW", () => {
  const d = decidePayee(buyer, { now });
  assert.equal(d.recommendation, "ALLOW");
  assert.deepEqual(d.reason_codes, ["history_ok"]);
});

test("payee 判定: shared_funder / 新規 / thin は WARN", () => {
  assert.equal(decidePayee({ ...buyer, sybil: { ...buyer.sybil, shared_funder: true } }, { now }).recommendation, "WARN");
  assert.equal(decidePayee({ ...buyer, first_seen: "2026-09-01T00:00:00Z" }, { now }).recommendation, "WARN");
  assert.equal(decidePayee({ ...buyer, settled_count_30d: 1 }, { now }).recommendation, "WARN");
});

test("payee 判定: sybil 高 / retry 超過 / degraded / blacklist は BLOCK", () => {
  assert.equal(decidePayee({ ...buyer, retry_burst_rate: 0.5 }, { now }).recommendation, "BLOCK");
  assert.equal(decidePayee({ ...buyer, sybil: { ...buyer.sybil, multi_agent_owner: true, shared_funder: true } }, { now }).recommendation, "BLOCK");
  const degraded = decidePayee({ ...buyer, sybil: { ...buyer.sybil, unavailable: ["funder_index"] } }, { now });
  assert.equal(degraded.recommendation, "BLOCK");
  assert.ok(degraded.reason_codes.includes("funder_index_unavailable"));
  assert.equal(decidePayee(buyer, { now, operatorBlacklist: true }).recommendation, "BLOCK");
});

test("payee 判定: ERC-8004 登録は reason に載るだけで判定を変えない（加点材料に留める）", () => {
  const d = decidePayee({ ...buyer, settled_count_30d: 1, erc8004: { agent_id: "eip155:8453:8004:1", feedback_with_payment_proof_ratio: 1 } }, { now });
  assert.equal(d.recommendation, "WARN");
  assert.ok(d.reason_codes.includes("erc8004_registered"));
});
