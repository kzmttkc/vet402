import { type FacilitatorReceipt, type SellerEdgeConfig } from "./seller-edge.js";
type LambdaHandlerResult = {
    status: string;
    body?: string;
};
export type LambdaSellerEdgeResult = {
    status: string;
    statusDescription: string;
    body: string;
    headers: Record<string, {
        key: string;
        value: string;
    }[]>;
};
export type LambdaSellerEdgeOptions<Event> = SellerEdgeConfig & {
    getReceipt: (event: Event) => FacilitatorReceipt | null;
    getPurchaseId: (event: Event) => string;
};
export declare function withLambdaEdgeSellerEdge<Event>(options: LambdaSellerEdgeOptions<Event>, handler: (event: Event) => Promise<LambdaHandlerResult> | LambdaHandlerResult): (event: Event) => Promise<LambdaSellerEdgeResult>;
export {};
