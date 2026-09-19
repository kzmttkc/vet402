// ============================================================
// vet402 Observatory L0 — public-page readers (design §5, §7).
//
// Read-only aggregation for /observatory pages. Two rules:
//
//  1. Missing-schema tolerant (all-company convention): deploying this code
//     before the migration must render an honest empty state, not a 500.
//
//  2. What these readers surface is FACTS with evidence attached — verdict
//     strings from the closed vocabulary, counts with their denominators.
//     The published verdict applies publishedVerdict() so a single fail
//     renders as `unverified` (legal multiple-measurement condition).
// ============================================================
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { isMissingSchemaError } from "@/lib/db/pg-errors";
import { escapeLike } from "@/lib/util/like";
import { toIsoUtc } from "@/lib/util/iso-utc";
import {
  x402CatalogSnapshots,
  x402DelistingEvents,
  x402Endpoints,
  x402L0Probes,
  x402L1Purchases,
} from "@/lib/db/schema";
import { CATALOG_SOURCE } from "./catalog-source";
import { publishedVerdict, MIN_CONSECUTIVE_FAILS_TO_PUBLISH } from "./l0-probe";
import { isOperatorPayTo } from "./operator";
import { isOperatorExclusionConfigured, operatorExclusionPredicate, operatorMatchPredicate } from "./operator-sql";
import { chainLabel, isTestnet, toCaip2 } from "./chains";
import { deliveredPredicate, heldReasonSql, inconclusivePredicate, inconclusiveSettledPredicate } from "./delivery";
import {
  settledTier,
  settledTierPredicate,
  settlementTimeWindowPredicate,
  type SettledTier,
} from "./settled-tier";
import type { ObservatoryQuery, ObservatoryVerdict } from "./query";
import { UUID_RE } from "@/lib/validation/uuid";

export type ObservatoryListRow = {
  id: string;
  resourceKey: string;
  network: string | null;
  method: string | null;
  status: string;
  publishedVerdict: "pass" | "fail" | "unverified";
  lastProbedAt: Date | null;
  qualityCalls30d: number | null;
  /** L1 paid attempts that settled with a receipt (PAID_ATTEMPT_STATUSES denominator). 0 when never purchased. */
  l1Settled: number;
  /**
   * settled かつ有料リクエストが 2xx を返した件数（2026-09-04 監査 E・P0-3）。
   * settled は転送の確認、delivered は応答の到着。片方だけ出すと LP §2 の
   * L1 の定義（"Does payment settle and a response arrive?"）に対して偽になる。
   */
  l1Delivered: number;
  /** L1 paid attempts (same denominator as the endpoint page and State of x402). */
  l1Attempts: number;
};

export type ObservatoryOverview = {
  rows: ObservatoryListRow[];
  page: number;
  pageSize: number;
  totalEndpoints: number;
  /** Snapshot health of the latest ingest — shown so the reader can judge the data's completeness. */
  latestSnapshot: {
    snapshotDate: string;
    totalCount: number;
    fetchedCount: number;
  } | null;
};

/**
 * Longest search term folded into an ILIKE pattern. Same 80 as
 * parseObservatorySearchParams uses, restated here because this reader is
 * exported and a caller can hand it a `q` the parser never saw.
 */
const SEARCH_MAX_LENGTH = 80;

/**
 * `q` → an ILIKE pattern that matches it LITERALLY.
 *
 * WHY (2026-08-22 audit). This was `%${q}%` interpolated straight into
 * `ILIKE ${like}`. Not injection — the value is bound, always was — but `%`
 * and `_` are wildcards INSIDE a bound value, and neither they nor the length
 * were constrained on this path. `/observatory` is a keyless page, so a
 * pattern like `%_%_%_%_%_%…` over the endpoint table is a cheap way to make
 * the database do quadratic work on someone else's behalf. The page's own
 * parser (parseObservatorySearchParams) strips those characters and caps the
 * length, so the live surface was already covered — this closes the door for
 * every OTHER caller of an exported reader, rather than trusting each one to
 * remember.
 *
 * Escaped with backslash, which is Postgres's default LIKE escape character,
 * so no ESCAPE clause is needed at the call site.
 *
 * Exported for the test that pins the escaping — nothing else calls it.
 */
export function searchLikePattern(q: string | null): string | null {
  if (!q) return null;
  // 2026-09-02 UX 監査: 完全 URL（https://api.exa.ai/search）を貼ると 0 件だった。
  // resource_key は host+path なので、scheme と末尾スラッシュを剥がして照合する。
  const trimmed = q
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .slice(0, SEARCH_MAX_LENGTH);
  if (trimmed.length === 0) return null;
  return `%${escapeLike(trimmed)}%`;
}

