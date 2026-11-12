export declare const SELLER_EDGE_TARGET_P95_MS = 20;
export declare const DELIVERY_PROOF_HEADER = "X-Vet402-Delivery-Proof";
export declare const DELIVERY_HASH_HEADER = "X-Vet402-Body-Hash";
export declare class SellerEdgeError extends Error {
    readonly code: string;
    constructor(message: string, code: string);
}
export type SellerOffer = {
    amount: string;
    payTo: string;
    asset: string;
    network: string;
};
/** Receipt the seller already got from the seller's facilitator. vet402 does not create it. */
export type FacilitatorReceipt = {
    valid: boolean;
    txHash?: string | null;
    amount?: string | null;
    payTo?: string | null;
    asset?: string | null;
    network?: string | null;
};
export type ChainTransfer = {
    txHash: string;
    amount: string;
    payTo: string;
    asset: string;
    network: string;
};
export type SellerEdgeE6Write = {
    purchaseId: string;
    seller: {
        paymentVerified: string;
        deliveredBodyHash: string;
        deliverySignature: string;
        vet402Middleware: true;
    };
};
export type ReplayStore = {
    has(key: string): boolean | Promise<boolean>;
    add(key: string): void | Promise<void>;
    delete(key: string): void | Promise<void>;
};
export type SellerEdgeConfig = {
    offer: SellerOffer;
    readChain: (txHash: string) => Promise<ChainTransfer | null>;
    signDelivery: (bodyHash: string) => string | Promise<string>;
    recordE6: (record: SellerEdgeE6Write) => void | Promise<void>;
    replay?: ReplayStore;
    /** Test clock. Production uses performance.now. */
    clock?: () => number;
};
export type SellerEdgeResult = {
    status: number;
    body: string;
    headers: Record<string, string>;
    delivered: boolean;
    reason: string;
    sellerMiss: boolean;
};
export type SellerEdgeLatencyReport = {
    samples: number;
    overheadMs: number[];
    measuredP95Ms: number | null;
    targetP95Ms: number;
    targetMet: boolean;
    statement: string;
};
export type SellerEdgeHandlerResult = {
    status: number;
    body: string;
    headers?: Record<string, string>;
};
export type SellerEdge = {
    run(request: {
        purchaseId: string;
        receipt: FacilitatorReceipt | null;
    }, handler: () => Promise<SellerEdgeHandlerResult>): Promise<SellerEdgeResult>;
    latency(): SellerEdgeLatencyReport;
};
export declare function deliveryBodyHash(body: string): string;
/** Publish the measured p95. Fewer than 20 samples does not claim the target. */
export declare function reportSellerEdgeLatency(samples: readonly number[]): SellerEdgeLatencyReport;
export declare function createSellerEdge(config: SellerEdgeConfig): SellerEdge;
