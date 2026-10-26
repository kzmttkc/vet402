// ============================================================
// 判定 API の件数を、鍵とチェーンで数える（2026-10-26）。
//
// 鍵なしは client_usage_daily の chain 列（呼び手の粒度は日・client・ルートのまま）。
// 鍵ありは decision_usage_daily（日・api_key_id・chain）。api_usage の課金とは別。
// どちらも応答の後に 1 文で upsert し、失敗はログへ出して捨てる。判定の応答は変えない。
// 数えるのは新鮮な 200 だけ。replay・400・404・401・503 は呼び手が数えない。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { toCaip2 } from "@/lib/observatory/chains";
import { runAfterResponse } from "@/lib/util/after-response";
import { logAndSwallowSafe } from "@/lib/util/log-safe";
import { rowsOf } from "@/lib/settlements/upsert";
import { UUID_RE } from "@/lib/validation/uuid";

/** 公開の文。断定語・we/our/us・セミコロン・ダッシュを置かない。 */
export const USAGE_MONTHLY_CHAIN_MESSAGE = "chain is required. Use a CAIP-2 network id such as eip155:42220.";
export const USAGE_MONTHLY_CHAIN_INVALID_MESSAGE = "chain must be a CAIP-2 network id such as eip155:42220.";
export const USAGE_MONTHLY_MONTH_MESSAGE = "month is required. Use YYYY-MM.";
export const USAGE_MONTHLY_MONTH_INVALID_MESSAGE = "month must be YYYY-MM.";
export const USAGE_MONTHLY_EMPTY_MESSAGE = "This chain and month have no decision calls in the usage tables.";
export const USAGE_MONTHLY_UNAVAILABLE_MESSAGE = "The usage tables could not be read.";

const CHAIN_MAX = 200;
/** CAIP-2 に出る文字。algorand の genesis は `=` を含む。空白や引用符は受けない。 */
const CHAIN_QUERY_RE = /^[A-Za-z0-9:._~/=+-]{1,200}$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;

/**
 * 出品の主ネットワークを、集計に書く CAIP-2 にする。空や null は空文字。
 * 既知のスラグ（base など）は toCaip2 で寄せ、未知の文字列はそのまま、長さだけ切る。
 */
export function usageChainOf(network: unknown): string {
  const caip = toCaip2(network);
  if (!caip) return "";
  return caip.length > CHAIN_MAX ? caip.slice(0, CHAIN_MAX) : caip;
}

export type MonthlyUsageQuery =
  | { ok: true; chain: string; month: string; start: string; end: string }
  | { ok: false; error: "chain_required" | "chain_invalid" | "month_required" | "month_invalid" };

/** month は UTC の [YYYY-MM-01, 翌月)。chain は toCaip2 済みの値で集計行と突き合わせる。 */
export function parseMonthlyUsageQuery(chainRaw: string | null, monthRaw: string | null): MonthlyUsageQuery {
  const chainText = (chainRaw ?? "").trim();
  if (chainText === "") return { ok: false, error: "chain_required" };
  if (!CHAIN_QUERY_RE.test(chainText)) return { ok: false, error: "chain_invalid" };
  const chain = usageChainOf(chainText);
  if (!chain || !CHAIN_QUERY_RE.test(chain)) return { ok: false, error: "chain_invalid" };

  const monthText = (monthRaw ?? "").trim();
  if (monthText === "") return { ok: false, error: "month_required" };
  const match = MONTH_RE.exec(monthText);
  if (!match) return { ok: false, error: "month_invalid" };
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return { ok: false, error: "month_invalid" };
  const start = `${match[1]}-${match[2]}-01`;
  const end = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  return { ok: true, chain, month: `${match[1]}-${match[2]}`, start, end };
}

