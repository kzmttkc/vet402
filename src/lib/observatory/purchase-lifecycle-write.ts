// ============================================================
// B1: 照合済みの決済を読み直し、鎖の組み直しで tx が無効なら
// raw_response_meta.purchaseLifecycle.reorgRevokedAt だけを足す。
//
// status、tx_hash、settlement_verified、settlement_verify_reason は変えない。
// export.csv の status の意味は 12/12 まで凍結。訂正ログは status か tx が
// 変わるときだけなので、ここからは書かない。3.2 の DecisionStore にも触れない。
// 段階の移った時刻は、この行の purchaseLifecycle に残す。
// ============================================================
import { sql, type SQL } from "drizzle-orm";

const UTC_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** tx が鎖から消えた、または取り消された。一時的な読み失敗や額の不一致は含まない。 */
export const REORG_INVALIDATION_REASONS = new Set(["tx_not_found", "tx_reverted"]);

/** 1 回の照合で読み直す、既に確認済みの行の上限。 */
export const REORG_REREAD_ROWS_PER_RUN = 20;

/** 読み直してまだ有効な行を、次に読むまでの日数。 */
export const REORG_REREAD_STALE_DAYS = 7;

type ExecuteDb = {
  execute: (query: SQL) => Promise<unknown>;
};

export type ChainRereadResult = { ok: true } | { ok: false; reason: string };

export type ChainRereadInput = {
  txHash: string;
  network: string;
  expectedPayTo: string;
  expectedPayer: string;
  expectedAmountUnits: string;
  expectedAuthNonce?: string | null;
};

function rowsOf(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  if (raw && typeof raw === "object" && Array.isArray((raw as { rows?: unknown[] }).rows)) {
    return (raw as { rows: Record<string, unknown>[] }).rows;
  }
  return [];
}

export function utcSecond(at: string): string {
  if (!UTC_SECOND.test(at)) throw new Error("purchase lifecycle time must be UTC to the second");
  return at;
}

/** 2 回とも取り消しの理由だったときだけ、鎖の組み直しとして扱う。 */
export function reorgInvalidationConfirmed(first: string | null | undefined, second: string | null | undefined): boolean {
  return (
    typeof first === "string" &&
    REORG_INVALIDATION_REASONS.has(first) &&
    typeof second === "string" &&
    REORG_INVALIDATION_REASONS.has(second)
  );
}

/**
 * purchaseLifecycle.reorgRevokedAt を足す。他のキーは残す。
 * 既に時刻があるときはその時刻を残し、wrote は false。status は足さない。
 */
export function mergeReorgRevokedAt(meta: unknown, at: string): { meta: Record<string, unknown>; wrote: boolean } {
  const when = utcSecond(at);
  const base: Record<string, unknown> =
    meta && typeof meta === "object" && !Array.isArray(meta) ? { ...(meta as Record<string, unknown>) } : {};
  const raw = base.purchaseLifecycle;
  const life: Record<string, unknown> =
    raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  if (typeof life.reorgRevokedAt === "string" && life.reorgRevokedAt.length > 0) {
    base.purchaseLifecycle = life;
    return { meta: base, wrote: false };
  }
  life.reorgRevokedAt = when;
  base.purchaseLifecycle = life;
  return { meta: base, wrote: true };
}

/** 台帳の status は触らない。時刻が既にある行は 0 行。 */
export async function appendReorgRevokedAt(db: ExecuteDb, purchaseId: string, at: string): Promise<boolean> {
  const when = utcSecond(at);
  const raw = await db.execute(sql`
    UPDATE x402_l1_purchases
    SET raw_response_meta =
      coalesce(CASE WHEN jsonb_typeof(raw_response_meta) = 'object' THEN raw_response_meta ELSE '{}'::jsonb END, '{}'::jsonb)
      || jsonb_build_object(
           'purchaseLifecycle',
           coalesce(
             CASE WHEN jsonb_typeof(raw_response_meta->'purchaseLifecycle') = 'object'
                  THEN raw_response_meta->'purchaseLifecycle'
                  ELSE '{}'::jsonb END,
             '{}'::jsonb
           ) || jsonb_build_object(
             'reorgRevokedAt',
             coalesce(NULLIF(raw_response_meta->'purchaseLifecycle'->>'reorgRevokedAt', ''), ${when}::text)
           )
         )
    WHERE id = ${purchaseId}::uuid
      AND coalesce(raw_response_meta->'purchaseLifecycle'->>'reorgRevokedAt', '') = ''
    RETURNING id::text AS id
  `);
  return rowsOf(raw).length > 0;
}

