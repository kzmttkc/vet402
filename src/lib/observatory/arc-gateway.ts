// Circle Gateway on Arc (eip155:5042). Pays a listing only when the live challenge
// has a pinned GatewayWalletBatched accept and no signable native Arc USDC accept.
// The native Arc lane (x402-payer selectAccept) is unchanged.
//
// OBSERVATORY_ARC_GATEWAY_L1_ENABLED must be the exact string "true". Default off.
// This module never deposits, withdraws, or broadcasts.

import { sql, type SQL } from "drizzle-orm";
import { isAddress, keccak256, sha256, toBytes, type Account, type Hex } from "viem";
import { chainDailyCapUnits, type CappedChain } from "./budget";
import {
  ARC_CAIP2,
  ARC_USDC,
  EVM_PAY_CHAINS,
  encodePaymentHeader,
  hasSignableEnabledEvmAccept,
  hasSignableNativeArcAccept,
  isEvmPayChainEnabled,
  MAX_PER_PURCHASE_UNITS,
  type ChallengeAccept,
  type Eip3009Authorization,
  type EvmPayChain,
} from "./x402-payer";

/** Pinned GatewayWallet on Arc. Sellers do not choose this address. */
export const ARC_GATEWAY_WALLET = "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE";
export const ARC_GATEWAY_DOMAIN_NAME = "GatewayWalletBatched";
export const ARC_GATEWAY_DOMAIN_VERSION = "1";
/** Unauthenticated Circle Gateway API. The verifier reads transfers here. */
export const ARC_GATEWAY_API = "https://gateway-api.circle.com/v1";
/** Circle's domain id for Arc mainnet. The balance read sends this and does not open an RPC. */
export const ARC_GATEWAY_DOMAIN = 26;
/**
 * Longest authorization this rail will sign.
 * The SDK uses max(seller maxTimeoutSeconds, 7 days + 100 seconds) and has no upper bound.
 */
export const ARC_GATEWAY_MAX_TIMEOUT_SECONDS = 7 * 24 * 60 * 60 + 100;
/** After validBefore, wait this long before closing an uncharged row. */
export const GATEWAY_NOT_CHARGED_GRACE_SECONDS = 24 * 60 * 60;
export { GATEWAY_NOT_CHARGED_EXPIRED } from "./arc-gateway-words";
/** One Gateway API call. The verifier also keeps a read budget, writes judged rows, then moves on to native rows. */
export const GATEWAY_FETCH_TIMEOUT_MS = 2_000;
/**
 * How long a UTC day's root can still gain a row. An authorization lasts at most
 * 7 days + 100 seconds, then an uncharged absent or failed row waits 24 hours.
 * 8 days and 100 seconds after that UTC day ends.
 */
export const GATEWAY_ROOT_WAIT_SECONDS = ARC_GATEWAY_MAX_TIMEOUT_SECONDS + GATEWAY_NOT_CHARGED_GRACE_SECONDS;

/** vet402 pays these Stellar assets and no others. Same strings as stellar402-payer.ts. */
const STELLAR_USDC_CLASSIC = "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const STELLAR_USDC_SAC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

export function gatewayRootWaitNote(day: string): string {
  const days = Math.floor(GATEWAY_ROOT_WAIT_SECONDS / 86_400);
  const extra = GATEWAY_ROOT_WAIT_SECONDS % 86_400;
  return `day ${day} UTC. This root is not final until ${days} days and ${extra} seconds after this UTC day ends. A pending charge does not expire, so the root stays open while any row attempted on this day is still unverified.`;
}
/** Reservation marker. Native Arc cap counts rows that lack it. */
export const ARC_GATEWAY_RAIL_KEY = "circleGatewayRail";
/** Signed authorization plus the batch tx, once Circle names one. */
export const ARC_GATEWAY_META_KEY = "circleGateway";

export function isArcGatewayL1Enabled(): boolean {
  return process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED === "true";
}

