import { NextRequest, NextResponse } from "next/server";
import { getAddress } from "viem";
import { publicRateLimit } from "@/lib/api/public-route";
import { isValidAddress } from "@/lib/chain/client";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { RWA_CHAIN_ID } from "../../../../../../../../../packages/rwa/config";
import { ReconstructionTimeout, TooBusy, cachedFacts } from "../../../../../../../../../packages/rwa/cache";
import { tooLargeAnswer } from "../../../../../../../../../packages/rwa/answers";
import { NoStockTokenActivity, WalletTooLarge, type RwaFacts } from "../../../../../../../../../packages/rwa/facts";
import { factsHashHeader } from "../../../../../../../../../packages/rwa/anchor";
import { exportDisallowedMethodHandlers, headFromGet } from "@/lib/api/method-not-allowed";
import {
  BadPayment,
  b64json,
  checkSignature,
  parsePaymentHeader,
  paymentRequired,
  type BasePaymentPayload,
} from "@/lib/x402/base-usdc";
import { cdpConfigured, settlePayment, verifyPayment } from "@/lib/x402/cdp-facilitator";
import { LOOKALIKE_END_BY_MS } from "../../../facts/[address]/route";

/**
 * GET /api/v1/rwa/paid/base/facts/:address?chain=4663 — same facts JSON as the free
 * route, paid per call over x402 v2 in USDC on Base (eip155:8453) via the CDP facilitator.
 */

type RouteContext = { params: Promise<{ address: string }> };

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const EXPOSE = {
  "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-Payment-Status, X-Facts-Hash, X-Bazaar-Status",
};
const SETTLE_START_BY_MS = 38_000;

function required(url: string, headers: Record<string, string>, error?: string, extra?: Record<string, string>) {
  const body = paymentRequired(url, error);
  return NextResponse.json(body, { status: 402, headers: { ...headers, ...EXPOSE, "PAYMENT-REQUIRED": b64json(body), ...extra } });
}

export async function GET(request: NextRequest, context: RouteContext) {
  const started = Date.now();
  const gate = await publicRateLimit(request, "rwa-paid-base-facts", 60, 60_000);
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

  let payment: BasePaymentPayload;
  try {
    payment = parsePaymentHeader(header);
  } catch (err) {
    if (err instanceof BadPayment) return required(resourceUrl, gate.headers, err.reason);
    throw err;
  }

  if (!(await checkSignature(payment))) return required(resourceUrl, gate.headers, "signature_does_not_match_from");

  if (!cdpConfigured()) {
    return NextResponse.json({ error: "facilitator_unconfigured", charged: false }, { status: 503, headers: gate.headers });
  }

  try {
    const verified = await verifyPayment(payment, resourceUrl);
    if (!verified.isValid) return required(resourceUrl, gate.headers, verified.invalidReason ?? "payment_invalid");
  } catch (err) {
    logServerErrorSafe("rwa_paid_base_verify", err);
    return NextResponse.json({ error: "facilitator_unavailable", charged: false }, { status: 502, headers: gate.headers });
  }

  let facts: RwaFacts;
  try {
    facts = await cachedFacts(address, { lookalikeEndBy: started + LOOKALIKE_END_BY_MS });
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
    if (err instanceof WalletTooLarge) {
      return NextResponse.json({ ...tooLargeAnswer(err), charged: false }, { status: 422, headers: gate.headers });
    }
    logServerErrorSafe("rwa_paid_base_facts", err);
    return NextResponse.json({ error: "feed_unavailable", charged: false }, { status: 503, headers: gate.headers });
  }

  const hashHeader = factsHashHeader(facts);

  if (Date.now() - started > SETTLE_START_BY_MS) {
    return NextResponse.json(
      { error: "too_slow_retry", charged: false },
      { status: 503, headers: { ...gate.headers, "Retry-After": "5" } },
    );
  }

  const outcome = await settlePayment(payment, resourceUrl);
  const bazaarHdr: Record<string, string> =
    outcome.kind === "settled" && outcome.bazaarStatus ? { "X-Bazaar-Status": outcome.bazaarStatus } : {};
  if (outcome.kind === "failed") {
    const failExtra: Record<string, string> = { "PAYMENT-RESPONSE": b64json(outcome.result) };
    if (bazaarHdr["X-Bazaar-Status"]) failExtra["X-Bazaar-Status"] = bazaarHdr["X-Bazaar-Status"];
    return required(resourceUrl, gate.headers, outcome.result.errorReason ?? "settlement_failed", failExtra);
  }
  if (outcome.kind === "unknown") {
    logServerErrorSafe("rwa_paid_base_settle_unknown", new Error(outcome.detail));
    return NextResponse.json(render(facts), {
      headers: { ...gate.headers, ...EXPOSE, ...hashHeader, "Cache-Control": "no-store", "X-Payment-Status": "unknown" },
    });
  }
  const okHeaders: Record<string, string> = {
    ...gate.headers,
    ...EXPOSE,
    ...hashHeader,
    "Cache-Control": "no-store",
    "X-Payment-Status": "settled",
    "PAYMENT-RESPONSE": b64json(outcome.result),
  };
  if (bazaarHdr["X-Bazaar-Status"]) okHeaders["X-Bazaar-Status"] = bazaarHdr["X-Bazaar-Status"];
  return NextResponse.json(render(facts), { headers: okHeaders });
}

function render(facts: RwaFacts): RwaFacts {
  return { ...facts, address: getAddress(facts.address) };
}
const __disallowed = exportDisallowedMethodHandlers(["GET"]);
export const { POST, PUT, PATCH, DELETE, OPTIONS } = __disallowed;
export const HEAD = headFromGet(GET);