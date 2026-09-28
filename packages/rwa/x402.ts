import { getAddress, isAddress, verifyTypedData, type Hex } from "viem";
import { RWA_CHAIN_ID } from "./config";

/**
 * The paid lane of the facts JSON: an agent pays 0.01 USDG on Robinhood Chain
 * over x402 v2 and gets the same JSON the free route returns (SPEC patch 017).
 *
 * The free route stays free (docs/rwa/OPERATING.md). What the payment buys is
 * a lane at 60 requests/min/IP instead of the free route's 10, and a settlement
 * receipt the agent can keep next to the record it acted on. It does not jump
 * the queue: the one-reconstruction-at-a-time limit per instance is shared with
 * the free route and the /rwa page.
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
export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
/** Canonical x402ExactPermit2Proxy (same address on every chain; code present on 4663, measured 2026-09-28). */
export const X402_PERMIT2_PROXY = "0x402085c248EeA27D92E8b30b2C58ed07f9E20001";
/** A signature must stay valid at least this long, so it cannot expire between verify and settle. */
const MIN_VALIDITY_SECONDS = 60;
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
      description: "vet402 /rwa facts JSON for one wallet on Robinhood Chain (same JSON as the free route; 60 requests/min/IP instead of 10; reconstructions are not prioritised)",
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

type Permit2Authorization = {
  permitted: { token: string; amount: string };
  from: string;
  spender: string;
  nonce: string;
  deadline: string;
  witness: { to: string; validAfter: string };
};

const PERMIT2_TYPES = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "Witness" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  Witness: [
    { name: "to", type: "address" },
    { name: "validAfter", type: "uint256" },
  ],
} as const;

const same = (x: unknown, y: string) => typeof x === "string" && x.toLowerCase() === y.toLowerCase();
const isUint = (x: unknown): x is string => typeof x === "string" && /^\d+$/.test(x);

/**
 * Decode PAYMENT-SIGNATURE and check that what the payer accepted and signed is
 * exactly what this route asks for: our network, USDG, exactly 0.01, our
 * wallet as the witness recipient, the canonical proxy as spender, and a
 * validity window that covers verify → build → settle. The signature itself is
 * checked in checkSignature() before the facilitator is ever called.
 */
export function parsePaymentHeader(header: string, nowSec: number = Math.floor(Date.now() / 1000)): PaymentPayload {
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
  if (a.scheme !== want.scheme || a.network !== want.network) throw new BadPayment("wrong_scheme_or_network");
  if (!same(a.asset, want.asset)) throw new BadPayment("wrong_asset");
  if (!same(a.payTo, want.payTo)) throw new BadPayment("wrong_pay_to");
  if (a.amount !== want.amount) throw new BadPayment("amount_is_not_the_price");
  const pl = p.payload as { signature?: unknown; permit2Authorization?: Permit2Authorization };
  const auth = pl.permit2Authorization;
  if (!auth || typeof pl.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(pl.signature)) throw new BadPayment("permit2_authorization_required");
  if (!same(auth.witness?.to, want.payTo)) throw new BadPayment("witness_to_is_not_pay_to");
  if (!same(auth.permitted?.token, want.asset)) throw new BadPayment("permitted_token_is_not_usdg");
  if (auth.permitted?.amount !== want.amount) throw new BadPayment("permitted_amount_is_not_the_price");
  if (!same(auth.spender, X402_PERMIT2_PROXY)) throw new BadPayment("spender_is_not_the_x402_proxy");
  if (typeof auth.from !== "string" || !isAddress(auth.from)) throw new BadPayment("from_is_not_an_address");
  if (!isUint(auth.nonce) || !isUint(auth.deadline) || !isUint(auth.witness?.validAfter)) throw new BadPayment("permit2_fields_not_uint");
  if (BigInt(auth.deadline) < BigInt(nowSec + MIN_VALIDITY_SECONDS)) throw new BadPayment("deadline_too_soon");
  if (BigInt(auth.witness.validAfter) > BigInt(nowSec)) throw new BadPayment("not_valid_yet");
  return p;
}

