// ============================================================
// ERC-8004 段階 D: Reputation Registry へ週次 successRate を書く計画（純関数）。
// 鎖への送信は scripts/erc8004-attest.ts が行う（本番は --send + オーナー承認）。
// ============================================================
import { parseAbi, keccak256, toBytes, type Address } from "viem";
import { ERC8004_ADDRESSES } from "@/lib/chain/config";
import { heldReasonOf, isDelivered } from "@/lib/observatory/delivery";
import type { PurchaseFeedbackRow } from "@/lib/observatory/erc8004-feedback";
import { buildProofOfPayment } from "@/lib/observatory/erc8004-feedback";
import type { Erc8004Match } from "@/lib/observatory/erc8004-match";
import { BASE_PAYER_PERIODS } from "@/lib/sellers/payers";

/** Deployed selector 0x3c036a7e on Base (2026-11-17). proofOfPayment lives in feedbackURI JSON. */
export const REPUTATION_REGISTRY_ABI = parseAbi([
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash) external",
]);

/** On-chain client address for vet402 weekly Reputation Registry attestments (public, docs/runbook/erc8004-attest.md). */
export const ERC8004_ATTEST_WRITER = "0x2180A4d582B0551c596830320139adb163bd271a" as const;

export const ERC8004_ATTEST_TAG1 = "successRate" as const;
export const ERC8004_ATTEST_TAG2 = "vet402" as const;
export const ERC8004_ATTEST_VALUE_DECIMALS = 2;
export const ERC8004_ATTEST_MIN_SETTLED = 3;
export const ERC8004_ATTEST_MAX_AGENTS = 200;
/** 1 回の走りのガス上限（wei）。 */
export const ERC8004_ATTEST_MAX_GAS_WEI = 500_000_000_000_000n;
export const ERC8004_INDEXED_CHAIN = "eip155:8453" as const;

export const BASE_PURCHASE_PAYERS: readonly string[] = BASE_PAYER_PERIODS.map((p) => p.address.toLowerCase());

export type AttestPopulation = {
  settled: number;
  delivered: number;
  inconclusiveSettled: number;
  judged: number;
  ratePercent: number | null;
  /** giveFeedback の int128（valueDecimals 2 → 85.5% は 8550）。 */
  value: bigint | null;
};

export function computeAttestPopulation(rows: readonly PurchaseFeedbackRow[]): AttestPopulation {
  const settledRows = rows.filter((r) => r.status === "settled");
  let inconclusiveSettled = 0;
  let delivered = 0;
  for (const r of settledRows) {
    const held = heldReasonOf({
      status: r.status,
      httpStatusPaid: r.http_status_paid,
      txHash: r.tx_hash,
      attemptedAt: r.attempted_at,
      network: r.network,
    });
    if (held === "settled_4xx") {
      inconclusiveSettled++;
      continue;
    }
    if (
      isDelivered({
        status: r.status,
        httpStatusPaid: r.http_status_paid,
        payloadNonEmpty: r.payload_non_empty,
      })
    ) {
      delivered++;
    }
  }
  const judged = Math.max(0, settledRows.length - inconclusiveSettled);
  const ratePercent = judged > 0 ? Math.round((delivered / judged) * 10_000) / 100 : null;
  const value = ratePercent !== null ? BigInt(Math.round(ratePercent * 100)) : null;
  return {
    settled: settledRows.length,
    delivered,
    inconclusiveSettled,
    judged,
    ratePercent,
    value,
  };
}

/** agentWallet で結べた Base の agent だけ（owner のみは今回書かない）。 */
export function selectAttestTargets(matches: readonly Erc8004Match[]): Erc8004Match[] {
  const out: Erc8004Match[] = [];
  const seen = new Set<string>();
  for (const m of matches) {
    if (m.chainId !== ERC8004_INDEXED_CHAIN) continue;
    if (m.matchKind !== "agent_wallet") continue;
    if (seen.has(m.agentId)) continue;
    seen.add(m.agentId);
    out.push(m);
  }
  return out;
}