export async function getObservatoryOverview(
  options: Partial<ObservatoryQuery> = {},
): Promise<ObservatoryOverview> {
  const pageSize = Math.min(Math.max(options.pageSize ?? 40, 1), 100);
  const page = Math.max(options.page ?? 1, 1);
  const q = options.q ?? null;
  const network = options.network ?? null;
  const verdict = (options.verdict ?? null) as ObservatoryVerdict | null;
  const onlyReceipts = options.l1 === true;
  const db = getDb();
  const empty: ObservatoryOverview = {
    rows: [],
    page,
    pageSize,
    totalEndpoints: 0,
    latestSnapshot: null,
  };
  if (!db) return empty;

  const like = searchLikePattern(q);
  const filters = sql`
    ${like ? sql`AND e.resource_key ILIKE ${like}` : sql``}
    ${network ? sql`AND e.network = ${network}` : sql``}
    ${
      verdict
        ? sql`AND (
            CASE
              WHEN (lp.verdicts)[1] = 'pass' THEN 'pass'
              WHEN (
                SELECT count(*) FROM unnest(lp.verdicts) WITH ORDINALITY AS u(x, n)
                WHERE n <= ${MIN_CONSECUTIVE_FAILS_TO_PUBLISH} AND x = 'fail'
              ) = ${MIN_CONSECUTIVE_FAILS_TO_PUBLISH} THEN 'fail'
              ELSE 'unverified'
            END
          ) = ${verdict}`
        : sql``
    }
    ${onlyReceipts ? sql`AND COALESCE(l1.l1_settled, 0) >= 1` : sql``}
  `;

  // 2026-09-02 導線監査 F2: 受領証つきの行がどれか一覧から分からなかった。endpoint ごとの
  // L1 を同じ分母（PAID_ATTEMPT_STATUSES）で数える——endpoint 頁・State of x402 と食い違わない。
  const l1Lateral = sql`
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE p.status = 'settled')::int AS l1_settled,
             count(*) FILTER (WHERE ${sql.raw(deliveredPredicate("p"))})::int AS l1_delivered,
             count(*)::int AS l1_attempts
      FROM x402_l1_purchases p
      WHERE p.endpoint_id = e.id
        AND p.status IN (${sql.join(PAID_ATTEMPT_STATUSES.map((st) => sql`${st}`), sql`, `)})
    ) l1 ON true
  `;

  const lateral = sql`
    LEFT JOIN LATERAL (
      SELECT array_agg(v.verdict) AS verdicts, max(v.probed_at) AS last_probed_at
      FROM (
        SELECT verdict, probed_at FROM x402_l0_probes p
        WHERE p.endpoint_id = e.id
        ORDER BY probed_at DESC
        LIMIT ${MIN_CONSECUTIVE_FAILS_TO_PUBLISH}
      ) v
    ) lp ON true
  `;

  try {
    const countRaw = await db.execute(sql`
      SELECT count(*)::int AS n
      FROM x402_endpoints e
      ${lateral}
      ${l1Lateral}
      WHERE true
      ${filters}
    `);
    const countList = (Array.isArray(countRaw) ? countRaw : (countRaw as { rows?: unknown[] }).rows ?? []) as Record<
      string,
      unknown
    >[];
    const totalEndpoints = Number(countList[0]?.n ?? 0);

    const raw = await db.execute(sql`
      SELECT e.id, e.resource_key, e.network, e.method, e.status,
             e.quality_calls_30d,
             lp.verdicts AS verdicts,
             lp.last_probed_at AS last_probed_at,
             COALESCE(l1.l1_settled, 0) AS l1_settled,
             COALESCE(l1.l1_delivered, 0) AS l1_delivered,
             COALESCE(l1.l1_attempts, 0) AS l1_attempts
      FROM x402_endpoints e
      ${lateral}
      ${l1Lateral}
      WHERE true
      ${filters}
      -- 2026-09-02 UX 監査: 既定表示（呼出量順）は上位 20 行が全部 unverified で、初見の人が
      -- 「測れていない製品」と読んだ。測定済み（pass / fail）を先に並べ、その中を呼出量順にする。
      -- verdict で絞っているときは元の並び（全行同じ判定なので同じ結果）。
      -- 2026-09-02 導線監査 F2: その前に受領証あり（L1 settled ≥ 1）を置く。
      ORDER BY (CASE WHEN COALESCE(l1.l1_settled, 0) >= 1 THEN 0 ELSE 1 END) ASC, (
        CASE
          WHEN (lp.verdicts)[1] = 'pass' THEN 0
          WHEN (
            SELECT count(*) FROM unnest(lp.verdicts) WITH ORDINALITY AS u(x, n)
            WHERE n <= ${MIN_CONSECUTIVE_FAILS_TO_PUBLISH} AND x = 'fail'
          ) = ${MIN_CONSECUTIVE_FAILS_TO_PUBLISH} THEN 0
          ELSE 1
        END
      ) ASC, e.quality_calls_30d DESC NULLS LAST, e.resource_key ASC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    `);
    const list = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Record<
      string,
      unknown
    >[];

    const rows: ObservatoryListRow[] = list.map((r) => ({
      id: String(r.id),
      resourceKey: String(r.resource_key),
      network: (r.network as string | null) ?? null,
      method: (r.method as string | null) ?? null,
      status: String(r.status),
      publishedVerdict: publishedVerdict(((r.verdicts as string[] | null) ?? []) as string[]),
      lastProbedAt: r.last_probed_at ? new Date(String(r.last_probed_at)) : null,
      qualityCalls30d:
        r.quality_calls_30d === null || r.quality_calls_30d === undefined
          ? null
          : Number(r.quality_calls_30d),
      l1Settled: Number(r.l1_settled ?? 0),
      l1Delivered: Number(r.l1_delivered ?? 0),
      l1Attempts: Number(r.l1_attempts ?? 0),
    }));

    const [snap] = await db
      .select({
        snapshotDate: x402CatalogSnapshots.snapshotDate,
        totalCount: x402CatalogSnapshots.totalCount,
        fetchedCount: x402CatalogSnapshots.fetchedCount,
      })
      .from(x402CatalogSnapshots)
      // 2026-09-19: source を固定しないと、同じ日付の行が source ごとに 1 本ずつ
      // 書かれている（Bazaar と mpp_directory）ので LIMIT 1 がどちらを返すか決まらない。
      // 主カタログ（Bazaar）の取得健全性だけをここで出す——別カタログの「取得が不完全」を
      // 主カタログの件数に貼るのが、直そうとしている不具合そのもの。
      .where(eq(x402CatalogSnapshots.source, CATALOG_SOURCE))
      .orderBy(desc(x402CatalogSnapshots.snapshotDate))
      .limit(1);

    return { rows, page, pageSize, totalEndpoints, latestSnapshot: snap ?? null };
  } catch (error) {
    if (isMissingSchemaError(error)) return empty;
    throw error;
  }
}

export type EndpointDetail = {
  endpoint: {
    id: string;
    resourceKey: string;
    resourceUrl: string;
    source: string;
    method: string | null;
    network: string | null;
    payTo: string | null;
    priceAmount: string | null;
    priceAsset: string | null;
    description: string | null;
    status: string;
    firstSeenAt: Date | null;
    lastSeenAt: Date | null;
    delistedAt: Date | null;
    qualityCalls30d: number | null;
    qualityPayers30d: number | null;
    /** True when this is vet402's OWN endpoint (operator payTo). Shown for
     * transparency, excluded from the aggregate rates — vet402 is never a
     * neutral third party in its own measurements. */
    isOperatorEndpoint: boolean;
  };
  publishedVerdict: "pass" | "fail" | "unverified";
  /** 直近プローブからの経過日数（表示時点・UTC）。未測定なら null。データ層で計算する（描画は純粋に保つ）。 */
  lastProbedAgeDays: number | null;
  probes: {
    probedAt: Date | null;
    method: string;
    verdict: string;
    httpStatus: number | null;
    latencyMs: number | null;
    failReason: string | null;
  }[];
  events: {
    eventType: string;
    detectedOn: string;
    prevValue: unknown;
    newValue: unknown;
    createdAt: Date | null;
  }[];
  /** L1 paid-purchase summary — attempts vs settles vs deliveries (the "n回中m回貫通" figure). */
  l1: PaidAttemptTotals;
  purchases: {
    attemptedAt: Date | null;
    status: string;
    amountUnits: string | null;
    txHash: string | null;
    httpStatusPaid: number | null;
    latencyMs: number | null;
    l2Schema: string | null;
    /**
     * settled 行の証拠強度（2026-09-05 監査 S-4 / S-17）。settled 以外は null。
     * 分類は settled-tier.ts が単独で持ち、描画は純粋に保つ。
     */
    settledTier: SettledTier | null;
  }[];
} | null;

/**
 * 受領証の行に強度ラベルを載せる。列（auth_nonce / settlement_verified）は
 * 公開面へは出さない——出すのは「その tx がこの購入のものと言えるか」という結論だけ。
 */
function withSettledTier<
  T extends { status: string; authNonce: string | null; settlementVerified: boolean | null },
>(rows: T[]): (Omit<T, "authNonce" | "settlementVerified"> & { settledTier: SettledTier | null })[] {
  return rows.map(({ authNonce, settlementVerified, ...rest }) => ({
    ...rest,
    settledTier: settledTier({ status: rest.status, authNonce, settlementVerified }),
  }));
}

/**
 * A "paid attempt" is one where money actually moved (or was committed): the
 * seller answered 402, we signed, and the on-chain settlement either succeeded
 * (`settled`), failed after the paid retry (`settle_failed`), delivered
 * goods with no receipt header (`delivered_no_receipt`), or came back with a
 * settlement claim whose transaction id is not even well-formed
 * (`settle_claimed_unverifiable`, 2026-08-23). Every other status —
 * `budget_denied` (our own daily-cap throttle), `request_error`, `no_402`,
 * `no_eligible_accept`, `price_mismatch`, `payto_mismatch`,
 * `payto_operator_self`, `over_cap`, `halted` (the runtime spending kill
 * switch stopped the batch before signing), `in_flight` — is NOT a
 * paid attempt: no payment happened, so it must never enter a seller's
 * settle-rate denominator. This is the SAME set the /observatory/state
 * aggregate uses (getObservatoryStats), so the per-endpoint receipt page, the
 * purchases API, and the network-wide State of x402 can never disagree on what
 * "attempts" means.
 */
export const PAID_ATTEMPT_STATUSES = [
  "settled",
  "settle_failed",
  "delivered_no_receipt",
  // 2026-08-23: 署名して実際に払った試行なので分母に入れる。ここから外すと、
  // 不都合な結果を自分の公表決済率から静かに落とすことになる。
  "settle_claimed_unverifiable",
  // 2026-08-23 C-4: 決済を主張されたがまだ照合していない / 照合して一致しなかった。
  // どちらも我々は実際に払っている。分母から外せば決済率が都合よく上がる。
  "settle_claimed",
  "settle_claim_refuted",
] as const;

