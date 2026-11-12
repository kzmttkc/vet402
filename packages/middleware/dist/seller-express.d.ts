import { type FacilitatorReceipt, type SellerEdgeConfig } from "./seller-edge.js";
type ExpressRes = {
    status(code: number): ExpressRes;
    json(body: unknown): unknown;
    setHeader?(name: string, value: string): unknown;
};
export type ExpressSellerEdgeOptions<Req> = SellerEdgeConfig & {
    getReceipt: (req: Req) => FacilitatorReceipt | null;
    getPurchaseId: (req: Req) => string;
};
export declare function createExpressSellerEdge<Req>(options: ExpressSellerEdgeOptions<Req>): (req: Req, res: ExpressRes, next: () => void | Promise<void>) => Promise<void>;
export {};
