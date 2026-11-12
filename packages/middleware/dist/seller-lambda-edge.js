// Lambda@Edge one liner. The seller still settles. This wrapper only guards the body.
import { createSellerEdge, } from "./seller-edge.js";
function cfHeaders(headers, contentType) {
    const out = {
        "content-type": [{ key: "Content-Type", value: contentType }],
    };
    for (const [name, value] of Object.entries(headers)) {
        out[name.toLowerCase()] = [{ key: name, value }];
    }
    return out;
}
export function withLambdaEdgeSellerEdge(options, handler) {
    const edge = createSellerEdge(options);
    return async (event) => {
        const result = await edge.run({ purchaseId: options.getPurchaseId(event), receipt: options.getReceipt(event) }, async () => {
            const out = await handler(event);
            const status = Number(out.status);
            return { status: Number.isFinite(status) ? status : 500, body: out.body ?? "" };
        });
        const contentType = result.delivered ? "text/plain; charset=utf-8" : "application/json; charset=utf-8";
        return {
            status: String(result.status),
            statusDescription: result.delivered ? "OK" : "Refused",
            body: result.body,
            headers: cfHeaders(result.headers, contentType),
        };
    };
}