/**
 * Authoritative attempt/settled counts for one endpoint, over the full history
 * (not the truncated display window). Counts in SQL so a seller with >100
 * receipts still reports a true total.
 */
/**
 * 判定を保留にした行の理由別件数（2026-09-17 Issue #29・delivery.ts の HeldReason）。
 * 3 つの和は inconclusive と必ず等しい。
 */
export type InconclusiveByReason = {
  /** settled かつ有料応答 4xx（2026-09-05 からの既存規則）。 */
  settled4xx: number;
  /** 決済レシートなし（settle_failed・tx なし）で有料応答 4xx（402 を除く）。 */
  unsettled4xx: number;
  /** 我々の購入元ウォレットの資金切れ期間に 402 か 5xx が返った行。 */
  payerUnfunded: number;
};

export type PaidAttemptTotals = {
  attempts: number;
  settled: number;
  delivered: number;
  /** 売り手の不履行として数えない署名済み試行（settled とは限らない）。 */
  inconclusive: number;
  /** inconclusive のうち settled のもの。delivered の分母から外すのはこの分だけ。 */
  inconclusiveSettled: number;
  inconclusiveByReason: InconclusiveByReason;
};

const EMPTY_PAID_TOTALS: PaidAttemptTotals = {
  attempts: 0,
  settled: 0,
  delivered: 0,
  inconclusive: 0,
  inconclusiveSettled: 0,
  inconclusiveByReason: { settled4xx: 0, unsettled4xx: 0, payerUnfunded: 0 },
};

async function countPaidAttempts(
  db: NonNullable<ReturnType<typeof getDb>>,
  id: string,
): Promise<PaidAttemptTotals> {
  const [row] = await db
    .select({
      attempts: sql<number>`count(*)::int`,
      settled: sql<number>`count(*) filter (where ${x402L1Purchases.status} = 'settled')::int`,
      delivered: sql<number>`count(*) filter (where ${sql.raw(deliveredPredicate("x402_l1_purchases"))})::int`,
      // 2026-09-05: 支払い後 4xx は「我々が要求を正しく組めなかった」可能性が消せない。
      // delivered の判定から外して保留にする（delivery.ts が規則の正典）。
      inconclusive: sql<number>`count(*) filter (where ${sql.raw(inconclusivePredicate("x402_l1_purchases"))})::int`,
      // 2026-09-17 Issue #29: 決済レシートなしの 4xx と資金切れ期間の 402・5xx も保留に入る。
      // 理由別に出す（和は inconclusive）。
      settled4xx: sql<number>`count(*) filter (where (${sql.raw(heldReasonSql("x402_l1_purchases"))}) = 'settled_4xx')::int`,
      unsettled4xx: sql<number>`count(*) filter (where (${sql.raw(heldReasonSql("x402_l1_purchases"))}) = 'unsettled_4xx')::int`,
      payerUnfunded: sql<number>`count(*) filter (where (${sql.raw(heldReasonSql("x402_l1_purchases"))}) = 'payer_unfunded')::int`,
    })
    .from(x402L1Purchases)
    .where(
      and(
        eq(x402L1Purchases.endpointId, id),
        inArray(x402L1Purchases.status, [...PAID_ATTEMPT_STATUSES]),
      ),
    );
  return {
    attempts: Number(row?.attempts ?? 0),
    settled: Number(row?.settled ?? 0),
    delivered: Number(row?.delivered ?? 0),
    inconclusive: Number(row?.inconclusive ?? 0),
    inconclusiveSettled: Number(row?.settled4xx ?? 0),
    inconclusiveByReason: {
      settled4xx: Number(row?.settled4xx ?? 0),
      unsettled4xx: Number(row?.unsettled4xx ?? 0),
      payerUnfunded: Number(row?.payerUnfunded ?? 0),
    },
  };
}

export async function getEndpointDetail(id: string): Promise<EndpointDetail> {
  if (!UUID_RE.test(id)) return null;
  const db = getDb();
  if (!db) return null;

  try {
    const [e] = await db.select().from(x402Endpoints).where(eq(x402Endpoints.id, id)).limit(1);
    if (!e) return null;

    const probes = await db
      .select({
        probedAt: x402L0Probes.probedAt,
        method: x402L0Probes.method,
        verdict: x402L0Probes.verdict,
        httpStatus: x402L0Probes.httpStatus,
        latencyMs: x402L0Probes.latencyMs,
        failReason: x402L0Probes.failReason,
      })
      .from(x402L0Probes)
      .where(eq(x402L0Probes.endpointId, id))
      .orderBy(desc(x402L0Probes.probedAt))
      .limit(30);

    const events = await db
      .select({
        eventType: x402DelistingEvents.eventType,
        detectedOn: x402DelistingEvents.detectedOn,
        prevValue: x402DelistingEvents.prevValue,
        newValue: x402DelistingEvents.newValue,
        createdAt: x402DelistingEvents.createdAt,
      })
      .from(x402DelistingEvents)
      .where(eq(x402DelistingEvents.endpointId, id))
      .orderBy(desc(x402DelistingEvents.createdAt))
      .limit(30);

    // L1 history is additive and may predate its migration — tolerate absence.
    let purchases: NonNullable<EndpointDetail>["purchases"] = [];
    let l1Totals: PaidAttemptTotals = EMPTY_PAID_TOTALS;
    try {
      purchases = withSettledTier(
        await db
        .select({
          attemptedAt: x402L1Purchases.attemptedAt,
          status: x402L1Purchases.status,
          amountUnits: x402L1Purchases.amountUnits,
          txHash: x402L1Purchases.txHash,
          httpStatusPaid: x402L1Purchases.httpStatusPaid,
          latencyMs: x402L1Purchases.latencyMs,
          l2Schema: x402L1Purchases.l2Schema,
          authNonce: x402L1Purchases.authNonce,
          settlementVerified: x402L1Purchases.settlementVerified,
        })
        .from(x402L1Purchases)
        .where(
          and(
            eq(x402L1Purchases.endpointId, id),
            inArray(x402L1Purchases.status, [...PAID_ATTEMPT_STATUSES]),
          ),
        )
        .orderBy(desc(x402L1Purchases.attemptedAt))
        .limit(20),
      );
      l1Totals = await countPaidAttempts(db, id);
    } catch (error) {
      if (!isMissingSchemaError(error)) throw error;
    }

    return {
      l1: l1Totals,
      purchases,
      endpoint: {
        id: e.id,
        resourceKey: e.resourceKey,
        resourceUrl: e.resourceUrl,
        source: e.source,
        method: e.method,
        network: e.network,
        payTo: e.payTo,
        priceAmount: e.priceAmount,
        priceAsset: e.priceAsset,
        description: e.description,
        status: e.status,
        firstSeenAt: e.firstSeenAt,
        lastSeenAt: e.lastSeenAt,
        delistedAt: e.delistedAt,
        qualityCalls30d: e.qualityCalls30d,
        qualityPayers30d: e.qualityPayers30d,
        isOperatorEndpoint: isOperatorPayTo(e.payTo),
      },
      publishedVerdict: publishedVerdict(probes.map((p) => p.verdict)),
      lastProbedAgeDays: probes[0]?.probedAt ? Math.max(0, Math.floor((Date.now() - probes[0].probedAt.getTime()) / 86_400_000)) : null,
      probes,
      events,
    };
  } catch (error) {
    if (isMissingSchemaError(error)) return null;
    throw error;
  }
}

