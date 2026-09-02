// ============================================================
// ERC-8004 Validation Registry 書込の dry-run 見積もり（2026-08-21・WO#5）。
// 金（ガス）に直結する数字を出す計算なので、純粋関数として固定する:
//  - 候補の判定は registry-hook の分岐と同じ（hookが呼ばれる終局3状態・EVM payTo のみ）
//  - 重複 requestHash は「初出の日」にだけ数える（台帳の一意制約＝冪等ゲートの写し）
//  - ガス単位は eth_estimateGas → 観測中央値 → 固定上限 の順で fail-closed に選ぶ
//  - 費用 = L2実行(gas×fee) + L1データ手数料（Base はOPスタック）。丸めない（wei整数）
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toBytes } from "viem";
import {
  estimateWriteCostWei,
  formatWeiAsEth,
  HOOK_OUTCOME_STATUSES,
  medianBigint,
  planRegistryWrites,
  recommendCaps,
  selectGasUnits,
  weiToUsd,
  wouldSkipForGasCap,
  type VerifiedPurchaseRowLike,
} from "@/lib/chain/registry-dryrun";

const EVM = "0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea";
const SOL = "GqSs5L9aPWGJwyRQe35YKQaWMDPh3R1dMqfSEPhSgkM";
const E1 = "5f0c9c5e-2c3a-4b1e-9a4d-8f6b2e1c7d0a";
const E2 = "6a1d0d6f-3d4b-4c2f-8b5e-9a7c3f2d8e1b";
const TX1 = `0x${"ab".repeat(32)}`;
const TX2 = `0x${"cd".repeat(32)}`;
const TX3 = `0x${"ef".repeat(32)}`;

let seq = 0;
function row(p: Partial<VerifiedPurchaseRowLike> & { verifiedAt?: string }): VerifiedPurchaseRowLike {
  seq++;
  return {
    purchaseRowId: p.purchaseRowId ?? `row-${seq}`,
    endpointId: p.endpointId ?? E1,
    status: p.status ?? "settled",
    payTo: p.payTo === undefined ? EVM : p.payTo,
    network: p.network === undefined ? "eip155:8453" : p.network,
    txHash: p.txHash === undefined ? TX1 : p.txHash,
    l2Schema: p.l2Schema === undefined ? "not_checked" : p.l2Schema,
    settlementVerifiedAt: new Date(p.verifiedAt ?? "2026-09-02T10:00:00Z"),
  };
}

const base = () => ({
  allowedTiers: new Set<"C0" | "C1" | "C2" | "C3" | "C4">(["C2", "C3"]),
  tierOf: new Map<string, "C0" | "C1" | "C2" | "C3" | "C4">([[E1, "C2"], [E2, "C3"]]),
  existingHashes: new Set<string>(),
  dailyMax: 200,
  writesToday: 0,
});

test("発火する終局状態は settled / settle_claim_refuted だけ（settlement-verifier の確定と 1:1）", () => {
  assert.deepEqual([...HOOK_OUTCOME_STATUSES], ["settled", "settle_claim_refuted"]);
});

test("plan: settled（EVM・C2）＋ L2 match → L1 pass と L2 pass の 2 件。requestKey は purchase_id と purchase_id:l2", () => {
  const out = planRegistryWrites([row({ l2Schema: "match" })], base());
  assert.equal(out.writes.length, 2);
  assert.deepEqual(
    out.writes.map((w) => [w.level, w.verdict, w.requestKey]),
    [["l1", "pass", `eip155:8453:${TX1}`], ["l2", "pass", `eip155:8453:${TX1}:l2`]],
  );
  assert.equal(out.writes[0].requestHash, keccak256(toBytes(`eip155:8453:${TX1}`)));
  assert.equal(out.writes[0].tier, "C2");
  assert.equal(out.writes[0].endpointId, E1);
});

