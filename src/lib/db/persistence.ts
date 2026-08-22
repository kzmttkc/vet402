import { desc, eq, and } from "drizzle-orm";
import { getDb } from "./client";
import { trustEvents } from "./schema";
import { getDataCoverage } from "@/lib/health/data-coverage";
import { hasUnavailableInput } from "@/lib/scoring/verdict";
import type { PayeeScoreResult } from "@/lib/scoring/payee-engine";
import type { TrustScoreResult } from "@/lib/scoring/types";

export async function persistScoreResult(
  apiKeyId: string,
  result: TrustScoreResult,
): Promise<void> {
  const db = getDb();
  if (!db || apiKeyId === "dev") return;

  const agentId =
    result.agentId === "0" ? null : BigInt(result.agentId);

  // Same rule persistPayeeScoreResult already enforces: a verdict computed
  // from an input we could not read is a refusal, not a measurement.
  if (
    hasUnavailableInput(result.signals.sybil.flags) ||
    Boolean(result.blockReason?.endsWith("_unavailable"))
  ) {
    return;
  }

  await db.insert(trustEvents).values({
    apiKeyId,
    agentId,
    wallet: result.wallet,
    trustScore: result.trustScore,
    recommendation: result.recommendation,
    // 2026-08-23 監査: この経路だけ `kind` が無く、結果として outcome-detector の
    // 監視集合（除外述語が `kind IS DISTINCT FROM 'payee_score'`）に入っていた。
    // 否定形の除外は「知らない種類は全部監視する」という意味になり、新しい書き手が
    // 増えるたび黙って監視対象が広がる。種類を名乗らせて肯定形で選ばせる。
    signals: { kind: "seller_score", ...result.signals },
    manualOverride: result.manualOverride ? "true" : "false",
    blockReason: result.blockReason ?? null,
    disclaimer: result.disclaimer,
    cacheExpiresAt: new Date(result.cacheExpiresAt),
  });
}

/**
 * Records a payee (buyer-side) score query into the same trust_events ledger
 * the agent/wallet score routes use — no new table. Payee rows carry
 * `signals.kind = "payee_score"` (the signals column is already jsonb), which
 * does two jobs: collectWatchedTrustEvents (src/lib/db/outcome-writer.ts)
 * excludes these rows from the outcome-detector's seller-side watch set —
 * otherwise its drain classification would label payee wallets and feed those
 * verdicts back into payee scores — and ad-hoc usage measurement can filter
 * on it to count external buyer-side queries. `dataDepth` rides along inside
 * signals for the same reason.
 */
export async function persistPayeeScoreResult(
  apiKeyId: string,
  result: PayeeScoreResult,
): Promise<void> {
  const db = getDb();
  if (!db || apiKeyId === "dev") return;

  // A verdict computed with an input we could not read is a refusal, not a
  // measurement, and trust_events is the ledger /accuracy is computed from.
  // Recording it would publish "vet402 blocked this wallet" for a wallet
  // nobody managed to check — the seller side stopped doing exactly this in
  // 8b0df27 ("上流に届かなかった結果を verdict として記録しない"); the payee
  // route was still doing it. Measured 2026-08-12: 15 of 17 known-good
  // addresses were logged as BLOCK during a Blockscout lockout and /accuracy
  // published an 88.2% false-positive rate against them.
  if (result.degraded) return;

  await db.insert(trustEvents).values({
    apiKeyId,
    agentId: null,
    wallet: result.payee,
    trustScore: result.score,
    recommendation: result.recommendation,
    signals: { kind: "payee_score", dataDepth: result.dataDepth, ...result.signals },
    manualOverride: "false",
    blockReason: null,
    disclaimer: result.disclaimer,
    cacheExpiresAt: new Date(result.cacheExpiresAt),
  });
}

export async function getScoreHistory(
  apiKeyId: string,
  agentId: bigint,
  limit: number,
): Promise<TrustScoreResult[]> {
  const db = getDb();
  if (!db) return [];

  const rows = await db
    .select()
    .from(trustEvents)
    .where(and(eq(trustEvents.apiKeyId, apiKeyId), eq(trustEvents.agentId, agentId)))
    .orderBy(desc(trustEvents.createdAt))
    .limit(limit);

  const dataCoverage = await getDataCoverage(
    rows[0]?.wallet ?? undefined,
  );

  return rows.map((row) => ({
    agentId: row.agentId?.toString() ?? "0",
    wallet: row.wallet,
    trustScore: row.trustScore ?? 0,
    recommendation: (row.recommendation ?? "BLOCK") as TrustScoreResult["recommendation"],
    signals: normalizeSignals(row.signals as TrustScoreResult["signals"] | null),
    scoredAt: row.createdAt?.toISOString() ?? new Date().toISOString(),
    cacheExpiresAt:
      row.cacheExpiresAt?.toISOString() ??
      row.createdAt?.toISOString() ??
      new Date().toISOString(),
    disclaimer:
      row.disclaimer ??
      "Scores are informational only and do not constitute a guarantee, credit assessment, or investment advice.",
    blockReason: row.blockReason ?? undefined,
    manualOverride: row.manualOverride === "true",
    dataCoverage,
  }));
}

function normalizeSignals(
  signals: TrustScoreResult["signals"] | null,
): TrustScoreResult["signals"] {
  const base = defaultSignals();
  if (!signals) return base;
  return {
    ...base,
    ...signals,
    x402: signals.x402 ?? base.x402,
  };
}

function defaultSignals(): TrustScoreResult["signals"] {
  return {
    identity: { registered: false, hasMetadataUri: false },
    reputation: { feedbackCount: 0, avgScore: 0, onChainAvgScore: 0 },
    wallet: { ageDays: 0, txCount: 0, isBurner: false },
    x402: { paymentCount: 0, uniqueDays: 0, score: 50 },
    sybil: { risk: "low", flags: [] },
    manual: { list: "none" },
  };
}
