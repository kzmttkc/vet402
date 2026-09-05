// ============================================================
// §7.2 / §9.1 センサス要約。生値（raw）と実需（real = wash_flag 'none'）を
// 同じ問い合わせから両方返す。混ぜて一つの数字にしない。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { RAW_RETENTION_DAYS, SETTLEMENT_DAY, UTC_TODAY, withDailyFallback } from "./rollup";
import { rowsOf } from "./upsert";

export type CensusWindow = "7d" | "30d";

export type CensusSummary = {
  chain: string;
  window: CensusWindow;
  settlements_raw: number;
  settlements_real: number;
  wash: { self_deal: number; circular: number; test: number };
  attribution: { confirmed: number; probable: number; unmatched: number };
  unique_payers_raw: number;
  unique_payers_real: number;
  unique_payees_real: number;
  endpoints_with_real_settlement: number;
  by_source: { l1_purchase: number; payments_api: number; chain_index: number };
  /**
   * 索引がいつから存在するか。`window` は**求めた期間**であって**持っている期間**ではない。
   * 2026-09-04 の本番実測では eip155:8453 の最古の日は 2026-08-23（30d 窓のうち 13 日ぶん）、
   * solana は 2026-07-21（46 日ぶん）で、チェーンによって 46 日違った。全体の最古日だけを
   * 出すと、件数の 99.9% を占める Base が 13 日ぶんであることを隠してしまう。だから
   * チェーン別（byChain）と、全チェーンが揃う日（all_chains_since）を同じ応答に入れる。
   * 分母を売るなら、分母の期間は応答だけで確かめられなければならない。
   */
  indexed_since: {
    /** 索引に 1 件でも決済がある最古の UTC 日（YYYY-MM-DD）。1 件も無ければ null。 */
    all: string | null;
    /** チェーン別の最古の UTC 日。chain を指定した応答は 1 件だけになる。 */
    byChain: Record<string, string>;
    /** どのチェーンも索引されている最古の UTC 日（= byChain の最も新しい日）。 */
    all_chains_since: string | null;
    /** 要求された窓の日数（7 か 30）。 */
    window_requested_days: number;
    /** その窓のうち、索引が実際に持っている UTC 日数。 */
    window_covered_days: number;
    /** window_covered_days が要求どおりか。false なら件数は下限であって総数ではない。 */
    window_fully_covered: boolean;
    /** 何を数えて何を数えないか（英語・応答だけで読めるように）。 */
    note: string;
  };
  definition: string;
  disclaimer: string;
  retrievedAt: string;
};

export const CENSUS_DEFINITION =
  "settlements_raw counts every indexed x402-related settlement in the window (chain index of USDC transfers to catalog-declared payTo addresses, verified POST /payments/x402 rows, and vet402's own L1 purchases). settlements_real excludes wash_flag self_deal (same EOA or same funder), circular (reverse transfer within 24h), and test (known measurement wallets, including every wallet vet402 pays from). Both numbers are published; they are never merged. attribution: confirmed = payTo, amount and time all match a catalog envelope; probable = payTo matches, amount or time is loose; unmatched = a receipt with no resource. ERC-8004 owner identity is not yet used for self_deal clustering (disclosed limitation). The window is counted in whole UTC days. Raw rows are kept " +
  RAW_RETENTION_DAYS +
  " days; older days are held as daily (payee, payer) aggregates; counts are exact, per-transaction receipts older than " +
  RAW_RETENTION_DAYS +
  " days are not served.";

export const CENSUS_INDEXED_SINCE_NOTE =
  "indexed_since.all is the oldest UTC day this index holds for any chain and indexed_since.byChain gives that day per chain, " +
  "counted over raw settlement rows together with the daily aggregates older rows are folded into; raw rows are kept " +
  RAW_RETENTION_DAYS +
  " days and older days survive only as daily (payee, payer) counts and amount sums with no per-transaction receipts, " +
  "so any day before all_chains_since is missing every chain whose index starts later, and window_covered_days is how many " +
  "whole UTC days of the requested window — ending today — the index actually holds, which is why counts are a floor rather " +
  "than a total whenever window_fully_covered is false.";

export const CENSUS_DISCLAIMER =
  "Scores are opinions; L0–L2 are measurement records. This is not credit assessment, KYC, sanctions screening, or certification.";

const DAY_MS = 86_400_000;

/**
 * 要求した窓のうち、索引が実際に持っている UTC 日数。純粋関数（境界は
 * tests/census-indexed-since.test.ts が固定する）。
 *
 * 窓の定義はセンサスの SQL と同じ——`day > today - days` なので
 * `today - (days - 1)` .. `today` の両端を含む days 日。最古日がその開始より
 * 古ければ要求どおり、新しければ「最古日から今日まで」の日数に縮む。
 * 読めない日付・未来の日付は 0 日に落とす（NaN や負数を日数として出さない）。
 */