/** True when the Gateway balance can cover this purchase. Null or short means do not sign. */
export function arcGatewayFundsOk(available: bigint | null, amount: bigint): boolean {
  return available !== null && amount > 0n && available >= amount;
}

/** True when today's Gateway spend is still under L1_ARC_GATEWAY_DAILY_CAP_USD. 0 stops the rail. */
export function arcGatewayCapOpen(spent: bigint): boolean {
  return spent < chainDailyCapUnits("arc_gateway");
}

/**
 * Network predicate for reserveSpend / the lane spend read.
 * `arc` and `arc_gateway` share eip155:5042 and are split by the rail marker.
 * Every other capped chain keeps `network LIKE`.
 */
export function chainCapNetworkSql(chain: CappedChain | null, capLike: string | null): SQL {
  if (chain === "arc") {
    return sql`network = 'eip155:5042' AND coalesce(raw_response_meta->>'circleGatewayRail', '') <> 'true'`;
  }
  if (chain === "arc_gateway") {
    return sql`network = 'eip155:5042' AND raw_response_meta->>'circleGatewayRail' = 'true'`;
  }
  return sql`network LIKE ${capLike ?? ""}`;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * The seller's verifyingContract string when it is the pinned wallet (case ignored), else null.
 * The facilitator compares `accepted` with the seller's requirements as exact strings, so the
 * header must carry the seller's spelling. The signing domain stays ARC_GATEWAY_WALLET.
 */
export function gatewayEchoedVerifyingContract(extra: unknown): string | null {
  const rec = asRecord(extra);
  if (!rec || typeof rec.verifyingContract !== "string") return null;
  return rec.verifyingContract.toLowerCase() === ARC_GATEWAY_WALLET.toLowerCase() ? rec.verifyingContract : null;
}

/**
 * A live or catalog accept this rail may sign. name and version are the pin.
 * verifyingContract is the seller's string, kept only after it matched the pin (case ignored),
 * so the PAYMENT-SIGNATURE `accepted` echoes what the seller sent.
 */
export function arcGatewayAcceptOf(raw: unknown): ChallengeAccept | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  if (rec.scheme !== "exact") return null;
  if (rec.network !== ARC_CAIP2) return null;
  if (typeof rec.amount !== "string" || !/^[0-9]+$/.test(rec.amount)) return null;
  if (typeof rec.asset !== "string" || rec.asset.toLowerCase() !== ARC_USDC.toLowerCase()) return null;
  if (typeof rec.payTo !== "string" || !isAddress(rec.payTo)) return null;
  const extra = asRecord(rec.extra);
  if (!extra) return null;
  if (extra.name !== ARC_GATEWAY_DOMAIN_NAME) return null;
  if (extra.version !== ARC_GATEWAY_DOMAIN_VERSION) return null;
  if (typeof extra.verifyingContract !== "string") return null;
  if (extra.verifyingContract.toLowerCase() !== ARC_GATEWAY_WALLET.toLowerCase()) return null;
  if (extra.salt !== undefined) return null;
  if (extra.chainId !== undefined && extra.chainId !== 5042 && extra.chainId !== "5042") return null;
  if (rec.maxTimeoutSeconds !== undefined && !Number.isInteger(rec.maxTimeoutSeconds)) return null;
  if (typeof rec.maxTimeoutSeconds === "number" && rec.maxTimeoutSeconds > ARC_GATEWAY_MAX_TIMEOUT_SECONDS) return null;
  const echoedContract = gatewayEchoedVerifyingContract(extra);
  if (echoedContract === null) return null;
  return {
    scheme: "exact",
    network: ARC_CAIP2,
    amount: rec.amount,
    asset: ARC_USDC,
    payTo: rec.payTo,
    ...(typeof rec.maxTimeoutSeconds === "number" ? { maxTimeoutSeconds: rec.maxTimeoutSeconds } : {}),
    extra: {
      name: ARC_GATEWAY_DOMAIN_NAME,
      version: ARC_GATEWAY_DOMAIN_VERSION,
      verifyingContract: echoedContract,
    },
  };
}

