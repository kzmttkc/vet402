import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import {
  consumeIpRateLimit,
  ipRateLimitHeaders,
  sharedCacheRateLimitHeaders,
} from "@/lib/api/ip-rate-limit";
import { getAnchors } from "@/lib/observatory/anchors";
import { logServerError } from "@/lib/util/log";

/**
 * GET /api/v1/observatory/anchors?days=30 — 台帳ハッシュチェーン、データとして。
 *
 * 各 UTC 日の root は「前日root + その日の全L1行の正規化JSON」の sha256。
 * 再計算手順はコード（src/lib/observatory/anchors.ts）が正典で、この
 * リポは公開されている——第三者は export.csv と合わせて末尾から検算できる。
 * anchoredTx が入った root はオンチェーンにも存在する（刻印は段階導入）。
 */

const RL_LIMIT = 30;
const RL_WINDOW_MS = 60_000;

// 2026-09-02 監査: 静的化された route handler が prerender から古い判定を返すのを防ぐ（09c1fa0 と同じ欠陥）。
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`observatory-anchors:${ip}`, RL_LIMIT, RL_WINDOW_MS);
  const perCaller = ipRateLimitHeaders(limited);
  const shared = sharedCacheRateLimitHeaders(limited);
  if (!limited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: perCaller });
  }
  const daysParam = request.nextUrl.searchParams.get("days");
  const days = daysParam === null ? 30 : Number(daysParam);
  if (!Number.isFinite(days)) {
    return NextResponse.json({ error: "invalid_days" }, { status: 400, headers: perCaller });
  }
  try {
    const anchors = await getAnchors(days);
    return NextResponse.json(
      {
        anchors,
        recompute:
          "root = sha256((prevRoot ?? 'genesis') + '\\n' + canonical day JSON of all L1 rows, pk-ascending); projection: src/lib/observatory/anchors.ts (open source). Third parties can verify chain LINKING from this API alone (cli/verify-anchors.ts); recomputing a root needs the raw rows — self-host the open-source stack or use per-endpoint receipts.",
        humanReadable: "https://vet402.com/observatory/state",
      },
      { headers: { ...shared, "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=7200" } },
    );
  } catch (error) {
    logServerError("observatory_anchors", error);
    return NextResponse.json({ error: "observatory_unavailable" }, { status: 503, headers: perCaller });
  }
}