test("plan: settled・L2 mismatch → L2 は fail。未検査・宣言なしなら L2 は出ない", () => {
  const mis = planRegistryWrites([row({ l2Schema: "mismatch" })], base());
  assert.deepEqual(mis.writes.map((w) => [w.level, w.verdict]), [["l1", "pass"], ["l2", "fail"]]);
  const none = planRegistryWrites([row({ l2Schema: "no_declaration" })], base());
  assert.deepEqual(none.writes.map((w) => [w.level, w.verdict]), [["l1", "pass"]]);
});

test("plan: settle_claim_refuted → L1 fail だけ（L2 match でも L2 は書かない）", () => {
  const out = planRegistryWrites([row({ status: "settle_claim_refuted", l2Schema: "match" })], base());
  assert.deepEqual(out.writes.map((w) => [w.level, w.verdict]), [["l1", "fail"]]);
});

test("plan: 未確定（settle_claimed 等）は not_final・Solana は not_evm・tx 無しは no_tx", () => {
  const out = planRegistryWrites(
    [
      row({ status: "settle_claimed" }),
      row({ status: "settle_failed" }),
      row({ payTo: SOL, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", txHash: "5x" }),
      row({ txHash: null }),
    ],
    base(),
  );
  assert.equal(out.writes.length, 0);
  assert.equal(out.skipped.not_final, 2);
  assert.equal(out.skipped.not_evm, 1);
  assert.equal(out.skipped.no_tx, 1);
});

test("plan: 台帳に同じ request_hash があれば duplicate（L1 だけ既存なら L2 は書く）", () => {
  const opts = base();
  opts.existingHashes.add(keccak256(toBytes(`eip155:8453:${TX1}`)));
  const out = planRegistryWrites([row({ l2Schema: "match" })], opts);
  assert.deepEqual(out.writes.map((w) => w.level), ["l2"]);
  assert.equal(out.skipped.duplicate, 1);
});

test("plan: tier が REGISTRY_WRITE_TIERS に無ければ tier_excluded。未知の endpoint は C0 扱いで除外", () => {
  const opts = base();
  opts.tierOf.set(E1, "C1");
  const out = planRegistryWrites([row({}), row({ endpointId: "unknown-endpoint", txHash: TX2 })], opts);
  assert.equal(out.writes.length, 0);
  assert.equal(out.skipped.tier_excluded, 2);
  assert.deepEqual(out.byEndpoint.map((e) => [e.endpointId, e.tier, e.writes]), [[E1, "C1", 0], ["unknown-endpoint", "C0", 0]]);
});

test("plan: 日次上限は writesToday を含めて数え、確定が早い順に埋める", () => {
  const opts = { ...base(), dailyMax: 3, writesToday: 1 };
  const out = planRegistryWrites(
    [
      row({ endpointId: E2, txHash: TX2, l2Schema: "match", verifiedAt: "2026-09-02T12:00:00Z" }),
      row({ endpointId: E1, txHash: TX1, verifiedAt: "2026-09-02T09:00:00Z" }),
      row({ endpointId: E1, txHash: TX3, verifiedAt: "2026-09-02T13:00:00Z" }),
    ],
    opts,
  );
  // 残り枠 2: 09:00 の E1/TX1 L1 → 12:00 の E2/TX2 L1 まで。E2 の L2 と 13:00 の TX3 は daily_cap。
  assert.deepEqual(out.writes.map((w) => [w.endpointId, w.level]), [[E1, "l1"], [E2, "l1"]]);
  assert.equal(out.skipped.daily_cap, 2);
  assert.deepEqual(out.byEndpoint.map((e) => [e.endpointId, e.writes]), [[E1, 1], [E2, 1]]);
});

test("selectGasUnits: estimate → 観測中央値 → 固定 の順・失敗は黙らず source に残す", () => {
  assert.deepEqual(selectGasUnits({ estimated: 120_000n, observedMedian: 130_000n, fixed: 400_000n }), {
    units: 120_000n,
    source: "eth_estimateGas",
  });
  assert.deepEqual(selectGasUnits({ estimated: null, observedMedian: 130_000n, fixed: 400_000n }), {
    units: 130_000n,
    source: "observed_onchain_median",
  });
  assert.deepEqual(selectGasUnits({ estimated: null, observedMedian: null, fixed: 400_000n }), {
    units: 400_000n,
    source: "fixed_fallback",
  });
  // 0 や負は「取れなかった」扱い
  assert.equal(selectGasUnits({ estimated: 0n, observedMedian: null, fixed: 1n }).source, "fixed_fallback");
});

test("medianBigint: 偶数個は中央2つの平均（切り捨て）・空は null", () => {
  assert.equal(medianBigint([]), null);
  assert.equal(medianBigint([5n]), 5n);
  assert.equal(medianBigint([3n, 1n, 2n]), 2n);
  assert.equal(medianBigint([1n, 2n, 3n, 10n]), 2n);
});

test("estimateWriteCostWei: 2tx（request+response）の L2実行 + L1データ を wei 整数で合算", () => {
  const out = estimateWriteCostWei({
    requestGas: 378_937n,
    responseGas: 134_790n,
    feePerGasWei: 5_000_000n, // 0.005 gwei
    requestL1FeeWei: 1_000n,
    responseL1FeeWei: 2_000n,
  });
  assert.equal(out.l2_execution_wei, (378_937n + 134_790n) * 5_000_000n);
  assert.equal(out.l1_data_wei, 3_000n);
  assert.equal(out.total_wei, (378_937n + 134_790n) * 5_000_000n + 3_000n);
  assert.equal(out.gas_units_total, 513_727n);
});

test("wouldSkipForGasCap: registry.ts のサーキットブレーカと同じ境界（cap超過で退く・等しければ書く）", () => {
  // 既定 0.5 gwei
  assert.equal(wouldSkipForGasCap(500_000_000n, undefined), false);
  assert.equal(wouldSkipForGasCap(500_000_001n, undefined), true);
  assert.equal(wouldSkipForGasCap(2_000_000_000n, "3"), false);
  assert.equal(wouldSkipForGasCap(2_000_000_000n, "1.5"), true);
});

test("formatWeiAsEth / weiToUsd: 丸めない（ETHは18桁の厳密10進・USDは出所必須）", () => {
  assert.equal(formatWeiAsEth(0n), "0.000000000000000000");
  assert.equal(formatWeiAsEth(1n), "0.000000000000000001");
  assert.equal(formatWeiAsEth(1_500_000_000_000_000_000n), "1.500000000000000000");
  assert.equal(weiToUsd(1_000_000_000_000_000_000n, 3000), 3000);
  assert.equal(weiToUsd(500_000_000_000_000_000n, 3000.5), 1500.25);
  assert.equal(weiToUsd(1n, null), null);
});

test("recommendCaps: 最大日次件数×1件費用で日次/7日/30日の上限を wei のまま出す（丸めない）", () => {
  const out = recommendCaps({
    maxUniqueNewWritesPerDay: 3,
    perWriteAtCapWei: 1_234_567n,
    perWriteNowWei: 1_000n,
    capGwei: 0.5,
  });
  assert.equal(out.max_fee_gwei_cap_recommended, 0.5);
  assert.equal(out.daily_writes_cap_recommended, 3);
  assert.equal(out.daily_gas_budget_wei_at_cap, 3_703_701n);
  assert.equal(out.weekly_gas_budget_wei_at_cap, 25_925_907n);
  assert.equal(out.monthly_30d_gas_budget_wei_at_cap, 111_111_030n);
  assert.equal(out.daily_gas_budget_wei_at_current_fee, 3_000n);
  // 件数0なら予算0（「書くものが無いのに上限を設ける」を作らない）
  assert.equal(
    recommendCaps({ maxUniqueNewWritesPerDay: 0, perWriteAtCapWei: 1n, perWriteNowWei: 1n, capGwei: 0.5 })
      .daily_gas_budget_wei_at_cap,
    0n,
  );
});
