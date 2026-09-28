import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import {
  consumeIpRateLimit,
  ipRateLimitHeaders,
  sharedCacheRateLimitHeaders,
} from "@/lib/api/ip-rate-limit";
import { scoreAgentById } from "@/lib/scoring/engine";
import { hasUnavailableInput } from "@/lib/scoring/verdict";
import { logServerErrorSafe } from "@/lib/util/log-safe";

/**
 * GET /api/demo/score — the one unauthenticated score on the site.
 *
 * WHY (2026-08-05 R&D): the homepage showed a hard-coded "sample response".
 * For a product whose entire pitch is "our score is computed from real chain
 * data", a fabricated 78 is the weakest possible first impression — a visitor
 * cannot tell it from marketing fiction, because it is marketing fiction.
 * This endpoint scores ONE fixed, publicly registered ERC-8004 agent so the
 * homepage can show a number that was actually computed, timestamped, and
 * re-computed while you watch.
 *
 * Abuse posture, in order:
 *   1. The agent id is fixed server-side (env DEMO_AGENT_ID, default 1).
 *      Nothing the caller sends selects what gets scored — this is a demo,
 *      not a free lookup API.
 *   2. Cross-request result cache (module scope, 5 min — same TTL as the
 *      scoring engine's own cache) so a page-view storm costs zero RPC.
 *   3. IP rate limit as the backstop for cache-miss storms.
 *   4. Everything returned is derived from public chain state; there is no
 *      customer data on this path (no apiKeyId → no manual lists).
 *
 * Failure posture: this endpoint must never look better than the truth.
 * If the score cannot be computed, it says so ({ live: false }) and the page
 * keeps its clearly-labelled static sample — it does NOT serve a stale
 * number as if it were fresh beyond the cache window.
 */

const DEMO_TTL_MS = 5 * 60 * 1000;
const RATE_LIMIT = 10; // per IP per minute — humans reloading, not scrapers
const RATE_WINDOW_MS = 60 * 1000;
// 2026-08-06 UX audit: a hang inside scoreAgentById (e.g. a slow/unreachable
// RPC several calls deep) is not a rejection, so the try/catch below never
// fires and the request hangs until the platform kills it (504, reproduced
// 3/3 by a persona audit and independently by curl — timeout, not error).
// This endpoint's own contract is "must never look better than the truth,"
// which a hang violates worse than a fast { live: false } ever could. Race
// against a timeout well under Vercel's function limit so a slow dependency
// degrades to the documented failure response instead of hanging the page.
const SCORE_TIMEOUT_MS = 8_000;
// The engine's base disclaimer, for the response shapes that carry no verdict
// to take one from. Kept identical to engine.ts's default string.
const DISCLAIMER =
  "Scores are informational only and do not constitute a guarantee, credit assessment, or investment advice.";

type DemoPayload = {
  live: true;
  agentId: string;
  trustScore: number;
  recommendation: string;
  walletAgeDays: number;
  x402PaymentCount: number;
  sybilRisk: string;
  registered: boolean;
  scoredAt: string;
  // 2026-08-13 (machine-reader persona audit): `live: true` was the only
  // freshness signal on a value measured at up to 5.5 minutes old, and the
  // sibling key-less endpoint (/api/v1/agents/{id}/passport) has published
  // scoredAt + cacheExpiresAt as a pair since it shipped. A machine could read
  // when this was computed but not when it stops being the current answer.
  // Taken from the engine's own result, not from this route's module cache, so
  // no surface can claim a longer life for a verdict than the engine gives it
  // (the rule tests/verdict-consistency.test.ts pins).
  cacheExpiresAt: string;
  // The per-verdict disclaimer the engine issued. /faq states as a
  // machine-checkable fact that it travels in the payload; it did not travel
  // here, on the one endpoint an anonymous machine is most likely to hit first.
  disclaimer: string;
  // 2026-08-13: was computed below and used only to pick a Cache-Control, so
  // the one fact that changes how this number should be read never left the
  // server. A caller saw `78 / ALLOW` and `39 / BLOCK` in the same shape, with
  // nothing in the body distinguishing "we checked" from "we could not finish
  // checking, so we fail closed". Additive and machine-readable, matching what
  // /payee already says in prose and what the v1 payee score returns as
  // `degraded`. Only meaningful when `live` is true — a `{ live: false }`
  // response is the absence of a verdict, not a degraded one.
  degraded: boolean;
};

