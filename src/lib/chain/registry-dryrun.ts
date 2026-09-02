// ============================================================
// ERC-8004 Validation Registry 書込の dry-run（純粋関数層）。
//
// 目的: REGISTRY_WRITES_ENABLED を OFF のまま、「今 ON にしたら」
//  - 直近 24h に確定した購入のうち、何件・どの endpoint がチェーンへ向かうか
//    （registry-hook の門を 1:1 で写す）
//  - 1件あたり Base で幾らか（L2実行 + L1データ）
// を wei 整数のまま出す。ここは DB にも RPC にも触れない——実測は
// scripts/registry-dryrun.ts が行い、数字だけをここへ渡す。
//
// 発火の定義は settlement-verifier / registry-hook と 1:1（2026-09-02 監査 P1-6/P1-7）:
//   settlement-verifier がチェーンで確定した settled → L1 pass
//     （l2_schema が match / mismatch なら L2 pass / fail も）
//   settle_claim_refuted → L1 fail
//   それ以外（settle_claimed・settle_failed・delivered_no_receipt …）は発火しない
//   payTo が EVM アドレスでなければ not_evm（Solana 等）
//   同じ purchase_id（request_hash）が registry_writes にあれば duplicate
//   endpoint の階層が REGISTRY_WRITE_TIERS に無ければ tier_excluded
//   今日の台帳行数 + 計画数が REGISTRY_DAILY_MAX_WRITES に達したら daily_cap
// 実際にはさらに no_agent（payTo が ERC-8004 agent に解決できない）と
// balance_low / gas_over_cap で退くので、実数はここより小さい。
// ============================================================
import { isAddress, keccak256, parseGwei, toBytes } from "viem";
import type { CoverageTier } from "@/lib/observatory/coverage";
import { purchaseId } from "@/lib/ids/canonical";

/** 発火する終局状態（settlement-verifier の確定と 1:1）。 */
export const HOOK_OUTCOME_STATUSES = ["settled", "settle_claim_refuted"] as const;

/** registry.ts の DEFAULT_MAX_FEE_GWEI と同値（片方だけ変えない）。 */
export const DEFAULT_MAX_FEE_GWEI = 0.5;

/**
 * eth_estimateGas も観測値も取れない時の固定上限（1tx あたり）。
 * Base 上の ValidationRegistry 実送信の観測最大（validationRequest 413,125 /
 * validationResponse 134,790・2026-03-09・Blockscout）を上に丸めた値。
 * 「上限」なので過小にならない側へ置く。
 */
export const FIXED_FALLBACK_GAS = {
  validationRequest: 450_000n,
  validationResponse: 150_000n,
} as const;

export type VerifiedPurchaseRowLike = {
  purchaseRowId: string;
  endpointId: string;
  status: string;
  payTo: string | null;
  network: string | null;
  txHash: string | null;
  l2Schema: string | null;
  settlementVerifiedAt: Date;
};

export type PlannedWrite = {
  purchaseRowId: string;
  endpointId: string;
  tier: CoverageTier;
  level: "l1" | "l2";
  verdict: "pass" | "fail";
  requestKey: string;
  requestHash: `0x${string}`;
  settlementVerifiedAt: string;
};

export type SkipReason = "not_final" | "not_evm" | "no_tx" | "duplicate" | "tier_excluded" | "daily_cap";

export type RegistryWritePlan = {
  writes: PlannedWrite[];
  skipped: Record<SkipReason, number>;
  byEndpoint: { endpointId: string; tier: CoverageTier; writes: number; skipped: number }[];
};

/**
 * 行 → 書込候補（level/verdict）。門はここで通さない（呼び手 planRegistryWrites が通す）。
 */
function candidatesOf(row: VerifiedPurchaseRowLike): { level: "l1" | "l2"; verdict: "pass" | "fail" }[] {
  if (row.status === "settled") {
    const out: { level: "l1" | "l2"; verdict: "pass" | "fail" }[] = [{ level: "l1", verdict: "pass" }];
    if (row.l2Schema === "match") out.push({ level: "l2", verdict: "pass" });
    else if (row.l2Schema === "mismatch") out.push({ level: "l2", verdict: "fail" });
    return out;
  }
  if (row.status === "settle_claim_refuted") return [{ level: "l1", verdict: "fail" }];
  return [];
}

/**
 * 「今 ON にしたら何が書かれるか」。registry-hook の門を同じ順で写す。
 * rows は settlement_verified_at の窓（既定 24h）で取った行。確定が早い順に日次枠を埋める。
 */