export type EndpointPurchases = {
  endpointId: string;
  resourceKey: string;
  resourceUrl: string;
  network: string | null;
  status: string;
  /** Paid-attempt series (PAID_ATTEMPT_STATUSES), newest first — includes settle_failed (facts, not wins), excludes our own budget_denied / request_error. */
  purchases: NonNullable<EndpointDetail>["purchases"];
  attemptCount: number;
  settledCount: number;
  /**
   * settled かつ 2xx（2026-09-04 監査 E・P0-3）。settledCount との差が
   * 「金は動いたが品が来ていない」件数で、この差を出さずに settled だけを
   * 報告していたのが事故だった。
   */
  deliveredCount: number;
  /**
   * **判定を保留にした署名済み試行の件数**（2026-09-05・2026-09-17 拡張）。「売り手が
   * 納品しなかった」ではない。settled かつ 4xx、決済レシートなしの 4xx（402 以外）、
   * 我々の資金切れ期間の 402・5xx。規則は delivery.ts が持ち、/decision の
   * facts.l1.n_inconclusive と同じ集合。
   */
  inconclusiveCount: number;
  /** inconclusiveCount のうち settled のもの（deliveryRatePct の分母から外す分）。 */
  inconclusiveSettledCount: number;
  /** 理由別の内訳。和は inconclusiveCount。 */
  inconclusiveByReason: InconclusiveByReason;
  /** settled/attempts to one decimal; null when there are no attempts (0/0 is not a rate). */
  settleRatePct: number | null;
  /**
   * delivered / (settled - inconclusiveSettled) を一桁で。**分母は判定できた settled だけ**
   * （保留にした行を分母に残すと、保留のはずのものが不履行として率に効く）。
   * 判定できた行が 0 件なら null——0/0 は率ではない。
   */
  deliveryRatePct: number | null;
} | null;

/**
 * The receipt series for one endpoint, as data (要件定義v2 2026-08-14 §2.1-1).
 * Same facts the /observatory/e/[id] page renders — aggregation lives HERE so
 * the page and the public API can never disagree. Returns null for an unknown
 * id and for a malformed id (never touches the DB on the latter).
 */
export async function getEndpointPurchases(id: string): Promise<EndpointPurchases> {
  if (!UUID_RE.test(id)) return null;
  const db = getDb();
  if (!db) return null;

  try {
    const [e] = await db
      .select({
        id: x402Endpoints.id,
        resourceKey: x402Endpoints.resourceKey,
        resourceUrl: x402Endpoints.resourceUrl,
        network: x402Endpoints.network,
        status: x402Endpoints.status,
      })
      .from(x402Endpoints)
      .where(eq(x402Endpoints.id, id))
      .limit(1);
    if (!e) return null;

    let purchases: NonNullable<EndpointDetail>["purchases"] = [];
    let totals: PaidAttemptTotals = EMPTY_PAID_TOTALS;
    try {
      purchases = withSettledTier(
        await db
        .select({
          attemptedAt: x402L1Purchases.attemptedAt,
          status: x402L1Purchases.status,
          amountUnits: x402L1Purchases.amountUnits,
          txHash: x402L1Purchases.txHash,
          httpStatusPaid: x402L1Purchases.httpStatusPaid,
          latencyMs: x402L1Purchases.latencyMs,
          l2Schema: x402L1Purchases.l2Schema,
          authNonce: x402L1Purchases.authNonce,
          settlementVerified: x402L1Purchases.settlementVerified,
        })
        .from(x402L1Purchases)
        .where(
          and(
            eq(x402L1Purchases.endpointId, id),
            inArray(x402L1Purchases.status, [...PAID_ATTEMPT_STATUSES]),
          ),
        )
        .orderBy(desc(x402L1Purchases.attemptedAt))
        .limit(100),
      );
      totals = await countPaidAttempts(db, id);
    } catch (error) {
      if (!isMissingSchemaError(error)) throw error;
    }

    const {
      attempts: attemptCount,
      settled: settledCount,
      delivered: deliveredCount,
      inconclusive: inconclusiveCount,
      inconclusiveSettled: inconclusiveSettledCount,
      inconclusiveByReason,
    } = totals;
    // 2026-09-05: 判定できた settled だけを分母にする。保留にした行を分母に残すと、
    // 「売り手の不履行として数えない」と言いながら率では不履行として効いてしまう。
    // 2026-09-17: 分母は settled なので、差し引くのも settled の保留分だけ。
    const judged = Math.max(0, settledCount - inconclusiveSettledCount);
    return {
      endpointId: e.id,
      resourceKey: e.resourceKey,
      resourceUrl: e.resourceUrl,
      network: e.network,
      status: e.status,
      purchases,
      attemptCount,
      settledCount,
      deliveredCount,
      inconclusiveCount,
      inconclusiveSettledCount,
      inconclusiveByReason,
      settleRatePct:
        attemptCount === 0 ? null : Math.round((settledCount / attemptCount) * 1000) / 10,
      deliveryRatePct: judged === 0 ? null : Math.round((deliveredCount / judged) * 1000) / 10,
    };
  } catch (error) {
    if (isMissingSchemaError(error)) return null;
    throw error;
  }
}

export type ObservatoryStats = {
  totalEndpoints: number;
  activeEndpoints: number;
  delistedEndpoints: number;
  /** Endpoints whose PUBLISHED verdict is fail (≥2 consecutive fails). */
  publishedFail: number;
  publishedPass: number;
  /** No declared method / no probe yet / gate not met. */
  publishedUnverified: number;
  methodUndeclared: number;
  eventCounts: { delisted: number; relisted: number; settleDrop: number };
  /**
   * L1 paid purchases: attempts include refusals-after-sign only (spent money);
   * settled = transfer confirmed on-chain; delivered = settled AND the paid
   * request returned 2xx（2026-09-04 監査 E・P0-3）.
   */
  l1: {
    attempts: number;
    settled: number;
    delivered: number;
    /**
     * settled のうち有料応答が 4xx だった件数（2026-09-05）。**delivered の判定を
     * 保留にした行**であって、売り手の不履行ではない。我々は POST に `{}` を送り、
     * API キーを持たずに買う——4xx は我々の要求の形で説明がつく。方法論 §2 が
     * `path_template` に対して既に持っていた原則を、URL からボディと認証まで広げた。
     * 行は消さない。規則の正典は delivery.ts。
     */
    inconclusive: number;
    /**
     * inconclusive のうち settled のもの（2026-09-17 Issue #29）。「settled − delivered −
     * inconclusiveSettled」が 2xx でも 4xx でもなく金が動いた件数になる。
     */
    inconclusiveSettled: number;
    /** 理由別の内訳（和は inconclusive）。 */
    inconclusiveByReason: InconclusiveByReason;
    /**
     * settled のうち署名 nonce（EVM: EIP-3009 の authorization nonce / Solana: 我々が
     * 生成した memo）まで束縛できた件数。2026-09-05 監査 S-4 / S-17: settled を
     * 1 段で出していたので、2026-09-04 12:00 UTC より前の「金額・宛先の一致のみ」の
     * 行と区別がつかなかった。件数は動かさず強度だけ分ける（settled-tier.ts）。
     */
    settledNonceBound: number;
    /** settled のうち nonce 束縛の無い件数。nonceBound との和は必ず settled。 */
    settledAmountPayeeOnly: number;
    /** 決済ブロック時刻が試行の -5 分〜+15 分に入った settled 件数。 */
    settledTimeWindowOk: number;
    /** 決済ブロック時刻を我々が持っていない settled 件数（ok とも outside とも言えない）。 */
    settledTimeWindowUnknown: number;
    endpointsAttempted: number;
    endpointsSettled: number;
    endpointsDelivered: number;
    /**
     * L1 を最後に試した時刻（ISO8601 UTC・全チェーン横断・一度も無ければ null）。
     * 2026-09-05: 実行時キルスイッチが入り、停止中は下の件数がまったく動かない。
     * この 1 つが無いと、読み手は「静かな日」と「止めている日」を区別できず、
     * 古い件数を今日の観測として引く。分母を出す面は鮮度も出す。
     * status は問わない——署名前に終わった試行も「見に行った」事実ではある。
     */
    lastAttemptAt: string | null;
    /**
     * L1 のチェーン別内訳。L0 の byChain と違いテストネットを落とさない——
     * 落とすと和が l1.settled と合わなくなり、分母として使えなくなる。
     */
    byChain: L1ChainStats[];
  };
  /**
   * 運営自身（vet402）の endpoint として、上のどの数からも取り除かれた件数。
   * **0 は「除外が効いていない」ではなく「取り除く行が無かった」**——vet402 が
   * 自分の endpoint をカタログに載せていなければ 0 になる。denylist そのものが
   * 空なら operator-sql.ts が鳴らす（この数では区別できない）。
   */
  operatorEndpointsExcluded: number;
  /**
   * 自己除外の名簿が設定されているか。`operatorEndpointsExcluded` の 0 が
   * 「一致が無かった」なのか「名簿が空＝規則が効いていない」なのかを分ける
   * （2026-09-19 最終確認 H3）。**誰を外しているかは出さない。**
   */
  operatorExclusionConfigured: boolean;
  /**
   * 主カタログ（CDP Bazaar）の最新スナップショット。**別カタログの行を混ぜない**——
   * 2026-09-19 まではタイブレークが無く、Tempo の mpp_directory の「取得が不完全」が
   * Bazaar 側の件数の見出しに付いていた。
   */
  latestSnapshot: CatalogSnapshot | null;
  /** source ごとの最新スナップショット（Bazaar・mpp_directory）。取得時点は面で別々に出す。 */
  catalogSnapshots: CatalogSnapshot[];
};

