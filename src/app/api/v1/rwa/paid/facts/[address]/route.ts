import { NextRequest, NextResponse } from "next/server";
import { getAddress } from "viem";
import { publicRateLimit } from "@/lib/api/public-route";
import { isValidAddress } from "@/lib/chain/client";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { RWA_CHAIN_ID } from "../../../../../../../../packages/rwa/config";
import { ReconstructionTimeout, TooBusy, cachedFacts } from "../../../../../../../../packages/rwa/cache";
import { NoStockTokenActivity, type RwaFacts } from "../../../../../../../../packages/rwa/facts";
import { factsHashHeader } from "../../../../../../../../packages/rwa/anchor";
import {
  BadPayment,
  b64json,
  checkSignature,
  parsePaymentHeader,
  paymentRequired,
  settlePayment,
  verifyPayment,
  type PaymentPayload,
} from "../../../../../../../../packages/rwa/x402";

/**
 * GET /api/v1/rwa/paid/facts/:address?chain=4663 — the same facts JSON as
 * /api/v1/rwa/facts, paid per call over x402 v2 in USDG on Robinhood Chain
 * (SPEC patch 017). The free route is unchanged and stays free.
 *
 * Without PAYMENT-SIGNATURE: 402 with PAYMENT-REQUIRED (base64 JSON) and the
 * same object as the body. With it: check the terms and the signature here,
 * verify at the facilitator, build the record, settle, answer 200 with
 * PAYMENT-RESPONSE. The record is built before the money moves, so a request
 * that ends in 404/503 is not charged; and once settle has been sent, the
 * record is returned whatever settle answered, unless the facilitator said
 * plainly that no money moved (402). An unknown settlement answers 200 with
 * the record and `X-Payment-Status: unknown` instead of a receipt.
 */

type RouteContext = { params: Promise<{ address: string }> };

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const EXPOSE = { "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-Payment-Status, X-Facts-Hash" };
/**
 * Latest moment (from the start of the request) at which settle may begin.
 * Settle is given 15 s, so this keeps the whole call inside maxDuration 60
 * with room for a cold start: a function cut off mid-settle could charge the
 * payer and return nothing. Past it, answer 503 uncharged; the record is
 * cached for 5 minutes, so the retry is fast.
 */
const SETTLE_START_BY_MS = 38_000;

function required(url: string, headers: Record<string, string>, error?: string, extra?: Record<string, string>) {
  const body = paymentRequired(url, error);
  return NextResponse.json(body, { status: 402, headers: { ...headers, ...EXPOSE, "PAYMENT-REQUIRED": b64json(body), ...extra } });
}

export async function GET(request: NextRequest, context: RouteContext) {
  const started = Date.now();
  const gate = await publicRateLimit(request, "rwa-paid-facts", 60, 60_000);
  if (!gate.ok) return gate.response;

  const { address } = await context.params;
  if (!isValidAddress(address)) {
    return NextResponse.json({ error: "invalid_address" }, { status: 400, headers: gate.headers });
  }
  const chain = request.nextUrl.searchParams.get("chain") ?? String(RWA_CHAIN_ID);
  if (chain !== String(RWA_CHAIN_ID)) {
    return NextResponse.json({ error: "invalid_address", detail: `chain must be ${RWA_CHAIN_ID}` }, { status: 400, headers: gate.headers });
  }
  const resourceUrl = `${request.nextUrl.origin}${request.nextUrl.pathname}`;

  const header = request.headers.get("PAYMENT-SIGNATURE");
  if (!header) return required(resourceUrl, gate.headers, "PAYMENT-SIGNATURE header is required");

  let payment: PaymentPayload;
  try {
    payment = parsePaymentHeader(header);
  } catch (err) {
    if (err instanceof BadPayment) return required(resourceUrl, gate.headers, err.reason);
    throw err;
  }

  if (!(await checkSignature(payment))) return required(resourceUrl, gate.headers, "signature_does_not_match_from");

  try {
    const verified = await verifyPayment(payment);
    if (!verified.isValid) return required(resourceUrl, gate.headers, verified.invalidReason ?? "payment_invalid");
  } catch (err) {
    logServerErrorSafe("rwa_paid_verify", err);
    return NextResponse.json({ error: "facilitator_unavailable", charged: false }, { status: 502, headers: gate.headers });
  }

  let facts: RwaFacts;
  try {
    facts = await cachedFacts(address);
  } catch (err) {
    if (err instanceof TooBusy || err instanceof ReconstructionTimeout) {
      return NextResponse.json(
        { error: err instanceof TooBusy ? "too_busy" : "feed_unavailable", charged: false },
        { status: 503, headers: { ...gate.headers, "Retry-After": String(err.retryAfterSec) } },
      );
    }
    if (err instanceof NoStockTokenActivity) {
      return NextResponse.json({ error: "no_stock_token_activity", charged: false }, { status: 404, headers: gate.headers });
    }
    logServerErrorSafe("rwa_paid_facts", err);
    return NextResponse.json({ error: "feed_unavailable", charged: false }, { status: 503, headers: gate.headers });
  }

  // The v2 anchor hash of the body (SPEC patch 023), computed before any money
  // moves. factsHashHeader never throws; the body is unchanged.
  const hashHeader = factsHashHeader(facts);

  if (Date.now() - started > SETTLE_START_BY_MS) {
    return NextResponse.json(
      { error: "too_slow_retry", charged: false },
      { status: 503, headers: { ...gate.headers, "Retry-After": "5" } },
    );
  }

  const outcome = await settlePayment(payment);
  if (outcome.kind === "failed") {
    return required(resourceUrl, gate.headers, outcome.result.errorReason ?? "settlement_failed", { "PAYMENT-RESPONSE": b64json(outcome.result) });
  }
  if (outcome.kind === "unknown") {
    // The money may have moved and the nonce may be spent: give the record, say we do not know.
    logServerErrorSafe("rwa_paid_settle_unknown", new Error(outcome.detail));
    return NextResponse.json(render(facts), {
      headers: { ...gate.headers, ...EXPOSE, ...hashHeader, "Cache-Control": "no-store", "X-Payment-Status": "unknown" },
    });
  }
  return NextResponse.json(render(facts), {
    headers: { ...gate.headers, ...EXPOSE, ...hashHeader, "Cache-Control": "no-store", "X-Payment-Status": "settled", "PAYMENT-RESPONSE": b64json(outcome.result) },
  });
}

/** Addresses are stored lower-cased and shown EIP-55 (SPEC §7). */
function render(facts: RwaFacts): RwaFacts {
  return { ...facts, address: getAddress(facts.address) };
}