let cached: { payload: DemoPayload; expiresAt: number } | null = null;

function demoAgentId(): bigint {
  try {
    return BigInt(process.env.DEMO_AGENT_ID ?? "1");
  } catch {
    return BigInt(1);
  }
}

export async function GET(request: NextRequest) {
  const now = Date.now();

  // Limiter runs BEFORE the cache short-circuit (2026-08-13). A cache hit
  // previously skipped it entirely, so the documented 10/min/IP was not applied
  // to most traffic and — the reported defect — the response carried no
  // RateLimit-* headers, leaving a machine unable to read its own budget.
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`demo-score:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  // Two header sets, because most responses here are served to other callers
  // from the shared CDN cache: `perCaller` (Remaining/Reset/Retry-After) goes
  // only on responses the CDN does not share, `shared` carries the ceiling,
  // which is true for everyone. See sharedCacheRateLimitHeaders.
  const perCallerRlHeaders = ipRateLimitHeaders(limited);
  const rlHeaders = sharedCacheRateLimitHeaders(limited);
  if (!limited.allowed) {
    // 2026-08-06: emit the full RateLimit-* set (not just Retry-After) so the
    // key-less paths share one visible contract.
    return NextResponse.json(
      { live: false, reason: "rate_limited" },
      { status: 429, headers: perCallerRlHeaders },
    );
  }

  if (cached && cached.expiresAt > now) {
    return NextResponse.json(cached.payload, {
      headers: {
        ...rlHeaders,
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
      },
    });
  }

  try {
    const result = await Promise.race([
      scoreAgentById(demoAgentId()),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("demo_score_timeout")), SCORE_TIMEOUT_MS),
      ),
    ]);
    const degraded = hasUnavailableInput(result.signals.sybil.flags);
    const payload: DemoPayload = {
      live: true,
      agentId: result.agentId,
      trustScore: result.trustScore,
      recommendation: result.recommendation,
      walletAgeDays: result.signals.wallet.ageDays,
      x402PaymentCount: result.signals.x402.paymentCount,
      sybilRisk: result.signals.sybil.risk,
      registered: result.signals.identity.registered,
      scoredAt: result.scoredAt,
      cacheExpiresAt: result.cacheExpiresAt,
      disclaimer: result.disclaimer,
      degraded,
    };
    // A degraded verdict (some input could not be read) is deliberately NOT
    // pinned. The engine already refuses to cache one; this route used to pin
    // it anyway for 5 minutes and hand the CDN another 15, which is how a
    // momentary Blockscout rate-limit became a quarter-hour of the showcase
    // agent reading 48/BLOCK — and how this endpoint came to disagree with
    // /agent/{id} and the passport at the same instant. One freshness policy,
    // one definition of degraded, shared with the engine.
    //
    // Still cached briefly rather than not at all: while upstream is unwell,
    // recomputing on every request is what deepens the outage.
    if (!degraded) {
      cached = { payload, expiresAt: now + DEMO_TTL_MS };
    }
    return NextResponse.json(payload, {
      headers: {
        ...rlHeaders,
        "Cache-Control": degraded
          ? "public, s-maxage=30"
          : "public, s-maxage=300, stale-while-revalidate=600",
      },
    });
  } catch (error) {
    logServerErrorSafe("demo_score", error);
    return NextResponse.json(
      // A `{ live: false }` body is the absence of a verdict, so it carries no
      // scoredAt/cacheExpiresAt to be stale about — but it still carries the
      // disclaimer, because "it travels with the data" has to hold on the
      // response a caller is most likely to log verbatim and least likely to
      // re-read the docs for.
      { live: false, reason: "unavailable", disclaimer: DISCLAIMER },
      { status: 200, headers: { ...rlHeaders, "Cache-Control": "public, s-maxage=60" } },
    );
  }
}