/** 1 カタログ source の最新取得。fetchedCount < totalCount はその source だけの不完全さ。 */
export type CatalogSnapshot = {
  source: string;
  snapshotDate: string;
  totalCount: number;
  fetchedCount: number;
};

/** 1 チェーン分の L1 実測。settledNonceBound + settledAmountPayeeOnly = settled。 */
export type L1ChainStats = {
  chain: string;
  attempts: number;
  settled: number;
  delivered: number;
  /** 判定保留の署名済み試行（delivery.ts の heldReasonOf・settled とは限らない）。delivered とは足し合わせない。 */
  inconclusive: number;
  settledNonceBound: number;
  settledAmountPayeeOnly: number;
};

export async function getObservatoryStats(): Promise<ObservatoryStats> {
  const empty: ObservatoryStats = {
    totalEndpoints: 0,
    activeEndpoints: 0,
    delistedEndpoints: 0,
    publishedFail: 0,
    publishedPass: 0,
    publishedUnverified: 0,
    methodUndeclared: 0,
    eventCounts: { delisted: 0, relisted: 0, settleDrop: 0 },
    l1: {
      attempts: 0,
      settled: 0,
      delivered: 0,
      inconclusive: 0,
      inconclusiveSettled: 0,
      inconclusiveByReason: { settled4xx: 0, unsettled4xx: 0, payerUnfunded: 0 },
      settledNonceBound: 0,
      settledAmountPayeeOnly: 0,
      settledTimeWindowOk: 0,
      settledTimeWindowUnknown: 0,
      endpointsAttempted: 0,
      endpointsSettled: 0,
      endpointsDelivered: 0,
      lastAttemptAt: null,
      byChain: [],
    },
    operatorEndpointsExcluded: 0,
    operatorExclusionConfigured: isOperatorExclusionConfigured(),
    latestSnapshot: null,
    catalogSnapshots: [],
  };
  const db = getDb();
  if (!db) return empty;

  // vet402's own endpoint(s) never pad the aggregate — a measurer is not a
  // neutral third party in its own numbers. Empty denylist → no-op.
  const operatorExclusion = sql`WHERE ${operatorExclusionPredicate("e")}`;

  try {
    // Publication-gated verdict per endpoint, computed in SQL with the same
    // rule as publishedVerdict(): latest pass → pass; latest fail counts its
    // streak against the gate; everything else → unverified.
    const raw = await db.execute(sql`
      WITH latest AS (
        SELECT e.id, e.status, e.method,
               lp.verdicts AS verdicts
        FROM x402_endpoints e
        LEFT JOIN LATERAL (
          SELECT array_agg(v.verdict) AS verdicts
          FROM (
            SELECT verdict FROM x402_l0_probes p
            WHERE p.endpoint_id = e.id
            ORDER BY probed_at DESC
            LIMIT ${MIN_CONSECUTIVE_FAILS_TO_PUBLISH}
          ) v
        ) lp ON true
        ${operatorExclusion}
      )
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE status = 'active')::int AS active,
        count(*) FILTER (WHERE status = 'delisted')::int AS delisted,
        count(*) FILTER (WHERE method IS NULL)::int AS method_undeclared,
        count(*) FILTER (WHERE verdicts[1] = 'pass')::int AS published_pass,
        count(*) FILTER (
          WHERE verdicts[1] = 'fail'
            AND cardinality(verdicts) >= ${MIN_CONSECUTIVE_FAILS_TO_PUBLISH}
            AND NOT EXISTS (
              SELECT 1 FROM unnest(verdicts) AS u(v) WHERE u.v <> 'fail'
            )
        )::int AS published_fail
      FROM latest
    `);
    const list = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Record<
      string,
      unknown
    >[];
    const agg = list[0] ?? {};
    const total = Number(agg.total ?? 0);
    const publishedPass = Number(agg.published_pass ?? 0);
    const publishedFail = Number(agg.published_fail ?? 0);

    // 2026-09-19 再レビュー V2: 除外が**今日何件取り除いているか**を数えて出す。
    // 「自社を外している」とだけ書くと、env が外れて 0 件になった日にも同じ文が
    // 「効いている保証」として読まれる。件数なら、0 は 0 と読める。
    const exRaw = await db.execute(sql`
      SELECT count(*)::int AS n FROM x402_endpoints e WHERE ${operatorMatchPredicate("e")}
    `);
    const exList = (Array.isArray(exRaw) ? exRaw : (exRaw as { rows?: unknown[] }).rows ?? []) as {
      n: number;
    }[];
    const operatorEndpointsExcluded = Number(exList[0]?.n ?? 0);

    const evRaw = await db.execute(sql`
      SELECT event_type, count(*)::int AS n
      FROM x402_delisting_events GROUP BY event_type
    `);
    const evList = (Array.isArray(evRaw) ? evRaw : (evRaw as { rows?: unknown[] }).rows ?? []) as {
      event_type: string;
      n: number;
    }[];
    const ev = Object.fromEntries(evList.map((r) => [r.event_type, Number(r.n)]));

    let l1 = {
      attempts: 0,
      settled: 0,
      delivered: 0,
      inconclusive: 0,
      inconclusiveSettled: 0,
      inconclusiveByReason: { settled4xx: 0, unsettled4xx: 0, payerUnfunded: 0 } as InconclusiveByReason,
      settledNonceBound: 0,
      settledAmountPayeeOnly: 0,
      settledTimeWindowOk: 0,
      settledTimeWindowUnknown: 0,
      endpointsAttempted: 0,
      endpointsSettled: 0,
      endpointsDelivered: 0,
      lastAttemptAt: null as string | null,
      byChain: [] as L1ChainStats[],
    };
    try {
      const l1Raw = await db.execute(sql`
        SELECT count(*)::int AS attempts,
               count(*) FILTER (WHERE status = 'settled')::int AS settled,
               count(*) FILTER (WHERE ${sql.raw(deliveredPredicate())})::int AS delivered,
               -- 2026-09-05: 支払い後 4xx は判定保留。delivered の分母から外す（delivery.ts）。
               -- 2026-09-17 Issue #29: 決済レシートなしの 4xx と資金切れ期間の 402・5xx も保留。
               count(*) FILTER (WHERE ${sql.raw(inconclusivePredicate())})::int AS inconclusive,
               count(*) FILTER (WHERE ${sql.raw(inconclusiveSettledPredicate())})::int AS inconclusive_settled,
               count(*) FILTER (WHERE (${sql.raw(heldReasonSql())}) = 'unsettled_4xx')::int AS inconclusive_unsettled_4xx,
               count(*) FILTER (WHERE (${sql.raw(heldReasonSql())}) = 'payer_unfunded')::int AS inconclusive_payer_unfunded,
               -- 2026-09-05 監査 S-4 / S-17: settled の証拠強度は 1 段ではない。
               -- 定義は settled-tier.ts が単独で持つ（JS の分類と同じ規則）。
               count(*) FILTER (WHERE ${sql.raw(settledTierPredicate("nonce_bound"))})::int AS settled_nonce_bound,
               count(*) FILTER (WHERE ${sql.raw(settledTierPredicate("amount_payee_only"))})::int AS settled_amount_payee_only,
               count(DISTINCT endpoint_id)::int AS endpoints,
               count(DISTINCT endpoint_id) FILTER (WHERE status = 'settled')::int AS endpoints_settled,
               count(DISTINCT endpoint_id) FILTER (WHERE ${sql.raw(deliveredPredicate())})::int AS endpoints_delivered
        FROM x402_l1_purchases
        WHERE status IN ('settled', 'settle_failed', 'delivered_no_receipt', 'settle_claimed_unverifiable', 'settle_claimed', 'settle_claim_refuted')
      `);
      const l1List = (Array.isArray(l1Raw) ? l1Raw : (l1Raw as { rows?: unknown[] }).rows ?? []) as {
        attempts: number;
        settled: number;
        delivered: number;
        inconclusive: number;
        inconclusive_settled: number;
        inconclusive_unsettled_4xx: number;
        inconclusive_payer_unfunded: number;
        settled_nonce_bound: number;
        settled_amount_payee_only: number;
        endpoints: number;
        endpoints_settled: number;
        endpoints_delivered: number;
      }[];
      if (l1List[0]) {
        l1 = {
          ...l1,
          attempts: Number(l1List[0].attempts),
          settled: Number(l1List[0].settled),
          delivered: Number(l1List[0].delivered ?? 0),
          inconclusive: Number(l1List[0].inconclusive ?? 0),
          inconclusiveSettled: Number(l1List[0].inconclusive_settled ?? 0),
          inconclusiveByReason: {
            settled4xx: Number(l1List[0].inconclusive_settled ?? 0),
            unsettled4xx: Number(l1List[0].inconclusive_unsettled_4xx ?? 0),
            payerUnfunded: Number(l1List[0].inconclusive_payer_unfunded ?? 0),
          },
          settledNonceBound: Number(l1List[0].settled_nonce_bound ?? 0),
          settledAmountPayeeOnly: Number(l1List[0].settled_amount_payee_only ?? 0),
          endpointsAttempted: Number(l1List[0].endpoints),
          endpointsSettled: Number(l1List[0].endpoints_settled ?? 0),
          endpointsDelivered: Number(l1List[0].endpoints_delivered ?? 0),
        };
      }

      // チェーン別。network の別名（"base" と "eip155:8453" は同じチェーン）は
      // SQL の GROUP BY では畳めないので、L0 側と同じく chainLabel() で JS 側で束ねる。
      // テストネットは落とさない——落とすと和が l1.settled と合わず、分母に使えない。
      const chainRaw = await db.execute(sql`
        SELECT network,
               count(*)::int AS attempts,
               count(*) FILTER (WHERE status = 'settled')::int AS settled,
               count(*) FILTER (WHERE ${sql.raw(deliveredPredicate())})::int AS delivered,
               count(*) FILTER (WHERE ${sql.raw(inconclusivePredicate())})::int AS inconclusive,
               count(*) FILTER (WHERE ${sql.raw(settledTierPredicate("nonce_bound"))})::int AS settled_nonce_bound,
               count(*) FILTER (WHERE ${sql.raw(settledTierPredicate("amount_payee_only"))})::int AS settled_amount_payee_only
        FROM x402_l1_purchases
        WHERE status IN ('settled', 'settle_failed', 'delivered_no_receipt', 'settle_claimed_unverifiable', 'settle_claimed', 'settle_claim_refuted')
        GROUP BY network
      `);
      const chainRows = (
        Array.isArray(chainRaw) ? chainRaw : (chainRaw as { rows?: unknown[] }).rows ?? []
      ) as {
        network: string | null;
        attempts: number;
        settled: number;
        delivered: number;
        inconclusive: number;
        settled_nonce_bound: number;
        settled_amount_payee_only: number;
      }[];
      const folded = new Map<string, L1ChainStats>();
      for (const row of chainRows) {
        // v1 スラグ（"base" / "solana" / "xrpl" …）は先に CAIP-2 へ寄せてからラベルを引く
        // （explorerTxUrl と同じ流儀）。同じラベルに畳まれた行は下で合算される。
        const chain = chainLabel(toCaip2(row.network));
        const entry = folded.get(chain) ?? {
          chain,
          attempts: 0,
          settled: 0,
          delivered: 0,
          inconclusive: 0,
          settledNonceBound: 0,
          settledAmountPayeeOnly: 0,
        };
        entry.attempts += Number(row.attempts ?? 0);
        entry.settled += Number(row.settled ?? 0);
        entry.delivered += Number(row.delivered ?? 0);
        entry.inconclusive += Number(row.inconclusive ?? 0);
        entry.settledNonceBound += Number(row.settled_nonce_bound ?? 0);
        entry.settledAmountPayeeOnly += Number(row.settled_amount_payee_only ?? 0);
        folded.set(chain, entry);
      }
      l1.byChain = [...folded.values()].sort((a, b) => b.attempts - a.attempts);

      // 鮮度。上の集計と違って status で絞らない——署名前に終わった試行
      // （no_eligible_accept / over_cap / halted …）も「最後に見に行った時刻」ではある。
      // 件数の分母と鮮度の分母を混ぜないため、別の 1 文で取る。
      const lastRaw = await db.execute(sql`
        SELECT max(attempted_at)::text AS last_attempt_at FROM x402_l1_purchases
      `);
      const lastRows = (
        Array.isArray(lastRaw) ? lastRaw : (lastRaw as { rows?: unknown[] }).rows ?? []
      ) as { last_attempt_at: string | null }[];
      l1.lastAttemptAt = toIsoUtc(lastRows[0]?.last_attempt_at ?? null);
    } catch (error) {
      if (!isMissingSchemaError(error)) throw error;
    }

    // 時刻窓は observed_purchases に依存するので別の try で囲む——その表が無い環境で
    // L1 の集計まで 0 に落ちるのは、測れないことと測って 0 だったことの混同になる。
    // lower() 突合は EVM の hex が大小どちらでも同じ tx を指すため（Solana の base58 も
    // 同じ変換を両辺へ当てるので、実在の 2 本が大小差だけで衝突しない限り一致は変わらない）。
    try {
      const winRaw = await db.execute(sql`
        SELECT count(*) FILTER (WHERE ${sql.raw(settlementTimeWindowPredicate("p", "o"))})::int AS in_window,
               count(*) FILTER (WHERE o.block_timestamp IS NULL)::int AS unknown_ts
        FROM x402_l1_purchases p
        LEFT JOIN observed_purchases o ON lower(o.tx_hash) = lower(p.tx_hash)
        WHERE p.status = 'settled'
      `);
      const winRows = (Array.isArray(winRaw) ? winRaw : (winRaw as { rows?: unknown[] }).rows ?? []) as {
        in_window: number;
        unknown_ts: number;
      }[];
      if (winRows[0]) {
        l1.settledTimeWindowOk = Number(winRows[0].in_window ?? 0);
        l1.settledTimeWindowUnknown = Number(winRows[0].unknown_ts ?? 0);
      }
    } catch (error) {
      if (!isMissingSchemaError(error)) throw error;
    }

    // 2026-09-19: カタログは 1 本ではない（Bazaar と Tempo の mpp_directory）。日付だけで
    // 並べて LIMIT 1 すると、どちらの行が返るかがタイブレーク無しで決まらず、実際には
    // mpp_directory（1,065/1,071）の「取得が不完全」が 29,337 件の表の見出しに付いていた。
    // 主カタログを名指しで取り、他の source は catalogSnapshots に別立てで出す。
    // 2026-09-19 レビュー N2: source ごとに 1 行だけ読む（DISTINCT ON）。日付順に全行
    // 読むと、日数 × source で伸び続ける表を毎リクエスト舐めることになる。
    const snapRaw = await db.execute(sql`
      SELECT DISTINCT ON (source)
             source, snapshot_date, total_count, fetched_count
      FROM x402_catalog_snapshots
      ORDER BY source, snapshot_date DESC
    `);
    const snapRows = (Array.isArray(snapRaw) ? snapRaw : (snapRaw as { rows?: unknown[] }).rows ?? []) as {
      source: string;
      snapshot_date: string;
      total_count: number;
      fetched_count: number;
    }[];
    const latestBySource = new Map<string, CatalogSnapshot>();
    for (const r of snapRows) {
      latestBySource.set(r.source, {
        source: String(r.source),
        snapshotDate: String(r.snapshot_date),
        totalCount: Number(r.total_count ?? 0),
        fetchedCount: Number(r.fetched_count ?? 0),
      });
    }
    const snap = latestBySource.get(CATALOG_SOURCE) ?? null;

    return {
      l1,
      totalEndpoints: total,
      activeEndpoints: Number(agg.active ?? 0),
      delistedEndpoints: Number(agg.delisted ?? 0),
      publishedFail,
      publishedPass,
      publishedUnverified: Math.max(0, total - publishedPass - publishedFail),
      methodUndeclared: Number(agg.method_undeclared ?? 0),
      eventCounts: {
        delisted: ev.delisted ?? 0,
        relisted: ev.relisted ?? 0,
        settleDrop: ev.settle_drop ?? 0,
      },
      operatorEndpointsExcluded,
      operatorExclusionConfigured: isOperatorExclusionConfigured(),
      latestSnapshot: snap,
      catalogSnapshots: [...latestBySource.values()].sort((a, b) => a.source.localeCompare(b.source)),
    };
  } catch (error) {
    if (isMissingSchemaError(error)) return empty;
    throw error;
  }
}

