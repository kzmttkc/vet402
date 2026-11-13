// ============================================================
// B1: purchase lifecycle stages (public state API and record page).
//
// JS (purchaseStageOf) and SQL (purchaseStageSql) share the same constants.
// Held / delivered predicates come from delivery.ts.
// ============================================================
import type { E6PublicStage } from "@/lib/observatory/e6-record";
import type { e4OutcomeForStage } from "@/lib/observatory/trade-dispute";
import { GATEWAY_NOT_CHARGED_EXPIRED } from "@/lib/observatory/arc-gateway-words";
import {
  deliveredPredicate,
  DELIVERED_HTTP_MAX,
  DELIVERED_HTTP_MIN,
  heldReasonOf,
  inconclusivePredicate,
  isDelivered,
  type HeldRowInput,
} from "@/lib/observatory/delivery";
import { SELLER_REQUEST_PRESIGN_PREFIX } from "@/lib/observatory/seller-retest-requests";
import { toIsoUtc } from "@/lib/util/iso-utc";
import { rowsOf } from "@/lib/settlements/upsert";
import { sql } from "drizzle-orm";
import type { getDb } from "@/lib/db/client";

/** 3.4 dispute stage for a paid request that did not arrive (e6-record.ts). */
export const NOT_DELIVERED_STAGE = "not_delivered" as const satisfies Extract<E6PublicStage, "not_delivered">;

/** 3.4 dispute outcome bucket tied to held rows (trade-dispute.ts). */
export const INCONCLUSIVE_STAGE = "inconclusive" as const satisfies Extract<
  NonNullable<ReturnType<typeof e4OutcomeForStage>>,
  "inconclusive"
>;

export const PURCHASE_STAGES = [
  "http_402",
  "signed",
  "settle_claimed",
  "settled",
  "delivered",
  INCONCLUSIVE_STAGE,
  NOT_DELIVERED_STAGE,
  "revoked",
] as const;

export type PurchaseStage = (typeof PURCHASE_STAGES)[number];

export const PURCHASE_STAGE_OUTSIDE = ["no_402", "unknown"] as const;
export type PurchaseStageOutside = (typeof PURCHASE_STAGE_OUTSIDE)[number];

export type PurchaseStageKey = PurchaseStage | PurchaseStageOutside;

export const SETTLE_CLAIMED_STATUSES = ["settle_claimed", "settle_claimed_unverifiable", "settle_claim_refuted"] as const;

export const SIGNED_LEDGER_STATUSES = ["settle_failed", "delivered_no_receipt", GATEWAY_NOT_CHARGED_EXPIRED] as const;

/**
 * Status values written only after the unpaid request returned HTTP 402 in purchaseOne
 * (l1-runner.ts: first.status !== 402 check at line 3978, no_402 at 3979).
 * budget_denied: l1-runner.ts:4285, 4535. halted: 4388, 4574.
 * payto_operator_self: l1-runner.ts:4342.
 * no_eligible_accept: l1-runner.ts:3997, 4011, 4027, 4176; x402-payer.ts:737, 876, 904;
 *   sol402-payer.ts:110, 166; xrpl402-payer.ts:206, 233, 268, 270; stellar402-payer.ts:297, 306, 310, 340;
 *   mpp-payer.ts:264+; arc-gateway.ts:277, 334 (as gatewayPick.reason or selection.reason at 4127 / 4176).
 * price_mismatch: l1-runner.ts:4176; x402-payer.ts:902; sol402-payer.ts:164; xrpl402-payer.ts:231;
 *   stellar402-payer.ts:338; mpp-payer.ts; arc-gateway.ts:333.
 * payto_mismatch: l1-runner.ts:4176; x402-payer.ts:779; sol402-payer.ts:121; xrpl402-payer.ts:214, 275;
 *   stellar402-payer.ts:306, 316; mpp-payer.ts; arc-gateway.ts:288.
 * over_cap: l1-runner.ts:4176; x402-payer.ts:902, 904; sol402-payer.ts:159; xrpl402-payer.ts:229;
 *   stellar402-payer.ts:336; mpp-payer.ts; arc-gateway.ts:332.
 * no_fee_payer: l1-runner.ts:4176 via selection.reason; sol402-payer.ts:137.
 * timeout_too_long: l1-runner.ts:4127 via gatewayPick.reason; arc-gateway.ts:276.
 * native_present is never written (l1-runner.ts:4122 excludes it).
 */
