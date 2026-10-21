// ============================================================
// vet402 Observatory L0 — rolling probe runner (design §4).
//
// Hobby crons fire once a day, and 15k probes don't fit one invocation —
// so each run takes the N endpoints whose last probe is OLDEST (never-probed
// first) and the fleet cycles through the catalog over a few days. Daily
// delisting detection doesn't depend on this: catalog-sync covers presence
// every day; the probe answers "does the payment wall actually stand".
// ============================================================
import { sql } from "drizzle-orm";
import { payeeId } from "@/lib/ids/canonical";
import { getDb } from "@/lib/db/client";
import { isMissingSchemaError } from "@/lib/db/pg-errors";
import { x402L0Probes } from "@/lib/db/schema";
import { probeEndpoint, type ProbeResult } from "./l0-probe";
import { invalidateDecisionCache } from "@/lib/decision/cache";
import { withDailyFallback } from "@/lib/settlements/rollup";
import { l0OrderBy, l0TierWhere } from "./coverage";
import { insertRuleChangeReprobe, needsRuleChangeReprobe, needsRuleChangeReprobeSql, readNewestProbeRows } from "./l0-rule-change";
import { acquireLeaseFailClosed } from "@/lib/cron/lease-fail-closed";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import {
  PRIORITY_DOMAIN_INTERVAL_MS,
  PRIORITY_LEASE_NAME,
  PRIORITY_LEASE_TTL_SECONDS,
  REPROBE_PRIORITY_LIMIT,
  interleaveByDomain,
  PRIORITY_MIN_PROBE_AGE_MINUTES,
  ENDPOINT_LEASE_TTL_SECONDS,
  PRIORITY_REQUEST_TOTAL_MS,
  TOTAL_LIMIT_EXCEEDED,
  endpointLeaseName,
  makeRequestGuard,
  resourceRegisteredDomain,
  withTotalLimit,
  runWithDomainInterval,
  selectReprobePriority,
} from "./reprobe-priority";

export type ProbeBatchSummary = {
  probed: number;
  pass: number;
  fail: number;
  unverified: number;
  /** 旧規則の公開 fail を測り直した件数と、そのうち公開判定が変わって訂正ログに残した件数（2026-09-29）。 */
  ruleChangeReprobed: number;
  ruleChangeCorrected: number;
  /** 要求の直前に飛ばした件数（この実行で始め済み、または直近 60 分にプローブ行がある）。 */
  skippedRecent: number;
  /** 出品ごとのリースを別の実行が持っていた（または取れたと確かめられなかった）ので飛ばした件数。 */
  skippedBusy: number;
  /** 優先の段で、本文まで含めた合計の上限を超えて結果を書かずに打ち切った件数。 */
  priorityAbandoned: number;
  /** 1 件の中の例外（直近行の SELECT・要求・書き込み）で、その件だけ飛ばした件数。ログに残す。 */
  itemErrors: number;
};

type Candidate = {
  id: string;
  resourceUrl: string;
  method: string | null;
  payTo: string | null;
  network: string | null;
  priceAmount: string | null;
  priceAsset: string | null;
  source: string | null;
  /** 見出しの fail が旧規則のプローブ行に乗っている（l0-rule-change.ts）。測り直しで公開判定が変われば訂正ログへ。 */
  ruleChangeReprobe: boolean;
};

