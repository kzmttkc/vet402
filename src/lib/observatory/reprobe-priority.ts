// どの階層の L0 実行でも、次に当たる出品を先頭に置く（D-01）。
//
// (a) 公開判定が fail で、最新プローブより後にカタログの宣言が変わった出品。
//     catalog-sync は毎回 last_seen_at を now() にするだけで、price_amount /
//     price_asset / pay_to / network / method の変更時刻は残さない。catalog-diff も
//     掲載の出入りと settle_drop だけ。だから「変わった時刻」は使えず、最新プローブ行に
//     残した比べた宣言（raw_response_meta.declared と method 列）と今のカタログの不一致で見る。
// (a') 旧規則の行に乗った公開 fail（needsRuleChangeReprobeSql）で、c1 の掲載窓（30 日）の外のもの。
//     最新行に declared が無くても入る。
// 優先は組をまたいで 1 登録ドメイン PRIORITY_PER_DOMAIN（5）件まで、全体 REPROBE_PRIORITY_LIMIT（50）件まで。
// (b) 7 日以内の異議のあと、まだプローブが無い出品。署名付きは disputes、
//     フォームは record_subscriptions（kind = dispute）。メールだけでは無い。
//     異議は (a)(a') が使わなかった枠だけを使う（異議を大量に出しても公開 fail の測り直しを押し出せない）。
//
// 同じ登録ドメインは同時 1 件、開始の間隔は旧規則の測り直しと同じ 1 秒
// （l0-rule-change-reprobe.ts の REPROBE_MIN_INTERVAL_MS）。
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { toCaip2 } from "./chains";
import { MIN_CONSECUTIVE_FAILS_TO_PUBLISH } from "./l0-probe";
import { needsRuleChangeReprobeSql } from "./l0-rule-change";
import { SETTLEMENT_WINDOW_DAYS } from "./coverage";
import { REPROBE_MIN_INTERVAL_MS } from "./l0-rule-change-reprobe";
import { notPathTemplateSql } from "./path-template";
import { registeredDomainOf } from "./registered-domain";
import {
  DISPUTE_PRIORITY_DAYS,
  PRIORITY_CLASS,
  PRIORITY_LEASE_NAME,
  PRIORITY_LEASE_TTL_SECONDS,
  PRIORITY_MIN_PROBE_AGE_MINUTES,
  ENDPOINT_LEASE_TTL_SECONDS,
  PRIORITY_MAX_PAGES,
  PRIORITY_PAGE_SIZE,
  PRIORITY_PER_DOMAIN,
  PRIORITY_REQUEST_TOTAL_MS,
  REPROBE_PRIORITY_LIMIT,
} from "./reprobe-priority-const";

export {
  ENDPOINT_LEASE_TTL_SECONDS,
  PRIORITY_REQUEST_TOTAL_MS,
  PRIORITY_PER_DOMAIN,
  DISPUTE_PRIORITY_DAYS,
  PRIORITY_CLASS,
  PRIORITY_LEASE_NAME,
  PRIORITY_LEASE_TTL_SECONDS,
  PRIORITY_MIN_PROBE_AGE_MINUTES,
  REPROBE_PRIORITY_LIMIT,
};

/** toCaip2 の `key === "..."` と同じ鍵。足すときは両方と tests/reprobe-priority.test.ts。 */
export const CAIP2_SLUG_KEYS = [
  "base",
  "base-sepolia",
  "polygon",
  "arc",
  "arc-testnet",
  "solana",
  "solana-mainnet",
  "solana-devnet",
  "xrpl",
  "xrpl:mainnet",
] as const;

/** 登録ドメインあたり、優先プローブの開始間隔。旧規則の測り直しの下限と同じ。 */
export const PRIORITY_DOMAIN_INTERVAL_MS = REPROBE_MIN_INTERVAL_MS;

