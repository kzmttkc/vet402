import { NextRequest, NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import {
  metricsRollupLookbackDays,
  rollupRecentDailyMetrics,
  shiftDay,
  utcDayString,
} from "@/lib/observatory/metrics-rollup";
import { anchorThrough } from "@/lib/observatory/anchors";
import { logServerError } from "@/lib/util/log";

// Phase 1.1 — 日次メトリクスのロールアップ。
//
// 2026-09-05: 「前日と当日の2日ぶん」から「直近 N 日（既定 14）を毎回再計算」へ。
// この cron は 10:30 UTC、L1 の決済確認（verify-settlements）は 14:00 UTC なので、
// その日の後半に settled へ昇格した行は 2 日窓を抜けたあと二度と集計へ入らなかった
// （実測 2026-09-05: Base の settled が 221 件過小）。再計算は raw からの再導出で
// 冪等なので、窓を広げる以外に持つべき状態は無い。
// N より古い日は scripts/backfill-daily-metrics.ts の守備範囲。
//
// 台帳アンカー（ledger_anchors）は L1 の生行を直接ハッシュしていて
// x402_daily_metrics を読まないので、この再計算はアンカーの root を動かさない。
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const lookbackDays = metricsRollupLookbackDays();
    const today = utcDayString();
    const days = await rollupRecentDailyMetrics({ days: lookbackDays, endDay: today });
    // 台帳ハッシュチェーン: 完結した前日だけをアンカーする（当日は行が増える）。
    // conflict_frozen（刻印済みrootと現データの食い違い）は整合性イベント——
    // 握りつぶさず監視ログに出す。
    // 2026-09-02 監査: 欠けた日を古い順に埋めてから昨日を固定する。cron が 1 回
    // 落ちても翌日に鎖が自己修復する（以前は穴を飛ばして連結し、5 日間検出されなかった）。
    const anchors = await anchorThrough(shiftDay(today, -1));
    for (const anchor of anchors) {
      if (anchor.status === "conflict_frozen") {
        logServerError(
          "cron.metrics-rollup.anchor",
          new Error(`ledger anchor conflict on ${anchor.day}: recomputed root differs from anchored root`),
        );
      }
    }
    const anchor = anchors[anchors.length - 1] ?? null;
    return NextResponse.json({
      ok: true,
      lookbackDays,
      days,
      anchor,
      backfilled: anchors.length - 1,
    });
  } catch (error) {
    logServerError("cron.metrics-rollup", error);
    return NextResponse.json({ ok: false, error: "rollup_failed" }, { status: 500 });
  }
}
