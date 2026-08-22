// ============================================================
// ERC-8004 Validation Registry 書込の dry-run 見積もり（純粋関数層）。
//
// 目的: REGISTRY_WRITES_ENABLED を OFF のまま、「もし ON だったら」
//  - 1日に何件の書込候補が出るか（registry-hook の分岐を写す）
//  - 1件あたり Base で幾らか（L2実行 + L1データ）
//  - 7日合計と、実費に基づく上限案
// を wei 整数のまま出す。ここは DB にも RPC にも触れない——実測は
// scripts/registry-dry-run.ts が行い、数字だけをここへ渡す。
//
// 候補の定義は registry-hook.ts の分岐と 1:1:
//   l1-runner が fireL1RegistryHook を呼ぶのは paid retry まで到達した
//   終局4状態（settled / settle_failed / delivered_no_receipt /
//   settle_claimed_unverifiable）だけ。
//   payTo が EVM アドレスでなければ not_evm（Solana 等）。
//   同じ (endpoint, verdict) は requestHash が同じ → 台帳の一意制約で
//   2度目以降は duplicate（チェーン呼び出しゼロ）。
// ============================================================
import { isAddress, parseGwei } from "viem";

export const HOOK_OUTCOME_STATUSES = [
  "settled",
  "settle_failed",
  "delivered_no_receipt",
  "settle_claimed_unverifiable",
] as const;

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

export type L1PurchaseRowLike = {
  endpointId: string;
  status: string;
  payTo: string | null;
  attemptedAt: Date;
};

export type Classification =
  | { kind: "candidate"; verdict: "pass" | "fail" }
  | { kind: "not_evm" }
  | { kind: "not_hook_outcome" };

export function classifyForRegistry(row: L1PurchaseRowLike): Classification {
  if (!(HOOK_OUTCOME_STATUSES as readonly string[]).includes(row.status)) {
    return { kind: "not_hook_outcome" };
  }
  if (!row.payTo || !row.payTo.startsWith("0x") || !isAddress(row.payTo)) {
    return { kind: "not_evm" };
  }
  return { kind: "candidate", verdict: row.status === "settled" ? "pass" : "fail" };
}

export type DailyCandidateRow = {
  day: string;
  /** hook が呼ばれる回数（EVM・終局3状態）。 */
  hook_calls: number;
  /** 初出の (endpoint, verdict) = 実際にチェーンへ向かう件数（台帳が空の前提）。 */
  unique_new_writes: number;
  unique_new_pass: number;
  unique_new_fail: number;
  /** unique_new_writes のうち payTo が索引済み ERC-8004 agent に載っている件数（null=集合未指定）。 */
  unique_new_writes_with_indexed_agent: number | null;
  duplicate_skipped: number;
};

export type CandidateAggregate = {
  window: { start: string; end: string; days: number };
  in_window: {
    rows_total: number;
    not_hook_outcome: number;
    not_evm: number;
    hook_calls: number;
    unique_new_writes: number;
    unique_new_writes_with_indexed_agent: number | null;
    duplicate_skipped: number;
    max_unique_new_writes_per_day: number;
    mean_unique_new_writes_per_day: number;
  };
  days: DailyCandidateRow[];
  assumptions: {
    dedupe_basis: "first_seen_all_time_over_supplied_rows";
    hook_outcome_statuses: readonly string[];
  };
};

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * rows は「全期間」を渡す（窓内だけ渡すと、窓の前に初出した hash を
 * 新規と誤認して過大見積もりになる）。窓内の集計だけを返す。
 */
export function aggregateRegistryCandidates(
  rows: L1PurchaseRowLike[],
  opts: { windowStart: Date; windowEnd: Date; indexedAgentWallets?: Set<string> },
): CandidateAggregate {
  const { windowStart, windowEnd } = opts;
  const indexed = opts.indexedAgentWallets
    ? new Set([...opts.indexedAgentWallets].map((w) => w.toLowerCase()))
    : null;
  const dayCount = Math.max(0, Math.round((windowEnd.getTime() - windowStart.getTime()) / 86_400_000));

  const days = new Map<string, DailyCandidateRow>();
  for (let i = 0; i < dayCount; i++) {
    const day = utcDay(new Date(windowStart.getTime() + i * 86_400_000));
    days.set(day, {
      day,
      hook_calls: 0,
      unique_new_writes: 0,
      unique_new_pass: 0,
      unique_new_fail: 0,
      unique_new_writes_with_indexed_agent: indexed ? 0 : null,
      duplicate_skipped: 0,
    });
  }

  const totals = {
    rows_total: 0,
    not_hook_outcome: 0,
    not_evm: 0,
    hook_calls: 0,
    unique_new_writes: 0,
    unique_new_writes_with_indexed_agent: indexed ? 0 : null,
    duplicate_skipped: 0,
  };

  const sorted = [...rows].sort((a, b) => a.attemptedAt.getTime() - b.attemptedAt.getTime());
  const seen = new Set<string>();
  for (const row of sorted) {
    const inWindow = row.attemptedAt >= windowStart && row.attemptedAt < windowEnd;
    const cls = classifyForRegistry(row);
    if (inWindow) totals.rows_total++;
    if (cls.kind === "not_hook_outcome") {
      if (inWindow) totals.not_hook_outcome++;
      continue;
    }
    if (cls.kind === "not_evm") {
      if (inWindow) totals.not_evm++;
      continue;
    }
    const key = `${row.endpointId}|${cls.verdict}`;
    const firstSeen = !seen.has(key);
    seen.add(key);
    if (!inWindow) continue;

    const bucket = days.get(utcDay(row.attemptedAt));
    totals.hook_calls++;
    if (bucket) bucket.hook_calls++;
    if (!firstSeen) {
      totals.duplicate_skipped++;
      if (bucket) bucket.duplicate_skipped++;
      continue;
    }
    totals.unique_new_writes++;
    if (bucket) {
      bucket.unique_new_writes++;
      if (cls.verdict === "pass") bucket.unique_new_pass++;
      else bucket.unique_new_fail++;
    }
    if (indexed && row.payTo && indexed.has(row.payTo.toLowerCase())) {
      totals.unique_new_writes_with_indexed_agent!++;
      if (bucket) bucket.unique_new_writes_with_indexed_agent!++;
    }
  }

  const dayRows = [...days.values()];
  const max = dayRows.reduce((m, d) => Math.max(m, d.unique_new_writes), 0);
  return {
    window: { start: windowStart.toISOString(), end: windowEnd.toISOString(), days: dayCount },
    in_window: {
      ...totals,
      max_unique_new_writes_per_day: max,
      mean_unique_new_writes_per_day: dayCount > 0 ? totals.unique_new_writes / dayCount : 0,
    },
    days: dayRows,
    assumptions: {
      dedupe_basis: "first_seen_all_time_over_supplied_rows",
      hook_outcome_statuses: HOOK_OUTCOME_STATUSES,
    },
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
