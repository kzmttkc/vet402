// ============================================================
// 鍵ありの判定 API の件数を、鍵とチェーンで数える（2026-10-26）。
//
// 鍵なしは client_usage_daily のまま（日・client・ルート）。チェーンは足さない。
// 鍵ありは decision_usage_daily（日・api_key_id・chain）。api_usage の課金とは別。
// 応答の後に 1 文で upsert し、失敗はログへ出して捨てる。判定の応答は変えない。
// 数えるのは新鮮な 200 だけ。replay・400・404・401・503 は呼び手が数えない。
//
// 公開の月次表は、締まった月だけ。今の UTC の月と未来の月は 400（month_not_closed）。
// 月が締まって 3 日たったあと（翌月 3 日 00:00 UTC 以降）の最初の読み取りで、
// decision_usage_monthly_published に一度だけ書く。それより前は 400（month_not_published_yet）。
// 運用者が区分を付ける猶予は、締まった翌月の 1 日と 2 日。固定のあとはこの表だけを読む。
//
// 数える単位は鍵ではなく持ち主。生きている鍵は COALESCE(user_id, 鍵 id)。消した鍵は owner_snapshot（無ければ置き換えた鍵 id）。
// 消した行は api_keys に無いので、置き換えた api_key_id を 1 人として数える。
// self / related / external / prezenti_grantee は人数と件数。3 人未満は人数を "<3" とし、件数は出さない。
// 未分類は件数を出さない。3 人未満なら人数も "<3"。
// 鍵 1 本の行は出さない。鍵なしの節も出さない（チェーンが無い）。
// 引けるチェーンは PUBLIC_USAGE_CHAINS だけ。month の年は 2026 から 2100。
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
export const USAGE_MONTHLY_MONTH_INVALID_MESSAGE = "month must be YYYY-MM from 2026 through 2100.";
export const USAGE_MONTHLY_MONTH_NOT_CLOSED_MESSAGE =
  "month is still open. Pass a UTC month that has already closed.";
export const USAGE_MONTHLY_MONTH_NOT_PUBLISHED_YET_MESSAGE =
  "month has closed. Figures are published on the first read after 00:00 UTC on the 3rd day of the next month.";
export const USAGE_MONTHLY_EMPTY_MESSAGE = "This chain and month have no decision calls in the usage tables.";
export const USAGE_MONTHLY_UNAVAILABLE_MESSAGE = "The usage tables could not be read.";

const CHAIN_MAX = 200;
/** CAIP-2 に出る文字。algorand の genesis は `=` を含む。空白や引用符は受けない。 */
const CHAIN_QUERY_RE = /^[A-Za-z0-9:._~/=+-]{1,200}$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;
const USAGE_YEAR_MIN = 2026;
const USAGE_YEAR_MAX = 2100;
const EIP155_PREFIX = "eip155:";

/**
 * 公開の月次表が受け付けるチェーン。保存はここを見ない。
 * 足すときはこの配列だけを変える。
 */
export const PUBLIC_USAGE_CHAINS = ["eip155:42220"] as const;

/** この人数未満の区分は、公開の表で人数を "<3" とし、件数を出さない。 */
export const PUBLIC_USAGE_MIN_OWNERS = 3;

/**
 * prezenti_grantee（2026-10-28）: Prezenti（Celo のビルダー支援）の採択者だと、公開の記録で確かめた持ち主の鍵。
 * external の一種だが別の区分に数える（external の行には入らない）。3 人未満の秘匿は他の区分と同じ。
 * 出どころの証拠は docs/operations/api-key-owner-relation.md。
 */
export const USAGE_RELATIONS = ["self", "related", "external", "prezenti_grantee"] as const;

export type UsageRelation = (typeof USAGE_RELATIONS)[number];

export type MonthlyUsageError =
  | "chain_required"
  | "chain_invalid"
  | "chain_unlisted"
  | "month_required"
  | "month_invalid"
  | "month_not_closed"
  | "month_not_published_yet";

/** eip155: の接頭辞だけを小文字にする。参照側の大文字小文字は変えない。 */
export function normalizeUsageChain(chain: string): string {
  if (chain.length >= EIP155_PREFIX.length && chain.slice(0, EIP155_PREFIX.length).toLowerCase() === EIP155_PREFIX) {
    return EIP155_PREFIX + chain.slice(EIP155_PREFIX.length);
  }
  return chain;
}

