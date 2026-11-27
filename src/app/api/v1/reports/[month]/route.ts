import { NextRequest, NextResponse } from "next/server";
import { publicRateLimit } from "@/lib/api/public-route";
import { stampNoindex, withNoindex } from "@/lib/api/public-read-robots";
import { getDb } from "@/lib/db/client";
import {
  MONTHLY_FREEZE_STATUS_NOT_CLOSED,
  MONTHLY_FREEZE_STATUS_NOT_FROZEN_YET,
  parseMonthlyFreezeMonth,
  readMonthlyFreezePublic,
} from "@/lib/observatory/monthly-freeze";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { exportDisallowedMethodHandlers, headFromGet } from "@/lib/api/method-not-allowed";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, context: { params: Promise<{ month: string }> }) {
  const gate = await publicRateLimit(_request, "reports-monthly-freeze", 120);
  if (!gate.ok) return stampNoindex(gate.response);
  const monthParam = (await context.params).month;
  const parsed = parseMonthlyFreezeMonth(monthParam);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: "invalid_month", message: "month must be YYYY-MM from 2026 through 2100." },
      { status: 400, headers: withNoindex(gate.headers) },
    );
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json(
      { error: "unavailable", message: "The monthly freeze store could not be read." },
      { status: 503, headers: withNoindex(gate.headers) },
    );
  }
  try {
    const body = await readMonthlyFreezePublic(db, parsed.month);
    if (body.status === MONTHLY_FREEZE_STATUS_NOT_CLOSED) {
      return NextResponse.json(
        { status: body.status, month: body.month, message: "That UTC month has not closed yet." },
        { status: 400, headers: withNoindex(gate.headers) },
      );
    }
    if (body.status === MONTHLY_FREEZE_STATUS_NOT_FROZEN_YET) {
      return NextResponse.json(
        {
          status: body.status,
          month: body.month,
          message:
            "That month is not frozen yet. vet402 publishes the freeze on or after 00:00 UTC on the 1st day of the next month.",
        },
        { status: 404, headers: withNoindex(gate.headers) },
      );
    }
    return NextResponse.json(body.summary, {
      headers: withNoindex({ ...gate.headers, "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=7200" }),
    });
  } catch (error) {
    logServerErrorSafe("reports.monthly-freeze", error);
    return NextResponse.json(
      { error: "unavailable", message: "The monthly freeze store could not be read." },
      { status: 503, headers: withNoindex(gate.headers) },
    );
  }
}

const __disallowed = exportDisallowedMethodHandlers(["GET"]);
export const { POST, PUT, PATCH, DELETE, OPTIONS } = __disallowed;
export const HEAD = headFromGet(GET);