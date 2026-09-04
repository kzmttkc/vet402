import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit, ipRateLimitHeaders } from "@/lib/api/ip-rate-limit";
import { getDb } from "@/lib/db/client";
import { agentPassports } from "@/lib/db/schema";
import { parseAgentId } from "@/lib/chain/client";
import { scoreAgentById } from "@/lib/scoring/engine";
import { agentPassportMessage, legacyAgentPassportMessage } from "@/lib/verify-message";
import { logServerError } from "@/lib/util/log";
import { verifyMessage } from "viem";
import { loadSellerFacts } from "@/lib/decision/seller-facts";
import { buildFactsSummary, type FactsSummary } from "@/lib/decision/facts-summary";
import { endpointsByPayee } from "@/lib/resolve/lookup";
import { payeeId as toPartyId } from "@/lib/ids/canonical";

// A-10 — the portable, third-party-verifiable passport. Key-less on purpose:
// a counterparty deciding whether to transact with an agent must be able to
// pull and verify the passport with zero onboarding (the whole point of the
// symmetric extension). It returns three things:
//   1. the signed identity claim (name, url, wallet, verifiedAt);
//   2. the verification material — the exact canonical `message` and the
//      `signature` — so the reader can re-run verifyMessage themselves and
//      cross-check `wallet` against getAgentWallet(agentId) on-chain;
//   3. a live trust score with explicit freshness (scoredAt / cacheExpiresAt),
//      best-effort — an unscorable agent still returns a valid passport.
//
// Key-less + chain-reading, so it is IP rate-limited. Legit agent-to-agent
// checks are low-volume; a scan over fresh agentIds is what this caps.
export const dynamic = "force-dynamic";

const PASSPORT_LIMIT = 20;
const PASSPORT_WINDOW_MS = 60_000;

/**
 * Reconstruct the exact message this row's signature was signed over, so a
 * third party can re-run verifyMessage without trusting us. Rows accreted
 * across four message shapes (pre-url, url-bound, — 2026-08-18 — with an
 * `issued` line, and — 2026-09-05 — with the `vet402.com` naming and domain
 * line), and the DB does not record which shape was signed. Prefer the most
 * complete shape supported by the stored fields, then fall back through the
 * older shapes, returning whichever the signature actually verifies against.
 * A row's own `issued_at`/`url` gate which candidates are even attempted, so
 * an empty field never invents a line.
 *
 * 2026-09-05 note on LEGACY_MESSAGE_ACCEPT_UNTIL: that deadline governs what
 * we will ACCEPT as a new registration. It does not govern this ladder. A row
 * signed in 2026-08 must stay third-party-verifiable forever — dropping its
 * shape here would not "expire" anything, it would silently publish a proof
 * that no longer checks out. So the pre-2026-09-05 candidates stay after the
 * write path stops taking them.
 */
