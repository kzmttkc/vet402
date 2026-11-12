// B1 の段階件数。DB が無い、または表が無いときは 0。台帳の status は更新しない。
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { isMissingSchemaError } from "@/lib/db/pg-errors";
import {
  emptyLifecycleCounts,
  lifecycleStageOf,
  type LifecycleCounts,
} from "@/lib/observatory/purchase-lifecycle";

function asRows(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  if (raw && typeof raw === "object" && Array.isArray((raw as { rows?: unknown[] }).rows)) {
    return (raw as { rows: Record<string, unknown>[] }).rows;
  }
  return [];
}

function asBool(v: unknown): boolean | null {
  if (v === true || v === false) return v;
  if (v === "t" || v === "true") return true;
  if (v === "f" || v === "false") return false;
  return null;
}

function asTime(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().replace(/\.\d{3}Z$/, "Z");
  if (typeof v === "string" && v.length > 0) {
    const t = new Date(v);
    if (!Number.isNaN(t.getTime())) return t.toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  return null;
}

function asHttp(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.length > 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 購入行を 1 件ずつ段階に置く。reorg の印は raw_response_meta.purchaseLifecycle.reorgRevokedAt。 */
export async function readPurchaseLifecycleCounts(): Promise<LifecycleCounts> {
  const empty = emptyLifecycleCounts();
  const db = getDb();
  if (!db) return empty;
  try {
    const raw = await db.execute(sql`
      SELECT status,
             http_status_paid,
             tx_hash,
             payload_non_empty,
             attempted_at,
             network,
             settlement_verified,
             raw_response_meta->'purchaseLifecycle'->>'reorgRevokedAt' AS reorg_revoked_at
      FROM x402_l1_purchases
    `);
    const counts = emptyLifecycleCounts();
    for (const item of asRows(raw)) {
      const stage = lifecycleStageOf({
        status: typeof item.status === "string" ? item.status : "",
        httpStatusPaid: asHttp(item.http_status_paid),
        txHash: item.tx_hash === null || item.tx_hash === undefined ? null : String(item.tx_hash),
        payloadNonEmpty: asBool(item.payload_non_empty),
        attemptedAt: asTime(item.attempted_at),
        network: item.network === null || item.network === undefined ? null : String(item.network),
        settlementConfirmed: asBool(item.settlement_verified) === true,
        reorgRevokedAt: typeof item.reorg_revoked_at === "string" && item.reorg_revoked_at.length > 0 ? item.reorg_revoked_at : null,
      });
      counts.stages[stage] += 1;
      counts.total += 1;
    }
    return counts;
  } catch (error) {
    if (isMissingSchemaError(error)) return empty;
    throw error;
  }
}
