import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { publicRateLimit } from "@/lib/api/public-route";
import { stampNoindex, withNoindex } from "@/lib/api/public-read-robots";
import { getDb } from "@/lib/db/client";
import {
  MONTHLY_FREEZE_STATUS_NOT_CLOSED,
  MONTHLY_FREEZE_STATUS_NOT_FROZEN_YET,
  loadMonthlyFreezeCsvBody,
  parseMonthlyFreezeMonth,
  readMonthlyFreezePublic,
} from "@/lib/observatory/monthly-freeze";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { exportDisallowedMethodHandlers, headFromGet } from "@/lib/api/method-not-allowed";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, context: { params: Promise<Record<string, string>> }) {
  const gate = await publicRateLimit(_request, "reports-monthly-freeze-csv", 120);
  if (!gate.ok) return stampNoindex(gate.response);
  const params = await context.params;
  const monthParam = params.month ?? params["month.csv"] ?? "";
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
    const publication = await readMonthlyFreezePublic(db, parsed.month);
    if (publication.status === MONTHLY_FREEZE_STATUS_NOT_CLOSED) {
      return NextResponse.json(
        { status: publication.status, month: publication.month, message: "That UTC month has not closed yet." },
        { status: 400, headers: withNoindex(gate.headers) },
      );
    }
    if (publication.status === MONTHLY_FREEZE_STATUS_NOT_FROZEN_YET) {
      return NextResponse.json(
        {
          status: publication.status,
          month: publication.month,
          message:
            "That month is not frozen yet. vet402 publishes the freeze on or after 00:00 UTC on the 1st day of the next month.",
        },
        { status: 404, headers: withNoindex(gate.headers) },
      );
    }
    const stored = await loadMonthlyFreezeCsvBody(db, parsed.month);
    if (!stored) {
      return NextResponse.json(
        { status: MONTHLY_FREEZE_STATUS_NOT_FROZEN_YET, month: parsed.month, message: "That month is not frozen yet." },
        { status: 404, headers: withNoindex(gate.headers) },
      );
    }
    const digest = createHash("sha256").update(stored.contentCsv, "utf8").digest("hex");
    if (digest !== stored.contentSha256) {
      logServerErrorSafe("reports.monthly-freeze.csv", new Error("content_sha256 does not match stored content_csv"));
      return NextResponse.json(
        { error: "unavailable", message: "The monthly freeze store could not be read." },
        { status: 503, headers: withNoindex(gate.headers) },
      );
    }
    return new NextResponse(stored.contentCsv, {
      headers: withNoindex({
        ...gate.headers,
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="vet402-ledger-${parsed.month}.csv"`,
        "x-vet402-content-sha256": stored.contentSha256,
        "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=7200",
      }),
    });
  } catch (error) {
    logServerErrorSafe("reports.monthly-freeze.csv", error);
    return NextResponse.json(
      { error: "unavailable", message: "The monthly freeze store could not be read." },
      { status: 503, headers: withNoindex(gate.headers) },
    );
  }
}

const __disallowed = exportDisallowedMethodHandlers(["GET"]);
export const { POST, PUT, PATCH, DELETE, OPTIONS } = __disallowed;
export const HEAD = headFromGet(GET);