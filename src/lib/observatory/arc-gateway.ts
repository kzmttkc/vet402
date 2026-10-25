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
  encodePaymentHeader,
  hasSignableNativeArcAccept,
  MAX_PER_PURCHASE_UNITS,
  type ChallengeAccept,
  type Eip3009Authorization,
} from "./x402-payer";

/** Pinned GatewayWallet on Arc. Sellers do not choose this address. */
export const ARC_GATEWAY_WALLET = "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE";
export const ARC_GATEWAY_DOMAIN_NAME = "GatewayWalletBatched";
export const ARC_GATEWAY_DOMAIN_VERSION = "1";
/** Unauthenticated Circle Gateway API. The verifier reads transfers here. */
export const ARC_GATEWAY_API = "https://gateway-api.circle.com/v1";
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

/** A live or catalog accept this rail may sign. The returned extra is the pin, not the seller's extra. */
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
      verifyingContract: ARC_GATEWAY_WALLET,
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

export type GatewayAcceptReason = "no_eligible_accept" | "price_mismatch" | "payto_mismatch" | "over_cap" | "native_present";

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

/**
 * Gateway accept for this challenge, or a refusal.
 * `nativeArcSignable` (hasSignableNativeArcAccept, flag-aware) means the direct Arc rail
 * can pay, so this rail does not. Callers record a seller finding only for the other reasons.
 */
export function selectArcGatewayAccept(
  accepts: readonly unknown[],
  options: {
    nativeArcSignable: boolean;
    declaredAmount: string | null;
    declaredPayTo: string | null;
    declaredNetwork: string | null;
    gatewayDeclaredPayTos: readonly string[];
  },
): GatewayAcceptSelection {
  if (options.nativeArcSignable) return { accept: null, reason: "native_present" };
  const protocol = accepts.map(arcGatewayAcceptOf).filter((a): a is ChallengeAccept => a !== null);
  if (protocol.length === 0) return { accept: null, reason: "no_eligible_accept" };

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
  if (priceOff) return { accept: null, reason: anyOverCap && !priceOff ? "over_cap" : "price_mismatch" };
  return { accept: null, reason: anyOverCap ? "over_cap" : "no_eligible_accept" };
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

/** Signable native Arc USDC accept inside e.raw_accepts. Alias `n`. Mirrors signableUsdcAccept. */
const NATIVE_ARC_ACCEPT_WHERE = `
  n->>'scheme' = 'exact'
  AND n->>'network' = 'eip155:5042'
  AND lower(n->>'asset') = '${ARC_USDC.toLowerCase()}'
  AND coalesce(n->'extra'->>'assetTransferMethod', 'eip3009') = 'eip3009'
  AND (n->'extra'->>'name' IS NULL OR n->'extra'->>'name' = 'USDC')
  AND (n->'extra'->>'version' IS NULL OR n->'extra'->>'version' = '2')
  AND (n->'extra'->>'verifyingContract' IS NULL OR lower(n->'extra'->>'verifyingContract') = '${ARC_USDC.toLowerCase()}')
  AND n->'extra'->>'salt' IS NULL
  AND coalesce(n->'extra'->>'name', '') <> 'GatewayWalletBatched'
  AND n->>'payTo' ~ '^0x[0-9a-fA-F]{40}$'
  AND n->>'amount' ~ '^[1-9][0-9]{0,29}$'`;

function existsGateway(): string {
  return `EXISTS (SELECT 1 FROM ${RAW_ACCEPTS} g WHERE ${GATEWAY_ACCEPT_WHERE})`;
}
function existsNativeArc(): string {
  return `EXISTS (SELECT 1 FROM ${RAW_ACCEPTS} n WHERE ${NATIVE_ARC_ACCEPT_WHERE})`;
}

/** Primary network is Arc, Gateway accept present, native Arc accept absent. */
export function gatewayPrimaryExclusionSql(): SQL {
  return sql.raw(`AND NOT (e.network = 'eip155:5042' AND ${existsGateway()} AND NOT ${existsNativeArc()})`);
}

/** Any primary network. Gateway accept present, native Arc accept absent. */
export function gatewayCandidateInclusionSql(): SQL {
  return sql.raw(`AND ${existsGateway()} AND NOT ${existsNativeArc()}`);
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
 * The scheme does not broadcast. Validity is the SDK window (about 7 days), not the 120s native window.
 */
export const signArcGatewayPayment: ArcGatewaySigner = async (input) => {
  const { BatchEvmScheme } = await import("@circle-fin/x402-batching/client");
  const scheme = new BatchEvmScheme(input.account as never);
  const created = await scheme.createPaymentPayload(input.x402Version, {
    scheme: "exact",
    network: ARC_CAIP2,
    amount: input.accept.amount,
    asset: ARC_USDC,
    payTo: input.accept.payTo,
    maxTimeoutSeconds: input.accept.maxTimeoutSeconds ?? 0,
    extra: {
      name: ARC_GATEWAY_DOMAIN_NAME,
      version: ARC_GATEWAY_DOMAIN_VERSION,
      verifyingContract: ARC_GATEWAY_WALLET,
    },
  });
  const authorization = created.payload.authorization;
  if (authorization.value !== input.accept.amount) throw new Error("gateway_value_mismatch");
  if (authorization.to.toLowerCase() !== input.accept.payTo.toLowerCase()) throw new Error("gateway_payto_mismatch");
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
        verifyingContract: ARC_GATEWAY_WALLET,
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

/** Gateway available balance (6 decimals). Throws when the API cannot be read. Never deposits. */
export async function readArcGatewayAvailable(privateKey: `0x${string}`): Promise<bigint> {
  const { GatewayClient } = await import("@circle-fin/x402-batching/client");
  const rpcUrl = process.env.ARC_RPC_URL?.trim();
  const client = new GatewayClient({
    chain: "arc",
    privateKey,
    ...(rpcUrl ? { rpcUrl } : {}),
  });
  const balances = await client.getBalances();
  const available = balances.gateway.available;
  if (typeof available !== "bigint" || available < 0n) throw new Error("gateway_balance_invalid");
  return available;
}
