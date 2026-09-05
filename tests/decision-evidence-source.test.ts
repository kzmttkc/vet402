// ============================================================
// evidence[].source — どの台帳が答えたかを、行ごとに機械可読で残す
// （ETHOnline 2026 / WINDOW_PLAN §2 #3・§13・§15。2026-09-05）
//
// WHY. 2026-09-05 の本番 /decision が返す evidence 行は `{level, url}` だけで、
// 「これは誰の観測か」がどこにも無かった。payOrRefuse は同じ配列に
// **The Graph の subgraph から読んだ行**を混ぜる（packages/sdk/src/pay-or-refuse.ts）。
// 源の名前が無い配列は、2 つの台帳の観測を 1 つの束にして見せることになる——
// §3 の核（同じウォレットについて我々のエンジンは WARN 69 / thin、The Graph の
// subgraph は受領 253 件）を、いちばん要る場所で潰す。
//
// この suite が固定するのは 3 つ:
//   1. **行は必ず源を名乗る。** /decision が出す行はすべて `source: "vet402"`
//   2. **live を名乗る行は証跡を持つ。** `source: "subgraph"` の行は
//      subgraphId / block.number / deployment / queriedAt を欠いてはならない
//      （§15: `_meta.block.number` と `deployment` が「live を読んだ」ことの唯一の自明な証明）
//   3. **源をまたいで足さない（D16）。** 1 行は 1 つの源の観測であり、
//      自社台帳の件数と subgraph の受領件数を 1 行・1 つの数にまとめてはならない
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDecision, type DecisionSubject } from "@/lib/decision/decide";
import { l2EvidenceOf } from "@/lib/decision/seller-facts";
import { assertEvidenceContract, EVIDENCE_SOURCES } from "@/lib/decision/evidence";
import type { Evidence, SellerFacts } from "@/lib/decision/types";

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
  l1: { n_delivered: 3, n_settled: 3, n_attempts: 3, n_probe_error: 0, p50_ms: 1, p95_ms: 1, last_purchase_id: "eip155:8453:0x1", observed_at: "2026-09-01T00:00:00Z", last_attempt_at: "2026-09-01T00:00:00Z" },
  l2: { status: "conform", declaration_hash: "d", response_hash: "r", diff_hash: null, missing_keys: null, observed_at: "2026-09-01T00:00:00Z" },
  availability_7d: 1,
  availability_30d: 1,
  offer_stability: "stable",
  payees: ["eip155:8453:0xb"],
  settlement_30d_real: 1,
  settlement_30d_raw: 2,
  settlement_30d_test: 0,
  unique_payers_30d_real: 1,
  wash_dominated: false,
};

/** §15 の実測どおりの形（09-05 09:00 の The Graph 受取ウォレット）。 */
const liveSubgraphRow = (): Evidence => ({
  level: "L1",
  source: "subgraph",
  url: "https://gateway.thegraph.com/api/subgraphs/id/Cb56epg3EvQ6JRpPfknbkM54QxpzTvLa7mwKNQQfUyoj",
  subgraphId: "Cb56epg3EvQ6JRpPfknbkM54QxpzTvLa7mwKNQQfUyoj",
  block: { number: 50888579, timestamp: 1757062800 },
  deployment: "QmcE24HARdXXnziPii9bWFRV6njfWW82H1RKPe5x9hBkUN",
  queriedAt: "2026-09-05T09:00:00.000Z",
  receipts: 253,
});

// ------------------------------------------------------------------
// 1. 行は必ず源を名乗る
// ------------------------------------------------------------------
test("/decision の evidence 行はすべて source を持ち、自社の観測は vet402 と名乗る", () => {
  const d = buildDecision({ role: "payer", subject, facts: seller, options: {}, score: null, registry: { status: "off", tx_hash: null } });
  assert.ok(d.evidence.length >= 3, `L0 / L1 / L2 の 3 行が出るはず: ${JSON.stringify(d.evidence)}`);
  for (const row of d.evidence) {
    assert.equal(row.source, "vet402", `${row.level} の行が源を名乗っていない: ${JSON.stringify(row)}`);
  }
});

