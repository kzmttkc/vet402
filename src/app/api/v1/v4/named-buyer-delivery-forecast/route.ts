import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import {
  consumeIpRateLimit,
  ipRateLimitHeaders,
  sharedCacheRateLimitHeaders,
} from "@/lib/api/ip-rate-limit";
import { withNoindex } from "@/lib/api/public-read-robots";
import { buildNamedBuyerDeliveryForecastFromFixture } from "@/lib/v4/named-buyer-delivery-forecast";

const RL_LIMIT = 60;
const RL_WINDOW_MS = 60_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/v4/named-buyer-delivery-forecast — F4 v1 dated forecast (named buyer scope only).
 */
export async function GET(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`v4-forecast:${ip}`, RL_LIMIT, RL_WINDOW_MS);
  const perCaller = withNoindex(ipRateLimitHeaders(limited));
  const shared = withNoindex(sharedCacheRateLimitHeaders(limited));
  if (!limited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: perCaller });
  }

  const snapshotDate = request.nextUrl.searchParams.get("snapshotDate");
  const resourceKey = request.nextUrl.searchParams.get("resourceKey");
  if (!snapshotDate || !DATE_RE.test(snapshotDate)) {
    return NextResponse.json({ error: "snapshotDate required. Use YYYY-MM-DD." }, { status: 400, headers: perCaller });
  }
  if (!resourceKey) {
    return NextResponse.json({ error: "resourceKey required." }, { status: 400, headers: perCaller });
  }

  const body = buildNamedBuyerDeliveryForecastFromFixture(snapshotDate, resourceKey);
  const retrievedAt = new Date().toISOString();
  return NextResponse.json(
    {
      ...body,
      retrievedAt,
      license: "CC-BY-4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      cite: `KIZUNA Creation. vet402 named-buyer delivery forecast, retrieved ${retrievedAt}. https://vet402.com/api/v1/v4/named-buyer-delivery-forecast`,
    },
    { headers: shared },
  );
}