export type PriorityCandidate = {
  id: string;
  resourceUrl: string;
  method: string | null;
  payTo: string | null;
  network: string | null;
  priceAmount: string | null;
  priceAsset: string | null;
  source: string | null;
  ruleChangeReprobe: boolean;
  /** PRIORITY_CLASS の値。 */
  priorityClass: number;
};

/** 出品 URL の登録ドメイン。読めない URL は文字列そのもの。 */
export function resourceRegisteredDomain(resourceUrl: string): string {
  try {
    return registeredDomainOf(new URL(resourceUrl).hostname);
  } catch {
    return registeredDomainOf(resourceUrl);
  }
}

/**
 * 最新プローブが比べた宣言と、今のカタログが違うか。
 * declared が無い行は価格・資産・受取先・網を推測しない（method 列だけ見る）。
 * 網は toCaip2 に寄せてから比べる（プローブは declared.network に CAIP-2 を書く）。
 * method 未宣言は GET で測るので、カタログの null とプローブの GET は違いではない。
 */
export function declarationDrifted(input: {
  probeMethod: string | null;
  declared: { amount?: unknown; asset?: unknown; payTo?: unknown; network?: unknown } | null;
  catalog: {
    method: string | null;
    priceAmount: string | null;
    priceAsset: string | null;
    payTo: string | null;
    network: string | null;
  };
}): boolean {
  const sent = (input.probeMethod ?? "").toUpperCase();
  // 空文字は未宣言。プローブは null を GET にする。SQL の nullif(..., '') と同じ。
  const catalogRaw = input.catalog.method;
  const catalogMethod = (catalogRaw === null || catalogRaw === "" ? "GET" : catalogRaw).toUpperCase();
  if (sent !== catalogMethod) return true;
  const declared = input.declared;
  if (declared === null) return false;
  if (textOrNull(declared.amount) !== input.catalog.priceAmount) return true;
  if (textOrNull(declared.asset) !== input.catalog.priceAsset) return true;
  if (textOrNull(declared.payTo) !== input.catalog.payTo) return true;
  if (toCaip2(textOrNull(declared.network)) !== toCaip2(input.catalog.network)) return true;
  return false;
}

/** 到達失敗の理由（l0-probe.ts の classifyNetworkError で fail になるもの）。この行は宣言を比べていない。 */
export const REACH_FAILURE_REASONS = ["dns", "timeout", "network"] as const;

export type ProbeRowForDrift = {
  verdict: string;
  method: string | null;
  failReason: string | null;
  rawResponseMeta: Record<string, unknown> | null;
};

/** 宣言を比べていない到達失敗の行か（declared が無い dns / timeout / network）。 */
export function isReachFailureRow(row: ProbeRowForDrift): boolean {
  const reach = (REACH_FAILURE_REASONS as readonly string[]).includes(row.failReason ?? "");
  const hasDeclared = row.rawResponseMeta !== null && Object.prototype.hasOwnProperty.call(row.rawResponseMeta, "declared");
  return reach && !hasDeclared;
}

/**
 * 組 0 の判定（純関数。reprobePrioritySql の cmp と同じ）。新しい順の行。
 * 公開判定が fail で、公開 fail を作っている新しい MIN 行のうち到達失敗でない一番新しい行の宣言が、
 * 今のカタログと違う。優先の測り直しが 1 回タイムアウトしても、その前の比べた行で判定し続ける。
 * MIN 行がどれも到達失敗なら、公開 fail は到達の話なので組 0 には入れない。
 */
export function publishedFailDrifted(
  newestFirst: readonly ProbeRowForDrift[],
  catalog: Parameters<typeof declarationDrifted>[0]["catalog"],
): boolean {
  const head = newestFirst.slice(0, MIN_CONSECUTIVE_FAILS_TO_PUBLISH);
  if (head.length < MIN_CONSECUTIVE_FAILS_TO_PUBLISH || head.some((r) => r.verdict !== "fail")) return false;
  const cmp = head.find((r) => !isReachFailureRow(r));
  if (!cmp) return false;
  const declared = cmp.rawResponseMeta?.declared;
  return declarationDrifted({
    probeMethod: cmp.method,
    declared: declared && typeof declared === "object" ? (declared as Record<string, unknown>) : null,
    catalog,
  });
}

function textOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : String(value);
}

function caip2Sql(value: SQL): SQL {
  const branches = CAIP2_SLUG_KEYS.map((key) => sql`WHEN ${key} THEN ${toCaip2(key)}`);
  return sql`(CASE lower(${value}) ${sql.join(branches, sql` `)} ELSE ${value} END)`;
}

/** 到達失敗の行（別名 r）。isReachFailureRow と同じ。 */
function reachFailureRowSql(r: string): SQL {
  const a = sql.raw(r);
  const reasons = sql.join(REACH_FAILURE_REASONS.map((x) => sql`${x}`), sql`, `);
  return sql`(${a}.fail_reason IN (${reasons}) AND NOT coalesce(${a}.raw_response_meta ? 'declared', false))`;
}

/**
 * 比べる行（別名 cmp）と出品 e の宣言が違う。declarationDrifted と同じ表。
 * cmp は公開 fail を作る新しい MIN 行のうち到達失敗でない一番新しい行（publishedFailDrifted と同じ）。
 */
function declarationDriftSql(): SQL {
  const declared = sql`cmp.raw_response_meta->'declared'`;
  const norm = (side: SQL) => sql`nullif(${caip2Sql(side)}, '')`;
  return sql`(cmp.probed_at IS NOT NULL AND (
    upper(cmp.method) IS DISTINCT FROM upper(coalesce(nullif(e.method, ''), 'GET'))
    OR (
      cmp.raw_response_meta ? 'declared'
      AND (
        (${declared}->>'amount') IS DISTINCT FROM e.price_amount
        OR (${declared}->>'asset') IS DISTINCT FROM e.price_asset
        OR (${declared}->>'payTo') IS DISTINCT FROM e.pay_to
        OR ${norm(sql`${declared}->>'network'`)} IS DISTINCT FROM ${norm(sql`e.network`)}
      )
    )
  ))`;
}

function disputeWindowSql(): SQL {
  return sql`created_at > now() - make_interval(days => ${DISPUTE_PRIORITY_DAYS})`;
}

/**
 * 最新プローブより後の、7 日以内の異議のうち一番古い時刻。無ければ NULL（= 待っていない）。
 * 同時刻（probed_at = created_at）は測り済みとする。別のメールで送り直しても一番古い時刻は動かない。
 */
function disputeAtSql(formTable: boolean): SQL {
  const signed = sql`SELECT created_at FROM disputes WHERE endpoint_id = e.id AND ${disputeWindowSql()}`;
  const union = formTable
    ? sql`${signed} UNION ALL SELECT created_at FROM record_subscriptions WHERE endpoint_id = e.id AND kind = 'dispute' AND ${disputeWindowSql()}`
    : signed;
  return sql`(SELECT min(u.created_at) FROM (${union}) u WHERE latest.probed_at IS NULL OR u.created_at > latest.probed_at)`;
}

/**
 * 優先候補。階層の WHERE は掛けない（c1 の 30 日窓の外が、この欠陥の本体）。
 * active かつパステンプレート以外。最新プローブが PRIORITY_MIN_PROBE_AGE_MINUTES より新しい出品は外す。
 * 並びは組（PRIORITY_CLASS）の順: 宣言ずれの公開 fail → 旧規則の公開 fail → 異議。
 * 異議は前の 2 組が使わなかった枠だけを使う。formTable が false のときは署名付き異議だけ
 * （record_subscriptions がまだ無い DB）。
 */