export const HTTP_402_STAGE_STATUSES: readonly string[] = [
  "no_eligible_accept",
  "price_mismatch",
  "payto_mismatch",
  "payto_operator_self",
  "over_cap",
  "no_fee_payer",
  "timeout_too_long",
  "budget_denied",
  "halted",
];

export type PurchaseStageRowInput = HeldRowInput & {
  status: string;
  authNonce?: string | null;
  payloadNonEmpty?: boolean | null;
};

export const STAGE_DEFINITIONS: Record<PurchaseStageKey, string> = {
  http_402:
    "vet402 got HTTP 402 from the seller and stopped before signing, or vet402's budget or halt gate stopped signing after the 402.",
  signed:
    "vet402 signed a paid request. vet402 has not settled it on chain yet, or settlement failed, or the seller returned goods without a receipt.",
  settle_claimed:
    "vet402 recorded a seller asserted settlement receipt. vet402 has not confirmed it on chain yet, or vet402 re-read the chain and the receipt did not match.",
  settled:
    "vet402 re-read the payment on the chain. The paid request answered 202 Accepted, or HTTP 2xx with a body vet402 recorded as empty, or vet402 has no HTTP status on record, so vet402 does not call it delivered or not_delivered.",
  delivered:
    "vet402 re-read the payment on the chain and the paid request returned HTTP 2xx other than 202 Accepted with a body vet402 did not record as empty.",
  inconclusive:
    "vet402 holds the row because the paid HTTP response was 4xx, or vet402's payer wallet was unfunded in a recorded window. vet402 keeps the row public in its own stage, apart from delivered and not_delivered.",
  not_delivered:
    "vet402 re-read the payment on the chain. The paid request returned 5xx, or another HTTP status outside 2xx that vet402 does not leave in settled. vet402 counts HTTP 4xx as inconclusive. vet402 leaves 202 Accepted, HTTP 2xx with a body vet402 recorded as empty, and no HTTP status on record in settled. This stage does not say whose side the failure is on. See Whose side.",
  revoked:
    "vet402 recorded a chain re-read correction that moved this purchase out of settled. The row stays in the ledger with its new status.",
  no_402: "vet402's first request did not return HTTP 402.",
  unknown: "vet402 has not matched this row to a named stage rule yet.",
};

export const LIFECYCLE_NOTE =
  "vet402 counts each purchase row once, in one lifecycle stage or one outside box. vet402 never drops a row from the total when a correction moves settled to another status. lifecycle.stages.settled holds only the rows of l1.settled whose paid request answered 202 Accepted, answered HTTP 2xx with a body vet402 recorded as empty, or has no HTTP status on record.";

export type PurchaseLifecycleCounts = {
  stages: Record<PurchaseStage, number>;
  outsideStages: { no_402: number; unknown: number };
  unknownByStatus: Record<string, number>;
  total: number;
  revokedLatestAt: string | null;
  note: string;
  stageDefinitions: Record<PurchaseStageKey, string>;
};

export function emptyPurchaseLifecycle(): PurchaseLifecycleCounts {
  return {
    stages: Object.fromEntries(PURCHASE_STAGES.map((s) => [s, 0])) as Record<PurchaseStage, number>,
    outsideStages: { no_402: 0, unknown: 0 },
    unknownByStatus: {},
    total: 0,
    revokedLatestAt: null,
    note: LIFECYCLE_NOTE,
    stageDefinitions: { ...STAGE_DEFINITIONS },
  };
}

function revokedAtApplies(status: string, revokedAt: string | null | undefined): revokedAt is string {
  return status !== "settled" && revokedAt != null && revokedAt !== "";
}

