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
  settlement_verified_at: string | null;
  resource_id: string | null;
  endpoint_id: string;
};

export async function ingestL1(options: { onlyPurchaseRowId?: string; limit?: number; sinceDays?: number } = {}) {
  const db = getDb();
  if (!db) throw new Error("ingestL1: DATABASE_URL is not configured");
  const { onlyPurchaseRowId, limit = 2000, sinceDays = 45 } = options;
  const rows = rowsOf<L1Row>(
    await db.execute(sql`
      SELECT pu.id::text AS id, pu.tx_hash, pu.network, pu.asset, pu.amount_units, pu.payer, pu.pay_to,
             pu.attempted_at::text AS attempted_at, pu.settlement_verified_at::text AS settlement_verified_at,
             e.resource_id, e.id::text AS endpoint_id
      FROM x402_l1_purchases pu
      JOIN x402_endpoints e ON e.id = pu.endpoint_id
      WHERE pu.status = 'settled' AND pu.tx_hash IS NOT NULL AND pu.network IS NOT NULL
        ${onlyPurchaseRowId ? sql`AND pu.id = ${onlyPurchaseRowId}::uuid` : sql`AND pu.attempted_at > now() - make_interval(days => ${sinceDays})`}
      ORDER BY pu.attempted_at DESC
      LIMIT ${limit}
    `),
  );
  let inserted = 0;
  let updated = 0;
  for (const r of rows) {
    const chain = toCaip2(r.network) ?? r.network!;
    const row = buildRow(
      {
        chain,
        txHash: r.tx_hash,
        asset: r.asset,
        amount: r.amount_units,
        payer: r.payer,
        payee: r.pay_to,
        // ブロック時刻は照合時刻で近似（確定を確認した時刻）。無ければ試行時刻。
        blockTime: new Date(r.settlement_verified_at ?? r.attempted_at),
        source: "l1_purchase",
        raw: { purchaseRowId: r.id, blockTimeSource: r.settlement_verified_at ? "settlement_verified_at" : "attempted_at" },
      },
      { attribution: "confirmed", washFlag: "test", resourceId: r.resource_id, endpointId: r.endpoint_id },
    );
    const outcome = await upsertSettlement(row);
    if (outcome === "inserted") inserted++;
    else updated++;
  }
  return { scanned: rows.length, inserted, updated };
}
