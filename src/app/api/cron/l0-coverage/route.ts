import { NextRequest, NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { L0_COVERAGE_RUN_LIMIT, L0_CRON_CONCURRENCY, l0RunDeadlineAt } from "@/lib/observatory/l0-coverage7d";
import { runL0ProbeBatch } from "@/lib/observatory/probe-runner";
import { logServerErrorSafe } from "@/lib/util/log-safe";

// vet402 Observatory L0 — coverage の回（2026-11-10・coverage7d）。
//
// 未払いの要求で 402 を読むだけの L0（l0-probe と同じ probeEndpoint）。支払い・署名はしない。
// 窓の外（直近 7 日に L0 行が無い出品）を先に測り、窓の内の更新は 1 回 L0_COVERAGE7D_IN_WINDOW_PER_RUN 件まで残す。
// 公開の再検証キュー（drain）と優先の段（宣言ずれ・旧規則の fail・異議）は持たない。それは l0-probe（10:30 UTC）と
// c2（launchd）の回が持つので、申し立ての測り直しの時刻（l0ProbeScheduleLabel）にこの回は入らない。
// 期限はこのルートの開始から数え、maxDuration の内側で返る（l0-coverage7d.ts の時間の内訳）。
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const routeStartedAt = Date.now();
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const summary = await runL0ProbeBatch({
      tier: "coverage",
      limit: L0_COVERAGE_RUN_LIMIT,
      concurrency: L0_CRON_CONCURRENCY,
      skipPriority: true,
      runDeadlineAt: l0RunDeadlineAt(routeStartedAt),
    });
    return NextResponse.json({ ok: true, tier: "coverage", limit: L0_COVERAGE_RUN_LIMIT, ...summary });
  } catch (error) {
    logServerErrorSafe("cron.l0-coverage", error);
    return NextResponse.json({ ok: false, error: "probe_failed" }, { status: 500 });
  }
}
