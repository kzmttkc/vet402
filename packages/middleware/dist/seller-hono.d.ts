import { type FacilitatorReceipt, type SellerEdgeConfig } from "./seller-edge.js";
type HonoCtx = {
    json(body: unknown, status?: number): Response;
};
export type HonoSellerEdgeOptions<Ctx> = SellerEdgeConfig & {
    getReceipt: (c: Ctx) => FacilitatorReceipt | null;
    getPurchaseId: (c: Ctx) => string;
};
export declare function createHonoSellerEdge<Ctx extends HonoCtx>(options: HonoSellerEdgeOptions<Ctx>): (c: Ctx, next: () => void | Promise<void>) => Promise<Response>;
export {};
