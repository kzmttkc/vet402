import { type FacilitatorReceipt, type SellerEdgeConfig } from "./seller-edge.js";
export type HttpSellerEdgeOptions<Req> = SellerEdgeConfig & {
    getReceipt: (req: Req) => FacilitatorReceipt | null;
    getPurchaseId: (req: Req) => string;
};
export declare function withSellerEdge<Req>(options: HttpSellerEdgeOptions<Req>, handler: (req: Req) => Promise<Response> | Response): (req: Req) => Promise<Response>;
export declare function withWorkerSellerEdge<Req>(options: HttpSellerEdgeOptions<Req>, handler: (req: Req) => Promise<Response> | Response): (req: Req) => Promise<Response>;
