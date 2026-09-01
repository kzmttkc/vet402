// ============================================================
// vet402 Observatory L1 — x402 payer (design §1 L1, W3).
//
// This module SIGNS MONEY, so its shape is a funnel of refusals: everything
// is a skip unless it is exactly scheme `exact`, EIP-3009, Base (eip155:8453),
// canonical Base USDC, at a price that matches what the catalog advertised
// when we chose the target, under a hard per-purchase ceiling. The
// facilitator/seller can choose to not deliver after settlement — that is a
// FINDING we publish — but they must never be able to choose how much we pay
// or in what asset.
//
// Spec grounding (fetched 2026-08-14, coinbase/x402):
//  - specs/schemes/exact/scheme_exact_evm.md — EIP-3009 payload:
//    { signature, authorization: { from, to, value, validAfter, validBefore, nonce } }
//  - specs/transports-v2/http.md — v2 headers PAYMENT-REQUIRED /
//    PAYMENT-SIGNATURE / PAYMENT-RESPONSE, all base64(JSON). v1 transport
//    used X-PAYMENT / X-PAYMENT-RESPONSE with the same authorization shape;
//    live sellers still speak it, so both are supported and the CHALLENGE
//    decides which we answer with.
// ============================================================
import { randomBytes } from "node:crypto";
import type { Account } from "viem";

/**
 * Canonical Base USDC. Same value as chain/config.BASE_USDC_ADDRESS —
 * duplicated on purpose: the observatory stays import-free of scoring/chain
 * (L0 design §0 non-interference), and this constant is load-bearing for the
 * money gate, so it lives next to the gate it guards.
 */
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export const BASE_CAIP2 = "eip155:8453";

/**
 * Canonical EIP-712 domain of Base mainnet USDC — PINNED, not taken from the
 * seller (2026-08-22 audit).
 *
 * Measured against the primary source on 2026-08-22 (eth_call to
 * https://mainnet.base.org, contract 0x8335…2913):
 *   name()    0x06fdde03 → "USD Coin"
 *   version() 0x54fd4d50 → "2"
 *
 * Why it matters even though chainId and verifyingContract were already
 * pinned: signX402Payment used to read `name` / `version` out of the SELLER's
 * `accept.extra`. A wrong domain cannot move funds anywhere unintended (the
 * signature simply fails verification), but the spend is RESERVED before the
 * signature exists — so a handful of hostile sellers could burn the whole $25
 * daily observation budget on authorizations that could never settle, at zero
 * cost to themselves. The domain is a property of the token, which we already
 * pinned; so we pin its name/version too and refuse any accept that
 * contradicts them BEFORE the reservation is taken.
 */
export const BASE_USDC_EIP712_NAME = "USD Coin";
export const BASE_USDC_EIP712_VERSION = "2";

/**
 * True iff the accept's `extra` does not contradict the canonical USDC domain.
 * Absent fields are fine (we then use the pinned values); a field that is
 * present and different — or present and not a string — is a refusal.
 */
export function hasCanonicalUsdcDomain(extra: Record<string, unknown> | undefined): boolean {
  const name = extra?.name;
  const version = extra?.version;
  return (
    (name === undefined || name === BASE_USDC_EIP712_NAME) &&
    (version === undefined || version === BASE_USDC_EIP712_VERSION)
  );
}

/**
 * Hard per-purchase ceiling in USDC base units (6 decimals): $1.00.
 * Catalog average is $0.32 (2026-08-13 survey); anything above the ceiling
 * is out of the observatory's price band and is recorded as such, not paid.
 * Env-tunable for W later, never above the daily budget.
 */
export const MAX_PER_PURCHASE_UNITS = (() => {
  const raw = process.env.OBSERVATORY_L1_MAX_PURCHASE_UNITS;
  if (!raw) return 1_000_000n;
  try {
    const v = BigInt(raw);
    return v > 0n && v <= 25_000_000n ? v : 1_000_000n;
  } catch {
    return 1_000_000n;
  }
})();

