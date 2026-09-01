import { NextRequest, NextResponse } from "next/server";
import { publicRateLimit } from "@/lib/api/public-route";
import { getCensusSummary, type CensusWindow } from "@/lib/settlements/census";
import { toCaip2 } from "@/lib/observatory/chains";
import { logServerError } from "@/lib/util/log";

// §9.1: GET /api/v1/census/summary?chain=&window=7d|30d
// 生値（raw）と実需（real = wash/test 除外）を同じ応答で両方返す。混ぜない（§7.2）。
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const gate = await publicRateLimit(request, "census", 60);
  if (!gate.ok) return gate.response;
  const params = request.nextUrl.searchParams;
  const windowRaw = params.get("window") ?? "30d";
  if (windowRaw !== "7d" && windowRaw !== "30d") {
    return NextResponse.json({ error: "invalid_window" }, { status: 400, headers: gate.headers });
  }
  const chainRaw = params.get("chain");
  const chain = chainRaw ? toCaip2(chainRaw) : null;
  if (chainRaw && (!chain || chain.length > 64)) {
    return NextResponse.json({ error: "invalid_chain" }, { status: 400, headers: gate.headers });
  }
  try {
    const summary = await getCensusSummary(chain, windowRaw as CensusWindow);
    return NextResponse.json(summary, { headers: { ...gate.cacheHeaders, "Cache-Control": "public, s-maxage=300, stale-while-revalidate=900" } });
  } catch (error) {
    logServerError("census.summary", error);
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers: gate.headers });
  }
}
