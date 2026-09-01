// ============================================================
// settlements への単文 upsert（neon-http は複文トランザクションを持てない）。
// purchase_id（chain:tx_hash）で一意。後から来た行は帰属・wash を更新し、
// 空だった列だけを埋める（既知の事実を null で上書きしない）。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { purchaseId as toPurchaseId, payeeId as toPartyId } from "@/lib/ids/canonical";
import type { SettlementInput, SettlementRow, Attribution, WashFlag } from "./types";

export function rowsOf<T = Record<string, unknown>>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

export function buildRow(
  input: SettlementInput,
  meta: { attribution: Attribution; washFlag: WashFlag; resourceId: string | null; endpointId: string | null },
): SettlementRow {
  return {
    ...input,
    purchaseId: toPurchaseId(input.chain, input.txHash),
    payerId: input.payer ? toPartyId(input.chain, input.payer) : null,
    payeeId: input.payee ? toPartyId(input.chain, input.payee) : null,
    ...meta,
  };
}

export async function upsertSettlement(row: SettlementRow): Promise<"inserted" | "updated"> {
  const db = getDb();
  if (!db) throw new Error("upsertSettlement: DATABASE_URL is not configured");
  const raw = await db.execute(sql`
    INSERT INTO settlements
      (chain, tx_hash, purchase_id, asset, amount, payer, payee, payer_id, payee_id, facilitator,
       block_time, attribution, resource_id, endpoint_id, wash_flag, source, raw)
    VALUES
      (${row.chain}, ${row.txHash}, ${row.purchaseId}, ${row.asset}, ${row.amount}, ${row.payer}, ${row.payee},
       ${row.payerId}, ${row.payeeId}, ${row.facilitator ?? null},
       ${row.blockTime ? row.blockTime.toISOString() : null}::timestamptz,
       ${row.attribution}, ${row.resourceId}, ${row.endpointId}::uuid, ${row.washFlag}, ${row.source},
       ${row.raw === undefined ? null : JSON.stringify(row.raw)}::jsonb)
    ON CONFLICT (purchase_id) DO UPDATE SET
      attribution = EXCLUDED.attribution,
      wash_flag = EXCLUDED.wash_flag,
      asset = COALESCE(EXCLUDED.asset, settlements.asset),
      amount = COALESCE(EXCLUDED.amount, settlements.amount),
      payer = COALESCE(EXCLUDED.payer, settlements.payer),
      payee = COALESCE(EXCLUDED.payee, settlements.payee),
      payer_id = COALESCE(EXCLUDED.payer_id, settlements.payer_id),
      payee_id = COALESCE(EXCLUDED.payee_id, settlements.payee_id),
      block_time = COALESCE(EXCLUDED.block_time, settlements.block_time),
      resource_id = COALESCE(EXCLUDED.resource_id, settlements.resource_id),
      endpoint_id = COALESCE(EXCLUDED.endpoint_id, settlements.endpoint_id)
    RETURNING (xmax = 0) AS inserted
  `);
  const r = rowsOf<{ inserted: boolean }>(raw)[0];
  return r?.inserted ? "inserted" : "updated";
}

/** 既に索引済みの purchase_id を 1 文で引く（同じ窓を再読するときに per-row 作業を飛ばす）。 */
export async function knownPurchaseIds(ids: readonly string[]): Promise<Set<string>> {
  const db = getDb();
  if (!db || ids.length === 0) return new Set();
  const rows = rowsOf<{ purchase_id: string }>(
    // drizzle は JS 配列をタプル ($1, $2) に展開するので ARRAY[...] を明示する
    await db.execute(sql`SELECT purchase_id FROM settlements WHERE purchase_id = ANY(ARRAY[${sql.join(ids.map((i) => sql`${i}`), sql`, `)}]::text[])`),
  );
  return new Set(rows.map((r) => r.purchase_id));
}

/**
 * 束ね upsert（1 文に最大 200 行）。戻りは inserted 数。同じ窓を再読したときの重複は
 * ON CONFLICT で吸収する（knownPurchaseIds で先に飛ばすのが前提だが、競合しても壊れない）。
 */
export async function upsertSettlementsBatch(rows: readonly SettlementRow[]): Promise<{ inserted: number; updated: number }> {
  const db = getDb();
  if (!db) throw new Error("upsertSettlementsBatch: DATABASE_URL is not configured");
  let inserted = 0;
  let updated = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const values = chunk.map(
      (row) => sql`(${row.chain}, ${row.txHash}, ${row.purchaseId}, ${row.asset}, ${row.amount}, ${row.payer}, ${row.payee},
        ${row.payerId}, ${row.payeeId}, ${row.facilitator ?? null}, ${row.blockTime ? row.blockTime.toISOString() : null}::timestamptz,
        ${row.attribution}, ${row.resourceId}, ${row.endpointId}::uuid, ${row.washFlag}, ${row.source},
        ${row.raw === undefined ? null : JSON.stringify(row.raw)}::jsonb)`,
    );
    const raw = await db.execute(sql`
      INSERT INTO settlements
        (chain, tx_hash, purchase_id, asset, amount, payer, payee, payer_id, payee_id, facilitator,
         block_time, attribution, resource_id, endpoint_id, wash_flag, source, raw)
      VALUES ${sql.join(values, sql`, `)}
      ON CONFLICT (purchase_id) DO UPDATE SET
        attribution = EXCLUDED.attribution,
        wash_flag = EXCLUDED.wash_flag,
        block_time = COALESCE(EXCLUDED.block_time, settlements.block_time),
        resource_id = COALESCE(EXCLUDED.resource_id, settlements.resource_id),
        endpoint_id = COALESCE(EXCLUDED.endpoint_id, settlements.endpoint_id)
      RETURNING (xmax = 0) AS inserted
    `);
    for (const r of rowsOf<{ inserted: boolean }>(raw)) {
      if (r.inserted) inserted++;
      else updated++;
    }
  }
  return { inserted, updated };
}