export type ChallengeAccept = {
  scheme: string;
  network: string;
  /** Base units as decimal string (v1 maxAmountRequired normalized here). */
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
};

export type ParsedChallenge = {
  x402Version: 1 | 2;
  accepts: ChallengeAccept[];
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

function normalizeNetwork(network: unknown): string {
  if (typeof network !== "string") return "";
  if (network === "base") return BASE_CAIP2; // v1 slug
  if (network === "base-sepolia") return "eip155:84532";
  return network;
}

/**
 * @param lenient L0 用。§6.1 の合格条件は「amount / asset / network / payTo が
 *   機械可読」であり scheme を要求しない。scheme 欠落は "exact" とみなす。
 *   L1（実際に署名する経路）は厳格のまま——scheme を推測して払わない。
 */
function normalizeAccept(raw: unknown, lenient = false): ChallengeAccept | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const amount =
    typeof rec.amount === "string"
      ? rec.amount
      : typeof rec.maxAmountRequired === "string"
        ? rec.maxAmountRequired // v1 field name
        : null;
  // `recipient` は一部の壁が payTo の別名として使う（L0 の旧パーサが受けていた）。
  const payTo =
    typeof rec.payTo === "string" ? rec.payTo : typeof rec.recipient === "string" ? rec.recipient : null;
  const scheme = typeof rec.scheme === "string" ? rec.scheme : lenient ? "exact" : null;
  if (!amount || !scheme || !payTo) return null;
  if (typeof rec.asset !== "string") return null;
  return {
    scheme,
    network: normalizeNetwork(rec.network),
    amount,
    asset: rec.asset,
    payTo,
    maxTimeoutSeconds: typeof rec.maxTimeoutSeconds === "number" ? rec.maxTimeoutSeconds : undefined,
    extra: asRecord(rec.extra) ?? undefined,
  };
}

/**
 * Parse a 402 response into a challenge: v2 PAYMENT-REQUIRED header first
 * (transport spec), then the JSON body (what most live sellers actually send,
 * v1 and v2 alike — verified against live Bazaar endpoints during L0).
 */
export function parseChallenge(
  input: {
    bodyText: string;
    headers: Headers;
  },
  options: { lenient?: boolean } = {},
): ParsedChallenge | null {
  const candidates: unknown[] = [];

  const headerB64 = input.headers.get("PAYMENT-REQUIRED");
  if (headerB64) {
    try {
      candidates.push(JSON.parse(Buffer.from(headerB64, "base64").toString("utf8")));
    } catch {
      /* fall through to body */
    }
  }
  if (input.bodyText) {
    try {
      candidates.push(JSON.parse(input.bodyText));
    } catch {
      /* not JSON */
    }
  }

  for (const candidate of candidates) {
    const rec = asRecord(candidate);
    if (!rec || !Array.isArray(rec.accepts)) continue;
    const version = rec.x402Version === 1 ? 1 : 2;
    const accepts = rec.accepts
      .map((a) => normalizeAccept(a, options.lenient === true))
      .filter((a): a is ChallengeAccept => a !== null);
    if (accepts.length > 0) return { x402Version: version, accepts };
  }
  return null;
}

export type AcceptSelection =
  | { accept: ChallengeAccept; reason: null }
  | {
      accept: null;
      reason: "no_eligible_accept" | "price_mismatch" | "payto_mismatch" | "over_cap";
    };

/**
 * The money gate. Only scheme `exact` + (eip3009 | unspecified) on Base in
 * canonical USDC is eligible; then the RECIPIENT must be the one the catalog
 * declared, the amount must equal the CATALOG-declared price (when one exists),
 * and it must sit under the hard ceiling. Order of refusals matters for honest
 * reporting: an eligible accept at the wrong price is `price_mismatch` (a
 * finding about the seller), not `no_eligible_accept`.
 *
 * payTo (2026-08-22 audit). The Solana path already cross-checked the wall's
 * payTo against the catalog declaration (sol402-payer.selectSolanaAccept);
 * the EVM path did not, while l1-runner signs EIP-3009 with `to: accept.payTo`
 * — so a seller could name ANY address at the wall and be paid it, and the
 * operator self-exclusion in candidate selection (which only filters the
 * catalog's own e.pay_to) would not see it. The gate has the same semantics as
 * Solana's: a catalog with no declared payTo (null) cannot contradict anything,
 * so it passes through; a declared one must match case-insensitively.
 *
 * It is checked BEFORE price because "who gets the money" is the graver finding
 * and, when nothing matches the declared payee, nothing here is payable at any
 * price.
 */
