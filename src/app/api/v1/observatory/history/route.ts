import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import {
  consumeIpRateLimit,
  ipRateLimitHeaders,
  sharedCacheRateLimitHeaders,
} from "@/lib/api/ip-rate-limit";
import {
  getDailyMetricsCoverage,
  getDailyMetricsHistory,
  metricsRollupLookbackDays,
} from "@/lib/observatory/metrics-rollup";
import { withNoindex } from "@/lib/api/public-read-robots";
import { logServerErrorSafe } from "@/lib/util/log-safe";

/**
 * GET /api/v1/observatory/history?days=30 — 日次メトリクス履歴、データとして。
 *
 * /observatory/state の履歴チャートと同じリーダー（getDailyMetricsHistory）
 * を読む——ページとAPIが食い違えない構造は state と同じ。日×チェーンの
 * L0/L1集計で、language は数と分母のみ。days は 10 進の整数だけ（`30.0`・`1e2` は 400）。
 * 1..366 の外と先頭の 0 は正規の値へ 308 で送る（export.csv と同じ。キャッシュのキーを増やさない）。
 * 無指定は 30 のまま、リダイレクトしない。DB を読む前に正規化する。
 */

const RL_LIMIT = 30;
const RL_WINDOW_MS = 60_000;

// 2026-09-02 監査: 静的化された route handler が prerender から古い判定を返すのを防ぐ（09c1fa0 と同じ欠陥）。
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`observatory-history:${ip}`, RL_LIMIT, RL_WINDOW_MS);
  const perCaller = withNoindex(ipRateLimitHeaders(limited));
  const shared = withNoindex(sharedCacheRateLimitHeaders(limited));
  if (!limited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: perCaller });
  }

  const daysParam = request.nextUrl.searchParams.get("days");
  if (daysParam !== null && !/^[0-9]{1,9}$/.test(daysParam)) {
    return NextResponse.json({ error: "invalid_days" }, { status: 400, headers: perCaller });
  }
  const days = daysParam === null ? 30 : Math.min(Math.max(Number(daysParam), 1), 366);
  if (daysParam !== null && daysParam !== String(days)) {
    const canonical = new URL(request.nextUrl.toString());
    canonical.search = `?days=${days}`;
    return NextResponse.redirect(canonical, { status: 308, headers: perCaller });
  }

  try {
    const [rows, coverage] = await Promise.all([
      getDailyMetricsHistory(days),
      getDailyMetricsCoverage(),
    ]);
    const window = metricsRollupLookbackDays();
    const retrievedAt = new Date().toISOString();
    return NextResponse.json(
      {
        days: rows,
        // 2026-09-05: 開始日と再計算の性質を書かずに合計だけ出していたので、
        // 第三者が state の live 合計と突き合わせたときに差を説明できなかった。
        // 表そのものの被覆（いつから・どこまで・いつ集計したか）を応答に載せる。
        ...coverage,
        recomputeWindowDays: window,
        semantics: `Daily rollup, recomputed for the trailing ${window} days on each run; late settlements are folded in on the next run, so a day older than that window is frozen until a backfill. Attempts use the same paid-attempt denominator as /api/v1/observatory/state. For live totals use /api/v1/observatory/state.`,
        disclaimer:
          "Daily L0/L1 aggregates per chain, rolled up from the same raw measurements the Observatory publishes. Counts with denominators, not an assessment. Chain 'unknown' means neither the payment rail nor the catalog row declares a network. Endpoints paying vet402's own addresses are left out of the rollup as of 2026-09-19, matching /api/v1/observatory/state. Each run restates the trailing recomputeWindowDays days, so days inside that window carry the new population and older days keep the old one — the step sits at the oldest day still inside the window at the first run after 2026-09-19. That boundary then stays where it is: a restated day is not restated back.",
        humanReadable: "https://vet402.com/observatory/state",
        methodology: "https://vet402.com/observatory/methodology",
        license: "CC-BY-4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        retrievedAt,
        cite: `KIZUNA Creation. vet402 observatory. Dataset, retrieved ${retrievedAt}. https://vet402.com/api/v1/observatory/history?days=${days}`,
      },
      {
        headers: {
          ...shared,
          // Rolled up daily — 1h shared cache keeps the CDN in front.
          "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=7200",
        },
      },
    );
  } catch (error) {
    logServerErrorSafe("observatory_history", error);
    return NextResponse.json(
      { error: "observatory_unavailable" },
      { status: 503, headers: perCaller },
    );
  }
}
