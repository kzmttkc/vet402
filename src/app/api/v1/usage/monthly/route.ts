import { NextRequest, NextResponse } from "next/server";
import { publicRateLimit } from "@/lib/api/public-route";
import { stampNoindex, withNoindex } from "@/lib/api/public-read-robots";
import {
  loadMonthlyDecisionUsage,
  MonthlyUsageRejected,
  monthlyPublicationError,
  monthlyUsageErrorMessage,
  parseMonthlyUsageQuery,
  USAGE_MONTHLY_UNAVAILABLE_MESSAGE,
} from "@/lib/api/decision-usage";
import { logServerErrorSafe } from "@/lib/util/log-safe";

// 判定 API の月次件数。鍵ありを区分の合計だけ返す。鍵・メール・名前は返さない。
// 鍵なしはチェーンごとに数えないので、ここには出さない。
// 締まった月は、翌月 3 日 00:00 UTC 以降の最初の読み取りで固定表に書き、以後はその表だけを読む。
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
  const publication = monthlyPublicationError(parsed);
  if (publication === "month_not_closed") {
    return NextResponse.json(
      { error: "month_not_closed", message: monthlyUsageErrorMessage("month_not_closed") },
      { status: 400, headers: withNoindex(gate.headers) },
    );
  }
  if (publication === "month_not_published_yet") {
    return NextResponse.json(
      { error: "month_not_published_yet", message: monthlyUsageErrorMessage("month_not_published_yet") },
      { status: 400, headers: withNoindex(gate.headers) },
    );
  }
  try {
    const body = await loadMonthlyDecisionUsage(parsed);
    return NextResponse.json(body, { headers: withNoindex({ ...gate.headers, "Cache-Control": "no-store" }) });
  } catch (error) {
    if (error instanceof MonthlyUsageRejected && error.code === "month_not_closed") {
      return NextResponse.json(
        { error: "month_not_closed", message: monthlyUsageErrorMessage("month_not_closed") },
        { status: 400, headers: withNoindex(gate.headers) },
      );
    }
    if (error instanceof MonthlyUsageRejected && error.code === "month_not_published_yet") {
      return NextResponse.json(
        { error: "month_not_published_yet", message: monthlyUsageErrorMessage("month_not_published_yet") },
        { status: 400, headers: withNoindex(gate.headers) },
      );
    }
    logServerErrorSafe("usage.monthly", error);
    return NextResponse.json(
      { error: "unavailable", message: USAGE_MONTHLY_UNAVAILABLE_MESSAGE },
      { status: 503, headers: withNoindex(gate.headers) },
    );
  }
}