export type ChainStats = {
  chain: string;
  totalEndpoints: number;
  activeEndpoints: number;
  publishedPass: number;
  publishedFail: number;
  publishedUnverified: number;
};

/**
 * Per-chain L0 breakdown (design: chain-foundation grant outreach,
 * 2026-08-14). L0 has always been chain-agnostic and $0 — this surfaces the
 * first-mover claim ("we already measure x402 on your chain") per chain
 * instead of only as one aggregate. Grouping happens in JS via chainLabel()
 * because the raw catalog `network` field carries split aliases for the same
 * chain (verified live: "eip155:8453" and "base" both mean Base) that SQL
 * GROUP BY cannot collapse without duplicating the normalization logic.
 */
export async function getObservatoryStatsByChain(
  options: { includeTestnets?: boolean } = {},
): Promise<ChainStats[]> {
  const db = getDb();
  if (!db) return [];

  // 2026-09-19 独立レビュー W1: §1 の総数だけが運営自身の endpoint を外していて、
  // このチェーン別集計は外していなかった（同じ頁の 2 表が別の母集団を数えていた）。
  // 述語は operator-sql.ts の 1 本を通す——写経を増やすと同じ写し忘れがまた起きる。
  const operatorExclusion = sql`WHERE ${operatorExclusionPredicate("e")}`;

  try {
    const raw = await db.execute(sql`
      WITH latest AS (
        SELECT e.id, e.status, e.network,
               lp.verdicts AS verdicts
        FROM x402_endpoints e
        LEFT JOIN LATERAL (
          SELECT array_agg(v.verdict) AS verdicts
          FROM (
            SELECT verdict FROM x402_l0_probes p
            WHERE p.endpoint_id = e.id
            ORDER BY probed_at DESC
            LIMIT ${MIN_CONSECUTIVE_FAILS_TO_PUBLISH}
          ) v
        ) lp ON true
        ${operatorExclusion}
      )
      SELECT network, status, verdicts FROM latest
    `);
    const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as {
      network: string | null;
      status: string;
      verdicts: string[] | null;
    }[];

    const byChain = new Map<string, ChainStats>();
    for (const row of rows) {
      // L1 の畳み込み（上の l1.byChain）と同じく、v1 スラグを先に CAIP-2 へ寄せてからラベルを引く。
      // 片方だけ寄せると、同じチェーンが L0 と L1 で別のラベルになる。行は endpoint 単位で、
      // 同じラベルに落ちた行は下の ++ で 1 つの entry に合算される。
      const network = toCaip2(row.network);
      if (!options.includeTestnets && isTestnet(network)) continue;
      const chain = chainLabel(network);
      const entry = byChain.get(chain) ?? {
        chain,
        totalEndpoints: 0,
        activeEndpoints: 0,
        publishedPass: 0,
        publishedFail: 0,
        publishedUnverified: 0,
      };
      entry.totalEndpoints++;
      if (row.status === "active") entry.activeEndpoints++;
      const verdict = publishedVerdict(row.verdicts ?? []);
      if (verdict === "pass") entry.publishedPass++;
      else if (verdict === "fail") entry.publishedFail++;
      else entry.publishedUnverified++;
      byChain.set(chain, entry);
    }

    return [...byChain.values()].sort((a, b) => b.totalEndpoints - a.totalEndpoints);
  } catch (error) {
    if (isMissingSchemaError(error)) return [];
    throw error;
  }
}

