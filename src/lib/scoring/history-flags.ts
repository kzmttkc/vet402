// ============================================================
// 履歴フラグ v0（A6 予測レイヤーの正直な最小形）。
//
// 「予測」を売る前に、予測の材料になる**機械的述語**を定義付きで出す。
// 各フラグは台帳から決定的に計算される事実の要約であって意見ではない——
// ただし「これをどう重むか」は意見の領域に近いので、この面は
// **キー付きAPI限定**で、観測所の公開ページには一切出さない（L0–L2の
// 公開面に評価的な語を持ち込まないという既存の分離を守る）。
// 述語を変えたら名前も変える（同名で意味を変えない）。
// ============================================================
import { sql } from "drizzle-orm";
import { inconclusivePredicate } from "@/lib/observatory/delivery";
import { getDb } from "@/lib/db/client";

export type HistoryFlags = {
  payTo: string;
  endpoints: number;
  flags: {
    /** settle_failed ≥2 かつ settled 0 のエンドポイントを1つ以上運用。 */
    repeatSettleFailureNoSuccess: boolean;
    /** 直近14日でL0 verdictが3回以上入れ替わったエンドポイントあり。 */
    l0Flapping14d: boolean;
    /** カタログ申告価格と壁の要求が食い違った記録（price_mismatch）あり。 */
    priceMismatchRecorded: boolean;
    /**
     * カタログ申告の受取先と壁の要求した受取先が食い違った記録
     * （payto_mismatch）あり。2026-08-22 追加——価格の食い違いより重い
     * 所見（誰に払うかの差し替え）なので、同じ「売り手についての事実」の
     * 面に並べる。述語は決定的、重み付けは呼び手の領域。
     */
    payToMismatchRecorded: boolean;
  };
  counts: { settled: number; settleFailed: number; priceMismatch: number; payToMismatch: number };
  definition: string;
};

export const HISTORY_FLAGS_DEFINITION =
  "Deterministic predicates over vet402's own ledger for endpoints whose payTo equals the queried wallet. repeatSettleFailureNoSuccess: some endpoint has >=2 settle_failed and 0 settled, not counting settle_failed rows held as inconclusive (a 4xx with no settlement receipt, or a 402 while vet402's own payer wallet was unfunded, 2026-09-13T00:00Z–2026-09-15T23:49Z; since 2026-09-17). l0Flapping14d: some endpoint's L0 verdict changed >=3 times in the last 14 days. priceMismatchRecorded: any price_mismatch attempt recorded. payToMismatchRecorded: any payto_mismatch attempt recorded (the wall named a payee other than the catalog-declared one). Facts summarized, not opinions; weighting is the caller's.";

export async function computeHistoryFlags(payTo: string): Promise<HistoryFlags | null> {
  const db = getDb();
  if (!db) return null;
  const wallet = payTo.startsWith("0x") ? payTo.toLowerCase() : payTo;
  const raw = await db.execute(sql`
    WITH eps AS (
      SELECT id FROM x402_endpoints WHERE pay_to = ${wallet}
    ), purch AS (
      SELECT pu.endpoint_id,
             count(*) FILTER (WHERE pu.status = 'settled') AS settled,
             -- 2026-09-17 Issue #29: 保留の行（決済レシートなしの 4xx・資金切れ期間の 402）は
             -- 売り手の失敗として数えない（delivery.ts が正典）。
             count(*) FILTER (WHERE pu.status = 'settle_failed' AND NOT (${sql.raw(inconclusivePredicate("pu"))})) AS failed,
             count(*) FILTER (WHERE pu.status = 'price_mismatch') AS mismatch,
             count(*) FILTER (WHERE pu.status = 'payto_mismatch') AS payto_mismatch
      FROM x402_l1_purchases pu JOIN eps ON eps.id = pu.endpoint_id
      GROUP BY pu.endpoint_id
    ), flap AS (
      SELECT p.endpoint_id, count(*) AS changes
      FROM (
        SELECT endpoint_id, verdict,
               lag(verdict) OVER (PARTITION BY endpoint_id ORDER BY probed_at) AS prev
        FROM x402_l0_probes
        WHERE probed_at > now() - interval '14 days'
          AND endpoint_id IN (SELECT id FROM eps)
      ) p
      WHERE p.prev IS NOT NULL AND p.prev <> p.verdict
      GROUP BY p.endpoint_id
    )
    SELECT
      (SELECT count(*)::int FROM eps) AS endpoints,
      coalesce((SELECT sum(settled)::int FROM purch), 0) AS settled,
      coalesce((SELECT sum(failed)::int FROM purch), 0) AS settle_failed,
      coalesce((SELECT sum(mismatch)::int FROM purch), 0) AS price_mismatch,
      coalesce((SELECT sum(payto_mismatch)::int FROM purch), 0) AS payto_mismatch,
      EXISTS (SELECT 1 FROM purch WHERE failed >= 2 AND settled = 0) AS repeat_fail,
      EXISTS (SELECT 1 FROM flap WHERE changes >= 3) AS flapping
  `);
  const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Record<
    string,
    unknown
  >[];
  const r = rows[0] ?? {};
  return {
    payTo: wallet,
    endpoints: Number(r.endpoints ?? 0),
    flags: {
      repeatSettleFailureNoSuccess: r.repeat_fail === true,
      l0Flapping14d: r.flapping === true,
      priceMismatchRecorded: Number(r.price_mismatch ?? 0) > 0,
      payToMismatchRecorded: Number(r.payto_mismatch ?? 0) > 0,
    },
    counts: {
      settled: Number(r.settled ?? 0),
      settleFailed: Number(r.settle_failed ?? 0),
      priceMismatch: Number(r.price_mismatch ?? 0),
      payToMismatch: Number(r.payto_mismatch ?? 0),
    },
    definition: HISTORY_FLAGS_DEFINITION,
  };
}