export function selectAccept(
  accepts: readonly unknown[],
  options: { declaredAmount: string | null; declaredPayTo: string | null },
): AcceptSelection {
  const protocolEligible = accepts
    .map((a) => normalizeAccept(a)) // 厳格（lenient=false）——ここは署名する経路
    .filter((a): a is ChallengeAccept => a !== null)
    .filter((a) => a.scheme === "exact")
    .filter((a) => a.network === BASE_CAIP2)
    .filter((a) => a.asset.toLowerCase() === BASE_USDC.toLowerCase())
    .filter((a) => {
      const method = a.extra?.assetTransferMethod;
      return method === undefined || method === "eip3009";
    })
    // The EIP-712 domain is the token's, not the seller's (see
    // BASE_USDC_EIP712_NAME). Refusing here — before the budget reservation —
    // is the point: a signature under a bogus domain can never settle, so
    // accepting one would let a seller burn budget for free. The full
    // accepts[] is recorded by the caller, so the contradiction stays visible.
    .filter((a) => hasCanonicalUsdcDomain(a.extra));

  if (protocolEligible.length === 0) return { accept: null, reason: "no_eligible_accept" };

  const declaredPayTo =
    options.declaredPayTo === null ? null : options.declaredPayTo.toLowerCase();
  const eligible =
    declaredPayTo === null
      ? protocolEligible
      : protocolEligible.filter((a) => a.payTo.toLowerCase() === declaredPayTo);
  if (eligible.length === 0) return { accept: null, reason: "payto_mismatch" };

  for (const accept of eligible) {
    let amount: bigint;
    try {
      amount = BigInt(accept.amount);
    } catch {
      continue;
    }
    if (amount <= 0n) continue;
    if (options.declaredAmount !== null && accept.amount !== options.declaredAmount) continue;
    if (amount > MAX_PER_PURCHASE_UNITS) continue;
    return { accept, reason: null };
  }

  // Eligible accepts existed but none matched the price gates — classify.
  const anyOverCap = eligible.some((a) => {
    try {
      return BigInt(a.amount) > MAX_PER_PURCHASE_UNITS;
    } catch {
      return false;
    }
  });
  if (options.declaredAmount !== null && eligible.some((a) => a.amount !== options.declaredAmount)) {
    // A seller charging other than it advertised is the more specific finding
    // unless everything was simply over the ceiling.
    const allOverCap = eligible.every((a) => {
      try {
        return BigInt(a.amount) > MAX_PER_PURCHASE_UNITS;
      } catch {
        return true;
      }
    });
    return { accept: null, reason: allOverCap ? "over_cap" : "price_mismatch" };
  }
  return { accept: null, reason: anyOverCap ? "over_cap" : "no_eligible_accept" };
}

export type Eip3009Authorization = {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
};

/** Short-lived, randomly-nonced authorization. validBefore ≤ now+600s regardless of seller's maxTimeoutSeconds. */
export function buildAuthorization(input: {
  from: string;
  to: string;
  value: string;
  nowSec: number;
  maxTimeoutSeconds?: number;
}): Eip3009Authorization {
  const window = Math.min(Math.max(input.maxTimeoutSeconds ?? 300, 60), 600);
  return {
    from: input.from,
    to: input.to,
    value: input.value,
    validAfter: String(input.nowSec - 60), // clock-skew slack
    validBefore: String(input.nowSec + window),
    nonce: `0x${randomBytes(32).toString("hex")}`,
  };
}

