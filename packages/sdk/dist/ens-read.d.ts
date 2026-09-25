export declare const ENS_SEPOLIA_CHAIN_ID: 11155111;
/** ENSv2 Sepolia (deployed 2026-09-15, measured on two RPCs 2026-09-18). */
export declare const ENS_SEPOLIA: {
    readonly universalResolver: "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe";
    readonly universalHelper: "0x33f571aa8A160a21b877cF6E0Fb8806692b97DF5";
    readonly ethRegistry: "0x657eA849311d3D5823348ddEd7C2AaAFb3EDE09E";
};
/**
 * The four methods the gate uses. viem's PublicClient satisfies this shape structurally;
 * a test double only has to implement these four.
 */
export type EnsRpc = {
    readContract(args: unknown): Promise<unknown>;
    getBlock(args?: unknown): Promise<{
        number: bigint | null;
        timestamp: bigint;
    }>;
    getBlockNumber(args?: unknown): Promise<bigint>;
    getChainId(): Promise<number>;
};
/** Two independent RPCs (different providers). */
export type EnsReadClients = {
    primary: EnsRpc;
    secondary: EnsRpc;
};
/** Thrown for RPC errors, disagreement between the two RPCs, stale head, wrong chain or ROOT mismatch. */
export declare class EnsEvidenceUnavailable extends Error {
    readonly code: "ens_evidence_unavailable";
    constructor(detail: string);
}
/** ENSIP-15 normalization (throws on an invalid name). */
export declare function normalizeName(name: string): string;
/** DNS wire format of an already-normalized name (labels of 1..255 bytes). */
export declare function dnsEncode(name: string): `0x${string}`;
/** Run `fn` on both RPCs; any error or any byte of difference → EnsEvidenceUnavailable. */
export declare function readBoth<T>(clients: EnsReadClients, fn: (c: EnsRpc) => Promise<T>, what?: string): Promise<T>;
export type PinnedBlock = {
    B: bigint;
    ts: bigint;
    heads: {
        primary: bigint;
        secondary: bigint;
    };
};
/**
 * Step 0. Both RPCs on chainId 11155111, |head1 − head2| ≤ 3, now − timestamp(B) ≤ maxHeadLagSeconds,
 * B = min(head1, head2), and at B: UniversalHelper.ROOT_REGISTRY() == UniversalResolver.ROOT_REGISTRY().
 */
export declare function pinBlock(clients: EnsReadClients, maxHeadLagSeconds: number, nowSeconds?: number): Promise<PinnedBlock>;
/** Exact owner of the (normalized) name, or null for 0x0 (unregistered, expired, RESERVED, wildcard subname). */
export declare function findExactOwner(clients: EnsReadClients, B: bigint, name: string): Promise<`0x${string}` | null>;
/** text(name, key) through UniversalResolver.resolve, with the resolver that answered. "" when empty. */
export declare function resolveText(clients: EnsReadClients, B: bigint, name: string, key: string): Promise<{
    value: string;
    resolver: `0x${string}` | null;
}>;
/** addr(name) (coin type 60) through UniversalResolver.resolve. null when empty or 0x0. */
export declare function resolveAddr(clients: EnsReadClients, B: bigint, name: string): Promise<{
    value: `0x${string}` | null;
    resolver: `0x${string}` | null;
}>;
/** ETHRegistry.getState(labelhash(label)) for a .eth second-level label. status 2 = registered. */
export declare function getState(clients: EnsReadClients, B: bigint, label: string): Promise<{
    tokenId: bigint;
    status: number;
    latestOwner: `0x${string}`;
    expiry: bigint;
}>;
