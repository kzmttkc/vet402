// Next.js and Cloudflare Workers share one Request to Response wrapper.
import {
  createSellerEdge,
  type FacilitatorReceipt,
  type SellerEdgeConfig,
} from "./seller-edge.js";

export type HttpSellerEdgeOptions<Req> = SellerEdgeConfig & {
  getReceipt: (req: Req) => FacilitatorReceipt | null;
  getPurchaseId: (req: Req) => string;
};

export function withSellerEdge<Req>(
  options: HttpSellerEdgeOptions<Req>,
  handler: (req: Req) => Promise<Response> | Response,
): (req: Req) => Promise<Response> {
  const edge = createSellerEdge(options);
  return async (req: Req): Promise<Response> => {
    const result = await edge.run(
      { purchaseId: options.getPurchaseId(req), receipt: options.getReceipt(req) },
      async () => {
        const res = await handler(req);
        return { status: res.status, body: await res.text() };
      },
    );
    const headers = new Headers();
    headers.set("content-type", result.delivered ? "text/plain; charset=utf-8" : "application/json; charset=utf-8");
    for (const [name, value] of Object.entries(result.headers)) headers.set(name, value);
    return new Response(result.body, { status: result.status, headers });
  };
}

export function withWorkerSellerEdge<Req>(
  options: HttpSellerEdgeOptions<Req>,
  handler: (req: Req) => Promise<Response> | Response,
): (req: Req) => Promise<Response> {
  return withSellerEdge(options, handler);
}
