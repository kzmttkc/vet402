import { getAddress, isAddress } from "viem";
import { RWA_CHAIN_ID } from "./config";

/**
 * The paid lane of the facts JSON: an agent pays 0.01 USDG on Robinhood Chain
 * over x402 v2 and gets the same JSON the free route returns (SPEC patch 017).
 *
 * The free route stays free (docs/rwa/OPERATING.md). What the payment buys is
 * a lane at 60 requests/min/IP instead of the free route's 10, and a settlement receipt the
 * agent can keep next to the record it acted on.
 *
 * Order of operations, so nobody pays for nothing: verify the signature with
 * the facilitator, build the record, and only then settle. A record that
 * cannot be built (busy, timeout, no Stock Token activity) is never charged.
 *
 * Facilitator: Dexter, the only public one that lists eip155:4663 (measured
 * 2026-09-28 from each facilitator's /supported). USDG has no EIP-3009, so the
 * scheme is `exact` with `assetTransferMethod: permit2`: the payer signs a
 * Permit2 witness transfer whose spender is the canonical x402ExactPermit2Proxy
 * and whose witness pins `to` = PAY_TO (x402 specs/schemes/exact/scheme_exact_evm.md).
 */

export const X402_NETWORK = `eip155:${RWA_CHAIN_ID}`;
/** USDG (Global Dollar) on 4663, 6 decimals — SPEC §2. */
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
/** 0.01 USDG. Dexter's floor on 4663 was 6072 atomic when measured. */
export const PRICE_ATOMIC = "10000";
/** The vet402 wallet that deployed RwaAnchor and sent the anchor tx (fixtures/rwa/anchor.json). */
export const PAY_TO = "0x973cD8a91A771C2C04C6036888F8175D6b4F6227";
export const FACILITATOR_URL = "https://x402.dexter.cash";
/** Long enough for verify + a cold reconstruction (≤45 s) + settle. */
export const MAX_TIMEOUT_SECONDS = 120;
const FACILITATOR_TIMEOUT_MS = 15_000;

export type PaymentRequirements = {
  scheme: "exact";
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string; assetTransferMethod: "permit2" };
};

export function paymentRequirements(): PaymentRequirements {
  return {
    scheme: "exact",
    network: X402_NETWORK,
    amount: PRICE_ATOMIC,
    asset: USDG,
    payTo: PAY_TO,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: { name: "Global Dollar", version: "1", assetTransferMethod: "permit2" },
  };
}

export function paymentRequired(resourceUrl: string, error?: string) {
  return {
    x402Version: 2 as const,
    ...(error ? { error } : {}),
    resource: {
      url: resourceUrl,
      description: "vet402 /rwa facts JSON for one wallet on Robinhood Chain (same JSON as the free route; 60 requests/min/IP instead of 10)",
      mimeType: "application/json",
    },
    accepts: [paymentRequirements()],
  };
}

export const b64json = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64");

export type PaymentPayload = {
  x402Version: 2;
  accepted: Record<string, unknown>;
  payload: Record<string, unknown>;
  resource?: unknown;
};

export class BadPayment extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/**
 * Decode PAYMENT-SIGNATURE and check that what the payer accepted is exactly
 * what this route asks for. The facilitator checks the signature; this checks
 * that a valid signature is for our price, our token, our network and our wallet.
 */
export function parsePaymentHeader(header: string): PaymentPayload {
  let p: PaymentPayload;
  try {
    p = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    throw new BadPayment("payment_header_not_base64_json");
  }
  if (!p || p.x402Version !== 2 || typeof p.accepted !== "object" || typeof p.payload !== "object" || !p.accepted || !p.payload) {
    throw new BadPayment("payment_payload_shape");
  }
  const a = p.accepted as Record<string, unknown>;
  const want = paymentRequirements();
  const same = (x: unknown, y: string) => typeof x === "string" && x.toLowerCase() === y.toLowerCase();
  if (a.scheme !== want.scheme || a.network !== want.network) throw new BadPayment("wrong_scheme_or_network");
  if (!same(a.asset, want.asset)) throw new BadPayment("wrong_asset");
  if (!same(a.payTo, want.payTo)) throw new BadPayment("wrong_pay_to");
  if (typeof a.amount !== "string" || !/^\d+$/.test(a.amount) || BigInt(a.amount) < BigInt(want.amount)) throw new BadPayment("amount_below_price");
  const auth = (p.payload as { permit2Authorization?: { witness?: { to?: unknown }; permitted?: { token?: unknown; amount?: unknown } } }).permit2Authorization;
  if (auth) {
    if (!same(auth.witness?.to, want.payTo)) throw new BadPayment("witness_to_is_not_pay_to");
    if (!same(auth.permitted?.token, want.asset)) throw new BadPayment("permitted_token_is_not_usdg");
  }
  return p;
}

export type VerifyResult = { isValid: boolean; invalidReason?: string; payer?: string };
export type SettleResult = { success: boolean; errorReason?: string; transaction: string; network?: string; payer?: string; amount?: string };

async function facilitator<T>(path: "/verify" | "/settle", payment: PaymentPayload, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(`${FACILITATOR_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ x402Version: 2, paymentPayload: payment, paymentRequirements: paymentRequirements() }),
    signal: AbortSignal.timeout(FACILITATOR_TIMEOUT_MS),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`facilitator ${path} ${res.status}: ${text.slice(0, 200)}`);
  }
  return body as T;
}

export const verifyPayment = (p: PaymentPayload, fetchImpl: typeof fetch = fetch) => facilitator<VerifyResult>("/verify", p, fetchImpl);
export const settlePayment = (p: PaymentPayload, fetchImpl: typeof fetch = fetch) => facilitator<SettleResult>("/settle", p, fetchImpl);

/** The payer as the facilitator reported it, EIP-55, or null. */
export function payerOf(v: { payer?: string }): string | null {
  return v.payer && isAddress(v.payer) ? getAddress(v.payer) : null;
}