export function windowCoverage(
  oldestDay: string | null,
  todayUtc: string,
  requestedDays: number,
): { window_requested_days: number; window_covered_days: number; window_fully_covered: boolean } {
  const none = { window_requested_days: requestedDays, window_covered_days: 0, window_fully_covered: false };
  if (!oldestDay) return none;
  const today = Date.parse(`${todayUtc}T00:00:00Z`);
  const oldest = Date.parse(`${oldestDay}T00:00:00Z`);
  if (!Number.isFinite(today) || !Number.isFinite(oldest)) return none;
  const windowStart = today - (requestedDays - 1) * DAY_MS;
  const effective = Math.max(windowStart, oldest);
  const covered = Math.min(requestedDays, Math.max(0, Math.round((today - effective) / DAY_MS) + 1));
  return {
    window_requested_days: requestedDays,
    window_covered_days: covered,
    window_fully_covered: covered >= requestedDays,
  };
}

export async function getCensusSummary(chain: string | null, window: CensusWindow): Promise<CensusSummary> {
  const db = getDb();
  const empty: CensusSummary = {
    chain: chain ?? "all",
    window,
    settlements_raw: 0,
    settlements_real: 0,
    wash: { self_deal: 0, circular: 0, test: 0 },
    attribution: { confirmed: 0, probable: 0, unmatched: 0 },
    unique_payers_raw: 0,
    unique_payers_real: 0,
    unique_payees_real: 0,
    endpoints_with_real_settlement: 0,
    by_source: { l1_purchase: 0, payments_api: 0, chain_index: 0 },
    indexed_since: {
      all: null,
      byChain: {},
      all_chains_since: null,
      ...windowCoverage(null, new Date().toISOString().slice(0, 10), window === "7d" ? 7 : 30),
      note: CENSUS_INDEXED_SINCE_NOTE,
    },
    definition: CENSUS_DEFINITION,
    disclaimer: CENSUS_DISCLAIMER,
    retrievedAt: new Date().toISOString(),
  };
  if (!db) return empty;
  const days = window === "7d" ? 7 : 30;
  const chainRaw = chain ? sql`AND chain = ${chain}` : sql``;
  // 生行 ∪ 日次集約。1 件の決済がこの 2 つに同時に載ることはない
  // （rollup.ts が「消して畳む」を単一文でやる）ので、足すだけで正確。
  // 集約がまだ 1 行も無ければ、これは生行だけの計算とまったく同じ式になる。
  const union = (daily: boolean) => sql`
      WITH u AS (
        SELECT payer_id, payee_id, endpoint_id, wash_flag, source, attribution, 1::bigint AS n
        FROM settlements
        WHERE ${SETTLEMENT_DAY} > ${UTC_TODAY} - ${days}::int ${chainRaw}
        ${
          daily
            ? sql`UNION ALL
        SELECT payer_id, payee_id, endpoint_id, wash_flag, source, attribution, n::bigint
        FROM settlement_daily
        WHERE day > ${UTC_TODAY} - ${days}::int ${chainRaw}`
            : sql``
        }
      )
      SELECT
        coalesce(sum(n), 0)::int AS raw,
        coalesce(sum(n) FILTER (WHERE wash_flag = 'none'), 0)::int AS real,
        coalesce(sum(n) FILTER (WHERE wash_flag = 'self_deal'), 0)::int AS self_deal,
        coalesce(sum(n) FILTER (WHERE wash_flag = 'circular'), 0)::int AS circular,
        coalesce(sum(n) FILTER (WHERE wash_flag = 'test'), 0)::int AS test,
        coalesce(sum(n) FILTER (WHERE attribution = 'confirmed'), 0)::int AS confirmed,
        coalesce(sum(n) FILTER (WHERE attribution = 'probable'), 0)::int AS probable,
        coalesce(sum(n) FILTER (WHERE attribution = 'unmatched'), 0)::int AS unmatched,
        count(DISTINCT payer_id)::int AS payers_raw,
        count(DISTINCT payer_id) FILTER (WHERE wash_flag = 'none')::int AS payers_real,
        count(DISTINCT payee_id) FILTER (WHERE wash_flag = 'none')::int AS payees_real,
        count(DISTINCT endpoint_id) FILTER (WHERE wash_flag = 'none' AND endpoint_id IS NOT NULL)::int AS endpoints_real,
        coalesce(sum(n) FILTER (WHERE source = 'l1_purchase'), 0)::int AS src_l1,
        coalesce(sum(n) FILTER (WHERE source = 'payments_api'), 0)::int AS src_api,
        coalesce(sum(n) FILTER (WHERE source = 'chain_index'), 0)::int AS src_chain
      FROM u
    `;
  // 索引の最古の日。**窓に関係なく**、生行 ∪ 日次集約のいちばん古い UTC 日を
  // チェーンごとに 1 文で取る。生行だけを見ると、畳んだ日（集約にしか無い日）を
  // 見落として「索引はもっと新しい」と過小に名乗ってしまう。
  const oldestPerChain = (daily: boolean) => sql`
      WITH u AS (
        SELECT chain, min(${SETTLEMENT_DAY}) AS d
        FROM settlements WHERE true ${chainRaw} GROUP BY chain
        ${
          daily
            ? sql`UNION ALL
        SELECT chain, min(day) AS d
        FROM settlement_daily WHERE true ${chainRaw} GROUP BY chain`
            : sql``
        }
      )
      SELECT (SELECT ${UTC_TODAY})::text AS today, chain, min(d)::text AS oldest
      FROM u WHERE d IS NOT NULL GROUP BY chain
    `;
  // 2 文だが往復は 1 回ぶんの待ち時間で済む（neon-http は 1 execute = 1 HTTP）。
  const [rows, sinceRows] = await Promise.all([
    withDailyFallback(
      async () => rowsOf<Record<string, number | string | null>>(await db.execute(union(true))),
      async () => rowsOf<Record<string, number | string | null>>(await db.execute(union(false))),
    ),
    withDailyFallback(
      async () => rowsOf<{ today: string; chain: string; oldest: string }>(await db.execute(oldestPerChain(true))),
      async () => rowsOf<{ today: string; chain: string; oldest: string }>(await db.execute(oldestPerChain(false))),
    ),
  ]);
  const byChain: Record<string, string> = {};
  for (const row of sinceRows) {
    if (row.chain && row.oldest) byChain[row.chain] = row.oldest;
  }
  // ISO の日付は辞書順が時系列順。最も古い日が all、最も新しい日が
  // 「どのチェーンも索引されている日」。
  const daysIndexed = Object.values(byChain).sort();
  const oldestAll = daysIndexed[0] ?? null;
  const allChainsSince = daysIndexed.length > 0 ? daysIndexed[daysIndexed.length - 1] : null;
  // UTC の今日は DB から取る（件数を数えた窓と同じ now() を使う）。索引が
  // 空で行が返らないときだけ JS の UTC 日付に落とす（どちらも UTC）。
  const todayUtc = sinceRows[0]?.today ?? new Date().toISOString().slice(0, 10);
  const r = rows[0] ?? {};
  const n = (k: string) => Number(r[k] ?? 0);
  return {
    ...empty,
    settlements_raw: n("raw"),
    settlements_real: n("real"),
    wash: { self_deal: n("self_deal"), circular: n("circular"), test: n("test") },
    attribution: { confirmed: n("confirmed"), probable: n("probable"), unmatched: n("unmatched") },
    unique_payers_raw: n("payers_raw"),
    unique_payers_real: n("payers_real"),
    unique_payees_real: n("payees_real"),
    endpoints_with_real_settlement: n("endpoints_real"),
    by_source: { l1_purchase: n("src_l1"), payments_api: n("src_api"), chain_index: n("src_chain") },
    indexed_since: {
      all: oldestAll,
      byChain,
      all_chains_since: allChainsSince,
      ...windowCoverage(oldestAll, todayUtc, days),
      note: CENSUS_INDEXED_SINCE_NOTE,
    },
  };
}

