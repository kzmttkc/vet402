// check(url): one read for "has vet402 seen this x402 URL deliver?".
// Two existing routes through @vet402/sdk's client, so the key, timeout and
// User-Agent behave exactly as they do there:
//   GET /api/v1/resolve?q=<url>                       (key-less)
//   GET /api/v1/resources/{resourceId}/decision?role=payer (key-less at 10/min per IP)
// No payment code here.
import { createVouchClient, DEFAULT_API_URL, VouchApiError } from "@vet402/sdk";
export { DEFAULT_API_URL };
/** Public page of one record. Same form as the hosted MCP server's record_url. */
export const RECORD_URL_BASE = "https://vet402.com/observatory/e/";
export async function check(url, opts = {}) {
    if (typeof url !== "string" || url.trim().length === 0)
        throw new Error("invalid_query");
    const apiUrl = opts.apiUrl ?? DEFAULT_API_URL;
    const client = createVouchClient({ apiKey: opts.apiKey, apiUrl, fetch: opts.fetch, timeoutMs: opts.timeoutMs });
    const resolved = await call(apiUrl, () => client.resolve(url)).catch((err) => {
        if (err instanceof VouchApiError && err.status === 404)
            return null;
        throw err;
    });
    if (resolved === null)
        return { recommendation: "UNKNOWN", reason: "not_found" };
    const resource = resolved.resource;
    const resourceId = resource?.resource_id;
    if (!resource || !resourceId) {
        // not_found.reason when the body has not_found. Otherwise url_not_on_record:
        // the host has listings but this URL does not.
        const nf = resolved.not_found;
        return { recommendation: "UNKNOWN", reason: nf?.reason ?? "url_not_on_record" };
    }
    const decision = await call(apiUrl, () => client.getDecision(resourceId, { role: "payer" })).catch((err) => {
        if (err instanceof VouchApiError && err.status === 404)
            return null;
        throw err;
    });
    if (decision === null)
        return { recommendation: "UNKNOWN", reason: "not_found" };
    const terms = decision.verified_terms ?? null;
    return {
        recommendation: decision.recommendation,
        reasonCodes: [...(decision.reason_codes ?? [])],
        verifiedTerms: terms,
        resourceId,
        evidenceUrl: `${RECORD_URL_BASE}${resource.observatory_id}`,
        retrievedAt: new Date().toISOString(),
        scoredAt: decision.scoredAt,
    };
}
// API answers (VouchApiError) pass through as the server's own code. A caller
// error thrown before the request (a message that starts with invalid_) passes
// through as itself, because fn() runs outside the try. The try wraps the
// request, and a failure there gets a message that says the API could not be reached.
async function call(apiUrl, fn) {
    const pending = fn();
    try {
        return await pending;
    }
    catch (err) {
        if (err instanceof VouchApiError)
            throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`vet402: could not reach ${apiUrl} (${msg})`, { cause: err });
    }
}
