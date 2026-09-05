import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import {
  consumeIpRateLimit,
  ipRateLimitHeaders,
  sharedCacheRateLimitHeaders,
} from "@/lib/api/ip-rate-limit";
import { getEndpointPurchases } from "@/lib/observatory/reader";
import { logServerError } from "@/lib/util/log";
import { UUID_RE } from "@/lib/validation/uuid";

/**
 * GET /api/v1/observatory/endpoints/{id}/purchases — the receipt, as data.
 *
 * Key-less ON PURPOSE (要件定義v2 2026-08-14 §2.1-1): the endpoint-level
 * settle-through record — n attempts, m settled, each settled row carrying
 * its on-chain tx hash — is the product's evidence layer, and evidence shown
 * only to paying callers is marketing, not measurement. Same reasoning as
 * /api/v1/accuracy, and the same guardrails: IP rate limit, CDN cache, facts
 * only (verdict strings from the closed vocabulary, no evaluative fields).
 *
 * Every row is returned including settle_failed — a seller whose payments
 * fail to settle is exactly what a counterparty needs to see, and hiding the
 * misses would turn the record into advertising.
 */

const RL_LIMIT = 30;
const RL_WINDOW_MS = 60_000;

// 2026-09-02 監査: 静的化された route handler が prerender から古い判定を返すのを防ぐ（09c1fa0 と同じ欠陥）。
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`observatory-purchases:${ip}`, RL_LIMIT, RL_WINDOW_MS);
  const perCallerHeaders = ipRateLimitHeaders(limited);
  const sharedHeaders = sharedCacheRateLimitHeaders(limited);
  if (!limited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: perCallerHeaders });
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { error: "invalid_endpoint_id" },
      { status: 400, headers: perCallerHeaders },
    );
  }

  try {
    const result = await getEndpointPurchases(id);
    if (!result) {
      return NextResponse.json(
        { error: "endpoint_not_found" },
        { status: 404, headers: perCallerHeaders },
      );
    }

    return NextResponse.json(
      {
        ...result,
        disclaimer:
          "Facts only: attempts, settlements and their on-chain receipts. settledCount is the transfer vet402 re-read on-chain; deliveredCount is the subset whose paid request also answered 2xx; inconclusiveCount is the subset whose paid request answered 4xx, held rather than counted against the seller because vet402 buys with an empty JSON body and no API key of the seller's and cannot rule out that the request was its own to get wrong. deliveryRatePct is deliveredCount over settledCount minus inconclusiveCount — the attempts vet402 can actually judge. This is a record of what happened when vet402 paid this endpoint, not an endorsement or a prediction.",
        methodology: "https://vet402.com/observatory/methodology",
      },
      {
        headers: {
          ...sharedHeaders,
          // Purchases land at most daily (the L1 cron) — 10 min shared cache
          // keeps the CDN in front of scans without staling the record.
          "Cache-Control": "public, s-maxage=600, stale-while-revalidate=1200",
        },
      },
    );
  } catch (error) {
    logServerError("observatory_purchases", error);
    return NextResponse.json(
      { error: "observatory_unavailable" },
      { status: 503, headers: perCallerHeaders },
    );
  }
}