/** 1 つの endpoint/payee の 30 日実需（seller_facts 用）。 */
export async function getSettlementCounts(
  where: { endpointId?: string; payeeId?: string },
  days = 30,
): Promise<{ raw: number; real: number; test: number; uniquePayersReal: number }> {
  const db = getDb();
  if (!db) return { raw: 0, real: 0, test: 0, uniquePayersReal: 0 };
  // 生行と集約で列名が同じなので、同じ条件式をそのまま両方に当てられる。
  const cond = where.endpointId
    ? sql`endpoint_id = ${where.endpointId}::uuid`
    : where.payeeId
      ? sql`payee_id = ${where.payeeId}`
      : sql`false`;
  const q = (daily: boolean) => sql`
      WITH u AS (
        SELECT payer_id, wash_flag, 1::bigint AS n FROM settlements
        WHERE ${cond} AND ${SETTLEMENT_DAY} > ${UTC_TODAY} - ${days}::int
        ${
          daily
            ? sql`UNION ALL
        SELECT payer_id, wash_flag, n::bigint FROM settlement_daily
        WHERE ${cond} AND day > ${UTC_TODAY} - ${days}::int`
            : sql``
        }
      )
      SELECT coalesce(sum(n), 0)::int AS raw,
             coalesce(sum(n) FILTER (WHERE wash_flag = 'none'), 0)::int AS real,
             coalesce(sum(n) FILTER (WHERE wash_flag = 'test'), 0)::int AS test,
             count(DISTINCT payer_id) FILTER (WHERE wash_flag = 'none')::int AS payers
      FROM u
    `;
  const rows = await withDailyFallback(
    async () => rowsOf<{ raw: number; real: number; test: number; payers: number }>(await db.execute(q(true))),
    async () => rowsOf<{ raw: number; real: number; test: number; payers: number }>(await db.execute(q(false))),
  );
  const r = rows[0];
  return { raw: Number(r?.raw ?? 0), real: Number(r?.real ?? 0), test: Number(r?.test ?? 0), uniquePayersReal: Number(r?.payers ?? 0) };
}