/** True when auth_nonce counts as unsigned (NULL or seller request presign slot). */
export function purchaseAuthNonceCountsAsSigned(authNonce: string | null | undefined): boolean {
  if (authNonce == null || authNonce === "") return false;
  return !authNonce.startsWith(SELLER_REQUEST_PRESIGN_PREFIX);
}

/** One row's public stage (rules a through h, first match). */
export function purchaseStageOf(row: PurchaseStageRowInput, revokedAt?: string | null): PurchaseStageKey {
  if (revokedAtApplies(row.status, revokedAt ?? null)) return "revoked";
  if (heldReasonOf(row) !== null) return INCONCLUSIVE_STAGE;
  if (isDelivered(row)) return "delivered";
  if (row.status === "settled") {
    const code = row.httpStatusPaid;
    if (code === null || (typeof code === "number" && code >= DELIVERED_HTTP_MIN && code <= DELIVERED_HTTP_MAX)) {
      return "settled";
    }
    return NOT_DELIVERED_STAGE;
  }
  if ((SETTLE_CLAIMED_STATUSES as readonly string[]).includes(row.status)) return "settle_claimed";
  if ((SIGNED_LEDGER_STATUSES as readonly string[]).includes(row.status)) return "signed";
  if (row.status === "request_error") {
    return purchaseAuthNonceCountsAsSigned(row.authNonce) ? "signed" : "unknown";
  }
  if (HTTP_402_STAGE_STATUSES.includes(row.status)) return "http_402";
  if (row.status === "no_402") return "no_402";
  return "unknown";
}

export function purchaseRevokedAt(
  row: PurchaseStageRowInput,
  revokedAt: string | null | undefined,
): string | null {
  if (purchaseStageOf(row, revokedAt) !== "revoked") return null;
  return revokedAt ?? null;
}

function assertAlias(fn: string, alias: string): string {
  if (alias !== "" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error(`${fn}: alias must be a plain identifier, got ${JSON.stringify(alias)}`);
  }
  return alias === "" ? "" : `${alias}.`;
}

const SQL_LITERAL_RE = /^[A-Za-z0-9:_-]+$/;

function assertSqlLiteral(fn: string, value: string): string {
  if (!SQL_LITERAL_RE.test(value)) {
    throw new Error(`${fn}: unexpected literal ${JSON.stringify(value)}`);
  }
  return value;
}

function sqlStringList(values: readonly string[]): string {
  for (const v of values) assertSqlLiteral("sqlStringList", v);
  return values.map((v) => `'${v}'`).join(", ");
}

/** Latest correction that moved settled to another status (rule a). */
export function purchaseRevokedAtSubquery(alias = "p"): string {
  const p = assertAlias("purchaseRevokedAtSubquery", alias);
  return `(
    SELECT max(cl.created_at)
    FROM correction_log cl
    WHERE cl.subject_type = 'purchase'
      AND cl.subject_id = ${p}id::text
      AND cl.level = 'l1'
      AND cl.before->>'status' = 'settled'
      AND cl.after->>'status' IS DISTINCT FROM 'settled'
  )`;
}

/**
 * SQL expression for the stage name (same order as purchaseStageOf).
 * `revokedAtExpr` should be purchaseRevokedAtSubquery(alias) or equivalent.
 */