export function planRegistryWrites(
  rows: readonly VerifiedPurchaseRowLike[],
  opts: {
    allowedTiers: ReadonlySet<CoverageTier>;
    tierOf: ReadonlyMap<string, CoverageTier>;
    existingHashes: ReadonlySet<string>;
    dailyMax: number;
    writesToday: number;
  },
): RegistryWritePlan {
  const skipped: Record<SkipReason, number> = { not_final: 0, not_evm: 0, no_tx: 0, duplicate: 0, tier_excluded: 0, daily_cap: 0 };
  const perEndpoint = new Map<string, { tier: CoverageTier; writes: number; skipped: number }>();
  const touch = (endpointId: string) => {
    let e = perEndpoint.get(endpointId);
    if (!e) {
      e = { tier: opts.tierOf.get(endpointId) ?? "C0", writes: 0, skipped: 0 };
      perEndpoint.set(endpointId, e);
    }
    return e;
  };
  const writes: PlannedWrite[] = [];
  const planned = new Set<string>(opts.existingHashes);
  let budget = Math.max(0, opts.dailyMax - opts.writesToday);

  const sorted = [...rows].sort((a, b) => a.settlementVerifiedAt.getTime() - b.settlementVerifiedAt.getTime());
  for (const row of sorted) {
    const cands = candidatesOf(row);
    if (cands.length === 0) {
      skipped.not_final++;
      continue;
    }
    const ep = touch(row.endpointId);
    if (!row.payTo || !row.payTo.startsWith("0x") || !isAddress(row.payTo)) {
      skipped.not_evm++;
      ep.skipped++;
      continue;
    }
    if (!row.txHash) {
      skipped.no_tx++;
      ep.skipped++;
      continue;
    }
    const network = row.network ?? "eip155:8453";
    for (const c of cands) {
      const requestKey = `${purchaseId(network, row.txHash)}${c.level === "l2" ? ":l2" : ""}`;
      const requestHash = keccak256(toBytes(requestKey));
      if (planned.has(requestHash)) {
        skipped.duplicate++;
        ep.skipped++;
        continue;
      }
      if (!opts.allowedTiers.has(ep.tier)) {
        skipped.tier_excluded++;
        ep.skipped++;
        continue;
      }
      if (budget <= 0) {
        skipped.daily_cap++;
        ep.skipped++;
        continue;
      }
      budget--;
      planned.add(requestHash);
      ep.writes++;
      writes.push({
        purchaseRowId: row.purchaseRowId,
        endpointId: row.endpointId,
        tier: ep.tier,
        level: c.level,
        verdict: c.verdict,
        requestKey,
        requestHash,
        settlementVerifiedAt: row.settlementVerifiedAt.toISOString(),
      });
    }
  }
  return {
    writes,
    skipped,
    byEndpoint: [...perEndpoint.entries()].map(([endpointId, e]) => ({ endpointId, ...e })),
  };
}

export type GasUnitsSource = "eth_estimateGas" | "observed_onchain_median" | "fixed_fallback";

/** 取れた順に使う。取れなかった段は source に残り、黙って固定値に落ちない。 */
export function selectGasUnits(input: {
  estimated: bigint | null;
  observedMedian: bigint | null;
  fixed: bigint;
}): { units: bigint; source: GasUnitsSource } {
  if (input.estimated !== null && input.estimated > 0n) {
    return { units: input.estimated, source: "eth_estimateGas" };
  }
  if (input.observedMedian !== null && input.observedMedian > 0n) {
    return { units: input.observedMedian, source: "observed_onchain_median" };
  }
  return { units: input.fixed, source: "fixed_fallback" };
}

export function medianBigint(values: bigint[]): bigint | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2n;
}

export function estimateWriteCostWei(input: {
  requestGas: bigint;
  responseGas: bigint;
  feePerGasWei: bigint;
  requestL1FeeWei: bigint;
  responseL1FeeWei: bigint;
}): { gas_units_total: bigint; l2_execution_wei: bigint; l1_data_wei: bigint; total_wei: bigint } {
  const gasUnits = input.requestGas + input.responseGas;
  const l2 = gasUnits * input.feePerGasWei;
  const l1 = input.requestL1FeeWei + input.responseL1FeeWei;
  return { gas_units_total: gasUnits, l2_execution_wei: l2, l1_data_wei: l1, total_wei: l2 + l1 };
}

/** registry.ts publishValidation のサーキットブレーカと同じ判定（cap 超過で退く）。 */
export function wouldSkipForGasCap(currentMaxFeeWei: bigint, capEnv: string | undefined): boolean {
  const capGwei = Number(capEnv ?? DEFAULT_MAX_FEE_GWEI);
  const maxFeeGwei = Number(currentMaxFeeWei) / 1e9;
  return maxFeeGwei > capGwei;
}

export function capGweiToWei(capGwei: number): bigint {
  return parseGwei(String(capGwei));
}

export function formatWeiAsEth(wei: bigint): string {
  const neg = wei < 0n;
  const abs = neg ? -wei : wei;
  const whole = abs / 10n ** 18n;
  const frac = (abs % 10n ** 18n).toString().padStart(18, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

export function weiToUsd(wei: bigint, ethUsd: number | null): number | null {
  if (ethUsd === null || !Number.isFinite(ethUsd)) return null;
  return (Number(wei) / 1e18) * ethUsd;
}

export function recommendCaps(input: {
  maxUniqueNewWritesPerDay: number;
  perWriteAtCapWei: bigint;
  perWriteNowWei: bigint;
  capGwei: number;
}): {
  max_fee_gwei_cap_recommended: number;
  daily_writes_cap_recommended: number;
  daily_gas_budget_wei_at_cap: bigint;
  weekly_gas_budget_wei_at_cap: bigint;
  monthly_30d_gas_budget_wei_at_cap: bigint;
  daily_gas_budget_wei_at_current_fee: bigint;
} {
  const n = BigInt(Math.max(0, Math.floor(input.maxUniqueNewWritesPerDay)));
  const daily = n * input.perWriteAtCapWei;
  return {
    max_fee_gwei_cap_recommended: input.capGwei,
    daily_writes_cap_recommended: Number(n),
    daily_gas_budget_wei_at_cap: daily,
    weekly_gas_budget_wei_at_cap: daily * 7n,
    monthly_30d_gas_budget_wei_at_cap: daily * 30n,
    daily_gas_budget_wei_at_current_fee: n * input.perWriteNowWei,
  };
}
