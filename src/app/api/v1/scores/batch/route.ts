import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  applyRateLimit,
  authenticateApiRequest,
  refundRateLimitUnits,
  withRateLimitHeaders,
} from "@/lib/api/guard";
import { isValidAddress, parseAgentId } from "@/lib/chain/client";
import { persistScoreResult } from "@/lib/db/persistence";
import { logServerError } from "@/lib/util/log";
import { scoreAgentById } from "@/lib/scoring/engine";
import { mapWithConcurrency } from "@/lib/util/concurrency";

const BATCH_CONCURRENCY = 3;

const batchSchema = z.object({
  agents: z
    .array(
      z.object({
        agentId: z.string(),
        wallet: z.string().optional(),
      }),
    )
    .min(1)
    .max(25),
});

// 2026-09-02 監査: 静的化された route handler が prerender から古い判定を返すのを防ぐ（09c1fa0 と同じ欠陥）。
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const auth = await authenticateApiRequest(request);
  if (!auth.ok) return auth.error;

  const body = await request.json().catch(() => null);
  const parsed = batchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const validItems: Array<{ agentId: string; wallet?: string; parsedId: bigint }> = [];
  const invalidResults: Array<{ agentId: string; error: string }> = [];

  for (const item of parsed.data.agents) {
    if (item.wallet && !isValidAddress(item.wallet)) {
      invalidResults.push({ agentId: item.agentId, error: "invalid_wallet_address" });
      continue;
    }

    const agentId = parseAgentId(item.agentId);
    if (agentId === null) {
      invalidResults.push({ agentId: item.agentId, error: "invalid_agent_id" });
      continue;
    }

    validItems.push({ agentId: item.agentId, wallet: item.wallet, parsedId: agentId });
  }

  if (validItems.length === 0) {
    return NextResponse.json({ results: invalidResults });
  }

  const limited = await applyRateLimit(auth.ctx, validItems.length);
  if (!limited.ok) return limited.error;

  const scored = await mapWithConcurrency(
    validItems,
    BATCH_CONCURRENCY,
    async (item) => {
      try {
        const score = await scoreAgentById(item.parsedId, {
          apiKeyId: auth.ctx.apiKeyId,
          verifyWallet: item.wallet,
        });

        void persistScoreResult(auth.ctx.apiKeyId, score).catch((error) =>
          logServerError("persist_score", error),
        );
        return score;
      } catch {
        return { agentId: item.agentId, error: "scoring_unavailable" as const };
      }
    },
  );

  // 2026-08-15 (audit): the reservation above spent validItems.length units;
  // credit back one unit per item that never got an answer, mirroring the
  // single-item score routes.
  const failedCount = scored.filter(
    (r): r is { agentId: string; error: "scoring_unavailable" } =>
      typeof r === "object" && r !== null && "error" in r && r.error === "scoring_unavailable",
  ).length;
  if (failedCount > 0) {
    void refundRateLimitUnits(auth.ctx, failedCount);
  }

  return withRateLimitHeaders(
    NextResponse.json({ results: [...invalidResults, ...scored] }),
    limited.rateLimit,
  );
}