/**
 * EIP-3009 TransferWithAuthorization signature over the CANONICAL Base USDC
 * domain. The domain is never taken from the seller: chainId and
 * verifyingContract were always pinned, and since 2026-08-22 name/version are
 * too (BASE_USDC_EIP712_NAME — measured on-chain, not assumed).
 *
 * selectAccept already refuses any accept whose `extra` contradicts the pin,
 * so the guard below is belt-and-braces for a caller that skips the gate: this
 * module signs money, and it must not be possible to talk it into signing
 * under a domain of someone else's choosing.
 */
export async function signX402Payment(input: {
  account: Account;
  accept: ChallengeAccept;
  authorization: Eip3009Authorization;
}): Promise<{ signature: string }> {
  const { account, accept, authorization } = input;
  if (!account.signTypedData) throw new Error("account cannot sign typed data");
  if (!hasCanonicalUsdcDomain(accept.extra)) {
    throw new Error("x402: accept contradicts the canonical Base USDC EIP-712 domain");
  }

  const signature = await account.signTypedData({
    domain: {
      name: BASE_USDC_EIP712_NAME,
      version: BASE_USDC_EIP712_VERSION,
      chainId: 8453,
      verifyingContract: BASE_USDC as `0x${string}`,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from as `0x${string}`,
      to: authorization.to as `0x${string}`,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce as `0x${string}`,
    },
  });
  return { signature };
}

/**
 * Wrap the signed payload in the transport the CHALLENGE spoke.
 *  v2 → PAYMENT-SIGNATURE: { x402Version:2, resource, accepted, payload }
 *  v1 → X-PAYMENT:        { x402Version:1, scheme, network(slug), payload }
 */
export function encodePaymentHeader(input: {
  x402Version: 1 | 2;
  accept: ChallengeAccept;
  payload: { signature: string; authorization: Eip3009Authorization };
  resourceUrl: string;
}): { headerName: string; headerValue: string } {
  const { x402Version, accept, payload, resourceUrl } = input;
  if (x402Version === 1) {
    const body = {
      x402Version: 1,
      scheme: "exact",
      network: accept.network === BASE_CAIP2 ? "base" : accept.network,
      payload,
    };
    return {
      headerName: "X-PAYMENT",
      headerValue: Buffer.from(JSON.stringify(body)).toString("base64"),
    };
  }
  const body = {
    x402Version: 2,
    resource: { url: resourceUrl },
    accepted: {
      scheme: accept.scheme,
      network: accept.network,
      amount: accept.amount,
      asset: accept.asset,
      payTo: accept.payTo,
      ...(accept.maxTimeoutSeconds !== undefined
        ? { maxTimeoutSeconds: accept.maxTimeoutSeconds }
        : {}),
      ...(accept.extra !== undefined ? { extra: accept.extra } : {}),
    },
    payload,
  };
  return {
    headerName: "PAYMENT-SIGNATURE",
    headerValue: Buffer.from(JSON.stringify(body)).toString("base64"),
  };
}

/** Parse the settlement response header (v2 PAYMENT-RESPONSE / v1 X-PAYMENT-RESPONSE). */
export function parseSettlementResponse(headers: Headers): {
  success: boolean;
  transaction: string | null;
  network: string | null;
  payer: string | null;
  errorReason: string | null;
} | null {
  const raw = headers.get("PAYMENT-RESPONSE") ?? headers.get("X-PAYMENT-RESPONSE");
  if (!raw) return null;
  try {
    const rec = asRecord(JSON.parse(Buffer.from(raw, "base64").toString("utf8")));
    if (!rec) return null;
    return {
      success: rec.success === true,
      transaction: typeof rec.transaction === "string" && rec.transaction !== "" ? rec.transaction : null,
      network: typeof rec.network === "string" ? rec.network : null,
      payer: typeof rec.payer === "string" ? rec.payer : null,
      errorReason: typeof rec.errorReason === "string" ? rec.errorReason : null,
    };
  } catch {
    return null;
  }
}
