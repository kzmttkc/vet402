// ============================================================
// トラストグラフ v0（A7）——payTo を節とした関係の照会。
//
// v0 の関係は2種類だけ（どちらも台帳から決定的）:
//  1. operates: この payTo が受け取り先のエンドポイント一覧＋レシート集計
//  2. sharesHostWith: 同じホストで別の payTo が受け取っているエンドポイント
//     （1ホストに複数ウォレット＝運用の分散か、名義の分散か——判断は
//      呼び手。ここは事実の隣接だけを返す）
// sybil 判定そのものは既存 sybil.ts の領分で、この面は材料の公開。
// キー付きAPI限定（history-flags と同じ分離方針）。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";

export type PayToGraph = {
  payTo: string;
  operates: {
    endpointId: string;
    resourceKey: string;
    network: string | null;
    attempts: number;
    settled: number;
  }[];
  sharesHostWith: { host: string; payTo: string; endpoints: number }[];
  definition: string;
};

export const GRAPH_DEFINITION =
  "operates: catalog endpoints whose payTo equals the queried wallet, with vet402's own paid-attempt tallies. sharesHostWith: other payTo values receiving on the same host(s). Adjacency facts only — no inference is made here.";

export async function computePayToGraph(payTo: string): Promise<PayToGraph | null> {
  const db = getDb();
  if (!db) return null;
  const wallet = payTo.startsWith("0x") ? payTo.toLowerCase() : payTo;

  const opRaw = await db.execute(sql`
    SELECT e.id::text AS id, e.resource_key, e.network,
           coalesce(count(pu.id) FILTER (WHERE pu.status IN ('settled','settle_failed','delivered_no_receipt','settle_claimed_unverifiable')), 0)::int AS attempts,
           coalesce(count(pu.id) FILTER (WHERE pu.status = 'settled'), 0)::int AS settled
    FROM x402_endpoints e
    LEFT JOIN x402_l1_purchases pu ON pu.endpoint_id = e.id
    WHERE e.pay_to = ${wallet}
    GROUP BY e.id, e.resource_key, e.network
    ORDER BY attempts DESC, e.resource_key ASC
    LIMIT 200
  `);
  const operates = ((Array.isArray(opRaw) ? opRaw : (opRaw as { rows?: unknown[] }).rows ?? []) as Record<string, unknown>[]).map((r) => ({
    endpointId: String(r.id),
    resourceKey: String(r.resource_key),
    network: r.network === null ? null : String(r.network),
    attempts: Number(r.attempts),
    settled: Number(r.settled),
  }));

  const shareRaw = await db.execute(sql`
    WITH my_hosts AS (
      SELECT DISTINCT split_part(resource_key, '/', 1) AS host
      FROM x402_endpoints WHERE pay_to = ${wallet}
    )
    SELECT split_part(e.resource_key, '/', 1) AS host, e.pay_to, count(*)::int AS endpoints
    FROM x402_endpoints e
    JOIN my_hosts h ON split_part(e.resource_key, '/', 1) = h.host
    WHERE e.pay_to IS NOT NULL AND e.pay_to <> ${wallet}
    GROUP BY 1, 2
    ORDER BY endpoints DESC
    LIMIT 100
  `);
  const sharesHostWith = ((Array.isArray(shareRaw) ? shareRaw : (shareRaw as { rows?: unknown[] }).rows ?? []) as Record<string, unknown>[]).map((r) => ({
    host: String(r.host),
    payTo: String(r.pay_to),
    endpoints: Number(r.endpoints),
  }));

  return { payTo: wallet, operates, sharesHostWith, definition: GRAPH_DEFINITION };
}