export function reprobePrioritySql(limit: number, formTable: boolean, offset = 0): SQL {
  const host = sql`lower(split_part(split_part(cand.resource_url, '://', 2), '/', 1))`;
  return sql`
    WITH cand AS (
      SELECT e.id, e.resource_url, e.method, e.pay_to, e.network, e.price_amount, e.price_asset, e.source,
             e.first_seen_at, rc.rule_change_reprobe, cls.priority_class,
             CASE WHEN cls.priority_class = ${PRIORITY_CLASS.dispute}::int THEN disp.dispute_at ELSE latest.probed_at END AS queue_at
      FROM x402_endpoints e
      LEFT JOIN LATERAL (
        SELECT p.probed_at, p.method, p.raw_response_meta
        FROM x402_l0_probes p
        WHERE p.endpoint_id = e.id
        ORDER BY p.probed_at DESC
        LIMIT 1
      ) latest ON true
      LEFT JOIN LATERAL (
        SELECT coalesce((count(*) = ${MIN_CONSECUTIVE_FAILS_TO_PUBLISH} AND bool_and(v.verdict = 'fail')), false) AS published_fail
        FROM (
          SELECT verdict FROM x402_l0_probes
          WHERE endpoint_id = e.id
          ORDER BY probed_at DESC
          LIMIT ${MIN_CONSECUTIVE_FAILS_TO_PUBLISH}
        ) v
      ) pub ON true
      LEFT JOIN LATERAL (
        SELECT r.probed_at, r.method, r.raw_response_meta
        FROM (
          SELECT q.probed_at, q.method, q.raw_response_meta, q.fail_reason
          FROM x402_l0_probes q
          WHERE q.endpoint_id = e.id
          ORDER BY q.probed_at DESC
          LIMIT ${MIN_CONSECUTIVE_FAILS_TO_PUBLISH}
        ) r
        WHERE NOT ${reachFailureRowSql("r")}
        ORDER BY r.probed_at DESC
        LIMIT 1
      ) cmp ON true
      LEFT JOIN LATERAL (
        SELECT ${needsRuleChangeReprobeSql("e")} AS rule_change_reprobe
      ) rc ON true
      LEFT JOIN LATERAL (
        SELECT ${disputeAtSql(formTable)} AS dispute_at
      ) disp ON true
      LEFT JOIN LATERAL (
        SELECT CASE
          WHEN pub.published_fail AND ${declarationDriftSql()} THEN ${PRIORITY_CLASS.declarationDrift}::int
          -- 旧規則の公開 fail のうち c1 の掲載窓の外だけ。窓の中は c1 の並び（l0OrderBy）が先頭に置く。
          WHEN rc.rule_change_reprobe
            AND NOT (e.last_seen_at > now() - make_interval(days => ${SETTLEMENT_WINDOW_DAYS})) THEN ${PRIORITY_CLASS.ruleChange}::int
          WHEN disp.dispute_at IS NOT NULL THEN ${PRIORITY_CLASS.dispute}::int
        END AS priority_class
      ) cls ON true
      WHERE e.status = 'active'
        AND ${notPathTemplateSql()}
        AND cls.priority_class IS NOT NULL
        AND (latest.probed_at IS NULL OR latest.probed_at < now() - make_interval(mins => ${PRIORITY_MIN_PROBE_AGE_MINUTES}))
    ), ranked AS (
      SELECT cand.*,
             row_number() OVER (
               PARTITION BY ${host}
               ORDER BY cand.priority_class ASC, cand.queue_at ASC NULLS FIRST, cand.first_seen_at ASC, cand.id ASC
             ) AS host_rank
      FROM cand
    )
    SELECT id, resource_url, method, pay_to, network, price_amount, price_asset, source, rule_change_reprobe, priority_class
    FROM ranked
    -- 組をまたいで 1 ホスト PRIORITY_PER_DOMAIN 件まで（1 ホストに旧規則の fail が 820 件ある）。
    -- 登録ドメイン単位の上限は selectReprobePriority が fillPriorityByDomain で掛け、落ちた分は次の頁で埋める。
    WHERE host_rank <= ${PRIORITY_PER_DOMAIN}
    ORDER BY priority_class ASC, queue_at ASC NULLS FIRST, first_seen_at ASC, id ASC
    LIMIT ${limit}
    OFFSET ${Math.max(0, Math.trunc(offset))}
  `;
}

