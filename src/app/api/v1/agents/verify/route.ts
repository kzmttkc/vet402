import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit, ipRateLimitHeaders } from "@/lib/api/ip-rate-limit";
import { getDb } from "@/lib/db/client";
import { isMissingSchemaError } from "@/lib/db/pg-errors";
import { writeAgentPassportVerification } from "@/lib/db/verify-writers";
import { parseAgentId } from "@/lib/chain/client";
import { readCanonicalAgentWallet } from "@/lib/chain/agent-wallet";
// Reuse the payee route's name canonicalization verbatim: the passport message
// shares the exact same line-injection risk (a name with a newline could forge
// an extra "wallet:" or "agentId:" line), so the fix must be the SAME rule, not
// a second copy that could drift. isCanonicalName + agentPassportMessage both
// live in lib now (@/lib/validation, @/lib/verify-message) so no route exports a
// shared helper (Next 16 route-type contract).
import { isCanonicalName } from "@/lib/validation/canonical-name";
import {
  agentPassportMessage,
  isSafeBoundUrl,
  isValidIssuedAt,
  legacyAgentPassportMessage,
  matchSignatureForm,
} from "@/lib/verify-message";
import { logServerError } from "@/lib/util/log";

// A-10 — agent passport self-verification, the symmetric twin of N-16
// (verified payees). Where a payee signs with a receiving wallet, an agent
// signs with the wallet `getAgentWallet(agentId)` returns on-chain: the
// signature proves control of that wallet, and the on-chain lookup proves the
// wallet IS the agent's. No API key: presenting your own passport should have
// zero friction, and the signature + on-chain binding are the anti-abuse gate.
// The canonical message builder is agentPassportMessage (@/lib/verify-message).

const schema = z.object({
  // Accept a numeric string or number; parseAgentId does the real validation.
  agentId: z.union([z.string(), z.number()]),
  name: z.string().refine(isCanonicalName, { message: "invalid_name" }),
  url: z.string().url().max(200).optional(),
  // 2026-08-18 (audit residual): the exact `issued` the caller signed — see
  // payees/verify for the full rationale. Required on writes.
  issued: z.string().refine(isValidIssuedAt, { message: "invalid_issued_at" }),
  signature: z.string().max(4000),
});

// Key-less path rate limits, mirroring the payee verify route. GET (preview)
// is looser than POST (write); POST additionally caps per-agent churn so one
// agent cannot rewrite its public passport in a hot loop across many IPs.
const GET_LIMIT = 30;
const POST_IP_LIMIT = 8;
const POST_AGENT_LIMIT = 4;
const RL_WINDOW_MS = 60_000;
const ISSUED_WINDOW_MS = 10 * 60_000;

/**
 * Preview the exact canonical message to sign for (agentId, name). Resolves
 * the agent's on-chain wallet so the signer sees the real 5 lines before
 * signing. Read-only but rate-limited: it is key-less and does a chain read.
 */
// 2026-09-02 監査: 静的化された route handler が prerender から古い判定を返すのを防ぐ（09c1fa0 と同じ欠陥）。
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`agent-verify-get:${ip}`, GET_LIMIT, RL_WINDOW_MS);
  const rlHeaders = ipRateLimitHeaders(limited);
  if (!limited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: rlHeaders });
  }

  const agentIdRaw = request.nextUrl.searchParams.get("agentId") ?? "";
  const name = request.nextUrl.searchParams.get("name") ?? "";
  const urlParam = request.nextUrl.searchParams.get("url");
  const agentId = parseAgentId(agentIdRaw);
  if (agentId === null) {
    return NextResponse.json({ error: "invalid_agent_id" }, { status: 400, headers: rlHeaders });
  }
  if (!isCanonicalName(name)) {
    return NextResponse.json({ error: "invalid_name" }, { status: 400, headers: rlHeaders });
  }

  let wallet: string | null;
  try {
    wallet = await readCanonicalAgentWallet(agentId);
  } catch {
    return NextResponse.json({ error: "chain_unavailable" }, { status: 503, headers: rlHeaders });
  }
  if (!wallet) {
    // The identity has no bound wallet on-chain, so there is nothing to sign
    // with that would prove control. Bind a wallet to the agent first.
    return NextResponse.json({ error: "agent_wallet_unbound" }, { status: 400, headers: rlHeaders });
  }

  let url: string | undefined;
  if (urlParam) {
    if (!isSafeBoundUrl(urlParam)) {
      return NextResponse.json({ error: "url_must_be_https" }, { status: 400, headers: rlHeaders });
    }
    url = urlParam;
  }

  const issued = new Date().toISOString();
  return NextResponse.json(
    {
      agentId: agentId.toString(),
      wallet: wallet.toLowerCase(),
      message: agentPassportMessage(agentId, wallet, name, url, issued),
      issued,
    },
    { headers: rlHeaders },
  );
}

