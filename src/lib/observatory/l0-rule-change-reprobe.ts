// ============================================================
// 旧規則の公開 fail を一度に測り直す（2026-09-29 監査 6 周目）——scripts/reprobe-legacy-l0-fails.ts の本体。
//
// 対象: 掲載中（status = active）で、見出しの fail が旧規則のプローブ行に乗っている出品
// （l0-rule-change.ts の needsRuleChangeReprobe）。1 出品 1 要求・今の probeEndpoint（cron と同じ計器）。
//
// 売り手への負荷:
//   - 同じ登録ドメイン（politenessKeyOf）へは同時に 1 件まで、要求の開始の間隔は intervalMs（1,000 未満にできない）。
//   - 全体の同時実行は concurrency まで。
//   - 最新のプローブが minAgeHours より新しい出品は飛ばす（直前の cron と続けて 2 回叩かない。
//     「2 回連続 fail」を数秒差の 2 要求で作らない）。
// 止め方: stop()（CLI は Ctrl-C）か maxMinutes。新しい要求を出すのをやめ、出した要求（最長 10 秒）を待って終わる。
// 冪等: 測り直した出品は新しい行が今の規則の行になるので、次の実行の対象から外れる（再実行＝続きから）。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { rowsOf } from "@/lib/settlements/upsert";
import { MIN_CONSECUTIVE_FAILS_TO_PUBLISH, probeEndpoint, type ProbeResult, type ProbeTarget } from "./l0-probe";
import {
  insertRuleChangeReprobe,
  legacyRuleFailKind,
  legacyRuleFailKindSql,
  needsRuleChangeReprobe,
  needsRuleChangeReprobeSql,
  politenessKeyOf,
  readNewestProbeRows,
  type LegacyRuleFailKind,
} from "./l0-rule-change";

export const REPROBE_MIN_INTERVAL_MS = 1_000;
export const REPROBE_LIMIT_MAX = 5_000;
export const REPROBE_MAX_MINUTES_MAX = 120;
export const REPROBE_CONCURRENCY_MAX = 32;

export type RuleChangeTarget = ProbeTarget & {
  id: string;
  kinds: LegacyRuleFailKind[];
  lastProbedAt: string | null;
  medianLatencyMs: number | null;
};

