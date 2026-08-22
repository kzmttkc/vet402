import { and, desc, eq, gte, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import { getDb } from "./client";
import { isMissingSchemaError } from "./pg-errors";
import { apiKeys, trustEvents, verdictOutcomes, x402Payments } from "./schema";
import { BASE_USDC_ADDRESS } from "@/lib/chain/config";
import { dispatchWebhookEvent } from "@/lib/webhooks";

export type AutoOutcomeType =
  | "rug_pull_outflow"
  | "wallet_dormant"
  | "sustained_healthy_activity"
  | "ownership_changed"
  | "reputation_negative_feedback";

export type PartnerOutcomeType =
  | "confirmed_fraud"
  | "confirmed_legitimate"
  | "chargeback_dispute"
  | "other";

/**
 * outcome_type values that are terminal verdicts about a wallet's post-score
 * activity: once one of these is recorded (source=auto) for a trust_event,
 * the outcome-detector stops re-scanning that wallet's transaction history —
 * it has reached a conclusion that resumed activity can no longer change
 * (wallet_dormant) or that already required sustained activity to earn
 * (sustained_healthy_activity).
 *
 * rug_pull_outflow is deliberately NOT terminal. It's a provisional verdict:
 * the event stays in the watched set (see collectWatchedTrustEvents) so a
 * later scan can still land sustained_healthy_activity if the wallet resumes
 * normal activity, overriding the rug-pull read. If the wallet never resumes,
 * the provisional verdict simply stands once the trust_event ages out of
 * WATCH_WINDOW_DAYS and stops being rescanned — see
 * src/lib/indexer/outcome-detector.ts for the detection logic.
 * ownership_changed and reputation_negative_feedback are independent
 * side-signals and don't gate re-scanning on their own.
 */
export const TERMINAL_ACTIVITY_OUTCOME_TYPES: AutoOutcomeType[] = [
  "wallet_dormant",
  "sustained_healthy_activity",
];

export type TrustEventRow = {
  id: string;
  apiKeyId: string | null;
  agentId: bigint | null;
  wallet: string | null;
  createdAt: Date;
  signals: unknown;
};

/**
 * verdict_outcomes is a new table (see scripts/sql/2026-07-14-verdict-outcomes.sql).
 * DATABASE_URL is a Vercel "sensitive" env var that CLI tooling can't read to
 * apply migrations by hand, so every read/write here must degrade to a
 * silent no-op (log only) rather than throw when the table isn't there yet —
 * same discipline as funder_index_skips (src/lib/db/funder-index-writer.ts).
 */

/**
 * Trust events created within the last N days that still need outcome
 * scanning.
 *
 * Payee score rows (written by persistPayeeScoreResult with
 * signals.kind = "payee_score") are excluded: the wallet on those rows is a
 * payment *recipient*, and this watch set feeds the outcome-detector's
 * seller-side activity classification — whose drain heuristics the payee
 * engine deliberately does not use (see detectDrainPattern in
 * src/lib/scoring/payee-engine.ts). Without the exclusion, a payee query
 * would enroll the payee wallet for seller-style scanning, an auto
 * rug_pull_outflow could be recorded against it, and getOutcomesForWallet
 * would feed that verdict straight back into the next payee score — a
 * self-inflicted contamination loop. The predicate is NULL-safe
 * (IS DISTINCT FROM) so legacy rows without signals or kind stay watched.
 */
export async function collectWatchedTrustEvents(
  windowDays: number,
  limit: number,
): Promise<TrustEventRow[]> {
  const db = getDb();
  if (!db) return [];

  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  try {
    const alreadyTerminal = db
      .select({ trustEventId: verdictOutcomes.trustEventId })
      .from(verdictOutcomes)
      .where(
        and(
          eq(verdictOutcomes.source, "auto"),
          inArray(verdictOutcomes.outcomeType, TERMINAL_ACTIVITY_OUTCOME_TYPES),
        ),
      );

    const rows = await db
      .select({
        id: trustEvents.id,
        apiKeyId: trustEvents.apiKeyId,
        agentId: trustEvents.agentId,
        wallet: trustEvents.wallet,
        createdAt: trustEvents.createdAt,
        signals: trustEvents.signals,
      })
      .from(trustEvents)
      .where(
        and(
          gte(trustEvents.createdAt, since),
          isNotNull(trustEvents.wallet),
          // 2026-08-23 監査: ここは「payee_score でない」「benchmark_seed でない」
          // という**否定形の除外**だった。否定形は「知らない種類は全部監視する」を
          // 意味するので、kind を名乗らない書き手（買い手側 persistScoreResult が
          // まさにそれだった）が黙って監視対象に入る。実際そこから
          // /v1/wallets/{任意アドレス}/score → rug_pull_outflow → BLOCK固定 という
          // 経路が開いていた。**監視するものを肯定形で名指す**形へ反転する。
          // 既存の kind 無し行は監視対象から外れる——誤検知が減る方向なので安全。
          sql`(${trustEvents.signals}->>'kind') = 'seller_score'`,
          notInArray(trustEvents.id, alreadyTerminal),
        ),
      )
      .orderBy(desc(trustEvents.createdAt))
      .limit(limit);

    return rows
      .filter((row): row is typeof row & { createdAt: Date } => row.createdAt !== null)
      .map((row) => ({
        id: row.id,
        apiKeyId: row.apiKeyId,
        agentId: row.agentId,
        wallet: row.wallet,
        createdAt: row.createdAt,
        signals: row.signals,
      }));
  } catch (err) {
    console.error(
      "outcome-writer: collectWatchedTrustEvents failed, degrading to no-op (verdict_outcomes likely not migrated yet)",
      err,
    );
    return [];
  }
}

/** Auto-detected outcome. Idempotent via unique(trust_event_id, outcome_type, source). */
export async function recordAutoOutcome(input: {
  trustEventId: string;
  outcomeType: AutoOutcomeType;
  relatedWallet?: string | null;
  windowMinutes: number;
  evidence?: unknown;
}): Promise<boolean> {
  const db = getDb();
  if (!db) return false;

  try {
    const inserted = await db
      .insert(verdictOutcomes)
      .values({
        trustEventId: input.trustEventId,
        outcomeType: input.outcomeType,
        relatedWallet: input.relatedWallet ?? null,
        windowMinutes: input.windowMinutes,
        source: "auto",
        evidence: input.evidence ?? null,
      })
      .onConflictDoNothing()
      .returning();

    if (inserted.length > 0) {
      // Notify the customer whose verdict this outcome judges (C-9). The
      // trust_event row carries the requesting api key; fire-and-forget —
      // notification failure must never fail outcome recording.
      void notifyOutcomeRecorded(input.trustEventId, input.outcomeType, "auto");
    }

    return inserted.length > 0;
  } catch (err) {
    console.error("outcome-writer: recordAutoOutcome failed, skipping write", err);
    return false;
  }
}

/** Webhook fan-out for outcome.recorded. Looks up which api key requested the
 *  original verdict; no key (dashboard/manual verdicts) → nobody to notify. */
async function notifyOutcomeRecorded(
  trustEventId: string,
  outcomeType: string,
  source: string,
): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    const rows = await db
      .select({ apiKeyId: trustEvents.apiKeyId, wallet: trustEvents.wallet, agentId: trustEvents.agentId })
      .from(trustEvents)
      .where(eq(trustEvents.id, trustEventId))
      .limit(1);
    const ev = rows[0];
    if (!ev?.apiKeyId) return;
    await dispatchWebhookEvent(ev.apiKeyId, "outcome.recorded", {
      trustEventId,
      outcomeType,
      source,
      wallet: ev.wallet,
      agentId: ev.agentId === null ? null : ev.agentId.toString(),
    });
  } catch (err) {
    console.error("outcome-writer: webhook notify failed (non-fatal)", err);
  }
}

