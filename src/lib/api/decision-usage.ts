// ============================================================
// 鍵ありの判定 API の件数を、鍵とチェーンで数える（2026-10-26）。
//
// 鍵なしは client_usage_daily のまま（日・client・ルート）。チェーンは足さない。
// 鍵ありは decision_usage_daily（日・api_key_id・chain）。api_usage の課金とは別。
// 応答の後に 1 文で upsert し、失敗はログへ出して捨てる。判定の応答は変えない。
// 数えるのは新鮮な 200 だけ。replay・400・404・401・503 は呼び手が数えない。
//
// 公開の月次表は区分（self / related / external / 未分類）ごとの本数と件数だけ。
// 鍵 1 本の行は出さない。鍵なしの節も出さない（チェーンが無い）。
// 区分の鍵が 3 本未満のときは本数を "<3" とし、件数は出さない。
// 引けるチェーンは PUBLIC_USAGE_CHAINS だけ。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { canonicalNetworkId } from "@/lib/observatory/chains";
import { runAfterResponse } from "@/lib/util/after-response";
import { logAndSwallowSafe } from "@/lib/util/log-safe";
import { rowsOf } from "@/lib/settlements/upsert";
import { UUID_RE } from "@/lib/validation/uuid";

/** 公開の文。断定語・we/our/us・セミコロン・ダッシュを置かない。 */
export const USAGE_MONTHLY_CHAIN_MESSAGE = "chain is required. Use a CAIP-2 network id such as eip155:42220.";
export const USAGE_MONTHLY_CHAIN_INVALID_MESSAGE = "chain must be a CAIP-2 network id such as eip155:42220.";
export const USAGE_MONTHLY_CHAIN_UNLISTED_MESSAGE =
  "chain must be a published network id. eip155:42220 is on the published list.";
export const USAGE_MONTHLY_MONTH_MESSAGE = "month is required. Use YYYY-MM.";
export const USAGE_MONTHLY_MONTH_INVALID_MESSAGE = "month must be YYYY-MM.";
export const USAGE_MONTHLY_EMPTY_MESSAGE = "This chain and month have no decision calls in the usage tables.";
export const USAGE_MONTHLY_UNAVAILABLE_MESSAGE = "The usage tables could not be read.";

const CHAIN_MAX = 200;
/** CAIP-2 に出る文字。algorand の genesis は `=` を含む。空白や引用符は受けない。 */
const CHAIN_QUERY_RE = /^[A-Za-z0-9:._~/=+-]{1,200}$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;

/**
 * 公開の月次表が受け付けるチェーン。保存はここを見ない。
 * 足すときはこの配列だけを変える。
 */
export const PUBLIC_USAGE_CHAINS = ["eip155:42220"] as const;

/** この本数未満の区分は、公開の表で本数を "<3" とし、件数を出さない。 */
export const PUBLIC_USAGE_MIN_KEYS = 3;

export type UsageRelation = "self" | "related" | "external";

/**
 * 出品の主ネットワークを、集計に書く CAIP-2 にする。空や null は空文字。
 * canonicalNetworkId（celo は eip155:42220。base などは toCaip2）。未知の文字列はそのまま、長さだけ切る。
 */
export function usageChainOf(network: unknown): string {
  if (typeof network !== "string") return "";
  const trimmed = network.trim();
  if (trimmed === "") return "";
  const caip = canonicalNetworkId(trimmed);
  if (!caip) return "";
  return caip.length > CHAIN_MAX ? caip.slice(0, CHAIN_MAX) : caip;
}

export function isPublicUsageChain(chain: string): boolean {
  return (PUBLIC_USAGE_CHAINS as readonly string[]).includes(chain);
}

export type MonthlyUsageQuery =
  | { ok: true; chain: string; month: string; start: string; end: string }
  | { ok: false; error: "chain_required" | "chain_invalid" | "chain_unlisted" | "month_required" | "month_invalid" };

/** month は UTC の [YYYY-MM-01, 翌月)。chain は canonicalNetworkId 済みで、公開一覧にあるものだけ。 */
export function parseMonthlyUsageQuery(chainRaw: string | null, monthRaw: string | null): MonthlyUsageQuery {
  const chainText = (chainRaw ?? "").trim();
  if (chainText === "") return { ok: false, error: "chain_required" };
  if (!CHAIN_QUERY_RE.test(chainText)) return { ok: false, error: "chain_invalid" };
  const chain = usageChainOf(chainText);
  if (!chain || !CHAIN_QUERY_RE.test(chain)) return { ok: false, error: "chain_invalid" };
  if (!isPublicUsageChain(chain)) return { ok: false, error: "chain_unlisted" };

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
  if (error === "chain_unlisted") return USAGE_MONTHLY_CHAIN_UNLISTED_MESSAGE;
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
    // 主キー (day, api_key_id, chain) は表と一緒に作る。ON CONFLICT はそれで足りる。
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

export type MonthlyRelationUsage = {
  owner_relation: UsageRelation | null;
  keys: number | "<3";
  calls?: number;
};

export type MonthlyDecisionUsage = {
  chain: string;
  month: string;
  relations: MonthlyRelationUsage[];
};

const RELATION_ORDER: Record<string, number> = { self: 0, related: 1, external: 2 };

function asRelation(value: string | null): UsageRelation | null {
  if (value === "self" || value === "related" || value === "external") return value;
  return null;
}

/**
 * 公開の月次表。鍵 id・ハッシュ・メール・名前は選ばない。鍵なしの行は選ばない。
 * 生きている鍵の区分は api_keys.owner_relation。消した鍵は relation_snapshot（削除の時点）。
 * 3 本未満の区分は件数を返さない。
 */
export async function loadMonthlyDecisionUsage(query: Extract<MonthlyUsageQuery, { ok: true }>): Promise<MonthlyDecisionUsage> {
  const db = getDb();
  if (!db) throw new Error("database_unconfigured");
  const grouped = rowsOf<{ owner_relation: string | null; keys: number; calls: number }>(
    await db.execute(sql`
      SELECT COALESCE(k.owner_relation, d.relation_snapshot) AS owner_relation,
             count(DISTINCT d.api_key_id)::int AS keys,
             sum(d.count)::int AS calls
      FROM decision_usage_daily d
      LEFT JOIN api_keys k ON k.id = d.api_key_id
      WHERE d.chain = ${query.chain}
        AND d.day >= ${query.start}::date
        AND d.day < ${query.end}::date
      GROUP BY 1
    `),
  );
  const relations = grouped
    .map((row) => {
      const owner_relation = asRelation(row.owner_relation);
      const keys = Number(row.keys);
      if (keys < PUBLIC_USAGE_MIN_KEYS) return { owner_relation, keys: "<3" as const };
      return { owner_relation, keys, calls: Number(row.calls) };
    })
    .sort((a, b) => (RELATION_ORDER[a.owner_relation ?? ""] ?? 3) - (RELATION_ORDER[b.owner_relation ?? ""] ?? 3));
  return { chain: query.chain, month: query.month, relations };
}
