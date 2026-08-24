// ============================================================
// @vet402/middleware/next — Next.js App Router gate.
//
// Two shapes: `withVouchGate` wraps a route handler, and `createNextGate`
// gives you a `check()` you can call inline. Both use the Web `Request` /
// `Response` the App Router already speaks, so there is nothing to import from
// next itself.
// ============================================================
import { createTrustGate, VouchGateError, } from "./core.js";
export function createNextGate(options) {
    const gate = createTrustGate(options);
    const blockStatus = options.blockStatus ?? 403;
    return {
        async check(address) {
            const decision = await gate.evaluate(address);
            if (decision.action === "block") {
                return {
                    decision,
                    response: Response.json({
                        error: "trust_blocked",
                        reason: decision.reason,
                        recommendation: decision.recommendation,
                        score: decision.score,
                        address: decision.address,
                    }, { status: blockStatus }),
                };
            }
            return { decision, response: null };
        },
        attest: (attestation) => gate.attest(attestation),
    };
}
/**
 * Wrap an App Router handler so anything that is not ALLOW short-circuits
 * with 403 before your handler runs (fail-closed default; opt out via
 * `policy`). The decision is passed as the second argument.
 *
 *   export const POST = withVouchGate(
 *     { apiUrl: process.env.VOUCH_API_URL!, apiKey: process.env.VOUCH_API_KEY!,
 *       getAddress: (req) => new URL(req.url).searchParams.get("payer") ?? undefined },
 *     async (req, trust) => Response.json({ ok: true, trust }),
 *   );
 */
export function withVouchGate(options, handler) {
    const gate = createNextGate(options);
    return async (req) => {
        const address = await options.getAddress(req);
        if (!address) {
            return Response.json({ error: "missing_counterparty_address" }, { status: 400 });
        }
        let checked;
        try {
            checked = await gate.check(address);
        }
        catch (error) {
            if (error instanceof VouchGateError && error.code === "invalid_address") {
                return Response.json({ error: "invalid_counterparty_address" }, { status: 400 });
            }
            return Response.json({ error: "trust_check_failed" }, { status: 502 });
        }
        if (checked.response)
            return checked.response;
        const attestation = options.getAttestation?.(req, checked.decision);
        if (attestation)
            void gate.attest(attestation);
        return handler(req, checked.decision);
    };
}
