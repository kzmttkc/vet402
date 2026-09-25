import { type AtstProfile } from "./atst-codec.js";
import { type EnsAttestationReason } from "./ens-reasons.js";
import { type EnsReadClients } from "./ens-read.js";
export type { AtstProfile } from "./atst-codec.js";
export type { EnsAttestationReason } from "./ens-reasons.js";
/** The seller's promise, stored as one line of JSON (whitespace is signed as-is). */
export type X402Offer = {
    v: 1;
    resource: string;
    method: "GET" | "POST";
    network: "eip155:84532";
    asset: `0x${string}`;
    amount: string;
    payTo: `0x${string}`;
    output?: {
        required: string[];
    };
};
export type TrustedAttester = {
    name: string;
    address: `0x${string}`;
    recordKeys: readonly string[];
    anchor?: {
        name: string;
        owner: `0x${string}`;
    };
};
export type EnsAttestationPolicy = {
    recordKey?: "x402-offer";
    trustedAttesters: readonly TrustedAttester[];
    minValid?: number;
    maxAgeSeconds?: number;
    futureSkewSeconds?: number;
    maxHeadLagSeconds?: number;
    profiles?: readonly AtstProfile[];
    sinceIssuanceScan?: false | {
        canary?: {
            address: `0x${string}`;
            blockNumber: bigint;
            txHash: `0x${string}`;
        };
    };
    now?: () => number;
};
/** The two fields of a chain profile this gate reads (the base-sepolia row of chain-profile.ts). */
export type EnsOfferProfile = {
    network: string;
    asset: string;
    [k: string]: unknown;
};
export type AttestationStep = {
    step: 1 | 2 | 3 | 4 | 5 | 6 | 7;
    status: "ok" | "fail" | "skipped";
    detail: Record<string, string>;
};
export type AttestationResult = {
    attester: string;
    profile: AtstProfile | null;
    t: number | null;
    recovered: `0x${string}` | null;
    expected: `0x${string}` | null;
    payloadHex: `0x${string}` | null;
    digest: `0x${string}` | null;
    valid: boolean;
    reason: EnsAttestationReason | null;
};
export type EnsOfferCheck = {
    ok: boolean;
    reason_codes: EnsAttestationReason[];
    name: string;
    node: `0x${string}`;
    chainId: 11155111;
    block: {
        number: bigint;
        timestamp: bigint;
    };
    heads: {
        primary: bigint;
        secondary: bigint;
    };
    manager: `0x${string}` | null;
    offerRaw: string | null;
    offer: X402Offer | null;
    endpoint: string | null;
    attestations: AttestationResult[];
    trace: AttestationStep[];
};
export type CheckEnsOfferInput = {
    name: string;
    resource: string;
    method: "GET" | "POST" | string;
    profile: EnsOfferProfile;
    clients: EnsReadClients;
    policy: EnsAttestationPolicy;
};
/** Throws `invalid_attestation_policy: …` before any network access if one field is off. */
export declare function assertEnsAttestationPolicy(p: unknown): asserts p is EnsAttestationPolicy;
/**
 * Compare the promise on the name with the 402 the seller actually returned.
 * Accepts x402 v1 (`maxAmountRequired`, network slug) and v2 (`amount`, CAIP-2 network).
 */
export declare function compareOfferToAccept(o: X402Offer, a: {
    payTo?: string;
    network?: string;
    asset?: string;
    maxAmountRequired?: string | number | bigint;
    amount?: string | number | bigint;
}): ("payee_mismatch" | "price_above_declared" | "chain_or_asset_mismatch")[];
/**
 * Verify the ENSIP-29 attestation(s) on `name`'s `x402-offer` record and that the offer matches
 * the request. Reads only the two Sepolia RPCs in `clients` (no HTTP). Never throws for chain
 * state; throws `invalid_attestation_policy` for a bad policy (before any read).
 */
export declare function checkEnsOffer(input: CheckEnsOfferInput): Promise<EnsOfferCheck>;
