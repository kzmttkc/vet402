import { NextRequest, NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import {
  metricsRollupCronRollups as defaultMetricsRollupCronRollups,
  shiftDay,
  utcDayString,
} from "@/lib/observatory/metrics-rollup";
import { anchorThrough as defaultAnchorThrough } from "@/lib/observatory/anchors";
import { ensurePriorMonthFrozenIfDue as defaultEnsurePriorMonthFrozenIfDue } from "@/lib/observatory/monthly-freeze";
import { getDb } from "@/lib/db/client";
import { sealTradeDisputeDay as defaultSealTradeDisputeDay } from "@/lib/observatory/trade-dispute-store";
import { sealNearAiDay as defaultSealNearAiDay } from "@/lib/nearai/store";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { exportDisallowedMethodHandlers, headFromGet } from "@/lib/api/method-not-allowed";

let anchorThroughFn: typeof defaultAnchorThrough = defaultAnchorThrough;
let ensurePriorMonthFrozenIfDueFn: typeof defaultEnsurePriorMonthFrozenIfDue = defaultEnsurePriorMonthFrozenIfDue;
let sealTradeDisputeDayFn: typeof defaultSealTradeDisputeDay = defaultSealTradeDisputeDay;
let sealNearAiDayFn: typeof defaultSealNearAiDay = defaultSealNearAiDay;
let metricsRollupCronRollupsFn: typeof defaultMetricsRollupCronRollups = defaultMetricsRollupCronRollups;

export function setMetricsRollupE6DepsForTests(
  deps: {
    anchorThrough?: typeof defaultAnchorThrough;
    ensurePriorMonthFrozenIfDue?: typeof defaultEnsurePriorMonthFrozenIfDue;
    sealTradeDisputeDay?: typeof defaultSealTradeDisputeDay;
    sealNearAiDay?: typeof defaultSealNearAiDay;
    metricsRollupCronRollups?: typeof defaultMetricsRollupCronRollups;
  } | null,
): void {
  if (!deps) {
    anchorThroughFn = defaultAnchorThrough;
    ensurePriorMonthFrozenIfDueFn = defaultEnsurePriorMonthFrozenIfDue;
    sealTradeDisputeDayFn = defaultSealTradeDisputeDay;
    sealNearAiDayFn = defaultSealNearAiDay;
    metricsRollupCronRollupsFn = defaultMetricsRollupCronRollups;
    return;
  }
  if (deps.anchorThrough) anchorThroughFn = deps.anchorThrough;
  if (deps.ensurePriorMonthFrozenIfDue) ensurePriorMonthFrozenIfDueFn = deps.ensurePriorMonthFrozenIfDue;
  if (deps.sealTradeDisputeDay) sealTradeDisputeDayFn = deps.sealTradeDisputeDay;
  if (deps.sealNearAiDay) sealNearAiDayFn = deps.sealNearAiDay;
  if (deps.metricsRollupCronRollups) metricsRollupCronRollupsFn = deps.metricsRollupCronRollups;
}

// Phase 1.1 — 日次メトリクスのロールアップ。
//
// 2026-09-05: 「前日と当日の2日ぶん」から「直近 N 日（既定 14）を毎回再計算」へ。
// この cron は 10:30 UTC、L1 の決済確認（verify-settlements）は 14:00 UTC なので、
// その日の後半に settled へ昇格した行は 2 日窓を抜けたあと二度と集計へ入らなかった
// （実測 2026-09-05: Base の settled が 221 件過小）。再計算は raw からの再導出で
// 冪等なので、窓を広げる以外に持つべき状態は無い。
// N より古い日は metrics-rollup cron が L1 ずれを検出した分だけ古い順に再計算する（1 回 10 日まで）。
// 手動の広い backfill は scripts/backfill-daily-metrics.ts。
//
// 台帳アンカー（ledger_anchors）は L1 の生行を直接ハッシュしていて
// x402_daily_metrics を読まないので、この再計算はアンカーの root を動かさない。
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const { lookbackDays, days, driftDaysRecomputed } = await metricsRollupCronRollupsFn({
      endDay: utcDayString(),
    });
    let monthlyFreeze: Awaited<ReturnType<typeof defaultEnsurePriorMonthFrozenIfDue>> | null = null;
    try {
      const db = getDb();
      if (db) {
        monthlyFreeze = await ensurePriorMonthFrozenIfDueFn(db, new Date());
      }
    } catch (error) {
      logServerErrorSafe("cron.metrics-rollup.monthly-freeze", error);
    }
    // 台帳ハッシュチェーン: 完結した前日だけをアンカーする（当日は行が増える）。
    // conflict_frozen（刻印済みrootと現データの食い違い）は整合性イベント——
    // 握りつぶさず監視ログに出す。
    // 2026-11-10 公平審査 3.8 の 6c: 欠けた日は後から埋めない。昨日だけを固定し、
    // 穴は /api/v1/observatory/anchors の missingHeadDays と headFreshness が公開する
    // （2026-09-02 の「5 日間検出されなかった」は、この公開と chainContinuity で防ぐ）。
    const anchors = await anchorThroughFn(shiftDay(utcDayString(), -1));
    for (const anchor of anchors) {
      if (anchor.status === "conflict_frozen") {
        logServerErrorSafe(
          "cron.metrics-rollup.anchor",
          new Error(`ledger anchor conflict on ${anchor.day}: recomputed root differs from anchored root`),
        );
      }
    }
    const anchor = anchors[anchors.length - 1] ?? null;
    try {
      const e6 = await sealTradeDisputeDayFn(shiftDay(utcDayString(), -1));
      if (e6.status === "conflict_frozen") {
        logServerErrorSafe(
          "cron.metrics-rollup.e6-anchor",
          new Error(`E6 trade dispute day conflict on ${e6.day}`),
        );
      }
    } catch (error) {
      logServerErrorSafe("cron.metrics-rollup.e6-anchor", error);
    }
    try {
      const nearai = await sealNearAiDayFn(shiftDay(utcDayString(), -1));
      if (nearai.status === "conflict_frozen") {
        logServerErrorSafe(
          "cron.metrics-rollup.nearai-anchor",
          new Error(`NEAR AI day conflict on ${nearai.day}`),
        );
      }
    } catch (error) {
      logServerErrorSafe("cron.metrics-rollup.nearai-anchor", error);
    }
    return NextResponse.json({
      ok: true,
      lookbackDays,
      days,
      driftDaysRecomputed,
      monthlyFreeze,
      anchor,
    });
  } catch (error) {
    logServerErrorSafe("cron.metrics-rollup", error);
    return NextResponse.json({ ok: false, error: "rollup_failed" }, { status: 500 });
  }
}
const __disallowed = exportDisallowedMethodHandlers(["GET"]);
export const { POST, PUT, PATCH, DELETE, OPTIONS } = __disallowed;
export const HEAD = headFromGet(GET);
