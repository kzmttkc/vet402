import { NextRequest, NextResponse } from "next/server";
import { authorizeApiRequest, refundRateLimitUnits, withRateLimitHeaders } from "@/lib/api/guard";
import { isValidAddress } from "@/lib/chain/client";
import { persistPayeeScoreResult } from "@/lib/db/persistence";
import { scorePayeeWallet } from "@/lib/scoring/payee-engine";
import { logServerError } from "@/lib/util/log";

type RouteContext = { params: Promise<{ address: string }> };

export const maxDuration = 30;

/**
 * GET /api/v1/payees/{address}/score
 *
 * Buyer-side counterpart to /v1/wallets/{address}/score and
 * /v1/agents/{agentId}/score: those answer "should I accept payment from
 * this agent/wallet?" (seller-side screening); this answers "should my
 * agent pay this wallet?" (buyer-side screening before an x402 payment is
 * sent). Never 404s for an unfamiliar wallet — data-poor wallets still get
 * a 200 with `dataDepth: "thin"` so callers can weigh the score's
 * confidence themselves, mirroring the existing dataCoverage pattern.
 */
// 2026-09-02 監査: 静的化された route handler が prerender から古い判定を返すのを防ぐ（09c1fa0 と同じ欠陥）。
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await authorizeApiRequest(request, 1);
  if (!auth.ok) return auth.error;

  const { address } = await context.params;
  if (!isValidAddress(address)) {
    return NextResponse.json({ error: "invalid_wallet_address" }, { status: 400 });
  }

  try {
    const result = await scorePayeeWallet(address);
    // Same fire-and-forget pattern as the wallet/agent score routes: payee
    // queries must land in trust_events so external API-key usage of the
    // buyer-side endpoint stays measurable (it gates feature C's go/no-go).
    void persistPayeeScoreResult(auth.ctx.apiKeyId, result).catch((error) =>
      logServerError("persist_payee_score", error),
    );
    return withRateLimitHeaders(NextResponse.json(result), auth.ctx.rateLimit);
  } catch (error) {
    logServerError("score_payee", error);
    // 2026-08-15 (audit): see agents/[agentId]/score for rationale.
    void refundRateLimitUnits(auth.ctx, 1);
    return NextResponse.json({ error: "scoring_unavailable" }, { status: 503 });
  }
}
