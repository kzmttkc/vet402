// Express one liner for the seller edge. Mount beside the seller's own payment check.
import {
  createSellerEdge,
  type FacilitatorReceipt,
  type SellerEdgeConfig,
} from "./seller-edge.js";

type ExpressRes = {
  status(code: number): ExpressRes;
  json(body: unknown): unknown;
  setHeader?(name: string, value: string): unknown;
};

export type ExpressSellerEdgeOptions<Req> = SellerEdgeConfig & {
  getReceipt: (req: Req) => FacilitatorReceipt | null;
  getPurchaseId: (req: Req) => string;
};

export function createExpressSellerEdge<Req>(options: ExpressSellerEdgeOptions<Req>) {
  const edge = createSellerEdge(options);
  return async (req: Req, res: ExpressRes, next: () => void | Promise<void>): Promise<void> => {
    const origStatus = res.status.bind(res);
    const origJson = res.json.bind(res);
    const origSetHeader = typeof res.setHeader === "function" ? res.setHeader.bind(res) : null;
    let status = 200;
    let sent = false;
    let payload: unknown;

    res.status = (code: number) => {
      status = code;
      return res;
    };
    res.json = (body: unknown) => {
      sent = true;
      payload = body;
      return res;
    };

    const result = await edge.run(
      { purchaseId: options.getPurchaseId(req), receipt: options.getReceipt(req) },
      async () => {
        await next();
        const body = !sent ? "" : typeof payload === "string" ? payload : JSON.stringify(payload ?? null);
        return { status, body };
      },
    );

    if (origSetHeader) {
      for (const [name, value] of Object.entries(result.headers)) origSetHeader(name, value);
    }
    origStatus(result.status);
    if (sent && result.delivered) {
      const encoded = typeof payload === "string" ? payload : JSON.stringify(payload ?? null);
      if (encoded === result.body) {
        origJson(payload);
        return;
      }
    }
    let out: unknown = result.body;
    try {
      out = JSON.parse(result.body);
    } catch {
      out = result.body;
    }
    origJson(out);
  };
}
