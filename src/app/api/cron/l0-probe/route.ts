import { NextRequest, NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { runL0ProbeBatch } from "@/lib/observatory/probe-runner";
import { drainVerificationRequests } from "@/lib/observatory/requests";
import { logServerError } from "@/lib/util/log";

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

export async function GET(request: NextRequest) {
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const tierParam = request.nextUrl.searchParams.get("tier");
  const tier: "c1" | "c2" = tierParam === "c2" ? "c2" : "c1";
  const limitParam = Number(request.nextUrl.searchParams.get("limit"));
  const limit =
    Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 5000) : tier === "c2" ? 1500 : 3000;

  try {
    // 公開キュー（C9）を先に消化——リクエストは順番を早めるだけで、
    // 判定ゲートは通常プローブと同一（requests.ts 冒頭）。
    const requests = await drainVerificationRequests(50);
    const summary = await runL0ProbeBatch({ tier, limit, concurrency: 40 });
    return NextResponse.json({ ok: true, tier, limit, requests, ...summary });
  } catch (error) {
    logServerError("cron.l0-probe", error);
    return NextResponse.json({ ok: false, error: "probe_failed" }, { status: 500 });
  }
}