async function matchingPassportMessage(params: {
  agentId: bigint;
  wallet: string;
  name: string;
  url: string | null;
  signature: string;
  issuedAt: Date | null;
}): Promise<string> {
  const { agentId, wallet, name, url, signature, issuedAt } = params;
  const candidates: string[] = [];
  const issued = issuedAt?.toISOString();
  if (issued && url) candidates.push(agentPassportMessage(agentId, wallet, name, url, issued));
  if (issued) candidates.push(agentPassportMessage(agentId, wallet, name, undefined, issued));
  if (url) candidates.push(agentPassportMessage(agentId, wallet, name, url));
  candidates.push(agentPassportMessage(agentId, wallet, name));
  if (issued && url) candidates.push(legacyAgentPassportMessage(agentId, wallet, name, url, issued));
  if (issued) candidates.push(legacyAgentPassportMessage(agentId, wallet, name, undefined, issued));
  if (url) candidates.push(legacyAgentPassportMessage(agentId, wallet, name, url));
  candidates.push(legacyAgentPassportMessage(agentId, wallet, name));

  for (const candidate of candidates) {
    try {
      const ok = await verifyMessage({
        address: wallet as `0x${string}`,
        message: candidate,
        signature: signature as `0x${string}`,
      });
      if (ok) return candidate;
    } catch {
      // Try the next-simpler shape.
    }
  }
  // None verified (shouldn't happen for a row we wrote) — return the most
  // complete shape so a reader sees the fields, and their own verify fails
  // honestly rather than us hiding the mismatch.
  return candidates[0];
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`agent-passport:${ip}`, PASSPORT_LIMIT, PASSPORT_WINDOW_MS);
  const rlHeaders = ipRateLimitHeaders(limited);
  if (!limited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: rlHeaders });
  }

  const { agentId: agentIdParam } = await params;
  const agentId = parseAgentId(agentIdParam);
  if (agentId === null) {
    return NextResponse.json({ error: "invalid_agent_id" }, { status: 400, headers: rlHeaders });
  }

  // 1+2. Identity claim + verification material (DB-only, always attempted).
  let identity:
    | {
        name: string;
        url: string | null;
        wallet: string;
        signature: string;
        verifiedAt: Date | null;
        issuedAt: Date | null;
      }
    | null = null;
  const db = getDb();
  if (db) {
    try {
      const rows = await db
        .select()
        .from(agentPassports)
        .where(eq(agentPassports.agentId, agentId))
        .limit(1);
      if (rows[0]) {
        identity = {
          name: rows[0].name,
          url: rows[0].url,
          wallet: rows[0].wallet,
          signature: rows[0].signature,
          verifiedAt: rows[0].verifiedAt,
          issuedAt: rows[0].issuedAt,
        };
      }
    } catch {
      // Missing table / DB down: fall through to an unverified passport rather
      // than 500. The score half can still be useful on its own.
      identity = null;
    }
  }

  // 3. Live score with freshness (best-effort — never fails the passport).
  let score: {
    trustScore: number;
    recommendation: string;
    x402: { paymentCount: number; uniqueDays: number };
    scoredAt: string;
    cacheExpiresAt: string;
  } | null = null;
  try {
    // 2026-08-06: key-less public endpoint. A hang in scoreAgentById's deep
    // chain reads is not a rejection, so the catch never fires and the request
    // 504s (same class as /api/demo/score and the /agent page). Race a timeout
    // so an unresponsive RPC degrades to a null score, not a hung request.
    const result = await Promise.race([
      scoreAgentById(agentId),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("agent_score_timeout")), 8_000),
      ),
    ]);
    score = {
      trustScore: result.trustScore,
      recommendation: result.recommendation,
      x402: { paymentCount: result.signals.x402.paymentCount, uniqueDays: result.signals.x402.uniqueDays },
      scoredAt: result.scoredAt,
      cacheExpiresAt: result.cacheExpiresAt,
    };
  } catch (error) {
    logServerError("agent_passport_score", error);
    score = null;
  }

  const verified = identity !== null;
  // 製品定義書 §14 P2（2026-09-02）: passport に facts 要約を載せる。bound wallet が
  // payTo の Endpoint について L0–L2 の事実だけを要約する（スコアではない）。
  // 取れなくても passport は落とさない（null で開示）。
  let factsSummary: FactsSummary | null = null;
  if (identity?.wallet) {
    try {
      const eps = await endpointsByPayee(toPartyId("eip155:8453", identity.wallet), 50);
      factsSummary = await buildFactsSummary(eps, loadSellerFacts);
    } catch (error) {
      logServerError("agent_passport_facts", error);
      factsSummary = null;
    }
  }

  return NextResponse.json(
    {
      agentId: agentId.toString(),
      verified,
      identity: identity
        ? {
            name: identity.name,
            url: identity.url,
            wallet: identity.wallet,
            verifiedAt: identity.verifiedAt?.toISOString() ?? null,
            // Everything a third party needs to re-verify control without
            // trusting this server: reconstruct + verifyMessage(message,
            // signature, wallet), then confirm wallet == getAgentWallet(agentId).
            proof: {
              message: await matchingPassportMessage({
                agentId,
                wallet: identity.wallet,
                name: identity.name,
                url: identity.url,
                signature: identity.signature,
                issuedAt: identity.issuedAt,
              }),
              signature: identity.signature,
              scheme: "eip191-personal-sign",
            },
          }
        : null,
      score,
      facts_summary: factsSummary,
      disclaimer:
        "A passport proves control of the agent's wallet and reports an independently-computed score. facts_summary carries L0–L2 measurement records for endpoints paid to that wallet. It is not an endorsement or a guarantee.",
    },
    { headers: rlHeaders },
  );
}
