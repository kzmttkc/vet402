import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit, ipRateLimitHeaders } from "@/lib/api/ip-rate-limit";
import { getDb } from "@/lib/db/client";
import { agentPassports } from "@/lib/db/schema";
import { parseAgentId } from "@/lib/chain/client";
import { agentBadgeState, renderBadgeSvg, type AgentBadgeScoreView } from "@/lib/badge/trust-badge";
import { scoreAgentById } from "@/lib/scoring/engine";
import { logServerError } from "@/lib/util/log";

// A-10 — embeddable SVG badge for an agent passport, the twin of the payee
// badge (/api/badge/[address]). H-1/H-5 (2026-08-13 R4): the same trust
// linkage as the payee badge — a signed passport alone no longer mints the
// green "Verified agent". Green is earned only when the passport is signed AND
// the live vet402 agent score is a clean ALLOW; BLOCK shows "Flagged"
// (revocation), and WARN / a failed lookup fail-closed to "Caution".
export const revalidate = 300;

// Key-less path: each distinct agentId is a cache-miss DB lookup and the id is
// attacker-chosen, so cap per IP. Generous — legit embeds serve from the CDN
// cache and never reach here.
const BADGE_LIMIT = 60;
const BADGE_WINDOW_MS = 60_000;

// 2026-09-02 監査: 静的化された route handler が prerender から古い判定を返すのを防ぐ（09c1fa0 と同じ欠陥）。
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`agent-badge:${ip}`, BADGE_LIMIT, BADGE_WINDOW_MS);
  if (!limited.allowed) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: ipRateLimitHeaders(limited) },
    );
  }
  const { agentId: agentIdParam } = await params;
  const agentId = parseAgentId(agentIdParam.replace(/\.svg$/, ""));
  if (agentId === null) {
    return NextResponse.json({ error: "invalid_agent_id" }, { status: 400 });
  }
  let signed = false;
  const db = getDb();
  if (db) {
    try {
      const rows = await db
        .select({ agentId: agentPassports.agentId })
        .from(agentPassports)
        .where(eq(agentPassports.agentId, agentId))
        .limit(1);
      signed = rows.length > 0;
    } catch {
      signed = false;
    }
  }

  // Score only a signed passport (see the payee badge for the rationale).
  // Fail-closed: any error leaves the score null, which agentBadgeState keeps
  // out of green. `degraded` is derived FROM the score's own sybil flags inside
  // agentBadgeState — the whole score is carried there rather than just
  // `recommendation`, so a fail-closed read reads amber "Caution" (symmetric
  // with the payee badge), never accusatory red "Flagged". See trust-badge.ts.
  let score: AgentBadgeScoreView | null = null;
  if (signed) {
    try {
      score = await scoreAgentById(agentId);
    } catch (error) {
      logServerError("badge_agent_score", error);
      score = null;
    }
  }

  const state = agentBadgeState(signed, score);
  return new NextResponse(renderBadgeSvg(state), {
    headers: {
      "Content-Type": "image/svg+xml",
      // 5-minute edge cache so a revocation surfaces quickly; see the payee
      // badge note on why the 1-hour window must not come back.
      "Cache-Control": "public, s-maxage=300, stale-while-revalidate=300",
    },
  });
}
