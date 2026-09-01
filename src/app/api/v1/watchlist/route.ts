import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { applyRateLimit, authenticateApiRequest, withRateLimitHeaders } from "@/lib/api/guard";
import { isValidAddress, parseAgentId } from "@/lib/chain/client";
import { MAX_WATCHLIST_PER_KEY, addWatch, listWatchlist } from "@/lib/watchlist";
import { logServerError } from "@/lib/util/log";

// N-15 — GET lists this key's watches; POST adds one. Verdict changes arrive
// via the `watch.verdict_changed` webhook (register one at /api/v1/webhooks).
const schema = z.object({
  targetType: z.enum(["agent", "wallet"]),
  target: z.string().min(1).max(80),
  chainId: z.number().int().optional(),
});

// 2026-09-02 監査: 静的化された route handler が prerender から古い判定を返すのを防ぐ（09c1fa0 と同じ欠陥）。
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await authenticateApiRequest(request);
  if (!auth.ok) return auth.error;
  try {
    return NextResponse.json({ watchlist: await listWatchlist(auth.ctx.apiKeyId) });
  } catch (error) {
    logServerError("watchlist_list", error);
    return NextResponse.json({ error: "watchlist_unavailable" }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await authenticateApiRequest(request);
  if (!auth.ok) return auth.error;
  const limited = await applyRateLimit(auth.ctx, 1);
  if (!limited.ok) return limited.error;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request", details: parsed.error.flatten() }, { status: 400 });
  }
  const { targetType, target, chainId } = parsed.data;
  if (targetType === "wallet" && !isValidAddress(target)) {
    return NextResponse.json({ error: "invalid_wallet_address" }, { status: 400 });
  }
  if (targetType === "agent" && parseAgentId(target) === null) {
    return NextResponse.json({ error: "invalid_agent_id" }, { status: 400 });
  }

  try {
    const result = await addWatch({ apiKeyId: auth.ctx.apiKeyId, targetType, target, chainId });
    if ("error" in result) {
      return result.error === "limit_reached"
        ? NextResponse.json(
            { error: "limit_reached", detail: `Max ${MAX_WATCHLIST_PER_KEY} watches per key.` },
            { status: 409 },
          )
        : NextResponse.json({ error: "watchlist_unavailable" }, { status: 503 });
    }
    return withRateLimitHeaders(NextResponse.json({ ok: true, id: result.id }, { status: 201 }), limited.rateLimit);
  } catch (error) {
    logServerError("watchlist_add", error);
    return NextResponse.json({ error: "watchlist_unavailable" }, { status: 503 });
  }
}