/**
 * Reads from trust_events — a stable, pre-existing table, not the new
 * verdict_outcomes one — so unlike the functions above this intentionally
 * lets a real DB failure propagate instead of degrading to null. Callers
 * must not conflate "genuinely not found" with "lookup failed".
 *
 * OWNER-SCOPED, and `apiKeyId` is deliberately REQUIRED rather than an
 * optional filter (2026-08-12). A trust event id is the handle to another
 * customer's verdict; the only caller of this function goes on to write a
 * partner outcome against whatever it returns. An optional scope would be one
 * forgotten argument away from re-opening that, so the scope is part of the
 * signature: `WHERE id = ? AND api_key_id = ?`, exactly like removeWatch /
 * deleteWebhook. Events with a NULL api_key_id (dashboard/manual verdicts)
 * belong to no key and therefore match nobody — fail-closed by construction.
 */
export async function getTrustEventById(
  trustEventId: string,
  apiKeyId: string,
): Promise<TrustEventRow | null> {
  const db = getDb();
  if (!db) throw new Error("database_unavailable");

  const rows = await db
    .select({
      id: trustEvents.id,
      apiKeyId: trustEvents.apiKeyId,
      agentId: trustEvents.agentId,
      wallet: trustEvents.wallet,
      createdAt: trustEvents.createdAt,
      signals: trustEvents.signals,
    })
    .from(trustEvents)
    .where(and(eq(trustEvents.id, trustEventId), eq(trustEvents.apiKeyId, apiKeyId)))
    .limit(1);

  const row = rows[0];
  if (!row || !row.createdAt) return null;

  return {
    id: row.id,
    apiKeyId: row.apiKeyId,
    agentId: row.agentId,
    wallet: row.wallet,
    createdAt: row.createdAt,
    signals: row.signals,
  };
}