export function purchaseStageSql(alias = "", revokedAtExpr?: string): string {
  const p = assertAlias("purchaseStageSql", alias);
  const revokedAt = revokedAtExpr ?? purchaseRevokedAtSubquery(alias);
  const delivered = deliveredPredicate(alias);
  const inconclusive = inconclusivePredicate(alias);
  const http402 = sqlStringList(HTTP_402_STAGE_STATUSES);
  const settleClaimed = sqlStringList(SETTLE_CLAIMED_STATUSES);
  const signedStatuses = sqlStringList(SIGNED_LEDGER_STATUSES);
  const presignPrefix = assertSqlLiteral("purchaseStageSql", SELLER_REQUEST_PRESIGN_PREFIX);
  return `CASE
    WHEN ${p}status <> 'settled' AND ${revokedAt} IS NOT NULL THEN 'revoked'
    WHEN ${inconclusive} THEN '${INCONCLUSIVE_STAGE}'
    WHEN ${delivered} THEN 'delivered'
    WHEN ${p}status = 'settled' AND (${p}http_status_paid IS NULL OR ${p}http_status_paid BETWEEN ${DELIVERED_HTTP_MIN} AND ${DELIVERED_HTTP_MAX}) THEN 'settled'
    WHEN ${p}status = 'settled' THEN '${NOT_DELIVERED_STAGE}'
    WHEN ${p}status IN (${settleClaimed}) THEN 'settle_claimed'
    WHEN ${p}status IN (${signedStatuses}) THEN 'signed'
    WHEN ${p}status = 'request_error' AND ${p}auth_nonce IS NOT NULL AND ${p}auth_nonce <> '' AND ${p}auth_nonce NOT LIKE '${presignPrefix}%' THEN 'signed'
    WHEN ${p}status = 'request_error' THEN 'unknown'
    WHEN ${p}status IN (${http402}) THEN 'http_402'
    WHEN ${p}status = 'no_402' THEN 'no_402'
    ELSE 'unknown'
  END`;
}

export function countPurchaseStages(
  rows: PurchaseStageRowInput[],
  revokedByPurchaseId: ReadonlyMap<string, string> = new Map(),
  purchaseIds?: readonly string[],
): PurchaseLifecycleCounts {
  const out = emptyPurchaseLifecycle();
  const unknownByStatus: Record<string, number> = {};
  let revokedLatestMs: number | null = null;

  rows.forEach((row, i) => {
    const pid = purchaseIds?.[i];
    const revokedRaw = pid ? revokedByPurchaseId.get(pid) : undefined;
    const revokedAt = revokedRaw ? toIsoUtc(revokedRaw) : null;
    const stage = purchaseStageOf(row, revokedAt);
    if (stage === "no_402") out.outsideStages.no_402 += 1;
    else if (stage === "unknown") {
      out.outsideStages.unknown += 1;
      unknownByStatus[row.status] = (unknownByStatus[row.status] ?? 0) + 1;
    } else {
      out.stages[stage] += 1;
      if (stage === "revoked" && revokedAt) {
        const ms = Date.parse(revokedAt);
        if (!Number.isNaN(ms) && (revokedLatestMs === null || ms > revokedLatestMs)) revokedLatestMs = ms;
      }
    }
    out.total += 1;
  });

  out.unknownByStatus = unknownByStatus;
  out.revokedLatestAt = revokedLatestMs !== null ? new Date(revokedLatestMs).toISOString().replace(/\.\d{3}Z$/, "Z") : null;
  return out;
}

function lifecycleInvariant(counts: PurchaseLifecycleCounts): void {
  const sum =
    PURCHASE_STAGES.reduce((n, s) => n + counts.stages[s], 0) + counts.outsideStages.no_402 + counts.outsideStages.unknown;
  if (sum !== counts.total) {
    throw new Error(`purchase lifecycle sum ${sum} !== total ${counts.total}`);
  }
}

export async function loadRevokedAtByPurchaseId(
  db: NonNullable<ReturnType<typeof getDb>>,
  purchaseIds: readonly string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (purchaseIds.length === 0) return map;
  const raw = await db.execute(sql`
    SELECT subject_id,
           max(created_at) AS revoked_at
    FROM correction_log
  WHERE subject_type = 'purchase'
    AND level = 'l1'
    AND before->>'status' = 'settled'
    AND after->>'status' IS DISTINCT FROM 'settled'
    AND subject_id IN (${sql.join(purchaseIds.map((id) => sql`${id}`), sql`, `)})
  GROUP BY subject_id
  `);
  for (const row of rowsOf<{ subject_id: string; revoked_at: string | Date }>(raw)) {
    const iso = toIsoUtc(row.revoked_at);
    if (iso) map.set(row.subject_id, iso);
  }
  return map;
}