async function noteChainRereadAt(db: ExecuteDb, purchaseId: string, at: string): Promise<void> {
  const when = utcSecond(at);
  await db.execute(sql`
    UPDATE x402_l1_purchases
    SET raw_response_meta =
      coalesce(CASE WHEN jsonb_typeof(raw_response_meta) = 'object' THEN raw_response_meta ELSE '{}'::jsonb END, '{}'::jsonb)
      || jsonb_build_object(
           'purchaseLifecycle',
           coalesce(
             CASE WHEN jsonb_typeof(raw_response_meta->'purchaseLifecycle') = 'object'
                  THEN raw_response_meta->'purchaseLifecycle'
                  ELSE '{}'::jsonb END,
             '{}'::jsonb
           ) || jsonb_build_object('chainRereadAt', ${when}::text)
         )
    WHERE id = ${purchaseId}::uuid
      AND coalesce(raw_response_meta->'purchaseLifecycle'->>'reorgRevokedAt', '') = ''
  `);
}

export type ReorgRereadSummary = { scanned: number; revoked: number; noted: number };

/**
 * settlement_verified が true の settled 行だけを読む。未照合の主張は既存の照合に残す。
 * 取り消しは 2 回の読みがどちらも tx_not_found か tx_reverted のときだけ。
 */
export async function rereadConfirmedSettlementsForReorg(
  db: ExecuteDb,
  options: {
    verify: (input: ChainRereadInput) => Promise<ChainRereadResult>;
    nowIso: string;
    limit?: number;
    staleDays?: number;
    stop?: () => boolean;
  },
): Promise<ReorgRereadSummary> {
  const nowIso = utcSecond(options.nowIso);
  const limit = options.limit ?? REORG_REREAD_ROWS_PER_RUN;
  const staleDays = options.staleDays ?? REORG_REREAD_STALE_DAYS;
  const raw = await db.execute(sql`
    SELECT pu.id::text AS id,
           pu.tx_hash,
           pu.network,
           pu.pay_to,
           pu.payer,
           pu.amount_units,
           pu.auth_nonce
    FROM x402_l1_purchases pu
    WHERE pu.status = 'settled'
      AND pu.settlement_verified IS TRUE
      AND pu.tx_hash IS NOT NULL
      AND btrim(pu.tx_hash) <> ''
      AND pu.pay_to IS NOT NULL
      AND pu.payer IS NOT NULL
      AND pu.amount_units IS NOT NULL
      AND coalesce(pu.raw_response_meta->>'circleGatewayRail', '') <> 'true'
      AND coalesce(pu.raw_response_meta->'purchaseLifecycle'->>'reorgRevokedAt', '') = ''
      AND CASE
            WHEN coalesce(pu.raw_response_meta->'purchaseLifecycle'->>'chainRereadAt', '') = '' THEN true
            WHEN (pu.raw_response_meta->'purchaseLifecycle'->>'chainRereadAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
              THEN (pu.raw_response_meta->'purchaseLifecycle'->>'chainRereadAt')::timestamptz
                   <= now() - (${staleDays}::int * interval '1 day')
            ELSE true
          END
    ORDER BY pu.attempted_at ASC, pu.id ASC
    LIMIT ${limit}
  `);
  const summary: ReorgRereadSummary = { scanned: 0, revoked: 0, noted: 0 };
  for (const row of rowsOf(raw)) {
    if (options.stop?.()) break;
    const id = typeof row.id === "string" ? row.id : "";
    const txHash = typeof row.tx_hash === "string" ? row.tx_hash : "";
    const network = typeof row.network === "string" ? row.network : "";
    const expectedPayTo = typeof row.pay_to === "string" ? row.pay_to : "";
    const expectedPayer = typeof row.payer === "string" ? row.payer : "";
    const expectedAmountUnits = row.amount_units === null || row.amount_units === undefined ? "" : String(row.amount_units);
    const expectedAuthNonce = typeof row.auth_nonce === "string" && row.auth_nonce.length > 0 ? row.auth_nonce : null;
    if (!id || !txHash || !network || !expectedPayTo || !expectedPayer || !expectedAmountUnits) continue;
    const input: ChainRereadInput = { txHash, network, expectedPayTo, expectedPayer, expectedAmountUnits, expectedAuthNonce };
    try {
      const first = await options.verify(input);
      summary.scanned += 1;
      const firstReason = first.ok ? null : first.reason;
      if (typeof firstReason === "string" && REORG_INVALIDATION_REASONS.has(firstReason)) {
        const second = await options.verify(input);
        const secondReason = second.ok ? null : second.reason;
        if (reorgInvalidationConfirmed(firstReason, secondReason)) {
          if (await appendReorgRevokedAt(db, id, nowIso)) summary.revoked += 1;
          continue;
        }
      }
      await noteChainRereadAt(db, id, nowIso);
      summary.noted += 1;
    } catch {
      // 読めなかった行は印を付けない。次の回が同じ行を読む。status は変えない。
    }
  }
  return summary;
}