export type WalletOutcomeRow = {
  outcomeType: string;
  source: string;
  /**
   * The reporting partner key for source='partner:{id}' rows, null for auto
   * rows. Carried so the payee scorer can ask whether that reporter is a
   * verified counterparty of the subject wallet, and collapse many keys of one
   * account to a single voice — see getNegativeReporterCorroboration and
   * src/lib/scoring/outcome-adjustment.ts. Without it a lone unverified fraud
   * report could BLOCK any wallet (vet402 2026-08-13, negative-poison).
   */
  apiKeyId: string | null;
  detectedAt: Date;
  evidence: unknown;
};

/**
 * The corroboration facts the payee scorer needs to decide whether a NEGATIVE
 * partner report is allowed to move a public score. Two independent bindings:
 *
 *  - verifiedCounterparties: reporter keys shown to control a wallet that
 *    actually settled a score-eligible x402 payment TO the subject wallet. A
 *    single such report is trusted — it is not self-attested.
 *  - accountByReporter: reporter key → owning account (userId). Collapses the
 *    independent-reporter count so one actor's many keys count once.
 */
export type NegativeReporterCorroboration = {
  verifiedCounterparties: Set<string>;
  accountByReporter: Map<string, string | null>;
};

/**
 * Outcome history for a wallet named as `relatedWallet` on any verdict —
 * used by the payee scoring engine (src/lib/scoring/payee-engine.ts) to
 * factor in prior fraud/legitimacy labels.
 *
 * WHAT AN EMPTY RESULT IS ALLOWED TO MEAN (2026-08-13). This used to catch
 * EVERY error and return `[]`, on the reasoning that verdict_outcomes may not
 * be migrated in some environment. But `[]` is not a neutral value here: it is
 * the input that decides whether applyOutcomeAdjustment caps a wallet's score
 * at 15. A wallet with a recorded confirmed_fraud scored as though it were
 * clean whenever the query failed for ANY reason — a connection reset, a
 * timeout, a permissions change — and the failure was invisible in the result.
 * That is the same fail-OPEN shape the payee engine's verdict path had.
 *
 * So the degrade is now narrowed to the case it was written for: a table that
 * does not exist yet legitimately reads as "no history". Every other failure
 * throws, and the caller flags it and fails closed.
 */
export async function getOutcomesForWallet(
  wallet: string,
  limit = 20,
): Promise<WalletOutcomeRow[]> {
  const db = getDb();
  if (!db) return [];

  try {
    const rows = await db
      .select({
        outcomeType: verdictOutcomes.outcomeType,
        source: verdictOutcomes.source,
        apiKeyId: verdictOutcomes.apiKeyId,
        detectedAt: verdictOutcomes.detectedAt,
        evidence: verdictOutcomes.evidence,
      })
      .from(verdictOutcomes)
      // relatedWallet is not consistently lowercased at write time (it can
      // come from a checksummed on-chain address), so compare case-insensitively.
      // Operator-benchmark rows (2026-08-06) are excluded: this feed steers
      // the payee scoring engine, and a benchmark must observe production
      // scoring, never steer it — otherwise the benchmark changes the very
      // thing it measures, and operator-written labels would leak into
      // customer-facing verdicts through the back door.
      .where(
        and(
          sql`lower(${verdictOutcomes.relatedWallet}) = ${wallet.toLowerCase()}`,
          sql`${verdictOutcomes.source} <> 'operator_benchmark'`,
        ),
      )
      .orderBy(desc(verdictOutcomes.detectedAt))
      .limit(limit);

    return rows;
  } catch (err) {
    if (isMissingSchemaError(err)) {
      console.error(
        "outcome-writer: getOutcomesForWallet found no verdict_outcomes table; reading as no history",
        err,
      );
      return [];
    }
    // Anything else is a read we did not complete. Never a silent [].
    throw new Error("outcome_history_unavailable", { cause: err });
  }
}

/**
 * For a set of reporter keys that filed a NEGATIVE outcome on `wallet`, gather
 * the two facts the scorer needs to decide whether those reports may move the
 * public score (vet402 2026-08-13, negative-poison):
 *
 *   1. Which reporters are VERIFIED COUNTERPARTIES — they control a wallet that
 *      actually settled a score-eligible x402 payment TO the subject. Read from
 *      x402_payments: payee = wallet, api_key_id = reporter, and the same
 *      score-eligibility gate (USDC + amount- + ownership-verified) the payee
 *      stats already use. ownership_verified is the load-bearing column: it
 *      proves the reporter controls the PAYING wallet, so posting a stranger's
 *      real transfer records a row but does not make that stranger a
 *      counterparty of anyone.
 *   2. Which ACCOUNT each reporter belongs to, so the multi-reporter path can
 *      collapse one actor's many keys to a single voice.
 *
 * FAILURE DIRECTION. This is a NEW, dependent read on the scoring path. A
 * missing table/column (migration lag) reads as "no corroboration available" —
 * the safe direction here, since it only means an unverified negative stays
 * uncorroborated (does not cap), never that a stranger gets BLOCKed. Any OTHER
 * error throws, so the caller can treat it as an unread input and fail closed
 * (degraded), exactly like getOutcomesForWallet — a corroboration we could not
 * check must not silently promote OR silently drop a negative.
 */
