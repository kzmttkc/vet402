import { NextRequest, NextResponse } from "next/server";
import {
  applyRateLimit,
  authenticateApiRequest,
  withRateLimitHeaders,
} from "@/lib/api/guard";
import { parseAgentId } from "@/lib/chain/client";
import { getScoreHistory } from "@/lib/db/persistence";

type RouteContext = { params: Promise<{ agentId: string }> };

const PRO_PLANS = new Set(["pro", "scale"]);

// 2026-09-02 監査: 静的化された route handler が prerender から古い判定を返すのを防ぐ（09c1fa0 と同じ欠陥）。
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: RouteContext) {
  const { agentId: agentIdParam } = await context.params;
  const agentId = parseAgentId(agentIdParam);
  if (agentId === null) {
    return NextResponse.json({ error: "invalid_agent_id" }, { status: 400 });
  }

  const auth = await authenticateApiRequest(request);
  if (!auth.ok) return auth.error;

  if (!PRO_PLANS.has(auth.ctx.plan)) {
    return NextResponse.json({ error: "plan_upgrade_required" }, { status: 403 });
  }

  const limited = await applyRateLimit(auth.ctx, 1);
  if (!limited.ok) return limited.error;

  const limitParam = request.nextUrl.searchParams.get("limit");
  const limit = limitParam ? Math.min(100, Math.max(1, Number(limitParam) || 20)) : 20;

  const history = await getScoreHistory(auth.ctx.apiKeyId, agentId, limit);

  return withRateLimitHeaders(
    NextResponse.json({
      agentId: agentId.toString(),
      history,
    }),
    limited.rateLimit,
  );
}
