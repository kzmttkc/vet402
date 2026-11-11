// ============================================================
// 3.8b（2026-11-11）: 公開の 10 鎖それぞれの、第三者が辿れる最新の settled 1 件。
//
// 粒度はホームの 1 件（home-example.ts の HomeReceipt）と同じで、formatSettledReceipt で作る。
// tx が空の行、Circle Gateway の共有バッチで決済した行（tx は他の購入と共有で、この購入だけの
// tx ではない）は載せない。バッチ tx で tx を埋めない。
//
// 段（settled-tier.ts の settledTier）ごとに一覧を分ける。amount_payee_only の行は nonce_bound の
// 一覧に入らない。各行は settledTier を名乗る。SQL で段を選んだあと、同じ行を settledTier で
// 分類し直し、食い違えば載せない（SQL と JS の二重定義が割れたときに強い段へ混ざらないように）。
//
// 例の無い鎖は chainsWithoutExample に名前を出す。新しい購入で埋めない。新しい集計ジョブも作らない。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { isPublicExplorerTxUrl, publicChainLabel, traceablePublicChains } from "@/lib/observatory/chains";
import { formatSettledReceipt, type HomeReceipt, readHomeExample } from "@/lib/observatory/home-example";
import { settledTier, settledTierPredicate, type SettledTier } from "@/lib/observatory/settled-tier";
import { confirmedUnitsSql } from "@/lib/observatory/export-columns";
import { heldReasonSql } from "@/lib/observatory/delivery";
import { settlementSourceSql } from "@/lib/observatory/settlement-source";
import { l2ReadingColumnsSql } from "@/lib/observatory/l2-check";
import { rowsOf } from "@/lib/settlements/upsert";

export type TraceableReceipt = HomeReceipt & { settledTier: SettledTier };

export type TraceableChainExample = {
  label: string;
  network: string;
  nonceBound: TraceableReceipt | null;
  amountPayeeOnly: TraceableReceipt | null;
};

export type TraceableByChain = {
  retrievedAt: string;
  chains: TraceableChainExample[];
  /** 段ごとの一覧。同じ購入は片方にしか無い。 */
  lists: { nonce_bound: TraceableReceipt[]; amount_payee_only: TraceableReceipt[] };
  traceableCount: number;
  /** 辿れる 1 件が無い鎖の公開名。 */
  chainsWithoutExample: string[];
  allChainsTraceable: boolean;
  /** ホームの最新 1 件。読めなければ null（架空の 1 件を作らない）。 */
  home: { purchaseId: string; listed: boolean } | null;
  /** ホームの 1 件とは別の、辿れる例が公開にあるか。 */
  moreThanHomeAlone: boolean;
};

type CandidateRow = Record<string, unknown> & {
  id: string;
  network: string;
  tier: string;
  auth_nonce: string | null;
  settlement_verified: boolean | null;
};

function traceable(r: HomeReceipt | null): r is HomeReceipt {
  return Boolean(r && r.tx !== "" && isPublicExplorerTxUrl(r.txUrl) && r.settlementSource !== "circle_gateway");
}