export function monthlyUsageErrorMessage(error: Exclude<MonthlyUsageQuery, { ok: true }>["error"]): string {
  if (error === "chain_required") return USAGE_MONTHLY_CHAIN_MESSAGE;
  if (error === "chain_invalid") return USAGE_MONTHLY_CHAIN_INVALID_MESSAGE;
  if (error === "month_required") return USAGE_MONTHLY_MONTH_MESSAGE;
  return USAGE_MONTHLY_MONTH_INVALID_MESSAGE;
}

async function upsertDecisionUsage(apiKeyId: string, chain: string, day: string): Promise<void> {
  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch (error) {
    logAndSwallowSafe("decision_usage.record")(error);
    return;
  }
  if (!db) return;
  if (!UUID_RE.test(apiKeyId)) return;
  try {
    await db.execute(
      sql`INSERT INTO decision_usage_daily (day, api_key_id, chain, count)
          VALUES (${day}::date, ${apiKeyId}::uuid, ${chain}, 1)
          ON CONFLICT (day, api_key_id, chain) DO UPDATE SET count = decision_usage_daily.count + 1`,
    );
  } catch (error) {
    logAndSwallowSafe("decision_usage.record")(error);
  }
}

/** 鍵ありの新鮮な判定 200。応答の後。失敗しても投げない。 */
export function recordDecisionUsage(apiKeyId: string, chain: string, now: Date = new Date()): void {
  try {
    const stored = usageChainOf(chain);
    const day = now.toISOString().slice(0, 10);
    runAfterResponse(() => upsertDecisionUsage(apiKeyId, stored, day));
  } catch (error) {
    logAndSwallowSafe("decision_usage.schedule")(error);
  }
}

export type MonthlyDecisionUsage = {
  chain: string;
  month: string;
  keyed: { label: string; owner_relation: string | null; calls: number }[];
  keyless: { client: string; calls: number }[];
  external_calls: number;
};

/**
 * 公開の月次表。鍵 id・ハッシュ・メール・名前は選ばない。
 * 番号は decision_usage_daily 全体で min(day), api_key_id の順。月を変えても同じ鍵は同じ番号。
 */
export async function loadMonthlyDecisionUsage(query: Extract<MonthlyUsageQuery, { ok: true }>): Promise<MonthlyDecisionUsage> {
  const db = getDb();
  if (!db) throw new Error("database_unconfigured");
  const keyed = rowsOf<{ label: string; owner_relation: string | null; calls: number }>(
    await db.execute(sql`
      WITH labels AS (
        SELECT api_key_id, row_number() OVER (ORDER BY min(day), api_key_id) AS n
        FROM decision_usage_daily
        GROUP BY api_key_id
      )
      SELECT 'key-' || labels.n::text AS label,
             k.owner_relation,
             sum(d.count)::int AS calls
      FROM decision_usage_daily d
      JOIN labels ON labels.api_key_id = d.api_key_id
      LEFT JOIN api_keys k ON k.id = d.api_key_id
      WHERE d.chain = ${query.chain}
        AND d.day >= ${query.start}::date
        AND d.day < ${query.end}::date
      GROUP BY labels.n, k.owner_relation
      ORDER BY labels.n
    `),
  );
  const keyless = rowsOf<{ client: string; calls: number }>(
    await db.execute(sql`
      SELECT client, sum(count)::int AS calls
      FROM client_usage_daily
      WHERE route = 'decision'
        AND chain = ${query.chain}
        AND day >= ${query.start}::date
        AND day < ${query.end}::date
      GROUP BY client
      ORDER BY client
    `),
  );
  const keyedRows = keyed.map((row) => ({
    label: String(row.label),
    owner_relation: row.owner_relation ?? null,
    calls: Number(row.calls),
  }));
  return {
    chain: query.chain,
    month: query.month,
    keyed: keyedRows,
    keyless: keyless.map((row) => ({ client: String(row.client), calls: Number(row.calls) })),
    external_calls: keyedRows.reduce((sum, row) => (row.owner_relation === "external" ? sum + row.calls : sum), 0),
  };
}
