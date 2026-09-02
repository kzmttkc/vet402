import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import {
  consumeIpRateLimit,
  ipRateLimitHeaders,
  sharedCacheRateLimitHeaders,
} from "@/lib/api/ip-rate-limit";
import { getCoverageShare, getObservatoryStats, getObservatoryStatsByChain } from "@/lib/observatory/reader";
import { logServerError } from "@/lib/util/log";

/**
 * GET /api/v1/observatory/state — "State of x402", as data.
 *
 * Key-less machine-readable twin of the /observatory/state page: the same
 * aggregate L0/L1 measurements a human reads there, computed by the same
 * readers so the two can never disagree. Facts only — counts with their
 * denominators, no composite score, no evaluative language.
 *
 * Exists so any consumer (a dashboard, an LLM answering "how healthy is
 * x402", the weekly distribution post generator) reads the numbers from one
 * canonical source instead of scraping the HTML table. IP-rate-limited and
 * CDN-cached like the other key-less public paths.
 */

const RL_LIMIT = 30;
const RL_WINDOW_MS = 60_000;

// 2026-09-02 監査: 静的化された route handler が prerender から古い判定を返すのを防ぐ（09c1fa0 と同じ欠陥）。
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`observatory-state:${ip}`, RL_LIMIT, RL_WINDOW_MS);
  const perCaller = ipRateLimitHeaders(limited);
  const shared = sharedCacheRateLimitHeaders(limited);
  if (!limited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: perCaller });
  }

  try {
    const [stats, byChain, coverage] = await Promise.all([
      getObservatoryStats(),
      getObservatoryStatsByChain(),
      getCoverageShare(),
    ]);

    return NextResponse.json(
      {
        ...stats,
        byChain,
        /** Share of active listed endpoints with an L0 measurement in the last 7 days. */
        coverage7d: coverage,
        // The top-level totals count every listing including testnets (Base
        // Sepolia); `byChain` is mainnet-only, matching the HTML page's
        // "Mainnets only" table. State this so a consumer summing byChain and
        // finding it below `totalEndpoints` sees why, rather than a silent gap.
        byChainScope: "mainnet_only",
        disclaimer:
          "Aggregate L0/L1 measurements over the public x402 discovery catalog. Catalog source: the CDP x402 Bazaar (and equivalent public discovery surfaces). x402 traffic that is not listed there — for example x402 on XRPL — is outside the measured population and shows as 0 in byChain; absence here is a coverage limit, not a finding. Facts with denominators, not an assessment of any operator. 'unverified' means not machine-checkable, not dead. Top-level totals include testnets; byChain is mainnet-only (byChainScope), so sum(byChain) can be below totalEndpoints.",
        humanReadable: "https://vet402.com/observatory/state",
        methodology: "https://vet402.com/observatory/methodology",
        // 引用されて初めて配布になる。ライセンスと取得日を本文に入れておかないと、
        // 機械が引いた数字は出所を失う（2026-08-25）。
        license: "CC-BY-4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        retrievedAt: new Date().toISOString(),
        cite: "KIZUNA Creation. vet402 observatory. Dataset, retrieved {retrievedAt}. https://vet402.com/api/v1/observatory/state",
      },
      {
        headers: {
          ...shared,
          // Recomputed at most daily (the catalog/probe crons) — 15 min shared
          // cache keeps the CDN in front of scans.
          "Cache-Control": "public, s-maxage=900, stale-while-revalidate=1800",
        },
      },
    );
  } catch (error) {
    logServerError("observatory_state", error);
    return NextResponse.json(
      { error: "observatory_unavailable" },
      { status: 503, headers: perCaller },
    );
  }
}