/** 鎖ごとの例と、ホームの 1 件から、公開の形を組む（DB を読まない部分）。 */
export function assembleTraceableByChain(
  candidates: readonly TraceableReceipt[],
  homePurchaseId: string | null,
  retrievedAt: string,
): TraceableByChain {
  const chains: TraceableChainExample[] = traceablePublicChains().map(({ label, network }) => {
    const pick = (tier: SettledTier) =>
      candidates
        .filter((c) => c.settledTier === tier && publicChainLabel(c.network) === label)
        .sort((a, b) => (a.attemptedAt === b.attemptedAt ? a.purchaseId.localeCompare(b.purchaseId) : a.attemptedAt < b.attemptedAt ? 1 : -1))[0] ?? null;
    return { label, network, nonceBound: pick("nonce_bound"), amountPayeeOnly: pick("amount_payee_only") };
  });
  const nonce_bound = chains.flatMap((c) => (c.nonceBound ? [c.nonceBound] : []));
  const amount_payee_only = chains.flatMap((c) => (c.amountPayeeOnly ? [c.amountPayeeOnly] : []));
  const ids = new Set([...nonce_bound, ...amount_payee_only].map((r) => r.purchaseId));
  const chainsWithoutExample = chains.filter((c) => !c.nonceBound && !c.amountPayeeOnly).map((c) => c.label);
  const others = [...ids].filter((id) => id !== homePurchaseId).length;
  return {
    retrievedAt,
    chains,
    lists: { nonce_bound, amount_payee_only },
    traceableCount: ids.size,
    chainsWithoutExample,
    allChainsTraceable: chainsWithoutExample.length === 0,
    home: homePurchaseId === null ? null : { purchaseId: homePurchaseId, listed: ids.has(homePurchaseId) },
    moreThanHomeAlone: homePurchaseId === null ? ids.size >= 2 : others >= 1,
  };
}

/** network と段ごとの最新の settled 1 行（tx あり、Gateway のバッチではない）。 */
async function readCandidates(): Promise<TraceableReceipt[] | null> {
  const db = getDb();
  if (!db) return null;
  const bound = settledTierPredicate("nonce_bound", "pu");
  const source = settlementSourceSql("pu");
  const rows = rowsOf<CandidateRow>(
    await db.execute(sql`
      SELECT * FROM (
        SELECT pu.id::text AS id,
               to_char(pu.attempted_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS attempted_at,
               e.resource_key,
               pu.network,
               pu.spent_units::text AS spent_units,
               pu.tx_hash,
               pu.http_status_paid::text AS http_status_paid,
               e.id::text AS endpoint_id,
               (${sql.raw(confirmedUnitsSql("pu"))})::text AS confirmed_units,
               pu.payload_non_empty,
               (${sql.raw(heldReasonSql("pu"))}) AS held_reason,
               (${sql.raw(source)}) AS settlement_source,
               ${sql.raw(l2ReadingColumnsSql("pu"))},
               pu.l2_schema,
               pu.auth_nonce,
               pu.settlement_verified,
               CASE WHEN ${sql.raw(bound)} THEN 'nonce_bound' ELSE 'amount_payee_only' END AS tier,
               row_number() OVER (
                 PARTITION BY pu.network, (${sql.raw(bound)})
                 ORDER BY pu.attempted_at DESC, pu.id ASC
               ) AS rn
        FROM x402_l1_purchases pu
        JOIN x402_endpoints e ON e.id = pu.endpoint_id
        WHERE pu.status = 'settled'
          AND pu.tx_hash IS NOT NULL AND btrim(pu.tx_hash) <> ''
          AND e.resource_key IS NOT NULL AND e.resource_key <> ''
          AND (${sql.raw(source)}) IS DISTINCT FROM 'circle_gateway'
      ) x
      WHERE x.rn = 1
    `),
  );
  const out: TraceableReceipt[] = [];
  for (const row of rows) {
    const tier = settledTier({
      status: "settled",
      settlementVerified: row.settlement_verified,
      authNonce: row.auth_nonce,
      network: row.network,
    });
    if (tier === null || tier !== row.tier) continue;
    const at = String(row.attempted_at);
    const receipt = formatSettledReceipt(row, { rows: 1, settled: 1, from: at, to: at });
    if (!traceable(receipt)) continue;
    out.push({ ...receipt, settledTier: tier });
  }
  return out;
}

export async function readTraceableByChain(): Promise<TraceableByChain | null> {
  const candidates = await readCandidates();
  if (candidates === null) return null;
  const home = await readHomeExample();
  return assembleTraceableByChain(candidates, home?.receipt.purchaseId ?? null, new Date().toISOString());
}