export async function getPurchaseLifecycleCounts(db: NonNullable<ReturnType<typeof getDb>>): Promise<PurchaseLifecycleCounts> {
  const stageExpr = purchaseStageSql("p");
  const revokedSub = purchaseRevokedAtSubquery("p");
  const raw = await db.execute(sql`
    WITH staged AS (
      SELECT ${sql.raw(stageExpr)} AS stage, p.status, ${sql.raw(revokedSub)} AS revoked_at
      FROM x402_l1_purchases p
    )
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE stage = 'http_402')::int AS http_402,
      count(*) FILTER (WHERE stage = 'signed')::int AS signed,
      count(*) FILTER (WHERE stage = 'settle_claimed')::int AS settle_claimed,
      count(*) FILTER (WHERE stage = 'settled')::int AS settled,
      count(*) FILTER (WHERE stage = 'delivered')::int AS delivered,
      count(*) FILTER (WHERE stage = 'inconclusive')::int AS inconclusive,
      count(*) FILTER (WHERE stage = 'not_delivered')::int AS not_delivered,
      count(*) FILTER (WHERE stage = 'revoked')::int AS revoked,
      count(*) FILTER (WHERE stage = 'no_402')::int AS no_402,
      count(*) FILTER (WHERE stage = 'unknown')::int AS unknown,
      to_char(max(revoked_at) FILTER (WHERE stage = 'revoked') AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS revoked_latest_at
    FROM staged
  `);
  const agg = rowsOf<Record<string, unknown>>(raw)[0] ?? {};
  const unknownRaw = await db.execute(sql`
    SELECT status, count(*)::int AS n
    FROM (
      SELECT ${sql.raw(stageExpr)} AS stage, p.status
      FROM x402_l1_purchases p
    ) u
    WHERE stage = 'unknown'
    GROUP BY status
  `);
  const unknownByStatus: Record<string, number> = {};
  for (const r of rowsOf<{ status: string; n: number }>(unknownRaw)) {
    unknownByStatus[r.status] = Number(r.n);
  }

  const counts: PurchaseLifecycleCounts = {
    stages: {
      http_402: Number(agg.http_402 ?? 0),
      signed: Number(agg.signed ?? 0),
      settle_claimed: Number(agg.settle_claimed ?? 0),
      settled: Number(agg.settled ?? 0),
      delivered: Number(agg.delivered ?? 0),
      inconclusive: Number(agg.inconclusive ?? 0),
      not_delivered: Number(agg.not_delivered ?? 0),
      revoked: Number(agg.revoked ?? 0),
    },
    outsideStages: {
      no_402: Number(agg.no_402 ?? 0),
      unknown: Number(agg.unknown ?? 0),
    },
    unknownByStatus,
    total: Number(agg.total ?? 0),
    revokedLatestAt: agg.revoked_latest_at ? String(agg.revoked_latest_at) : null,
    note: LIFECYCLE_NOTE,
    stageDefinitions: { ...STAGE_DEFINITIONS },
  };
  lifecycleInvariant(counts);
  return counts;
}

export type PurchaseLifecycleRow = PurchaseStageRowInput & { id: string };

export function attachPurchaseStageFields<T extends PurchaseStageRowInput & { id?: string }>(
  rows: T[],
  revokedByPurchaseId: ReadonlyMap<string, string>,
): (Omit<T, "id" | "payloadNonEmpty" | "authNonce"> & { stage: PurchaseStageKey; revokedAt: string | null })[] {
  return rows.map((row) => {
    const revokedAt =
      row.id && row.status !== "settled" ? (revokedByPurchaseId.get(row.id) ?? null) : null;
    const stage = purchaseStageOf(row, revokedAt);
    const { id: _id, payloadNonEmpty: _payload, authNonce: _auth, ...rest } = row;
    return {
      ...rest,
      stage,
      revokedAt: purchaseRevokedAt(row, revokedAt),
    };
  });
}