test("l2EvidenceOf（/facts と /decision が共有する L2 行）も源を名乗る", () => {
  const row = l2EvidenceOf(seller, subject.observatory_id);
  assert.ok(row, "conform なら L2 行が出る");
  assert.equal(row.source, "vet402");
});

test("buildDecision の出す行は行契約を満たす（構築側が関門を通っている）", () => {
  const d = buildDecision({ role: "payer", subject, facts: seller, options: {}, score: null, registry: { status: "off", tx_hash: null } });
  assert.doesNotThrow(() => assertEvidenceContract(d.evidence));
});

test("行の源は 2 つだけ。`both` は行の値ではない（読む源の指定であって観測の出どころではない）", () => {
  assert.deepEqual([...EVIDENCE_SOURCES], ["vet402", "subgraph"]);
});

// ------------------------------------------------------------------
// 2. live を名乗る行は証跡を持つ
// ------------------------------------------------------------------
test("正しい subgraph 行と vet402 行は契約を通る", () => {
  assert.doesNotThrow(() =>
    assertEvidenceContract([
      { level: "L1", source: "vet402", purchase_id: "eip155:8453:0x1", url: "https://vet402.com/x" },
      liveSubgraphRow(),
    ]),
  );
});

test("source が無い行は通さない（源を名乗らない観測を配らない）", () => {
  const row = { level: "L1", url: "https://vet402.com/x" } as unknown as Evidence;
  assert.throws(() => assertEvidenceContract([row]), /evidence_row_missing_source/);
});

test("source が 2 つの源をまとめた語（both）の行は通さない", () => {
  const row = { ...liveSubgraphRow(), source: "both" } as unknown as Evidence;
  assert.throws(() => assertEvidenceContract([row]), /evidence_row_unknown_source/);
});

for (const missing of ["subgraphId", "deployment", "queriedAt"] as const) {
  test(`subgraph 行から ${missing} が欠けたら通さない（live を読んだ証跡が無い）`, () => {
    const row = liveSubgraphRow();
    delete row[missing];
    assert.throws(() => assertEvidenceContract([row]), /evidence_row_not_live/);
  });
}

test("subgraph 行から block が欠けたら通さない（ブロック高が無ければ live と言えない）", () => {
  const row = liveSubgraphRow();
  delete row.block;
  assert.throws(() => assertEvidenceContract([row]), /evidence_row_not_live/);
});

test("block.number が数でない subgraph 行は通さない（形だけの証跡を証拠にしない）", () => {
  const row = { ...liveSubgraphRow(), block: { number: "50888579" } } as unknown as Evidence;
  assert.throws(() => assertEvidenceContract([row]), /evidence_row_not_live/);
});

// ------------------------------------------------------------------
// 3. 源をまたいで足さない（D16）
// ------------------------------------------------------------------
test("1 行が 2 つの源の材料を持っていたら通さない（自社の purchase_id と subgraph の証跡の同居）", () => {
  const row = { ...liveSubgraphRow(), source: "vet402", purchase_id: "eip155:8453:0x1" } as unknown as Evidence;
  assert.throws(() => assertEvidenceContract([row]), /evidence_row_mixes_sources/);
});

test("vet402 の行が subgraph の受領件数を持っていたら通さない（合算の入口）", () => {
  const row = { level: "L1", source: "vet402", url: "https://vet402.com/x", receipts: 253 } as unknown as Evidence;
  assert.throws(() => assertEvidenceContract([row]), /evidence_row_mixes_sources/);
});

test("2 つの源は 2 行のまま残り、件数は行ごとに別々に読める（合算した 1 つの数を作らない）", () => {
  const rows: Evidence[] = [
    { level: "L1", source: "vet402", purchase_id: "eip155:8453:0x1", url: "https://vet402.com/x" },
    liveSubgraphRow(),
  ];
  assertEvidenceContract(rows);
  assert.equal(rows.length, 2, "源が違えば行も違う");
  assert.equal(rows.filter((r) => r.source === "subgraph").length, 1);
  assert.equal(rows.filter((r) => r.source === "vet402").length, 1);
  // 受領件数は subgraph の行だけが持つ。自社行の側に同じ数が現れたら、それは合算である。
  assert.equal(rows.find((r) => r.source === "vet402")?.receipts, undefined);
  assert.equal(rows.find((r) => r.source === "subgraph")?.receipts, 253);
});
