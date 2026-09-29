import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit, ipRateLimitHeaders } from "@/lib/api/ip-rate-limit";
import { getDb } from "@/lib/db/client";
import { SELLER_EXPORT_COLUMN_NOTES, SELLER_EXPORT_COLUMNS } from "@/lib/sellers/export";
import { readSellerExport } from "@/lib/sellers/reader";
import { csvLines } from "@/lib/util/csv-write";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { acquireExportSlot, exportBusyResponse, rejectUnknownQuery } from "@/lib/api/export-guard";

/**
 * GET /api/v1/sellers/export.csv — /sellers の区分の元データ（2026-09-29 監査 5 周目・データ記者の立場）。
 *
 * 1 行 = Base の掲載中の出品 1 つ。その最新の購入行を /sellers と同じ関数（fix-modes.ts の classifySellerRow）で
 * 振り分けた結果（outcome・fix_mode・side_label・confirmed_seller）と、その行の事実（status・時刻・HTTP・id）。
 * 行を outcome で数えると /sellers の見出しの件数になる。新しい判定はここでは生まれない（分類は読むだけ）。
 *
 * /sellers は帰属（どちら側か）の見直しが済むまで noindex なので、この CSV も X-Robots-Tag: noindex で出す。
 * 列の定義はヘッダ（x-vet402-column-notes）と openapi に。取得時刻は x-vet402-retrieved-at。
 */

const RL_LIMIT = 6;
const RL_WINDOW_MS = 60_000;

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`sellers-export:${ip}`, RL_LIMIT, RL_WINDOW_MS);
  const perCaller = ipRateLimitHeaders(limited);
  if (!limited.allowed) {
    const status = limited.unavailable ? 503 : 429;
    return NextResponse.json({ error: limited.unavailable ? "temporarily_unavailable" : "rate_limited" }, { status, headers: perCaller });
  }
  // 2026-09-29 監査 6 周目: クエリは受け取らない（`?cb=<乱数>` で CDN を迂回させない）。DB を読むのは export 全体で 1 本。
  const badQuery = rejectUnknownQuery(request.nextUrl.searchParams, [], perCaller);
  if (badQuery) return badQuery;
  const db = getDb();
  if (!db) return NextResponse.json({ error: "observatory_unavailable" }, { status: 503, headers: perCaller });
  const slot = await acquireExportSlot();
  if (!slot.ok) return exportBusyResponse(slot, perCaller);
  try {
    const { fetchedAt, rows } = await readSellerExport(db);
    return new NextResponse(csvLines(SELLER_EXPORT_COLUMNS, rows), {
      headers: {
        ...perCaller,
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="vet402-sellers-base.csv"',
        "x-robots-tag": "noindex",
        "x-vet402-license": "CC-BY-4.0",
        "x-vet402-retrieved-at": fetchedAt,
        "x-vet402-rows": String(rows.length),
        "x-vet402-column-notes": SELLER_EXPORT_COLUMN_NOTES,
        Link:
          '<https://creativecommons.org/licenses/by/4.0/>; rel="license", ' +
          '<https://vet402.com/sellers>; rel="describedby"',
        "Cache-Control": "public, s-maxage=900, stale-while-revalidate=1800",
      },
    });
  } catch (error) {
    logServerErrorSafe("sellers_export", error);
    return NextResponse.json({ error: "observatory_unavailable" }, { status: 503, headers: perCaller });
  } finally {
    await slot.release();
  }
}
