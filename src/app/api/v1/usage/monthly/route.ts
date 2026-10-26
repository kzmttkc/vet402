import { NextRequest, NextResponse } from "next/server";
import { publicRateLimit } from "@/lib/api/public-route";
import { stampNoindex, withNoindex } from "@/lib/api/public-read-robots";
import {
  loadMonthlyDecisionUsage,
  monthlyUsageErrorMessage,
  parseMonthlyUsageQuery,
  USAGE_MONTHLY_UNAVAILABLE_MESSAGE,
} from "@/lib/api/decision-usage";
import { logServerErrorSafe } from "@/lib/util/log-safe";

// 判定 API の月次件数。鍵・メール・名前は返さない。数字は decision_usage_daily と client_usage_daily から読む。
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const gate = await publicRateLimit(request, "usage-monthly", 60);
  if (!gate.ok) return stampNoindex(gate.response);
  const parsed = parseMonthlyUsageQuery(request.nextUrl.searchParams.get("chain"), request.nextUrl.searchParams.get("month"));
  if (!parsed.ok) {
    return NextResponse.json(
      { error: parsed.error, message: monthlyUsageErrorMessage(parsed.error) },
      { status: 400, headers: withNoindex(gate.headers) },
    );
  }
  try {
    const body = await loadMonthlyDecisionUsage(parsed);
    return NextResponse.json(body, { headers: withNoindex({ ...gate.headers, "Cache-Control": "no-store" }) });
  } catch (error) {
    logServerErrorSafe("usage.monthly", error);
    return NextResponse.json(
      { error: "unavailable", message: USAGE_MONTHLY_UNAVAILABLE_MESSAGE },
      { status: 503, headers: withNoindex(gate.headers) },
    );
  }
}
