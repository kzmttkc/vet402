import { NextRequest, NextResponse } from "next/server";
import {
  applyRateLimit,
  authenticateApiRequest,
  refundRateLimitUnits,
  withRateLimitHeaders,
} from "@/lib/api/guard";
import { isValidAddress, parseAgentId } from "@/lib/chain/client";
import { chainBySlug, enabledChainSlugs, isChainEnabled } from "@/lib/chain/chains";
import { persistScoreResult } from "@/lib/db/persistence";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { scoreAgentById } from "@/lib/scoring/engine";
import { withScoreDeprecationBody, withScoreDeprecationHeaders } from "@/lib/api/score-deprecation";

type RouteContext = { params: Promise<{ agentId: string }> };

// 2026-09-02 監査: 静的化された route handler が prerender から古い判定を返すのを防ぐ（09c1fa0 と同じ欠陥）。
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await authenticateApiRequest(request);
  if (!auth.ok) return auth.error;

  const { agentId: agentIdParam } = await context.params;
  const agentId = parseAgentId(agentIdParam);
  if (agentId === null) {
    return NextResponse.json({ error: "invalid_agent_id" }, { status: 400 });
  }

  const verifyWallet = request.nextUrl.searchParams.get("wallet") ?? undefined;
  if (verifyWallet && !isValidAddress(verifyWallet)) {
    return NextResponse.json({ error: "invalid_wallet_address" }, { status: 400 });
  }

  // ?chain=base|ethereum (2026-08-05, C-8). Omitted = Base, byte-identical to
  // the pre-multichain behaviour. An unknown or not-enabled chain is a 400
  // with the live list — never a silent fallback to a different chain, which
  // would score the wrong registration.
  const chainSlug = request.nextUrl.searchParams.get("chain");
  let chainId: number | undefined;
  if (chainSlug) {
    const chain = chainBySlug(chainSlug);
    if (!chain || !isChainEnabled(chain)) {
      return NextResponse.json(
        { error: "unsupported_chain", supported: enabledChainSlugs() },
        { status: 400 },
      );
    }
    chainId = chain.id;
  }

  const limited = await applyRateLimit(auth.ctx, 1);
  if (!limited.ok) return limited.error;

  try {
    const result = await scoreAgentById(agentId, {
      apiKeyId: auth.ctx.apiKeyId,
      verifyWallet,
      chainId,
    });

    void persistScoreResult(auth.ctx.apiKeyId, result).catch((error) =>
      logServerErrorSafe("persist_score", error),
    );

    // 2026-09-29: 非推奨を応答そのものに載せる（値は変えない・score-deprecation.ts）。
    return withScoreDeprecationHeaders(
      withRateLimitHeaders(NextResponse.json(withScoreDeprecationBody(result)), limited.rateLimit),
    );
  } catch (error) {
    logServerErrorSafe("score_agent", error);
    // 2026-08-15 (audit): the reservation above already spent 1 unit; this
    // request never got an answer, so credit it back rather than charging
    // the caller for an outage on our end.
    void refundRateLimitUnits(auth.ctx, 1);
    return NextResponse.json({ error: "scoring_unavailable" }, { status: 503 });
  }
}
