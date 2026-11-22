import { NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit, ipRateLimitHeaders } from "@/lib/api/ip-rate-limit";
import { exportDisallowedMethodHandlers, headFromGet } from "@/lib/api/method-not-allowed";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`nearai-anchors:${ip}`, 30, 60_000);
  const perCaller = ipRateLimitHeaders(limited);
  if (!limited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: perCaller });
  }
  return NextResponse.json(
    {
      chain: "nearai_tee",
      description: "Independent hash chain for NEAR AI TEE public rows (separate from L1 x402 ledger).",
      dayEndpoint: "/api/v1/observatory/nearai/anchors/day",
    },
    { headers: perCaller },
  );
}

const __disallowed = exportDisallowedMethodHandlers(["GET"]);
export const { POST, PUT, PATCH, DELETE, OPTIONS } = __disallowed;
export const HEAD = headFromGet(GET);