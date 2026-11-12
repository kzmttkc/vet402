// Hono one liner for the seller edge. vet402 does not settle the payment.
import { createSellerEdge, } from "./seller-edge.js";
export function createHonoSellerEdge(options) {
    const edge = createSellerEdge(options);
    return async (c, next) => {
        let status = 200;
        let body = "";
        let sent = false;
        const origJson = c.json.bind(c);
        c.json = (payload, code = 200) => {
            sent = true;
            status = code;
            body = typeof payload === "string" ? payload : JSON.stringify(payload ?? null);
            return origJson(payload, code);
        };
        const result = await edge.run({ purchaseId: options.getPurchaseId(c), receipt: options.getReceipt(c) }, async () => {
            await next();
            return { status: sent ? status : 200, body };
        });
        const headers = new Headers();
        headers.set("content-type", result.delivered ? "text/plain; charset=utf-8" : "application/json; charset=utf-8");
        for (const [name, value] of Object.entries(result.headers))
            headers.set(name, value);
        return new Response(result.body, { status: result.status, headers });
    };
}