export async function POST(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`agent-verify:${ip}`, POST_IP_LIMIT, RL_WINDOW_MS);
  const rlHeaders = ipRateLimitHeaders(limited);
  if (!limited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: rlHeaders });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: rlHeaders });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", details: parsed.error.flatten() },
      { status: 400, headers: rlHeaders },
    );
  }
  const { name, url, issued, signature } = parsed.data;
  const agentId = parseAgentId(String(parsed.data.agentId));
  if (agentId === null) {
    return NextResponse.json({ error: "invalid_agent_id" }, { status: 400, headers: rlHeaders });
  }
  if (url && !isSafeBoundUrl(url)) {
    return NextResponse.json({ error: "url_must_be_https" }, { status: 400, headers: rlHeaders });
  }
  if (Math.abs(Date.now() - Date.parse(issued)) > ISSUED_WINDOW_MS) {
    return NextResponse.json({ error: "signature_expired" }, { status: 400, headers: rlHeaders });
  }

  // Per-agent write throttle: a valid signature proves control, but cap how
  // often ONE agent may (re)register its passport. Runs after schema
  // validation so we never spend a bucket slot on malformed input.
  const agentLimited = await consumeIpRateLimit(
    `agent-verify-agent:${agentId.toString()}`,
    POST_AGENT_LIMIT,
    RL_WINDOW_MS,
  );
  if (!agentLimited.allowed) {
    return NextResponse.json(
      { error: "rate_limited", scope: "agent" },
      { status: 429, headers: ipRateLimitHeaders(agentLimited) },
    );
  }

  // Resolve the on-chain wallet FIRST — this is the binding that makes the
  // signature mean "this agent", not merely "some wallet". A chain failure is
  // fail-closed (503): we never store an unverifiable claim.
  let wallet: string | null;
  try {
    wallet = await readCanonicalAgentWallet(agentId);
  } catch {
    return NextResponse.json({ error: "chain_unavailable" }, { status: 503, headers: rlHeaders });
  }
  if (!wallet) {
    return NextResponse.json({ error: "agent_wallet_unbound" }, { status: 400, headers: rlHeaders });
  }

  // 2026-09-05 (S-6): same two-form window as payees/verify — current text
  // first, the pre-2026-09-05 text until LEGACY_MESSAGE_ACCEPT_UNTIL, then a
  // named refusal instead of a silent mismatch.
  const expectedMessage = agentPassportMessage(agentId, wallet, name, url, issued);
  const { matched } = await matchSignatureForm({
    address: wallet,
    signature,
    current: expectedMessage,
    legacy: legacyAgentPassportMessage(agentId, wallet, name, url, issued),
  });
  if (matched === "legacy_expired") {
    return NextResponse.json(
      { error: "signature_message_legacy_expired", expectedMessage },
      { status: 400, headers: rlHeaders },
    );
  }
  if (matched === "none") {
    return NextResponse.json(
      { error: "signature_mismatch", expectedMessage },
      { status: 400, headers: rlHeaders },
    );
  }
  const legacyMessage = matched === "legacy";
  if (legacyMessage) {
    console.warn(`[vouch] agent_verify_legacy_message: agentId=${agentId.toString()}`);
  }

  const db = getDb();
  if (!db) return NextResponse.json({ error: "store_unavailable" }, { status: 503, headers: rlHeaders });
  try {
    // 2026-08-18 (audit residual): monotonic write with graceful pre-migration
    // fallback. The passport route is the one that publicly exposes
    // {message, signature} key-less, which is what makes this guard
    // load-bearing here. See @/lib/db/verify-writers.
    const result = await writeAgentPassportVerification(db, {
      agentId,
      wallet,
      name,
      url: url ?? null,
      signature,
      issued,
    });
    if (result === "stale_signature") {
      return NextResponse.json({ error: "stale_signature" }, { status: 409, headers: rlHeaders });
    }
    if (result === "store_unavailable") {
      return NextResponse.json({ error: "store_unavailable" }, { status: 503, headers: rlHeaders });
    }
    return NextResponse.json(
      {
        ok: true,
        agentId: agentId.toString(),
        wallet: wallet.toLowerCase(),
        passport: `/api/v1/agents/${agentId.toString()}/passport`,
        profile: `/agent/${agentId.toString()}`,
        badge: `/api/badge/agent/${agentId.toString()}`,
        // Present only while the pre-2026-09-05 message form is still accepted.
        ...(legacyMessage
          ? {
              legacy_message: true,
              note: "Accepted a signature over the pre-2026-09-05 message form. That form stops verifying on 2026-09-21 — re-fetch the message from GET /api/v1/agents/verify.",
            }
          : {}),
      },
      { headers: rlHeaders },
    );
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return NextResponse.json({ error: "store_unavailable" }, { status: 503, headers: rlHeaders });
    }
    logServerError("agent_passport_verify", error);
    return NextResponse.json({ error: "store_unavailable" }, { status: 503, headers: rlHeaders });
  }
}