export function weeklyFeedbackUri(siteOrigin: string, agentId: string, week: string): string {
  const base = siteOrigin.replace(/\/$/, "");
  return `${base}/api/v1/observatory/erc8004/weekly/${encodeURIComponent(agentId)}?week=${encodeURIComponent(week)}`;
}

/** 週次 JSON 本文（UTF-8）の keccak256。C の sha256 とは別。 */
export function feedbackHashKeccak256(canonicalJsonUtf8: string): `0x${string}` {
  return keccak256(toBytes(canonicalJsonUtf8));
}

export type AttestAgentPlan = {
  agentId: string;
  agentIdBigInt: bigint;
  chainId: typeof ERC8004_INDEXED_CHAIN;
  population: AttestPopulation;
  feedbackURI: string;
  feedbackHash: `0x${string}`;
  endpoint: string;
  tag1: typeof ERC8004_ATTEST_TAG1;
  tag2: typeof ERC8004_ATTEST_TAG2;
  valueDecimals: typeof ERC8004_ATTEST_VALUE_DECIMALS;
  value: bigint;
  representativePurchaseId: string | null;
  proofTxHash: string | null;
};

export function representativeSettledRow(rows: readonly PurchaseFeedbackRow[]): PurchaseFeedbackRow | null {
  for (const r of rows) {
    if (r.status === "settled" && r.tx_hash) return r;
  }
  return null;
}

export type AttestPlanSkipReason = "already_written" | "min_settled" | "no_judged_population";

export function planAttestAgent(input: {
  match: Erc8004Match;
  week: string;
  siteOrigin: string;
  rows: readonly PurchaseFeedbackRow[];
  canonicalWeeklyBody: string;
  alreadyWritten?: boolean;
}): AttestAgentPlan | { skipReason: AttestPlanSkipReason } {
  if (input.alreadyWritten) return { skipReason: "already_written" };
  const pop = computeAttestPopulation(input.rows);
  if (pop.settled < ERC8004_ATTEST_MIN_SETTLED) {
    return { skipReason: "min_settled" };
  }
  if (pop.value === null || pop.judged === 0) {
    return { skipReason: "no_judged_population" };
  }
  const rep = representativeSettledRow(input.rows);
  const agentIdBigInt = BigInt(input.match.agentId);
  return {
    agentId: input.match.agentId,
    agentIdBigInt,
    chainId: ERC8004_INDEXED_CHAIN,
    population: pop,
    feedbackURI: weeklyFeedbackUri(input.siteOrigin, input.match.agentId, input.week),
    feedbackHash: feedbackHashKeccak256(input.canonicalWeeklyBody),
    endpoint: rep?.resource_key ?? "https://vet402.com/observatory/methodology#erc8004-attest",
    tag1: ERC8004_ATTEST_TAG1,
    tag2: ERC8004_ATTEST_TAG2,
    valueDecimals: ERC8004_ATTEST_VALUE_DECIMALS,
    representativePurchaseId: rep?.id ?? null,
    proofTxHash: rep?.tx_hash ?? null,
    value: pop.value,
  };
}

export function writerMustNotBePurchasePayer(writerAddress: string): boolean {
  return BASE_PURCHASE_PAYERS.includes(writerAddress.toLowerCase());
}

export function writerMustNotBeAgentOwner(writerAddress: string, owner: Address | null): boolean {
  if (!owner) return false;
  return owner.toLowerCase() === writerAddress.toLowerCase();
}

export type AttestLedger = {
  week: string;
  writtenAt?: string;
  agents: { agentId: string; txHash?: string; status?: "pending" | "written" | "reverted" }[];
};

export function ledgerHasAgent(ledger: AttestLedger | null, agentId: string): boolean {
  if (!ledger) return false;
  return ledger.agents.some((a) => a.agentId === agentId);
}

export function attestRegistryAddress(): Address {
  return ERC8004_ADDRESSES.reputationRegistry;
}

export function proofOfPaymentFromRow(row: PurchaseFeedbackRow) {
  return buildProofOfPayment(row);
}

export function sendRequiresEnabled(send: boolean, enabled: string | undefined): boolean {
  return !send || enabled === "1";
}

export function wouldExceedGasBudget(remainingWei: bigint, nextCostWei: bigint): boolean {
  return nextCostWei > remainingWei;
}