/**
 * 出品の主ネットワークを、集計に書く CAIP-2 にする。空や null は空文字。
 * canonicalNetworkId（celo は eip155:42220。base などは toCaip2）。未知の文字列はそのまま、長さだけ切る。
 * EIP155:42220 は eip155:42220。保存と月次の問い合わせの両方がここを通る。
 */
export function usageChainOf(network: unknown): string {
  if (typeof network !== "string") return "";
  const trimmed = network.trim();
  if (trimmed === "") return "";
  const caip = canonicalNetworkId(trimmed);
  if (!caip) return "";
  const normalized = normalizeUsageChain(caip);
  return normalized.length > CHAIN_MAX ? normalized.slice(0, CHAIN_MAX) : normalized;
}

export function isPublicUsageChain(chain: string): boolean {
  return (PUBLIC_USAGE_CHAINS as readonly string[]).includes(chain);
}

export type MonthlyUsageQuery =
  | { ok: true; chain: string; month: string; start: string; end: string }
  | { ok: false; error: Exclude<MonthlyUsageError, "month_not_closed" | "month_not_published_yet"> };

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** 翌月 1 日。年は呼び出し側が 2026〜2100 に限ったあとで渡す。Date.UTC の 0〜99 年には寄せない。 */
function nextMonthStart(year: number, month: number): string {
  const endYear = month === 12 ? year + 1 : year;
  const endMonth = month === 12 ? 1 : month + 1;
  return `${String(endYear).padStart(4, "0")}-${pad2(endMonth)}-01`;
}

/** month は UTC の [YYYY-MM-01, 翌月)。chain は usageChainOf 済みで、公開一覧にあるものだけ。 */
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
  if (!Number.isInteger(year) || !Number.isInteger(month)) return { ok: false, error: "month_invalid" };
  if (year < USAGE_YEAR_MIN || year > USAGE_YEAR_MAX) return { ok: false, error: "month_invalid" };
  if (month < 1 || month > 12) return { ok: false, error: "month_invalid" };
  const start = `${match[1]}-${match[2]}-01`;
  return { ok: true, chain, month: `${match[1]}-${match[2]}`, start, end: nextMonthStart(year, month) };
}

/**
 * 公開してよい月か。今の UTC 月と未来は month_not_closed。
 * 締まった月は、翌月 3 日 00:00 UTC より前なら month_not_published_yet。
 */
export function monthlyPublicationError(
  query: Extract<MonthlyUsageQuery, { ok: true }>,
  now: Date = new Date(),
): "month_not_closed" | "month_not_published_yet" | null {
  const match = MONTH_RE.exec(query.month);
  if (!match) return "month_not_closed";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const nowYear = now.getUTCFullYear();
  const nowMonth = now.getUTCMonth() + 1;
  if (year > nowYear || (year === nowYear && month >= nowMonth)) return "month_not_closed";
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const publishAt = Date.parse(`${String(nextYear).padStart(4, "0")}-${pad2(nextMonth)}-03T00:00:00.000Z`);
  if (!Number.isFinite(publishAt) || now.getTime() < publishAt) return "month_not_published_yet";
  return null;
}

export class MonthlyUsageRejected extends Error {
  readonly code: "month_not_closed" | "month_not_published_yet";

  constructor(code: "month_not_closed" | "month_not_published_yet") {
    super(code);
    this.name = "MonthlyUsageRejected";
    this.code = code;
  }
}

export function monthlyUsageErrorMessage(error: MonthlyUsageError): string {
  if (error === "chain_required") return USAGE_MONTHLY_CHAIN_MESSAGE;
  if (error === "chain_invalid") return USAGE_MONTHLY_CHAIN_INVALID_MESSAGE;
  if (error === "chain_unlisted") return USAGE_MONTHLY_CHAIN_UNLISTED_MESSAGE;
  if (error === "month_required") return USAGE_MONTHLY_MONTH_MESSAGE;
  if (error === "month_invalid") return USAGE_MONTHLY_MONTH_INVALID_MESSAGE;
  if (error === "month_not_closed") return USAGE_MONTHLY_MONTH_NOT_CLOSED_MESSAGE;
  return USAGE_MONTHLY_MONTH_NOT_PUBLISHED_YET_MESSAGE;
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
  owners: number | "<3";
  calls?: number;
};

export type MonthlyDecisionUsage = {
  chain: string;
  month: string;
  relations: MonthlyRelationUsage[];
};