/** Payees the catalog declared on a pinned Gateway accept (lowercased). */
export function gatewayDeclaredPayTosFor(rawAccepts: unknown): string[] {
  let list: unknown = rawAccepts;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const out = new Set<string>();
  for (const raw of list) {
    const hit = arcGatewayAcceptOf(raw);
    if (hit) out.add(hit.payTo.toLowerCase());
  }
  return [...out];
}

export type GatewayAcceptReason =
  | "no_eligible_accept"
  | "price_mismatch"
  | "payto_mismatch"
  | "over_cap"
  | "native_present"
  | "timeout_too_long";

export type GatewayAcceptSelection =
  | { accept: ChallengeAccept; reason: null }
  | { accept: null; reason: GatewayAcceptReason };

function declaredUnitsOf(amount: string | null): bigint | null {
  if (amount === null) return null;
  try {
    const v = BigInt(amount);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

function gatewayTimeoutTooLong(raw: unknown): boolean {
  const rec = asRecord(raw);
  if (!rec || rec.scheme !== "exact" || rec.network !== ARC_CAIP2) return false;
  const extra = asRecord(rec.extra);
  if (!extra || extra.name !== ARC_GATEWAY_DOMAIN_NAME) return false;
  return typeof rec.maxTimeoutSeconds === "number" && rec.maxTimeoutSeconds > ARC_GATEWAY_MAX_TIMEOUT_SECONDS;
}

/**
 * Gateway accept for this challenge, or a refusal.
 * `nativeArcSignable` (hasSignableNativeArcAccept, flag-aware) means the direct Arc rail
 * can pay, so this rail does not. `otherChainSignable` means some other enabled rail can
 * sign an accept on this challenge, so this rail does not. Callers record a seller finding
 * only when neither is true.
 */
export function selectArcGatewayAccept(
  accepts: readonly unknown[],
  options: {
    nativeArcSignable: boolean;
    otherChainSignable?: boolean;
    declaredAmount: string | null;
    declaredPayTo: string | null;
    declaredNetwork: string | null;
    gatewayDeclaredPayTos: readonly string[];
  },
): GatewayAcceptSelection {
  if (options.nativeArcSignable) return { accept: null, reason: "native_present" };
  if (options.otherChainSignable) return { accept: null, reason: "native_present" };
  const protocol = accepts.map(arcGatewayAcceptOf).filter((a): a is ChallengeAccept => a !== null);
  if (protocol.length === 0) {
    if (accepts.some(gatewayTimeoutTooLong)) return { accept: null, reason: "timeout_too_long" };
    return { accept: null, reason: "no_eligible_accept" };
  }

  const declaredPayTo = options.declaredPayTo === null ? null : options.declaredPayTo.toLowerCase();
  const declaredGateway = new Set(options.gatewayDeclaredPayTos.map((p) => p.toLowerCase()).filter((p) => p !== ""));
  const payToOk = (payTo: string): boolean => {
    const lower = payTo.toLowerCase();
    if (declaredGateway.size > 0) return declaredGateway.has(lower);
    return declaredPayTo === null || lower === declaredPayTo;
  };
  const eligible = protocol.filter((a) => payToOk(a.payTo));
  if (eligible.length === 0) return { accept: null, reason: "payto_mismatch" };

  const declaredNetwork = options.declaredNetwork ?? null;
  const onDeclaredArc = declaredNetwork === ARC_CAIP2;
  const declaredUnits = declaredUnitsOf(options.declaredAmount);
  const relativeCap = declaredUnits === null ? null : declaredUnits < MAX_PER_PURCHASE_UNITS ? declaredUnits : MAX_PER_PURCHASE_UNITS;

  for (const accept of eligible) {
    let amount: bigint;
    try {
      amount = BigInt(accept.amount);
    } catch {
      continue;
    }
    if (amount <= 0n) continue;
    if (amount > MAX_PER_PURCHASE_UNITS) continue;
    if (onDeclaredArc) {
      if (options.declaredAmount !== null && accept.amount !== options.declaredAmount) continue;
    } else if (relativeCap === null) {
      // No readable declared price, so the other-chain exemption is closed.
      if (options.declaredAmount !== null && accept.amount !== options.declaredAmount) continue;
    } else if (amount > relativeCap) {
      continue;
    }
    return { accept, reason: null };
  }

  const anyOverCap = eligible.some((a) => {
    try {
      return BigInt(a.amount) > MAX_PER_PURCHASE_UNITS;
    } catch {
      return false;
    }
  });
  const priceOff = eligible.some((a) => {
    try {
      const amount = BigInt(a.amount);
      if (onDeclaredArc) return options.declaredAmount !== null && a.amount !== options.declaredAmount;
      if (relativeCap === null) return options.declaredAmount !== null && a.amount !== options.declaredAmount;
      return amount > relativeCap;
    } catch {
      return false;
    }
  });
  if (anyOverCap) return { accept: null, reason: "over_cap" };
  if (priceOff) return { accept: null, reason: "price_mismatch" };
  return { accept: null, reason: "no_eligible_accept" };
}

/** Re-export so the runner and tests share one native-Arc predicate. */
export { hasSignableNativeArcAccept };

const RAW_ACCEPTS = `jsonb_array_elements(CASE WHEN jsonb_typeof(e.raw_accepts) = 'array' THEN e.raw_accepts ELSE '[]'::jsonb END)`;

/** Pinned Gateway accept inside e.raw_accepts. Alias `g`. */
const GATEWAY_ACCEPT_WHERE = `
  g->>'scheme' = 'exact'
  AND g->>'network' = 'eip155:5042'
  AND lower(g->>'asset') = '${ARC_USDC.toLowerCase()}'
  AND g->'extra'->>'name' = 'GatewayWalletBatched'
  AND g->'extra'->>'version' = '1'
  AND lower(g->'extra'->>'verifyingContract') = '${ARC_GATEWAY_WALLET.toLowerCase()}'
  AND g->>'payTo' ~ '^0x[0-9a-fA-F]{40}$'
  AND g->>'amount' ~ '^[1-9][0-9]{0,29}$'
  AND (
    g->'maxTimeoutSeconds' IS NULL
    OR (jsonb_typeof(g->'maxTimeoutSeconds') = 'number' AND g->>'maxTimeoutSeconds' !~ '\\.')
  )`;

function existsGateway(): string {
  return `EXISTS (SELECT 1 FROM ${RAW_ACCEPTS} g WHERE ${GATEWAY_ACCEPT_WHERE})`;
}

function sqlQuote(value: string): string {
  return value.replace(/'/g, "''");
}

/** Signable exact accept on one pinned EVM chain. Alias `o`. GatewayWalletBatched is not signable. */
function evmSignableWhere(chain: EvmPayChain): string {
  return `
    o->>'scheme' = 'exact'
    AND o->>'network' = '${sqlQuote(chain.caip2)}'
    AND lower(o->>'asset') = '${chain.usdc.toLowerCase()}'
    AND coalesce(o->'extra'->>'assetTransferMethod', 'eip3009') = 'eip3009'
    AND (o->'extra'->>'name' IS NULL OR o->'extra'->>'name' = '${sqlQuote(chain.eip712Name)}')
    AND (o->'extra'->>'version' IS NULL OR o->'extra'->>'version' = '${sqlQuote(chain.eip712Version)}')
    AND (o->'extra'->>'verifyingContract' IS NULL OR lower(o->'extra'->>'verifyingContract') = '${chain.usdc.toLowerCase()}')
    AND o->'extra'->>'salt' IS NULL
    AND coalesce(o->'extra'->>'name', '') <> 'GatewayWalletBatched'
    AND o->>'payTo' ~ '^0x[0-9a-fA-F]{40}$'
    AND o->>'amount' ~ '^[1-9][0-9]{0,29}$'`;
}

function envSet(name: string): boolean {
  return (process.env[name]?.trim() ?? "") !== "";
}

function solanaRailConfigured(): boolean {
  return process.env.OBSERVATORY_SOLANA_L1_ENABLED === "true" && envSet("OBSERVATORY_SOLANA_SECRET_KEY") && envSet("SOLANA_RPC_URL");
}
function xrplRailConfigured(): boolean {
  return process.env.OBSERVATORY_XRPL_L1_ENABLED === "true" && envSet("OBSERVATORY_XRPL_SEED") && envSet("XRPL_RPC_URL");
}
function stellarRailConfigured(): boolean {
  return (
    process.env.OBSERVATORY_STELLAR_L1_ENABLED === "true" &&
    envSet("STELLAR_PAYER_SECRET") &&
    envSet("STELLAR_RPC_URL") &&
    envSet("STELLAR_HORIZON_URL")
  );
}

/**
 * True when an enabled rail other than native Arc would sign one of these accepts.
 * Arc is excluded here because nativeArcSignable already covers it.
 * A non-EVM rail counts when its flag is on, the key and RPC env vars are non-empty,
 * and the asset is one vet402 can pay. The values of those env vars are not read.
 */
export function hasSignableOtherRailAccept(accepts: readonly unknown[]): boolean {
  if (hasSignableEnabledEvmAccept(accepts, ARC_CAIP2)) return true;
  for (const raw of accepts) {
    const rec = asRecord(raw);
    if (!rec || rec.scheme !== "exact") continue;
    const network = typeof rec.network === "string" ? rec.network : "";
    const payTo = typeof rec.payTo === "string" ? rec.payTo : "";
    const asset = typeof rec.asset === "string" ? rec.asset : "";
    if (payTo === "" || !/^[1-9][0-9]{0,29}$/.test(typeof rec.amount === "string" ? rec.amount : "")) continue;
    if (solanaRailConfigured() && network === "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" && asset === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") {
      return true;
    }
    if (
      xrplRailConfigured() &&
      network === "xrpl:0" &&
      (asset === "RLUSD" || asset.toUpperCase() === "524C555344000000000000000000000000000000")
    ) {
      return true;
    }
    if (stellarRailConfigured() && network === "stellar:pubnet" && (asset === STELLAR_USDC_CLASSIC || asset === STELLAR_USDC_SAC)) return true;
  }
  return false;
}

/** Exists-clause for an accept vet402 could sign on a chain other than Gateway. */
function existsOtherSignable(): string {
  const parts: string[] = [];
  for (const chain of EVM_PAY_CHAINS) {
    if (!isEvmPayChainEnabled(chain)) continue;
    parts.push(`EXISTS (SELECT 1 FROM ${RAW_ACCEPTS} o WHERE ${evmSignableWhere(chain)})`);
  }
  if (solanaRailConfigured()) {
    parts.push(`EXISTS (SELECT 1 FROM ${RAW_ACCEPTS} o WHERE o->>'scheme' = 'exact' AND o->>'network' = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' AND o->>'asset' = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' AND o->>'payTo' <> '' AND o->>'amount' ~ '^[1-9][0-9]{0,29}$')`);
  }
  if (xrplRailConfigured()) {
    parts.push(`EXISTS (SELECT 1 FROM ${RAW_ACCEPTS} o WHERE o->>'scheme' = 'exact' AND o->>'network' = 'xrpl:0' AND (upper(o->>'asset') = '524C555344000000000000000000000000000000' OR o->>'asset' = 'RLUSD') AND o->>'payTo' <> '' AND o->>'amount' ~ '^[1-9][0-9]{0,29}$')`);
  }
  if (stellarRailConfigured()) {
    parts.push(`EXISTS (SELECT 1 FROM ${RAW_ACCEPTS} o WHERE o->>'scheme' = 'exact' AND o->>'network' = 'stellar:pubnet' AND (o->>'asset' = '${STELLAR_USDC_CLASSIC}' OR o->>'asset' = '${STELLAR_USDC_SAC}') AND o->>'payTo' <> '' AND o->>'amount' ~ '^[1-9][0-9]{0,29}$')`);
  }
  return parts.length === 0 ? "FALSE" : parts.join(" OR ");
}

/**
 * With the flag off this is empty, so primary candidates match the selection from before this rail.
 * With the flag on, a listing vet402 can sign on no other chain, and that has a Gateway accept, leaves the primary list.
 */
export function gatewayPrimaryExclusionSql(): SQL {
  if (!isArcGatewayL1Enabled()) return sql``;
  return sql.raw(`AND NOT (${existsGateway()} AND NOT (${existsOtherSignable()}))`);
}

/** Gateway lane: a Gateway accept, and no accept vet402 can sign on another chain. */
export function gatewayCandidateInclusionSql(): SQL {
  if (!isArcGatewayL1Enabled()) return sql`AND false`;
  return sql.raw(`AND ${existsGateway()} AND NOT (${existsOtherSignable()})`);
}

/**
 * Outcome of a signed Gateway purchase. There is no per-payment transaction id here,
 * so the well-formed-tx branch of the native purchase does not apply.
 * No response, a 402, and a 500 stay settle_failed. A 200 with no settlement receipt
 * stays delivered_no_receipt until the Gateway API shows the charge.
 */
export function gatewaySignedStatus(
  paid: { status: number } | null,
  claimedSettlement: boolean,
): "settle_failed" | "settle_claimed" | "delivered_no_receipt" {
  if (paid === null) return "settle_failed"; // gateway_no_seller_response
  if (paid.status === 402 || paid.status >= 500) return "settle_failed"; // gateway_seller_refused
  if (claimedSettlement) return "settle_claimed"; // gateway_receipt_not_settled
  if (paid.status === 200) return "delivered_no_receipt";
  return "settle_failed";
}

/** True when validBefore is still ahead and the remaining window is within the cap. */
export function gatewayAuthWindowOk(validBefore: string, nowSec: number): boolean {
  if (!/^[0-9]+$/.test(validBefore)) return false;
  const before = Number(validBefore);
  if (!Number.isFinite(before)) return false;
  const left = before - nowSec;
  return left > 0 && left <= ARC_GATEWAY_MAX_TIMEOUT_SECONDS;
}

/** USDC base units from a Gateway API decimal string. Scientific notation is refused. */
export function parseGatewayUsdc(raw: unknown): bigint | null {
  if (typeof raw !== "string" || !/^\d+(\.\d{1,6})?$/.test(raw)) return null;
  const [whole, frac = ""] = raw.split(".");
  try {
    return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
  } catch {
    return null;
  }
}

export type ArcGatewaySigned = {
  header: { headerName: string; headerValue: string };
  authorization: Eip3009Authorization;
  signature: string;
  verifyingContract: string;
};

export type ArcGatewaySigner = (input: {
  account: Account;
  accept: ChallengeAccept;
  x402Version: 1 | 2;
  resourceUrl: string;
}) => Promise<ArcGatewaySigned>;

/**
 * Sign a Gateway authorization with BatchEvmScheme. The domain is the pinned wallet.
 * The scheme does not broadcast. Validity is capped at 7 days + 100 seconds, not the 120s native window.
 */
export const signArcGatewayPayment: ArcGatewaySigner = async (input) => {
  // Checked again before signing: an accept that did not come from arcGatewayAcceptOf is refused.
  const echoedContract = gatewayEchoedVerifyingContract(input.accept.extra);
  if (echoedContract === null) throw new Error("gateway_verifying_contract_mismatch");
  const { BatchEvmScheme } = await import("@circle-fin/x402-batching/client");
  const scheme = new BatchEvmScheme(input.account as never);
  const maxTimeoutSeconds = input.accept.maxTimeoutSeconds ?? 0;
  if (maxTimeoutSeconds > ARC_GATEWAY_MAX_TIMEOUT_SECONDS) throw new Error("gateway_validity_window");
  const created = await scheme.createPaymentPayload(input.x402Version, {
    scheme: "exact",
    network: ARC_CAIP2,
    amount: input.accept.amount,
    asset: ARC_USDC,
    payTo: input.accept.payTo,
    maxTimeoutSeconds,
    extra: {
      name: ARC_GATEWAY_DOMAIN_NAME,
      version: ARC_GATEWAY_DOMAIN_VERSION,
      verifyingContract: ARC_GATEWAY_WALLET,
    },
  });
  const authorization = created.payload.authorization;
  if (authorization.value !== input.accept.amount) throw new Error("gateway_value_mismatch");
  if (authorization.to.toLowerCase() !== input.accept.payTo.toLowerCase()) throw new Error("gateway_payto_mismatch");
  const nowSec = Math.floor(Date.now() / 1000);
  if (!gatewayAuthWindowOk(authorization.validBefore, nowSec)) throw new Error("gateway_validity_window");
  const header = encodePaymentHeader({
    x402Version: input.x402Version,
    accept: {
      ...input.accept,
      scheme: "exact",
      network: ARC_CAIP2,
      asset: ARC_USDC,
      extra: {
        name: ARC_GATEWAY_DOMAIN_NAME,
        version: ARC_GATEWAY_DOMAIN_VERSION,
        // The seller's spelling, already matched to the pin. The domain above signed the pin.
        verifyingContract: echoedContract,
      },
    },
    payload: { signature: created.payload.signature, authorization },
    resourceUrl: input.resourceUrl,
  });
  return {
    header,
    authorization,
    signature: created.payload.signature,
    verifyingContract: ARC_GATEWAY_WALLET,
  };
};

/**
 * Leaf facts for the daily Merkle root. resourceHash is keccak256 of the resource URL.
 * requestHash and responseHash are sha256 of the bytes we stored (the body may be truncated).
 * httpStatus outside uint16 becomes 0.
 */
export function gatewayLeafFacts(input: {
  resourceUrl: string;
  method: string;
  paidUrl: string;
  requestBody: string;
  responseBody: string;
  httpStatus: number;
}): { resourceHash: Hex; requestHash: Hex; responseHash: Hex; httpStatus: number } {
  const httpStatus = Number.isInteger(input.httpStatus) && input.httpStatus >= 0 && input.httpStatus <= 65535 ? input.httpStatus : 0;
  return {
    resourceHash: keccak256(toBytes(input.resourceUrl)),
    requestHash: sha256(toBytes(`${input.method} ${input.paidUrl}\n${input.requestBody}`)),
    responseHash: sha256(toBytes(input.responseBody)),
    httpStatus,
  };
}

/**
 * Gateway available balance (6 decimals) from the Gateway API alone.
 * Does not open an RPC and does not read a private key. Throws when the API cannot be read. Never deposits.
 */
export async function readArcGatewayAvailable(depositor: string): Promise<bigint> {
  const res = await fetch(`${ARC_GATEWAY_API}/balances`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "USDC", sources: [{ depositor, domain: ARC_GATEWAY_DOMAIN }] }),
    signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error("gateway_balance_http");
  const body = (await res.json()) as { balances?: { balance?: unknown }[] };
  const available = parseGatewayUsdc(body.balances?.[0]?.balance);
  if (available === null) throw new Error("gateway_balance_invalid");
  return available;
}