function rowsOf(raw: unknown): Record<string, unknown>[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
}

function mapCandidate(r: Record<string, unknown>): PriorityCandidate {
  return {
    id: String(r.id),
    resourceUrl: String(r.resource_url),
    method: (r.method as string | null) ?? null,
    payTo: (r.pay_to as string | null) ?? null,
    network: (r.network as string | null) ?? null,
    priceAmount: (r.price_amount as string | null) ?? null,
    priceAsset: (r.price_asset as string | null) ?? null,
    source: (r.source as string | null) ?? null,
    ruleChangeReprobe: r.rule_change_reprobe === true,
    priorityClass: Number(r.priority_class),
  };
}

type Db = NonNullable<ReturnType<typeof getDb>>;

export async function selectReprobePriority(
  db: Db,
  limit: number,
  formTable: boolean,
  pageSize: number = PRIORITY_PAGE_SIZE,
): Promise<PriorityCandidate[]> {
  const cap = Math.min(Math.max(Math.trunc(limit) || 0, 0), REPROBE_PRIORITY_LIMIT);
  if (cap === 0) return [];
  // SQL はホスト単位で 5 件に切る。登録ドメイン単位の 5 件はここで切り、落ちた分は次の頁で埋める。
  return fillPriorityByDomain(
    async (offset, size) => rowsOf(await db.execute(reprobePrioritySql(size, formTable, offset))).map(mapCandidate),
    {
      perDomain: PRIORITY_PER_DOMAIN,
      limit: cap,
      pageSize: Math.max(1, Math.trunc(pageSize)),
      maxPages: PRIORITY_MAX_PAGES,
      domainOf: (c) => resourceRegisteredDomain(c.resourceUrl),
    },
  );
}

/**
 * 並び順の頁を読みながら、1 登録ドメイン perDomain 件・全体 limit 件まで詰める。
 * 頁が足りなくなったか、limit が埋まったか、maxPages を読んだら止める。
 */
export async function fillPriorityByDomain<T>(
  fetchPage: (offset: number, size: number) => Promise<T[]>,
  opts: { perDomain: number; limit: number; pageSize: number; maxPages: number; domainOf: (item: T) => string },
): Promise<T[]> {
  const counts = new Map<string, number>();
  const out: T[] = [];
  for (let page = 0; page < opts.maxPages && out.length < opts.limit; page++) {
    const rows = await fetchPage(page * opts.pageSize, opts.pageSize);
    for (const item of rows) {
      if (out.length >= opts.limit) break;
      const domain = opts.domainOf(item);
      const n = counts.get(domain) ?? 0;
      if (n >= opts.perDomain) continue;
      counts.set(domain, n + 1);
      out.push(item);
    }
    if (rows.length < opts.pageSize) break;
  }
  return out;
}

/** 同じ登録ドメインが並ばないよう、ドメインの中の順は保って交互に出す。 */
export function interleaveByDomain<T>(items: readonly T[], domainOf: (item: T) => string): T[] {
  const groups = new Map<string, T[]>();
  const order: string[] = [];
  for (const item of items) {
    const domain = domainOf(item);
    const group = groups.get(domain);
    if (group) group.push(item);
    else {
      groups.set(domain, [item]);
      order.push(domain);
    }
  }
  const out: T[] = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const domain of order) {
      const group = groups.get(domain);
      const next = group?.shift();
      if (next !== undefined) {
        out.push(next);
        progressed = true;
      }
    }
  }
  return out;
}

/**
 * 同じ登録ドメインは同時 1 件。開始間隔は intervalMs 以上。
 * 別ドメインは concurrency まで同時に出す。
 */