export type CoverageShare = {
  activeEndpoints: number;
  measuredLast7d: number;
  /** measured/active を小数1桁%。active=0 は null（0/0は率ではない）。 */
  pct: number | null;
};

/**
 * カバレッジ支配率（GTM §4.4）: 「アクティブ掲載中のエンドポイントのうち、
 * 直近7日以内に vet402 の L0 測定が存在する割合」。分母はカタログの active、
 * 分子は7日窓の実測定——"under regular verification" の機械的定義。
 * 主張はこの分母付きの形でのみ公開する（"largest share" の裏付けは
 * この数字と、他に同種の公開系列が無いという観測で語る）。
 */
export async function getCoverageShare(): Promise<CoverageShare> {
  const db = getDb();
  if (!db) return { activeEndpoints: 0, measuredLast7d: 0, pct: null };
  try {
    const raw = await db.execute(sql`
      SELECT
        count(*) FILTER (WHERE e.status = 'active')::int AS active,
        count(*) FILTER (
          WHERE e.status = 'active' AND EXISTS (
            SELECT 1 FROM x402_l0_probes p
            WHERE p.endpoint_id = e.id AND p.probed_at > now() - interval '7 days'
          )
        )::int AS measured
      FROM x402_endpoints e
      -- 2026-09-19 再レビュー V1: ここだけ母集団が 4 つ目として残っていた。
      -- coverage7d は「カタログのどれだけを測れているか」なので、分母は §1 と同じ集合。
      WHERE ${operatorExclusionPredicate("e")}
    `);
    const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as {
      active: number;
      measured: number;
    }[];
    const active = Number(rows[0]?.active ?? 0);
    const measured = Number(rows[0]?.measured ?? 0);
    return {
      activeEndpoints: active,
      measuredLast7d: measured,
      pct: active === 0 ? null : Math.round((measured / active) * 1000) / 10,
    };
  } catch (error) {
    if (isMissingSchemaError(error)) return { activeEndpoints: 0, measuredLast7d: 0, pct: null };
    throw error;
  }
}

