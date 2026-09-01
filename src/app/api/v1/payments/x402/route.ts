import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  applyRateLimit,
  authenticateApiRequest,
  withRateLimitHeaders,
} from "@/lib/api/guard";
import { isValidAddress } from "@/lib/chain/client";
import { verifyX402Ownership, verifyX402PaymentOnChain } from "@/lib/chain/x402-verify";
import { recordX402Payment } from "@/lib/db/x402-payments";
import { invalidateScoreCacheForListChange } from "@/lib/scoring/cache-invalidation";
import { invalidatePayeeScoreCache } from "@/lib/scoring/payee-engine";
import { logServerError } from "@/lib/util/log";

const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;

const bodySchema = z.object({
  wallet: z.string().min(1),
  txHash: z.string().min(1),
  amount: z.string().max(78).optional(),
  network: z.string().max(32).optional(),
  resource: z.string().max(512).optional(),
  /**
   * vet402 2026-08-13 — proof of control. An EIP-191 signature by `wallet`
   * over the canonical attestation message (see x402AttestationMessage). Its
   * presence and validity decides ownership_verified, which decides whether the
   * row counts toward any score. Optional for backward compatibility: an
   * unsigned write-back is still recorded, just never scored.
   */
  signature: z.string().max(4000).optional(),
});

/**
 * POST /api/v1/payments/x402
 *
 * Provider write-back after x402 payment verification.
 * Idempotent on txHash. Weights into trust score (SCORE_WEIGHTS.x402) — but
 * ONLY when the caller proves control of `wallet` with a valid EIP-191
 * signature (ownership_verified). Without it the row is stored and returned
 * with ownershipVerified=false, and getX402PaymentStats/getPayeeStats exclude
 * it, so posting a stranger's real transfer cannot move that stranger's score.
 */
// 2026-09-02 監査: 静的化された route handler が prerender から古い判定を返すのを防ぐ（09c1fa0 と同じ欠陥）。
export const dynamic = "force-dynamic";

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

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { wallet, txHash, amount, network, resource, signature } = parsed.data;

  if (!isValidAddress(wallet)) {
    return NextResponse.json({ error: "invalid_wallet_address" }, { status: 400 });
  }
  if (!TX_HASH_RE.test(txHash)) {
    return NextResponse.json({ error: "invalid_tx_hash" }, { status: 400 });
  }

  const resolvedNetwork = network ?? "base";

  // Anyone can POST a well-formed wallet + regex-shaped txHash; without an
  // on-chain check that would be enough to fabricate settlement history for
  // an arbitrary wallet. Verify the tx is real, succeeded, and is actually
  // attributable to the claimed wallet before it can influence trust scores.
  // Fail-closed: any RPC failure or mismatch is rejected, never recorded.
  const verification = await verifyX402PaymentOnChain(
    txHash as `0x${string}`,
    wallet,
    resolvedNetwork,
    amount ?? null,
  );
  if (!verification.ok) {
    return NextResponse.json(
      { error: "attestation_unverifiable", reason: verification.reason },
      { status: 422 },
    );
  }

  // Proof of control (vet402 2026-08-13). A valid EIP-191 signature by `wallet`
  // over the tx-specific attestation message binds THIS write-back to the
  // wallet's controller. Without it, the row is recorded but ownership_verified
  // stays false and it never counts toward a score. Verified separately from
  // the on-chain checks so an invalid signature does not lose a real
  // settlement — it just leaves it unscored (recorded, not rewarded).
  const ownershipVerified = await verifyX402Ownership(wallet, txHash, signature);

  try {
    const result = await recordX402Payment({
      wallet,
      txHash,
      amount: amount ?? null,
      apiKeyId: auth.ctx.apiKeyId,
      network: resolvedNetwork,
      resource: resource ?? null,
      payee: verification.payee,
      // 2026-08-05: what the chain said, alongside what the caller said. The
      // declared `amount` is kept as-is for the caller's own reconciliation;
      // `onchainAmount` is the authoritative figure and `amountVerified`
      // states plainly whether the two agree.
      onchainAmount: verification.settlement.onChainAmount,
      token: verification.settlement.token,
      amountVerified: verification.amountVerified,
      // The authoritative day axis for uniqueDays, and the ownership gate.
      blockTimestamp: verification.blockTimestamp,
      ownershipVerified,
    });

    if (result.created) {
      void invalidateScoreCacheForListChange(wallet).catch((error) =>
        logServerError("x402_cache_invalidate", error),
      );
      if (verification.payee) {
        invalidatePayeeScoreCache(verification.payee);
      }
    }

    return withRateLimitHeaders(
      NextResponse.json(
        {
          ok: true,
          created: result.created,
          id: result.id,
          wallet: wallet.toLowerCase(),
          txHash: txHash.toLowerCase(),
          payee: verification.payee,
          // Told plainly: a write-back that did not prove ownership is stored
          // but will not count toward this wallet's score. The caller finds
          // that out now, from us, not from a score that never moves.
          ownershipVerified,
          // Surfaced rather than hidden: a caller whose declared amount did
          // not match the chain should find that out from us, immediately,
          // and not from a reconciliation weeks later.
          amountVerified: verification.amountVerified,
          onChainAmount: verification.settlement.onChainAmount,
          token: verification.settlement.token,
          ...(verification.amountMismatch
            ? { amountMismatch: verification.amountMismatch }
            : {}),
        },
        { status: result.created ? 201 : 200 },
      ),
      limited.rateLimit,
    );
  } catch (error) {
    logServerError("x402_payment_ingest", error);
    return NextResponse.json({ error: "payment_ingest_unavailable" }, { status: 503 });
  }
}
