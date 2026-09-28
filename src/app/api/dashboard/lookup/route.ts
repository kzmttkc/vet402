import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isValidAddress, parseAgentId } from "@/lib/chain/client";
import { authorizeDashboardRequest } from "@/lib/dashboard/auth";
import { persistPayeeScoreResult, persistScoreResult } from "@/lib/db/persistence";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { scoreAgentById } from "@/lib/scoring/engine";
import { scorePayeeWallet } from "@/lib/scoring/payee-engine";

const lookupSchema = z.object({
  agentId: z.string().optional(),
  wallet: z.string().optional(),
});

export async function POST(request: NextRequest) {
  // 2026-08-15 (audit): auth used to run after body parsing/validation, so an
  // unauthenticated caller could distinguish invalid_wallet_address /
  // invalid_agent_id / session_required from an unauthenticated POST — a
  // parser-shape oracle with no other effect (scoring/DB/billing all still
  // sit behind this check). Every other dashboard route authorizes first;
  // matching that order here closes the oracle for free.
  const auth = await authorizeDashboardRequest(request, 1);
  if (!auth.ok) return auth.error;

  const body = await request.json().catch(() => null);
  const parsed = lookupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const { agentId, wallet } = parsed.data;
  if (!agentId && !wallet) {
    return NextResponse.json({ error: "agent_id_or_wallet_required" }, { status: 400 });
  }

  if (wallet && !isValidAddress(wallet)) {
    return NextResponse.json({ error: "invalid_wallet_address" }, { status: 400 });
  }

  if (agentId) {
    const id = parseAgentId(agentId);
    if (id === null) {
      return NextResponse.json({ error: "invalid_agent_id" }, { status: 400 });
    }
  }

  const ctx = { apiKeyId: auth.ctx.apiKeyId };

  try {
    if (agentId) {
      const id = parseAgentId(agentId)!;
      const result = await scoreAgentById(id, { ...ctx, verifyWallet: wallet });
      void persistScoreResult(auth.ctx.apiKeyId, result).catch((error) =>
        logServerErrorSafe("persist_score", error),
      );
      return NextResponse.json(result);
    }

    const result = await scorePayeeWallet(wallet!);
    void persistPayeeScoreResult(auth.ctx.apiKeyId, result).catch((error) =>
      logServerErrorSafe("persist_score", error),
    );
    return NextResponse.json({ kind: "payee", ...result });
  } catch {
    return NextResponse.json({ error: "scoring_unavailable" }, { status: 503 });
  }
}
