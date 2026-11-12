import type { ChainTransfer } from "./seller-edge.js";
export type SellerRpc = (method: string, params: readonly unknown[]) => Promise<unknown>;
export type SellerReceiptLog = {
    address?: string;
    topics?: readonly string[];
    data?: string;
};
export type SellerReceipt = {
    status?: string | number;
    transactionHash?: string;
    logs?: readonly SellerReceiptLog[];
};
export declare function chainIdFromCaip2(network: string): number | null;
/** One Transfer of `asset`, or null when the receipt does not show exactly one. */
export declare function transferFromSellerReceipt(input: {
    network: string;
    asset: string;
    chainIdHex: string;
    receipt: SellerReceipt | null;
    txHash: string;
}): ChainTransfer | null;
export declare function createSellerChainReader(options: {
    network: string;
    asset: string;
    rpc: SellerRpc;
}): (txHash: string) => Promise<ChainTransfer | null>;