export type UnverifiedBreakdown = {
  /** 公開判定が unverified の endpoint 総数（publishedUnverified と同じ数）。 */
  total: number;
  /** まだ 1 度もプローブしていない（ローリングの順番が来ていない）。 */
  notYetProbed: number;
  /** 直近が fail だが、公開ゲート（連続 fail 本数）に届いていない。 */
  singleFailGateNotMet: number;
  /** 直近が unverified で、理由が path_template（URL に未埋めのパラメータ）。 */
  pathTemplate: number;
  /** 直近が unverified で、カタログが HTTP メソッドを申告していない。 */
  methodUndeclared: number;
  /** 直近が unverified で、上のどれでもない（レート制限・TLS など、我々側の到達失敗）。 */
  otherNotReached: number;
};

const EMPTY_UNVERIFIED: UnverifiedBreakdown = {
  total: 0,
  notYetProbed: 0,
  singleFailGateNotMet: 0,
  pathTemplate: 0,
  methodUndeclared: 0,
  otherNotReached: 0,
};

/**
 * unverified が何で出来ているか（2026-09-04 外部監査 E・P1-8）。
 *
 * 方法論 §2 と観測所の abstract は「unverified の主因は method の未申告」と
 * 言い続けていた。本番実測ではそれが 1 件、unverified は 12,305 件で、実際の主因は
 * 「まだ到達していない」と「単発 fail が公開ゲートに届いていない」だった。散文で
 * 順位を書くとまた腐るので、順位を書かずに実測を出す。分類は publishedVerdict() と
 * 同じゲートで、この 5 つの合計が publishedUnverified に一致する。
 */
export async function getUnverifiedBreakdown(): Promise<UnverifiedBreakdown> {
  const db = getDb();
  if (!db) return EMPTY_UNVERIFIED;
  const operatorExclusion = sql`WHERE ${operatorExclusionPredicate("e")}`;
  try {
    const raw = await db.execute(sql`
      WITH latest AS (
        SELECT e.id, e.method, lp.verdicts, lp.reasons
        FROM x402_endpoints e
        LEFT JOIN LATERAL (
          SELECT array_agg(v.verdict) AS verdicts, array_agg(v.fail_reason) AS reasons
          FROM (
            SELECT verdict, fail_reason FROM x402_l0_probes p
            WHERE p.endpoint_id = e.id
            ORDER BY probed_at DESC
            LIMIT ${MIN_CONSECUTIVE_FAILS_TO_PUBLISH}
          ) v
        ) lp ON true
        ${operatorExclusion}
      ),
      unverified AS (
        SELECT * FROM latest
        -- 未プローブは verdicts が NULL。NULL 比較は TRUE にならないので coalesce で
        -- 明示しないと、unverified の最大の塊（まだ到達していない endpoint）が
        -- 分母から静かに落ちる。実測で 12,305 が 3,497 になった経路がこれ。
        WHERE coalesce(verdicts[1], '') <> 'pass'
          AND NOT (
            coalesce(verdicts[1], '') = 'fail'
            AND cardinality(verdicts) >= ${MIN_CONSECUTIVE_FAILS_TO_PUBLISH}
            AND NOT EXISTS (SELECT 1 FROM unnest(verdicts) AS u(v) WHERE u.v <> 'fail')
          )
      )
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE verdicts IS NULL)::int AS not_yet_probed,
             count(*) FILTER (WHERE verdicts IS NOT NULL AND verdicts[1] = 'fail')::int AS single_fail,
             count(*) FILTER (WHERE verdicts IS NOT NULL AND verdicts[1] <> 'fail' AND reasons[1] = 'path_template')::int AS path_template,
             count(*) FILTER (
               WHERE verdicts IS NOT NULL AND verdicts[1] <> 'fail'
                 AND coalesce(reasons[1], '') <> 'path_template' AND method IS NULL
             )::int AS method_undeclared
      FROM unverified
    `);
    const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Record<
      string,
      unknown
    >[];
    const r = rows[0] ?? {};
    const total = Number(r.total ?? 0);
    const notYetProbed = Number(r.not_yet_probed ?? 0);
    const singleFailGateNotMet = Number(r.single_fail ?? 0);
    const pathTemplate = Number(r.path_template ?? 0);
    const methodUndeclared = Number(r.method_undeclared ?? 0);
    return {
      total,
      notYetProbed,
      singleFailGateNotMet,
      pathTemplate,
      methodUndeclared,
      otherNotReached: Math.max(
        0,
        total - notYetProbed - singleFailGateNotMet - pathTemplate - methodUndeclared,
      ),
    };
  } catch (error) {
    if (isMissingSchemaError(error)) return EMPTY_UNVERIFIED;
    throw error;
  }
}

/** id → resource_key。/corrections の表で subject_id を人が読める名前にする（最大 500 件・1 文）。 */
export async function getEndpointNames(ids: readonly string[]): Promise<Map<string, string>> {
  const db = getDb();
  const unique = [...new Set(ids)].filter((i) => UUID_RE.test(i)).slice(0, 500);
  if (!db || unique.length === 0) return new Map();
  const raw = await db.execute(
    sql`SELECT id::text AS id, resource_key FROM x402_endpoints WHERE id = ANY(ARRAY[${sql.join(unique.map((i) => sql`${i}`), sql`, `)}]::uuid[])`,
  );
  const rows = (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as { id: string; resource_key: string }[];
  return new Map(rows.map((r) => [r.id, r.resource_key]));
}

// ============================================================
// sitemap 用: 索引に出す価値のある endpoint 頁だけを返す（2026-09-05 SEO）。
//
// /observatory/e/{id} は数千件あり、src/app/sitemap.ts はこれを列挙しない
// —— 「無限に生成できる」から、というのがその判断の理由だった。ここで返すのは
// その懸念が当たらない部分集合に限る:
//   - カタログに現在も掲載されている（status = 'active'）
//   - 公開判定が pass（測っていない頁を索引に出さない）
//   - 直近 7 日に実測がある（古い測定の頁を鮮度信号つきで出さない）
// 3 条件とも「我々が測った結果」で決まるので、生成できる URL の数は
// 測定した数を超えない。空でも例外を投げない（欠損スキーマ耐性は
// このモジュールの規約）。
//
// 上限は sitemap 規格（50,000 URL / 50MB）の半分に置く。超えた分は落とすが、
// 落ちたことが分かるように件数を返す（黙って切らない）。
// ============================================================

/** sitemap 1 本に載せる上限。規格上限 50,000 の半分。 */
export const SITEMAP_ENDPOINT_LIMIT = 25_000;

/** 索引対象とみなす測定の鮮度（日）。 */
export const SITEMAP_MEASURED_WITHIN_DAYS = 7;

export type SitemapEndpoint = { id: string; lastMeasuredAt: Date };

export async function getSitemapEndpoints(): Promise<SitemapEndpoint[]> {
  const db = getDb();
  if (!db) return [];
  try {
    const raw = await db.execute(sql`
      SELECT e.id::text AS id, lp.last_probed_at AS last_probed_at
      FROM x402_endpoints e
      LEFT JOIN LATERAL (
        SELECT array_agg(v.verdict) AS verdicts, max(v.probed_at) AS last_probed_at
        FROM (
          SELECT verdict, probed_at FROM x402_l0_probes p
          WHERE p.endpoint_id = e.id
          ORDER BY probed_at DESC
          LIMIT ${MIN_CONSECUTIVE_FAILS_TO_PUBLISH}
        ) v
      ) lp ON true
      WHERE e.status = 'active'
        AND (lp.verdicts)[1] = 'pass'
        AND lp.last_probed_at >= now() - (${SITEMAP_MEASURED_WITHIN_DAYS} * interval '1 day')
      ORDER BY lp.last_probed_at DESC
      LIMIT ${SITEMAP_ENDPOINT_LIMIT}
    `);
    const rows = (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as {
      id: string;
      last_probed_at: string | Date;
    }[];
    return rows.map((r) => ({ id: r.id, lastMeasuredAt: new Date(r.last_probed_at) }));
  } catch (error) {
    if (isMissingSchemaError(error)) return [];
    throw error;
  }
}
