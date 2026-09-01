import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyMessage } from "viem";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit, ipRateLimitHeaders } from "@/lib/api/ip-rate-limit";
import { getDb } from "@/lib/db/client";
import { isMissingSchemaError } from "@/lib/db/pg-errors";
import { writePayeeVerification } from "@/lib/db/verify-writers";
import { isValidAddress } from "@/lib/chain/client";
import { logServerError } from "@/lib/util/log";
// 2026-08-14: isCanonicalName/NAME_MAX_LENGTH moved to @/lib/validation and
// payeeMessage to @/lib/verify-message so this route file no longer exports a
// shared helper (Next 16 route-type contract — a route may only export handlers).
import { isCanonicalName } from "@/lib/validation/canonical-name";
import { isSafeBoundUrl, isValidIssuedAt, payeeMessage } from "@/lib/verify-message";

// N-16 — payee self-verification. Sign the canonical message (payeeMessage,
// @/lib/verify-message) with the payee wallet; a valid signature IS the proof of
// control (EIP-191 via viem — EOA wallets only). No API key required:
// registering yourself as a payee should have zero friction, and the
// signature requirement is the anti-abuse gate.

const schema = z.object({
  wallet: z.string(),
  // Canonical name enforced at the schema layer: single-line, trimmed, no
  // control chars, <= NAME_MAX_LENGTH. See isCanonicalName above for why.
  name: z.string().refine(isCanonicalName, { message: "invalid_name" }),
  url: z.string().url().max(200).optional(),
  // 2026-08-18 (audit residual): the exact `issued` the caller signed. Required
  // on writes so every registration carries a freshness timestamp; the GET
  // preview mints one. Signatures without it (legacy shape) are refused.
  issued: z.string().refine(isValidIssuedAt, { message: "invalid_issued_at" }),
  signature: z.string().max(4000),
});

// How far a client-supplied `issued` may drift from server time. Bounds both
// directions: too old is a replayed stale signature, too far in the future
// would let a signer "lock" the row against real future updates under the
// monotonic guard below.
const ISSUED_WINDOW_MS = 10 * 60_000;

// Key-less path rate limits (item 1). The write path (POST) is stricter than
// the read/preview path (GET), and POST additionally caps per-wallet churn so
// one wallet cannot rewrite its public profile in a hot loop even from many IPs.
const GET_LIMIT = 30;
const POST_IP_LIMIT = 8;
const POST_WALLET_LIMIT = 4;
const RL_WINDOW_MS = 60_000;

// Preview the exact canonical message for a given (wallet, name) pair, so a
// caller can construct + sign it before ever attempting POST. Read-only, but
// still rate-limited: it is key-less and does DB-free work an abuser could
// hammer, and integrators benefit from seeing the same RateLimit-* contract.
// 2026-09-02 監査: 静的化された route handler が prerender から古い判定を返すのを防ぐ（09c1fa0 と同じ欠陥）。
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`payee-verify-get:${ip}`, GET_LIMIT, RL_WINDOW_MS);
  const rlHeaders = ipRateLimitHeaders(limited);
  if (!limited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: rlHeaders });
  }

  const wallet = request.nextUrl.searchParams.get("wallet") ?? "";
  const name = request.nextUrl.searchParams.get("name") ?? "";
  const urlParam = request.nextUrl.searchParams.get("url");
  if (!isValidAddress(wallet)) {
    return NextResponse.json({ error: "invalid_wallet_address" }, { status: 400, headers: rlHeaders });
  }
  if (!isCanonicalName(name)) {
    // Same rule the signer enforces: reject newlines/tabs/control chars and
    // over-length here so a caller cannot preview a message the POST would
    // reject, and cannot smuggle extra "wallet:" lines into the preview.
    return NextResponse.json({ error: "invalid_name" }, { status: 400, headers: rlHeaders });
  }
  let url: string | undefined;
  if (urlParam) {
    if (!isSafeBoundUrl(urlParam)) {
      return NextResponse.json({ error: "url_must_be_https" }, { status: 400, headers: rlHeaders });
    }
    url = urlParam;
  }
  // Mint `issued` here so a caller that signs-and-immediately-POSTs never
  // constructs a timestamp itself. POST re-validates the freshness window
  // server-side regardless of what the client echoes back.
  const issued = new Date().toISOString();
  return NextResponse.json(
    { message: payeeMessage(wallet, name, url, issued), issued },
    { headers: rlHeaders },
  );
}

export async function POST(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`payee-verify:${ip}`, POST_IP_LIMIT, RL_WINDOW_MS);
  if (!limited.allowed) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: ipRateLimitHeaders(limited) },
    );
  }
  const rlHeaders = ipRateLimitHeaders(limited);
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
  const { wallet, name, url, issued, signature } = parsed.data;
  if (!isValidAddress(wallet)) {
    return NextResponse.json({ error: "invalid_wallet_address" }, { status: 400, headers: rlHeaders });
  }
  if (url && !isSafeBoundUrl(url)) {
    return NextResponse.json({ error: "url_must_be_https" }, { status: 400, headers: rlHeaders });
  }
  if (Math.abs(Date.now() - Date.parse(issued)) > ISSUED_WINDOW_MS) {
    return NextResponse.json({ error: "signature_expired" }, { status: 400, headers: rlHeaders });
  }

  // Per-wallet write throttle (item 1): a valid signature proves control, but
  // wallets are free to mint, so IP alone is not the whole barrier. Cap how
  // often ONE wallet may (re)register its public payee profile. Keyed on the
  // lowercased address; runs after schema validation so we never spend a
  // wallet-bucket slot on malformed input.
  const walletLimited = await consumeIpRateLimit(
    `payee-verify-wallet:${wallet.toLowerCase()}`,
    POST_WALLET_LIMIT,
    RL_WINDOW_MS,
  );
  if (!walletLimited.allowed) {
    return NextResponse.json(
      { error: "rate_limited", scope: "wallet" },
      { status: 429, headers: ipRateLimitHeaders(walletLimited) },
    );
  }

  const expectedMessage = payeeMessage(wallet, name, url, issued);
  let valid = false;
  try {
    valid = await verifyMessage({
      address: wallet as `0x${string}`,
      message: expectedMessage,
      signature: signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }
  if (!valid) {
    return NextResponse.json({ error: "signature_mismatch", expectedMessage }, { status: 400 });
  }

  const db = getDb();
  if (!db) return NextResponse.json({ error: "store_unavailable" }, { status: 503 });
  try {
    // 2026-08-18 (audit residual): monotonic write in a single statement (the
    // update fires only when the stored issued_at is NULL or strictly older),
    // with a graceful legacy fallback while the issued_at migration is not yet
    // applied to production. See @/lib/db/verify-writers.
    const result = await writePayeeVerification(db, { wallet, name, url: url ?? null, signature, issued });
    if (result === "stale_signature") {
      return NextResponse.json({ error: "stale_signature" }, { status: 409 });
    }
    if (result === "store_unavailable") {
      return NextResponse.json({ error: "store_unavailable" }, { status: 503 });
    }
    return NextResponse.json({
      ok: true,
      profile: `/payee/${wallet.toLowerCase()}`,
      badge: `/api/badge/${wallet.toLowerCase()}`,
    });
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return NextResponse.json({ error: "store_unavailable" }, { status: 503 });
    }
    logServerError("payee_verify", error);
    return NextResponse.json({ error: "store_unavailable" }, { status: 503 });
  }
}
