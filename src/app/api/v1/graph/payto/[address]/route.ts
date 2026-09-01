import { NextRequest, NextResponse } from "next/server";
import { authorizeApiRequest, withRateLimitHeaders } from "@/lib/api/guard";
import { computePayToGraph } from "@/lib/scoring/graph";
import { logServerError } from "@/lib/util/log";

/**
 * GET /api/v1/graph/payto/{address} — payToグラフ v0（キー付き）。
 * 隣接の事実のみ（src/lib/scoring/graph.ts 冒頭）。推論はしない。
 */
export const maxDuration = 15;

type RouteContext = { params: Promise<{ address: string }> };
const ADDR_RE = /^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;

// 2026-09-02 監査: 静的化された route handler が prerender から古い判定を返すのを防ぐ（09c1fa0 と同じ欠陥）。
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await authorizeApiRequest(request, 1);
  if (!auth.ok) return auth.error;
  const { address } = await context.params;
  if (!ADDR_RE.test(address)) {
    return NextResponse.json({ error: "invalid_wallet_address" }, { status: 400 });
  }
  try {
    const graph = await computePayToGraph(address);
    if (!graph) return NextResponse.json({ error: "graph_unavailable" }, { status: 503 });
    return withRateLimitHeaders(NextResponse.json(graph), auth.ctx.rateLimit);
  } catch (error) {
    logServerError("payto_graph", error);
    return NextResponse.json({ error: "graph_unavailable" }, { status: 503 });
  }
}