export async function runWithDomainInterval<T>(
  items: readonly T[],
  opts: {
    concurrency: number;
    intervalMs: number;
    domainOf: (item: T) => string;
    run: (item: T) => Promise<void>;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<void> {
  if (items.length === 0) return;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const concurrency = Math.max(1, Math.trunc(opts.concurrency) || 1);
  const intervalMs = Math.max(0, opts.intervalMs);
  const pending = items.slice();
  const inFlight = new Set<string>();
  const nextAt = new Map<string, number>();
  let active = 0;
  let wakeGen = 0;
  const pendingWaits: (() => void)[] = [];
  const wake = () => {
    wakeGen++;
    const all = pendingWaits.splice(0);
    for (const resolve of all) resolve();
  };
  const waitForWake = (seen: number) =>
    new Promise<void>((resolve) => {
      if (wakeGen !== seen) {
        resolve();
        return;
      }
      pendingWaits.push(resolve);
    });

  const claim = async (): Promise<{ item: T; domain: string } | null> => {
    for (;;) {
      if (pending.length === 0 && active === 0) return null;
      const n = now();
      let earliest = Number.POSITIVE_INFINITY;
      for (let i = 0; i < pending.length; i++) {
        const domain = opts.domainOf(pending[i] as T);
        if (inFlight.has(domain)) continue;
        const at = nextAt.get(domain) ?? 0;
        if (n >= at) {
          const item = pending.splice(i, 1)[0] as T;
          inFlight.add(domain);
          nextAt.set(domain, n + intervalMs);
          active++;
          return { item, domain };
        }
        if (at < earliest) earliest = at;
      }
      const seen = wakeGen;
      if (pending.length === 0 || earliest === Number.POSITIVE_INFINITY) {
        await waitForWake(seen);
        continue;
      }
      await Promise.race([sleep(Math.max(0, earliest - now())), waitForWake(seen)]);
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const claimed = await claim();
      if (!claimed) return;
      try {
        await opts.run(claimed.item);
      } finally {
        inFlight.delete(claimed.domain);
        active--;
        wake();
      }
    }
  });
  await Promise.all(workers);
}

/** 出品ごとのリースの名前（job_leases.name）。 */
export function endpointLeaseName(id: string): string {
  return `l0:endpoint:${id.toLowerCase()}`;
}

export type RequestGate =
  | { skip: true; reason: "started" | "busy" }
  | { skip: false; release: () => Promise<void> };

/**
 * 要求を出す直前の関門（直近行の確認より前の部分）。
 *   1. この実行ですでに始めた id は飛ばす（await の前に印を付けるので、並行の 2 本が同じ id を通さない）。
 *   2. claim（出品ごとのリース）が取れなければ飛ばす。別の実行が要求の途中でも止まる。
 * 通った id は release を持つ。呼び手は直近行の確認・要求・行の書き込みを 1 つの try/finally に入れ、
 * finally で release する（probe-runner.ts の probeOne）。
 */
export function makeRequestGuard(opts: {
  claim: (id: string) => Promise<(() => Promise<void>) | null>;
}): (id: string) => Promise<RequestGate> {
  const started = new Set<string>();
  return async (id: string) => {
    if (started.has(id)) return { skip: true, reason: "started" };
    started.add(id);
    const release = await opts.claim(id);
    if (!release) return { skip: true, reason: "busy" };
    return { skip: false, release };
  };
}

export const TOTAL_LIMIT_EXCEEDED: unique symbol = Symbol("total_limit_exceeded");

/** promise が ms 以内に終わらなければ TOTAL_LIMIT_EXCEEDED。promise 自体は止めない（呼び手が結果を捨てる）。 */
export async function withTotalLimit<T>(promise: Promise<T>, ms: number): Promise<T | typeof TOTAL_LIMIT_EXCEEDED> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<typeof TOTAL_LIMIT_EXCEEDED>((resolve) => {
    timer = setTimeout(() => resolve(TOTAL_LIMIT_EXCEEDED), Math.max(0, ms));
  });
  try {
    return await Promise.race([promise, limit]);
  } finally {
    clearTimeout(timer);
  }
}
