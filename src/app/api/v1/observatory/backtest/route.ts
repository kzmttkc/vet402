import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import {
  consumeIpRateLimit,
  ipRateLimitHeaders,
  sharedCacheRateLimitHeaders,
} from "@/lib/api/ip-rate-limit";
import { computeSpendGuardBacktest } from "@/lib/observatory/backtest";
import { logServerError } from "@/lib/util/log";

/**
 * GET /api/v1/observatory/backtest — 「シグナルに従っていたら」の両面集計。
 * avoided（従えば失わなかった支出）と forgone（従えば見送った成功）を
 * **必ず両方**返す——機械定義はレスポンスに同梱（definition）。
 * 対象は vet402 自身の実購入台帳であり、他者の損益の推計ではない。
 */

const RL_LIMIT = 12;
const RL_WINDOW_MS = 60_000;

// 2026-09-02 監査: 静的化された route handler が prerender から古い判定を返すのを防ぐ（09c1fa0 と同じ欠陥）。
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`observatory-backtest:${ip}`, RL_LIMIT, RL_WINDOW_MS);
  const perCaller = ipRateLimitHeaders(limited);
  const shared = sharedCacheRateLimitHeaders(limited);
  if (!limited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: perCaller });
  }
  try {
    const result = await computeSpendGuardBacktest();
    return NextResponse.json(
      {
        ...result,
        scope: "vet402's own ledger only — not an estimate of anyone else's losses",
        humanReadable: "https://vet402.com/observatory/state",
      },
      { headers: { ...shared, "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=7200" } },
    );
  } catch (error) {
    logServerError("observatory_backtest", error);
    return NextResponse.json({ error: "observatory_unavailable" }, { status: 503, headers: perCaller });
  }
}