const RELATION_ORDER: Record<string, number> = { self: 0, related: 1, external: 2, prezenti_grantee: 3 };

function asRelation(value: string | null): UsageRelation | null {
  return (USAGE_RELATIONS as readonly string[]).includes(value ?? "") ? (value as UsageRelation) : null;
}

type PublishedRow = { relation: string; owners: number | string; calls: number | string };

type AppDb = NonNullable<ReturnType<typeof getDb>>;

function publishRelations(stored: PublishedRow[]): MonthlyRelationUsage[] {
  const relations: MonthlyRelationUsage[] = [];
  for (const row of stored) {
    const owners = Number(row.owners);
    const calls = Number(row.calls);
    if (!Number.isFinite(owners) || owners <= 0) continue;
    const owner_relation = row.relation === "unclassified" ? null : asRelation(row.relation);
    if (row.relation !== "unclassified" && owner_relation === null) continue;
    const below = owners < PUBLIC_USAGE_MIN_OWNERS;
    // 未分類は、鍵を作った人が入れる。件数は人数にかかわらず出さない。
    if (owner_relation === null || below) {
      relations.push({ owner_relation, owners: below ? "<3" : owners });
      continue;
    }
    relations.push({ owner_relation, owners, calls });
  }
  relations.sort((a, b) => (RELATION_ORDER[a.owner_relation ?? ""] ?? 4) - (RELATION_ORDER[b.owner_relation ?? ""] ?? 4));
  return relations;
}

async function readPublished(db: AppDb, query: Extract<MonthlyUsageQuery, { ok: true }>): Promise<PublishedRow[]> {
  return rowsOf<PublishedRow>(
    await db.execute(sql`
      SELECT relation, owners, calls
      FROM decision_usage_monthly_published
      WHERE month = ${query.start}::date AND chain = ${query.chain}
    `),
  );
}

/**
 * 空の月も 5 区分（2026-10-28 に prezenti_grantee を足した）の 0 行を書いて固定する。あとから行が増えても、次の読み取りは再集計しない。
 * 0 人の区分は公開の配列に出さない。
 */
async function freezeMonthlyDecisionUsage(db: AppDb, query: Extract<MonthlyUsageQuery, { ok: true }>): Promise<void> {
  await db.execute(sql`
    INSERT INTO decision_usage_monthly_published (month, chain, relation, owners, calls)
    SELECT ${query.start}::date, ${query.chain}, bucket.relation,
           COALESCE(agg.owners, 0)::int,
           COALESCE(agg.calls, 0)::bigint
    FROM (VALUES ('self'::text), ('related'::text), ('external'::text), ('prezenti_grantee'::text), ('unclassified'::text)) AS bucket(relation)
    LEFT JOIN (
      SELECT CASE
               WHEN COALESCE(k.owner_relation, d.relation_snapshot) IN ('self', 'related', 'external', 'prezenti_grantee')
               THEN COALESCE(k.owner_relation, d.relation_snapshot)
               ELSE 'unclassified'
             END AS relation,
             count(DISTINCT COALESCE(k.user_id, d.owner_snapshot, k.id, d.api_key_id))::int AS owners,
             COALESCE(sum(d.count), 0)::bigint AS calls
      FROM decision_usage_daily d
      LEFT JOIN api_keys k ON k.id = d.api_key_id
      WHERE d.chain = ${query.chain}
        AND d.day >= ${query.start}::date
        AND d.day < ${query.end}::date
      GROUP BY 1
    ) AS agg ON agg.relation = bucket.relation
    ON CONFLICT (month, chain, relation) DO NOTHING
  `);
}

/**
 * 公開の月次表。鍵 id・ハッシュ・メール・名前は選ばない。
 * 固定済みの月は decision_usage_monthly_published だけを読む。
 */
export async function loadMonthlyDecisionUsage(
  query: Extract<MonthlyUsageQuery, { ok: true }>,
  now: Date = new Date(),
): Promise<MonthlyDecisionUsage> {
  const rejection = monthlyPublicationError(query, now);
  if (rejection) throw new MonthlyUsageRejected(rejection);
  const db = getDb();
  if (!db) throw new Error("database_unconfigured");
  const existing = await readPublished(db, query);
  if (existing.length === 0) await freezeMonthlyDecisionUsage(db, query);
  const stored = existing.length > 0 ? existing : await readPublished(db, query);
  return { chain: query.chain, month: query.month, relations: publishRelations(stored) };
}