export async function runL0ProbeBatch(
  options: {
    limit?: number;
    concurrency?: number;
    fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
    timeoutMs?: number;
    /**
     * §7.4 カバレッジ階層（2026-09-02）。c1 = 30 日以内に listed/決済のある active、
     * c2 = 決済帰属あり ∨ 問い合わせ多（6 時間周期・5 時間以内に測った行は飛ばす）。
     * all = 従来どおり active 全件（テスト・手動用）。
     */
    tier?: "c1" | "c2" | "all";
    /** 優先の段の 1 件あたりの合計の上限（ミリ秒）。既定は PRIORITY_REQUEST_TOTAL_MS。テストが短くする。 */
    priorityRequestLimitMs?: number;
  } = {},
): Promise<ProbeBatchSummary> {
  const {
    limit = 500,
    concurrency = 20,
    fetchImpl,
    timeoutMs,
    tier = "all",
    priorityRequestLimitMs = PRIORITY_REQUEST_TOTAL_MS,
  } = options;
  const where = (daily: boolean) => (tier === "all" ? sql`e.status = 'active'` : l0TierWhere(tier, daily));
  const freshness = tier === "c2" ? sql`AND (lp.last_probed_at IS NULL OR lp.last_probed_at < now() - interval '5 hours')` : sql``;
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL is not configured");

  // D-01: 階層の外でも、宣言が変わった公開 fail・旧規則の公開 fail・7 日以内の異議で未測定の出品を
  // 先頭に置く。1 回の上限は REPROBE_PRIORITY_LIMIT。異議は公開 fail が使わなかった枠だけ。
  // 残りの枠は下の並びのまま。record_subscriptions が無い DB では署名付き異議だけを見る。
  // 優先分はリース（PRIORITY_LEASE_NAME）を取れたと確かめられた実行だけが測る（acquireLeaseFailClosed）。
  // c1 と c2 が重なっても同じ優先出品を 2 本の実行が同時に測らない。保持中でも取得の例外でも、
  // 優先分は飛ばして普通の列だけ流す。
  let priority: Candidate[] = [];
  const priorityCap = Math.min(REPROBE_PRIORITY_LIMIT, limit);
  const priorityLease = priorityCap > 0 ? await acquireLeaseFailClosed(PRIORITY_LEASE_NAME, PRIORITY_LEASE_TTL_SECONDS) : null;
  let releasePriority: () => Promise<void> = async () => {};
  if (priorityLease?.acquired) {
    releasePriority = priorityLease.release;
    try {
      priority = await selectReprobePriority(db, priorityCap, true);
    } catch (error) {
      if (!isMissingSchemaError(error)) {
        await releasePriority();
        throw error;
      }
      try {
        priority = await selectReprobePriority(db, priorityCap, false);
      } catch (error2) {
        if (!isMissingSchemaError(error2)) {
          await releasePriority();
          throw error2;
        }
      }
    }
  }
  const restLimit = Math.max(0, limit - priority.length);
  // 直近 PRIORITY_MIN_PROBE_AGE_MINUTES 分に測った出品は、普通の列でも次の回へ回す（優先の選定と同じ線）。
  // 重なった別の実行（c1 と c2）が同じ出品を続けて測り、短い fail を 2 行書いて公開 fail にしないため。
  // cron の階層（c1・c2）だけに掛ける。all は手動とテスト用で、続けて 2 回測る使い方がある。
  const recentlyProbed =
    tier === "all"
      ? sql``
      : sql`AND (lp.last_probed_at IS NULL OR lp.last_probed_at < now() - make_interval(mins => ${PRIORITY_MIN_PROBE_AGE_MINUTES}))`;
  const excludePriority =
    priority.length === 0
      ? sql``
      : sql`AND NOT (e.id = ANY(${sql`ARRAY[${sql.join(
          priority.map((c) => sql`${c.id}`),
          sql`, `,
        )}]::uuid[]`}))`;

  // Order: see l0OrderBy — c1 puts single-probe fails first (so the published
  // verdict can be settled), then never-probed, then oldest-probed; c2/all are
  // oldest-probed-first (never-probed before that).
  // 2026-09-29 監査 6 周目: 旧規則の公開 fail（lp.rule_change_reprobe）。c1 はこれを先頭に並べ、
  // どの階層でも、これを測り直して公開判定が変われば訂正ログに残す（insertRuleChangeReprobe）。
  let candidates: Candidate[] = [];
  try {
    if (restLimit === 0) {
      candidates = [];
    } else {
    // 候補 SQL は settlement_daily を読む（30 日窓が生行の保持期間へ縮まないため）。
    // 表がまだ無い環境では生行だけの式へ落とす（withDailyFallback）。
    const candidatesSql = (daily: boolean) => sql`
      SELECT e.id, e.resource_url, e.method, e.pay_to, e.network,
             e.price_amount, e.price_asset, e.source, lp.rule_change_reprobe
      FROM x402_endpoints e
      LEFT JOIN LATERAL (
        SELECT max(p.probed_at) AS last_probed_at,
               count(*)::int AS probe_count,
               (SELECT p2.verdict FROM x402_l0_probes p2 WHERE p2.endpoint_id = e.id
                  ORDER BY p2.probed_at DESC LIMIT 1) AS last_verdict,
               ${needsRuleChangeReprobeSql("e")} AS rule_change_reprobe
        FROM x402_l0_probes p WHERE p.endpoint_id = e.id
      ) lp ON true
      WHERE ${where(daily)}
      ${freshness}
      ${recentlyProbed}
      ${excludePriority}
      ORDER BY ${l0OrderBy(tier)}
      LIMIT ${restLimit}
    `;
    const rows = await withDailyFallback(
      async () => await db.execute(candidatesSql(true)),
      async () => await db.execute(candidatesSql(false)),
    );
    const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
    candidates = (list as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      resourceUrl: String(r.resource_url),
      method: (r.method as string | null) ?? null,
      payTo: (r.pay_to as string | null) ?? null,
      network: (r.network as string | null) ?? null,
      priceAmount: (r.price_amount as string | null) ?? null,
      priceAsset: (r.price_asset as string | null) ?? null,
      source: (r.source as string | null) ?? null,
      ruleChangeReprobe: r.rule_change_reprobe === true,
    }));
    }
  } catch (error) {
    await releasePriority();
    if (isMissingSchemaError(error)) {
      return { probed: 0, pass: 0, fail: 0, unverified: 0, ruleChangeReprobed: 0, ruleChangeCorrected: 0, skippedRecent: 0, skippedBusy: 0, priorityAbandoned: 0, itemErrors: 0 };
    }
    throw error;
  }

  const checkRecent = tier !== "all";
  const summary: ProbeBatchSummary = {
    probed: 0,
    pass: 0,
    fail: 0,
    unverified: 0,
    ruleChangeReprobed: 0,
    ruleChangeCorrected: 0,
    skippedRecent: 0,
    skippedBusy: 0,
    priorityAbandoned: 0,
    itemErrors: 0,
  };

  // 要求を出す直前の関門（優先と普通の列の両方）。順に見る:
  //   1. この実行がすでに始めた出品は飛ばす。
  //   2. 出品ごとの短いリース（job_leases の `l0:endpoint:<id>`、fail-closed）を取る。別の実行（c1 と c2）が
  //      要求の途中で、まだ行を書いていなくても、同じ出品へ 2 本目の要求は出ない。保持中・取得の例外なら飛ばす。
  //   3. リースを取ったあとで、直近 PRIORITY_MIN_PROBE_AGE_MINUTES 分のプローブ行を見る（別の実行が書き終えた行）。
  //      行の確認は cron の階層（c1・c2）だけ（all は手動とテスト用で、続けて 2 回測る使い方がある）。
  // リースは行を書いたあとに返す。
  const claimBeforeRequest = makeRequestGuard({
    claim: async (id) => {
      const lease = await acquireLeaseFailClosed(endpointLeaseName(id), ENDPOINT_LEASE_TTL_SECONDS);
      return lease.acquired ? lease.release : null;
    },
  });
  const probedRecently = async (id: string): Promise<boolean> => {
    const raw = await db.execute(sql`
      SELECT 1 AS hit FROM x402_l0_probes
      WHERE endpoint_id = ${id}::uuid
        AND probed_at > now() - make_interval(mins => ${PRIORITY_MIN_PROBE_AGE_MINUTES})
      LIMIT 1`);
    const list = Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? []);
    return list.length > 0;
  };

  async function probeOne(c: Candidate, stage: "priority" | "normal"): Promise<void> {
    let gate: Awaited<ReturnType<typeof claimBeforeRequest>>;
    try {
      gate = await claimBeforeRequest(c.id);
    } catch (error) {
      // リースの取得は fail-closed で投げないが、念のためこの 1 件だけ飛ばす。
      summary.itemErrors++;
      logServerErrorSafe("l0.probe-runner.claim", error);
      return;
    }
    if (gate.skip) {
      if (gate.reason === "busy") summary.skippedBusy++;
      else summary.skippedRecent++;
      return;
    }
    let keepLease = false;
    // リースを取ったあとの直近行の SELECT・要求・行の書き込みは、同じ try/finally の中に置く。
    // どこで例外が出ても、その 1 件だけ飛ばしてリースを返し、段と普通の列は続ける。
    try {
      if (checkRecent && (await probedRecently(c.id))) {
        summary.skippedRecent++;
        return;
      }
      const request = probeEndpoint(
        {
          resourceUrl: c.resourceUrl,
          method: c.method,
          payTo: c.payTo,
          network: c.network,
          priceAmount: c.priceAmount,
          priceAsset: c.priceAsset,
          source: c.source,
        },
        { fetchImpl, timeoutMs },
      );
      let result: ProbeResult;
      if (stage === "priority") {
        // 優先の段は 1 件ごとに、本文の読みまで含めた合計の上限を掛ける（遅い本文の 1 件が段を
        // maxDuration まで引かないため）。超えたら結果を書かずに打ち切る（測れたとは言えない）。
        // 置き去りの要求がまだ走りうるので、その出品のリースは返さず期限で切らせる。
        const limited = await withTotalLimit(request, priorityRequestLimitMs);
        if (limited === TOTAL_LIMIT_EXCEEDED) {
          request.catch(() => {});
          summary.priorityAbandoned++;
          keepLease = true;
          return;
        }
        result = limited;
      } else {
        result = await request;
      }
      // 書く直前の新しい行を読み直す（選定から時間が経っている・並行する c2 が書いたかもしれない）。
      // その間に今の規則の行で片付いていれば、通常の行として書く（訂正ログの対象にしない）。
      const prior = c.ruleChangeReprobe ? await readNewestProbeRows(db!, c.id) : null;
      if (prior && needsRuleChangeReprobe(prior)) {
        const written = await insertRuleChangeReprobe(db!, {
          endpointId: c.id,
          priorNewestFirst: prior,
          result,
          by: `cron_${tier}`,
        });
        summary.ruleChangeReprobed++;
        if (written.corrected) summary.ruleChangeCorrected++;
      } else {
        await db!.insert(x402L0Probes).values({
          endpointId: c.id,
          method: result.method,
          verdict: result.verdict,
          dialect: result.dialect,
          httpStatus: result.httpStatus,
          has402Challenge: result.has402Challenge,
          acceptsValid: result.acceptsValid,
          priceConsistent: result.priceConsistent,
          metadataConsistent: result.metadataConsistent,
          latencyMs: result.latencyMs,
          failReason: result.failReason,
          rawResponseMeta: result.rawResponseMeta,
        });
      }
      // MPP（2026-09-17）: directory は受取先を載せない。宣言と一致した壁の受取先を、
      // まだ受取先を知らない行にだけ書く（既にある値は動かさない——「変わった提案」に
      // 見せないため。offer_stability は probe 行の metadata_consistent だけを見るので、
      // ここで endpoint の pay_to を埋めても drifting にはならない）。
      if (result.verdict === "pass" && result.learnedPayTo && c.payTo === null && c.network) {
        try {
          await db!.execute(sql`
            UPDATE x402_endpoints
            SET pay_to = ${result.learnedPayTo}, payee_id = ${payeeId(c.network, result.learnedPayTo)}
            WHERE id = ${c.id}::uuid AND pay_to IS NULL
          `);
        } catch (error) {
          if (!isMissingSchemaError(error)) throw error;
        }
      }
      invalidateDecisionCache(c.id); // L0 判定は判定材料（このインスタンスのみ・cache.ts 参照）
      summary.probed++;
      summary[result.verdict]++;
    } catch (error) {
      summary.itemErrors++;
      logServerErrorSafe("l0.probe-runner.item", error);
    } finally {
      if (!keepLease) await gate.release();
    }
  }

  // 2 段で流す（2 周目の形）。先に優先分を、登録ドメインごとに同時 1 件・開始間隔 1 秒で測り、
  // 終わったらリースを返してから普通の列を従来の並行プールで流す。優先分は 1 登録ドメイン
  // PRIORITY_PER_DOMAIN 件までなので、遅いドメインでも優先の段は 300 秒の中で終わる。
  const orderedPriority = interleaveByDomain(priority, (c) => resourceRegisteredDomain(c.resourceUrl));
  try {
    await runWithDomainInterval(orderedPriority, {
      concurrency,
      intervalMs: PRIORITY_DOMAIN_INTERVAL_MS,
      domainOf: (c) => resourceRegisteredDomain(c.resourceUrl),
      run: (c) => probeOne(c, "priority"),
    });
  } finally {
    await releasePriority();
  }

  let cursor = 0;
  // Small worker pool — polite to targets, bounded for the function's clock.
  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= candidates.length) return;
      await probeOne(candidates[index], "normal");
    }
  }

  if (candidates.length > 0) {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, candidates.length) }, worker),
    );
  }
  return summary;
}
