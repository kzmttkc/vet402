// ============================================================
// 経路 1: 我々の L1 購入（§7.2 / §7.3 / §13）。
//   - attribution は confirmed（封筒を見て払ったのは我々自身）
//   - wash_flag は必ず test（測定ウォレットは実需から除く）
//   - L1 ランナーが settled を書いた直後にも呼ばれ、逆引きが 1 分以内に更新される
//     （§7.3 実装完了の定義）
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { toCaip2 } from "@/lib/observatory/chains";
import { RAW_RETENTION_DAYS } from "./rollup";
import { buildRow, rowsOf, upsertSettlement } from "./upsert";

type L1Row = {
  id: string;
  tx_hash: string;
  network: string | null;
  asset: string | null;
  amount_units: string | null;
  payer: string | null;
  pay_to: string | null;
  attempted_at: string;
  settlement_block_time: string | null;
  observed_block_time: string | null;
  resource_id: string | null;
  endpoint_id: string;
};

/**
 * 台帳時刻の文字列。ISO でも、Postgres の timestamptz の文字でも、読めるものだけ返す。
 * 読めない値（空・壊れた文字）は無いものとして扱う。
 */
export function chainBlockTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export async function ingestL1(options: { onlyPurchaseRowId?: string; limit?: number; sinceDays?: number } = {}) {
  const db = getDb();
  if (!db) throw new Error("ingestL1: DATABASE_URL is not configured");
  // 2026-10-19: 窓は生行の保持（RAW_RETENTION_DAYS）の内側に収める。45 日だと、畳んで消した日の行を
  // 毎日入れ直し、rollup の加算（ON CONFLICT … n + excluded.n）でもう一度数える芽になる。
  // 並びは「settlements にまだ無い行」を先に。2,000 件の上限で新しい行だけを毎日なめ直し、
  // 古い行が永久に入らない取りこぼし（10/19 実測: 30 日で 6,393 件のうち 2,000 件）を数日で埋める。
  const { onlyPurchaseRowId, limit = 2000, sinceDays = Math.max(1, RAW_RETENTION_DAYS - 1) } = options;
  const rows = rowsOf<L1Row>(
    await db.execute(sql`
      SELECT pu.id::text AS id, pu.tx_hash, pu.network, pu.asset, pu.amount_units, pu.payer, pu.pay_to,
             pu.attempted_at::text AS attempted_at,
             pu.raw_response_meta->>'settlementBlockTime' AS settlement_block_time,
             op.block_timestamp::text AS observed_block_time,
             e.resource_id, e.id::text AS endpoint_id
      FROM x402_l1_purchases pu
      JOIN x402_endpoints e ON e.id = pu.endpoint_id
      -- 照合済みの行は settlementBlockTime を後から書かない。台帳時刻は照合のたびに
      -- observed_purchases.block_timestamp へ残っている（observed_by は購入 id）。
      -- observed_by に一意制約は無いので、あるときは block_timestamp の新しい 1 件だけ採る。
      LEFT JOIN LATERAL (
        SELECT block_timestamp
        FROM observed_purchases
        WHERE observed_by = 'observatory-l1-verified:' || pu.id::text
        ORDER BY block_timestamp DESC NULLS LAST
        LIMIT 1
      ) op ON true
      WHERE pu.status = 'settled' AND pu.tx_hash IS NOT NULL AND pu.network IS NOT NULL
        ${onlyPurchaseRowId ? sql`AND pu.id = ${onlyPurchaseRowId}::uuid` : sql`AND pu.attempted_at > now() - make_interval(days => ${sinceDays})`}
      ORDER BY (EXISTS (SELECT 1 FROM settlements s WHERE s.purchase_id = pu.network || ':' || pu.tx_hash)) ASC,
               pu.attempted_at DESC
      LIMIT ${limit}
    `),
  );
  let inserted = 0;
  let updated = 0;
  for (const r of rows) {
    const chain = toCaip2(r.network) ?? r.network!;
    // 台帳時刻。読める settlementBlockTime を先に、無ければ observed_purchases の
    // block_timestamp。どちらから採っても blockTimeSource は chain。両方無ければ試行時刻。
    // 照合が終わった時刻（settlement_verified_at）は使わない。
    const chainTime = chainBlockTime(r.settlement_block_time) ?? chainBlockTime(r.observed_block_time);
    const row = buildRow(
      {
        chain,
        txHash: r.tx_hash,
        asset: r.asset,
        amount: r.amount_units,
        payer: r.payer,
        payee: r.pay_to,
        blockTime: chainTime ?? new Date(r.attempted_at),
        source: "l1_purchase",
        raw: { purchaseRowId: r.id, blockTimeSource: chainTime ? "chain" : "attempted_at" },
      },
      { attribution: "confirmed", washFlag: "test", resourceId: r.resource_id, endpointId: r.endpoint_id },
    );
    const outcome = await upsertSettlement(row);
    if (outcome === "inserted") inserted++;
    else updated++;
  }
  return { scanned: rows.length, inserted, updated };
}
