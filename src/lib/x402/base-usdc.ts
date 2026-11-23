import { getAddress, isAddress, verifyTypedData, type Hex } from "viem";
import { PAY_TO, b64json } from "../../../packages/rwa/x402";

export { b64json };

/** Base mainnet (payment rail only; facts are still Robinhood Chain). */
export const BASE_CHAIN_ID = 8453;
export const X402_NETWORK = `eip155:${BASE_CHAIN_ID}`;
/** USDC on Base, 6 decimals. */
export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const PRICE_ATOMIC = "10000";
export { PAY_TO };
export const MAX_TIMEOUT_SECONDS = 120;
const MIN_VALIDITY_SECONDS = 60;

export type BaseUsdcPaymentRequirements = {
  scheme: "exact";
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
};

export function paymentRequirements(): BaseUsdcPaymentRequirements {
  return {
    scheme: "exact",
    network: X402_NETWORK,
    amount: PRICE_ATOMIC,
    asset: USDC,
    payTo: PAY_TO,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: { name: "USD Coin", version: "2" },
  };
}

/** Small, real-shaped example for Bazaar output discovery. */
export const FACTS_OUTPUT_EXAMPLE = {
  address: "0x973cD8a91A771C2C04C6036888F8175D6b4F6227",
  chain_id: 4663,
  as_of: "2026-01-01T00:00:00.000Z",
  as_of_block: 1,
  method_version: "rwa-recon-0.3",
  identity_binding: "unknown",
  r0: "present",
  r1_status: "partial",
  r2: "no_declaration",
  gaps: [] as string[],
  disclaimer: "Rebuilt from public chain data only.",
};

export function bazaarSchema() {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      input: {
        type: "object",
        properties: {
          type: { const: "http" },
          method: { enum: ["GET"] },
          queryParams: {
            type: "object",
            properties: { chain: { type: "string" } },
            required: ["chain"],
          },
        },
        required: ["type", "method", "queryParams"],
      },
      output: {
        type: "object",
        properties: {
          type: { const: "json" },
          example: { type: "object" },
        },
        required: ["type", "example"],
      },
    },
    required: ["input", "output"],
  };
}

export function bazaarInfo() {
  return {
    input: { type: "http" as const, method: "GET" as const, queryParams: { chain: "4663" } },
    output: { type: "json" as const, example: FACTS_OUTPUT_EXAMPLE },
  };
}

export function paymentRequired(resourceUrl: string, error?: string) {
  return {
    x402Version: 2 as const,
    ...(error ? { error } : {}),
    resource: {
      url: resourceUrl,
      description:
        "vet402 RWA facts JSON for one wallet on Robinhood Chain (eip155:4663). Same JSON as the free route. Payment settles in USDC on Base (eip155:8453) via the CDP x402 facilitator.",
      mimeType: "application/json",
      serviceName: "vet402 RWA facts",
      tags: ["rwa", "facts", "base", "usdc", "x402"],
    },
    accepts: [paymentRequirements()],
    extensions: { bazaar: { info: bazaarInfo(), schema: bazaarSchema() } },
  };
}

export type BasePaymentPayload = {
  x402Version: 2;
  accepted: Record<string, unknown>;
  payload: Record<string, unknown>;
  resource?: unknown;
  extensions?: Record<string, unknown>;
};

export class BadPayment extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

type Eip3009Authorization = {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
};

const TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const same = (x: unknown, y: string) => typeof x === "string" && x.toLowerCase() === y.toLowerCase();
const isUint = (x: unknown): x is string => typeof x === "string" && /^\d+$/.test(x);
const isNonce32 = (x: unknown) => typeof x === "string" && /^0x[0-9a-fA-F]{64}$/.test(x);

export function parsePaymentHeader(header: string, nowSec: number = Math.floor(Date.now() / 1000)): BasePaymentPayload {
  let p: BasePaymentPayload;
  try {
    p = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    throw new BadPayment("payment_header_not_base64_json");
  }
  if (!p || p.x402Version !== 2 || typeof p.accepted !== "object" || typeof p.payload !== "object" || !p.accepted || !p.payload) {
    throw new BadPayment("payment_header_shape");
  }
  const a = p.accepted as Record<string, unknown>;
  const want = paymentRequirements();
  if (a.scheme !== want.scheme || a.network !== want.network) throw new BadPayment("wrong_scheme_or_network");
  if (!same(a.asset, want.asset)) throw new BadPayment("wrong_asset");
  if (!same(a.payTo, want.payTo)) throw new BadPayment("wrong_pay_to");
  if (a.amount !== want.amount) throw new BadPayment("amount_is_not_the_price");
  const pl = p.payload as { signature?: unknown; authorization?: Eip3009Authorization };
  const auth = pl.authorization;
  if (!auth || typeof pl.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(pl.signature)) {
    throw new BadPayment("eip3009_authorization_required");
  }
  if (!same(auth.to, want.payTo)) throw new BadPayment("authorization_to_is_not_pay_to");
  if (auth.value !== want.amount) throw new BadPayment("authorization_value_is_not_the_price");
  if (typeof auth.from !== "string" || !isAddress(auth.from)) throw new BadPayment("from_is_not_an_address");
  if (!isUint(auth.validAfter) || !isUint(auth.validBefore) || !isNonce32(auth.nonce)) throw new BadPayment("authorization_fields_invalid");
  if (BigInt(auth.validBefore) < BigInt(nowSec + MIN_VALIDITY_SECONDS)) throw new BadPayment("valid_before_too_soon");
  if (BigInt(auth.validAfter) > BigInt(nowSec)) throw new BadPayment("not_valid_yet");
  return p;
}

export async function checkSignature(p: BasePaymentPayload): Promise<boolean> {
  const pl = p.payload as { signature: Hex; authorization: Eip3009Authorization };
  const auth = pl.authorization;
  try {
    return await verifyTypedData({
      address: getAddress(auth.from),
      domain: { name: "USD Coin", version: "2", chainId: BASE_CHAIN_ID, verifyingContract: USDC },
      types: TRANSFER_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: getAddress(auth.from),
        to: getAddress(auth.to),
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce as Hex,
      },
      signature: pl.signature,
    });
  } catch {
    return false;
  }
}