/** Recover the Permit2 witness signature locally, so a forged header never reaches the facilitator. */
export async function checkSignature(p: PaymentPayload): Promise<boolean> {
  const pl = p.payload as { signature: Hex; permit2Authorization: Permit2Authorization };
  const auth = pl.permit2Authorization;
  try {
    return await verifyTypedData({
      address: getAddress(auth.from),
      domain: { name: "Permit2", chainId: RWA_CHAIN_ID, verifyingContract: PERMIT2 },
      types: PERMIT2_TYPES,
      primaryType: "PermitWitnessTransferFrom",
      message: {
        permitted: { token: getAddress(auth.permitted.token), amount: BigInt(auth.permitted.amount) },
        spender: getAddress(auth.spender),
        nonce: BigInt(auth.nonce),
        deadline: BigInt(auth.deadline),
        witness: { to: getAddress(auth.witness.to), validAfter: BigInt(auth.witness.validAfter) },
      },
      signature: pl.signature,
    });
  } catch {
    return false;
  }
}

export type VerifyResult = { isValid: boolean; invalidReason?: string; payer?: string };
export type SettleResult = { success: boolean; errorReason?: string; transaction: string; network?: string; payer?: string; amount?: string };

type FacilitatorReply<T> = { ok: boolean; status: number; body: T | null };

async function facilitator<T>(path: "/verify" | "/settle", payment: PaymentPayload, fetchImpl: typeof fetch): Promise<FacilitatorReply<T>> {
  const res = await fetchImpl(`${FACILITATOR_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ x402Version: 2, paymentPayload: payment, paymentRequirements: paymentRequirements() }),
    signal: AbortSignal.timeout(FACILITATOR_TIMEOUT_MS),
  });
  const text = await res.text();
  let body: T | null = null;
  try {
    body = JSON.parse(text) as T;
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body };
}

/**
 * Valid only on a 2xx whose body says `isValid: true`. A body with
 * `isValid: false` is a refusal whatever the status; anything without a
 * boolean `isValid` is an outage (thrown, answered 502, nothing charged).
 */
export async function verifyPayment(p: PaymentPayload, fetchImpl: typeof fetch = fetch): Promise<VerifyResult> {
  const r = await facilitator<VerifyResult>("/verify", p, fetchImpl);
  if (!r.body || typeof r.body.isValid !== "boolean") throw new Error(`facilitator /verify ${r.status}`);
  return { ...r.body, isValid: r.ok && r.body.isValid === true };
}

/**
 * What settle means for the payer. Only a 2xx with `success: false` is a clean
 * "no money moved" (402, pay again). A 2xx with `success: true` and a tx hash is
 * settled. Everything else (5xx, a non-JSON body, a timeout, a network error)
 * is unknown: the money may have moved, so the caller must still get the record.
 */
export type SettleOutcome =
  | { kind: "settled"; result: SettleResult }
  | { kind: "failed"; result: SettleResult }
  | { kind: "unknown"; detail: string };

export async function settlePayment(p: PaymentPayload, fetchImpl: typeof fetch = fetch): Promise<SettleOutcome> {
  let r: FacilitatorReply<SettleResult>;
  try {
    r = await facilitator<SettleResult>("/settle", p, fetchImpl);
  } catch (err) {
    return { kind: "unknown", detail: err instanceof Error ? err.name : "error" };
  }
  const b = r.body;
  if (r.ok && b && b.success === true && typeof b.transaction === "string" && /^0x[0-9a-fA-F]{64}$/.test(b.transaction)) return { kind: "settled", result: b };
  if (r.ok && b && b.success === false) return { kind: "failed", result: b };
  return { kind: "unknown", detail: `status ${r.status}` };
}

/** The payer as the facilitator reported it, EIP-55, or null. */
export function payerOf(v: { payer?: string }): string | null {
  return v.payer && isAddress(v.payer) ? getAddress(v.payer) : null;
}