/** 対象の一覧（掲載中・見出しの fail が旧規則の行に乗っている）。最終プローブが古い順。 */
export async function selectRuleChangeTargets(limit: number): Promise<RuleChangeTarget[]> {
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL is not configured");
  const rows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      SELECT e.id::text AS id, e.resource_url, e.method, e.pay_to, e.network, e.price_amount, e.price_asset, e.source,
             r.kinds, r.last_probed_at::text AS last_probed_at, r.median_latency_ms
      FROM x402_endpoints e
      JOIN LATERAL (
        SELECT array_remove(array_agg(k.kind ORDER BY k.probed_at DESC), NULL) AS kinds,
               max(k.probed_at) AS last_probed_at,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY k.latency_ms) AS median_latency_ms
        FROM (
          SELECT q.probed_at, q.latency_ms, ${legacyRuleFailKindSql("q")} AS kind
          FROM x402_l0_probes q WHERE q.endpoint_id = e.id
          ORDER BY q.probed_at DESC LIMIT ${MIN_CONSECUTIVE_FAILS_TO_PUBLISH}
        ) k
      ) r ON true
      WHERE e.status = 'active' AND ${needsRuleChangeReprobeSql("e")}
      ORDER BY r.last_probed_at ASC, e.first_seen_at ASC
      LIMIT ${limit}
    `),
  );
  return rows.map((r) => ({
    id: String(r.id),
    resourceUrl: String(r.resource_url),
    method: (r.method as string | null) ?? null,
    payTo: (r.pay_to as string | null) ?? null,
    network: (r.network as string | null) ?? null,
    priceAmount: (r.price_amount as string | null) ?? null,
    priceAsset: (r.price_asset as string | null) ?? null,
    source: (r.source as string | null) ?? null,
    kinds: ((r.kinds as string[] | null) ?? []) as LegacyRuleFailKind[],
    lastProbedAt: (r.last_probed_at as string | null) ?? null,
    medianLatencyMs: r.median_latency_ms === null || r.median_latency_ms === undefined ? null : Number(r.median_latency_ms),
  }));
}

/**
 * 所要時間の見積もり（秒）。下限は「一番多いドメインの件数 × 間隔」と「総件数 × 典型の応答時間 ÷ 並行数」の大きい方。
 * 1 要求は間隔と応答時間の長い方を占める。
 */
export function estimateReprobeSeconds(
  targets: readonly Pick<RuleChangeTarget, "resourceUrl" | "medianLatencyMs">[],
  opts: { concurrency: number; intervalMs: number },
): { seconds: number; byDomain: [string, number][]; typicalLatencyMs: number } {
  const byDomainMap = new Map<string, number>();
  for (const t of targets) byDomainMap.set(politenessKeyOf(t.resourceUrl), (byDomainMap.get(politenessKeyOf(t.resourceUrl)) ?? 0) + 1);
  const byDomain = [...byDomainMap.entries()].sort((a, b) => b[1] - a[1]);
  const lat = targets.map((t) => t.medianLatencyMs).filter((v): v is number => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  const typicalLatencyMs = lat.length === 0 ? 1_000 : lat[Math.floor(lat.length / 2)];
  const perDomainSeconds = (byDomain[0]?.[1] ?? 0) * Math.max(opts.intervalMs, typicalLatencyMs) / 1000;
  const throughputSeconds = (targets.length * typicalLatencyMs) / 1000 / Math.max(1, opts.concurrency);
  return { seconds: Math.ceil(Math.max(perDomainSeconds, throughputSeconds)), byDomain, typicalLatencyMs };
}

export type ReprobeRunOptions = {
  targets: readonly RuleChangeTarget[];
  concurrency: number;
  intervalMs: number;
  maxMinutes: number;
  minAgeHours: number;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  /** 進捗の出力（CLI は console.log）。 */
  log?: (line: string) => void;
  /** 時計（テスト用）。 */
  now?: () => number;
  /** 各要求の開始（テスト用・ドメインごとの間隔の確認）。 */
  onRequestStart?: (domain: string, at: number) => void;
};

export type ReprobeRunSummary = {
  planned: number;
  probed: number;
  corrected: number;
  /** 測り直しの結果、公開判定の遷移（before->after）ごとの件数。 */
  transitions: Record<string, number>;
  /** 新しい行の理由ごとの件数（pass は "pass"）。 */
  newReasons: Record<string, number>;
  /** 測り直しても fail で、2 行目がまだ旧規則の行（次の実行・cron の C1 がもう一度測る）。 */
  stillRestingOnLegacyRow: number;
  skippedResolved: number;
  skippedRecent: number;
  notStarted: number;
  errors: number;
  stoppedBy: "done" | "deadline" | "signal";
  elapsedSeconds: number;
};

/** 実行の本体。stop() を呼ぶと新しい要求を出さなくなる。 */
export function startRuleChangeReprobe(opts: ReprobeRunOptions): { done: Promise<ReprobeRunSummary>; stop: () => void } {
  const intervalMs = Math.max(REPROBE_MIN_INTERVAL_MS, Math.trunc(opts.intervalMs));
  const concurrency = Math.min(Math.max(1, Math.trunc(opts.concurrency)), REPROBE_CONCURRENCY_MAX);
  const maxMs = Math.min(Math.max(1, opts.maxMinutes), REPROBE_MAX_MINUTES_MAX) * 60_000;
  const minAgeMs = Math.max(0, opts.minAgeHours) * 3_600_000;
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  let stopped: ReprobeRunSummary["stoppedBy"] | null = null;

  const summary: ReprobeRunSummary = {
    planned: opts.targets.length,
    probed: 0,
    corrected: 0,
    transitions: {},
    newReasons: {},
    stillRestingOnLegacyRow: 0,
    skippedResolved: 0,
    skippedRecent: 0,
    notStarted: 0,
    errors: 0,
    stoppedBy: "done",
    elapsedSeconds: 0,
  };

  type Lane = { key: string; queue: RuleChangeTarget[]; inFlight: boolean; nextAt: number };
  const lanes = new Map<string, Lane>();
  for (const t of opts.targets) {
    const key = politenessKeyOf(t.resourceUrl);
    const lane = lanes.get(key) ?? { key, queue: [], inFlight: false, nextAt: 0 };
    lane.queue.push(t);
    lanes.set(key, lane);
  }

  const done = (async () => {
    const db = getDb();
    if (!db) throw new Error("DATABASE_URL is not configured");
    const startedAt = now();
    let inFlight = 0;
    const running = new Set<Promise<unknown>>();

    /** 1 出品。要求を出す直前にそのドメインの次の開始時刻を決める（飛ばした出品は間隔を消費しない）。 */
    const one = async (lane: Lane, t: RuleChangeTarget): Promise<void> => {
      try {
        const prior = await readNewestProbeRows(db, t.id);
        if (!needsRuleChangeReprobe(prior)) {
          summary.skippedResolved++;
          return;
        }
        const newest = prior[0]?.probedAt ? Date.parse(prior[0].probedAt.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00")) : NaN;
        if (Number.isFinite(newest) && now() - newest < minAgeMs) {
          summary.skippedRecent++;
          return;
        }
        const requestAt = now();
        lane.nextAt = requestAt + intervalMs; // 要求の開始から次の開始まで intervalMs 以上（この間 lane は inFlight）
        opts.onRequestStart?.(lane.key, requestAt);
        const result: ProbeResult = await probeEndpoint(t, { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
        const written = await insertRuleChangeReprobe(db, { endpointId: t.id, priorNewestFirst: prior, result, by: "script" });
        summary.probed++;
        if (written.corrected) summary.corrected++;
        const tr = `${written.before}->${written.after}`;
        summary.transitions[tr] = (summary.transitions[tr] ?? 0) + 1;
        const reason = result.verdict === "pass" ? "pass" : (result.failReason ?? result.verdict);
        summary.newReasons[reason] = (summary.newReasons[reason] ?? 0) + 1;
        if (written.after === "fail" && prior[0] && legacyRuleFailKind(prior[0]) !== null) summary.stillRestingOnLegacyRow++;
        if (summary.probed % 100 === 0) {
          log(`  probed=${summary.probed} corrected=${summary.corrected} elapsed=${Math.round((now() - startedAt) / 1000)}s`);
        }
      } catch (error) {
        summary.errors++;
        log(`  error ${t.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    for (;;) {
      if (!stopped && now() - startedAt >= maxMs) stopped = "deadline";
      const pending = [...lanes.values()].some((l) => l.queue.length > 0);
      if (stopped || !pending) {
        if (running.size === 0) break;
        await Promise.race(running);
        continue;
      }
      // 空いているドメインのうち、残りが一番多いものから（長い列を先に始めて終わりを早める）。
      const t0 = now();
      let pick: Lane | null = null;
      if (inFlight < concurrency) {
        for (const lane of lanes.values()) {
          if (lane.inFlight || lane.queue.length === 0 || lane.nextAt > t0) continue;
          if (!pick || lane.queue.length > pick.queue.length) pick = lane;
        }
      }
      if (!pick) {
        const waits = [...lanes.values()].filter((l) => !l.inFlight && l.queue.length > 0).map((l) => l.nextAt - t0);
        const wait = inFlight >= concurrency || waits.length === 0 ? 50 : Math.max(5, Math.min(...waits));
        if (running.size > 0) await Promise.race([...running, sleep(wait)]);
        else await sleep(wait);
        continue;
      }
      const lane = pick;
      const target = lane.queue.shift()!;
      lane.inFlight = true;
      inFlight++;
      const p: Promise<unknown> = one(lane, target).finally(() => {
        lane.inFlight = false;
        inFlight--;
        running.delete(p);
      });
      running.add(p);
    }
    summary.notStarted = [...lanes.values()].reduce((n, l) => n + l.queue.length, 0);
    summary.stoppedBy = stopped ?? "done";
    summary.elapsedSeconds = Math.round((now() - startedAt) / 1000);
    return summary;
  })();

  return {
    done,
    stop: () => {
      if (!stopped) stopped = "signal";
    },
  };
}