export async function getNegativeReporterCorroboration(
  wallet: string,
  reporterKeyIds: string[],
): Promise<NegativeReporterCorroboration> {
  const empty: NegativeReporterCorroboration = {
    verifiedCounterparties: new Set(),
    accountByReporter: new Map(),
  };
  const db = getDb();
  if (!db || reporterKeyIds.length === 0) return empty;

  const uniqueKeyIds = [...new Set(reporterKeyIds)];

  try {
    const paidRows = await db
      .select({ apiKeyId: x402Payments.apiKeyId })
      .from(x402Payments)
      .where(
        and(
          sql`lower(${x402Payments.payee}) = ${wallet.toLowerCase()}`,
          inArray(x402Payments.apiKeyId, uniqueKeyIds),
          eq(x402Payments.token, BASE_USDC_ADDRESS.toLowerCase()),
          eq(x402Payments.amountVerified, true),
          eq(x402Payments.ownershipVerified, true),
        ),
      );

    const verifiedCounterparties = new Set<string>();
    for (const row of paidRows) {
      if (row.apiKeyId != null) verifiedCounterparties.add(row.apiKeyId);
    }

    const keyRows = await db
      .select({ id: apiKeys.id, userId: apiKeys.userId })
      .from(apiKeys)
      .where(inArray(apiKeys.id, uniqueKeyIds));

    const accountByReporter = new Map<string, string | null>();
    for (const row of keyRows) {
      accountByReporter.set(row.id, row.userId ?? null);
    }

    return { verifiedCounterparties, accountByReporter };
  } catch (err) {
    if (isMissingSchemaError(err)) {
      console.error(
        "outcome-writer: getNegativeReporterCorroboration hit a missing table/column; reading as no corroboration",
        err,
      );
      return empty;
    }
    throw new Error("outcome_corroboration_unavailable", { cause: err });
  }
}

export type RecordPartnerOutcomeInput = {
  trustEventId: string;
  outcomeType: PartnerOutcomeType;
  relatedWallet?: string | null;
  windowMinutes: number;
  apiKeyId: string;
  evidence?: unknown;
};

/**
 * Idempotent on (trust_event_id, outcome_type, source). A second report of
 * the same type from the same partner key returns the existing row instead
 * of erroring, mirroring recordX402Payment's idempotent-insert pattern.
 */
export async function recordPartnerOutcome(
  input: RecordPartnerOutcomeInput,
): Promise<{ created: boolean; id: string } | null> {
  const db = getDb();
  if (!db) return null;

  const source = `partner:${input.apiKeyId}`;

  try {
    const existing = await db
      .select({ id: verdictOutcomes.id })
      .from(verdictOutcomes)
      .where(
        and(
          eq(verdictOutcomes.trustEventId, input.trustEventId),
          eq(verdictOutcomes.outcomeType, input.outcomeType),
          eq(verdictOutcomes.source, source),
        ),
      )
      .limit(1);

    if (existing[0]) {
      return { created: false, id: existing[0].id };
    }

    const inserted = await db
      .insert(verdictOutcomes)
      .values({
        trustEventId: input.trustEventId,
        outcomeType: input.outcomeType,
        relatedWallet: input.relatedWallet ?? null,
        windowMinutes: input.windowMinutes,
        source,
        apiKeyId: input.apiKeyId,
        evidence: input.evidence ?? null,
      })
      .onConflictDoNothing()
      .returning();

    if (inserted[0]) {
      void notifyOutcomeRecorded(input.trustEventId, input.outcomeType, source);
      return { created: true, id: inserted[0].id };
    }

    // Lost a race with a concurrent identical report — re-read.
    const raced = await db
      .select({ id: verdictOutcomes.id })
      .from(verdictOutcomes)
      .where(
        and(
          eq(verdictOutcomes.trustEventId, input.trustEventId),
          eq(verdictOutcomes.outcomeType, input.outcomeType),
          eq(verdictOutcomes.source, source),
        ),
      )
      .limit(1);

    return raced[0] ? { created: false, id: raced[0].id } : null;
  } catch (err) {
    console.error("outcome-writer: recordPartnerOutcome failed", err);
    throw err;
  }
}
