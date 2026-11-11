import { NextRequest, NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import {
  L0_CRON_C1_DEFAULT_LIMIT,
  L0_CRON_CONCURRENCY,
  L0_CRON_DRAIN_CAP_MS,
  l0RunDeadlineAt,
} from "@/lib/observatory/l0-coverage7d";
import { runL0ProbeBatch } from "@/lib/observatory/probe-runner";
import { TOTAL_LIMIT_EXCEEDED, withTotalLimit } from "@/lib/observatory/reprobe-priority";
import { drainVerificationRequests } from "@/lib/observatory/requests";
import { logServerErrorSafe } from "@/lib/util/log-safe";

// vet402 Observatory L0 — no-purchase probe.
//
// 製品定義書 §7.4（2026-09-02）: 既定は C1（30 日以内に listed / 決済のある active を
// 日次で L0・上限 3,000・並行 40）。C2（決済帰属あり ∨ 問い合わせ多）は 6 時間周期
// だが Vercel Hobby の cron は日次までなので、管理リポの launchd が `?tier=c2` で
// 叩く。C4（再検証要求）は drainVerificationRequests が毎回先に流す。
//
// 2026-09-01 までは 500 件/日で、14,662 件の active を一巡するのに約 1 か月かかり、
// 「2 連続 fail で公開」のゲートが構造的に発火しなかった（publishedFail = 0）。
// 日次 C1 で cadence を仕様に合わせる。
export const maxDuration = 300;

//
// 2026-11-10（coverage7d・c36.rr3）: 期限はこのルートの開始から数える（l0RunDeadlineAt）。drain は
// L0_CRON_DRAIN_CAP_MS で待つのをやめ、超えた分はランナーの残りの時間から自然に引かれる。
// 窓の外を先に測る回は別のルート（/api/cron/l0-coverage）で、drain と優先の段を持たない。
export async function GET(request: NextRequest) {
  const routeStartedAt = Date.now();
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const tierParam = request.nextUrl.searchParams.get("tier");
  const tier: "c1" | "c2" = tierParam === "c2" ? "c2" : "c1";
  const limitParam = Number(request.nextUrl.searchParams.get("limit"));
  const limit =
    Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(limitParam, 5000)
      : tier === "c2"
        ? 1500
        : L0_CRON_C1_DEFAULT_LIMIT;

  try {
    // 公開キュー（C9）を先に消化——リクエストは順番を早めるだけで、
    // 判定ゲートは通常プローブと同一（requests.ts 冒頭）。
    const runDeadlineAt = l0RunDeadlineAt(routeStartedAt);
    const drain = drainVerificationRequests(50);
    drain.catch(() => {}); // 上限で待つのをやめたあとの例外を未処理にしない
    const drained = await withTotalLimit(drain, L0_CRON_DRAIN_CAP_MS);
    const requests =
      drained === TOTAL_LIMIT_EXCEEDED ? { drained: 0, probed: 0, invalid: 0, deferred: 0, capped: true } : drained;
    const summary = await runL0ProbeBatch({
      tier,
      limit,
      concurrency: L0_CRON_CONCURRENCY,
      runDeadlineAt,
    });
    return NextResponse.json({ ok: true, tier, limit, requests, ...summary });
  } catch (error) {
    logServerErrorSafe("cron.l0-probe", error);
    return NextResponse.json({ ok: false, error: "probe_failed" }, { status: 500 });
  }
}
