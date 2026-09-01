import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit, ipRateLimitHeaders } from "@/lib/api/ip-rate-limit";
import { getDb } from "@/lib/db/client";
import { verifiedPayees } from "@/lib/db/schema";
import { isValidAddress } from "@/lib/chain/client";
import { payeeBadgeState, renderBadgeSvg, type PayeeBadgeScoreView } from "@/lib/badge/trust-badge";
import { scorePayeeWallet } from "@/lib/scoring/payee-engine";
import { logServerError } from "@/lib/util/log";

// N-16 — embeddable SVG badge. H-1/H-5 (2026-08-13 R4): the green "Verified
// payee" is no longer minted by a self-signed claim alone — it is earned only
// when ownership is signed AND the live vet402 score is a clean ALLOW. A BLOCK
// verdict shows "Flagged" (the revocation path), and WARN / a degraded read /
// a failed lookup fail-closed to "Caution". See @/lib/badge/trust-badge.
//
// Freshness: because the badge now reflects a live verdict that can flip
// (revocation), the CDN window is cut to the score's own 5-minute cache TTL so
// a BLOCK transition cannot keep serving a green badge for an hour.
export const revalidate = 300;

// 2026-08-06 security (self-audit item 1): key-less path. Each distinct
// address is a cache-miss that costs a DB lookup, and the address is
// attacker-chosen (unlike a CDN-cached hit), so an unbounded /api/badge/:addr
// loop over fresh addresses bypasses the cache entirely. Cap per IP. Generous
// because legit embeds are served from the CDN cache and never reach here.
const BADGE_LIMIT = 60;
const BADGE_WINDOW_MS = 60_000;

// 2026-09-02 監査: 静的化された route handler が prerender から古い判定を返すのを防ぐ（09c1fa0 と同じ欠陥）。
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`badge:${ip}`, BADGE_LIMIT, BADGE_WINDOW_MS);
  if (!limited.allowed) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: ipRateLimitHeaders(limited) },
    );
  }
  const { address } = await params;
  const clean = address.replace(/\.svg$/, "");
  if (!isValidAddress(clean)) {
    return NextResponse.json({ error: "invalid_address" }, { status: 400 });
  }
  const walletLower = clean.toLowerCase();
  let signed = false;
  const db = getDb();
  if (db) {
    try {
      const rows = await db
        .select({ wallet: verifiedPayees.wallet })
        .from(verifiedPayees)
        .where(eq(verifiedPayees.wallet, walletLower))
        .limit(1);
      signed = rows.length > 0;
    } catch {
      signed = false;
    }
  }

  // Only consult the (heavier) live score once we know a signed claim exists —
  // an unsigned wallet is "Unverified" regardless, so the common attacker
  // probe over fresh addresses never pays the scoring cost. Fail-closed: any
  // error or timeout leaves recommendation null, which resolveBadgeState keeps
  // out of green.
  // Carry the whole score to payeeBadgeState, which derives `degraded` from the
  // engine's explicit flag AND the unavailable-input flags (the same derivation
  // the agent badge uses). Fail-closed: any error leaves the score null, kept
  // out of green. See trust-badge.ts for why the derivation lives there.
  let score: PayeeBadgeScoreView | null = null;
  if (signed) {
    try {
      score = await scorePayeeWallet(clean);
    } catch (error) {
      logServerError("badge_payee_score", error);
      score = null;
    }
  }

  const state = payeeBadgeState(signed, score);
  return new NextResponse(renderBadgeSvg(state), {
    headers: {
      "Content-Type": "image/svg+xml",
      // 5-minute edge cache matches the score's own TTL: fresh enough that a
      // revocation surfaces quickly, cached enough that legit embeds stay off
      // the origin. Do not restore the 1-hour window — it would outlive a
      // BLOCK transition and keep a green badge live on a draining wallet.
      "Cache-Control": "public, s-maxage=300, stale-while-revalidate=300",
    },
  });
}
