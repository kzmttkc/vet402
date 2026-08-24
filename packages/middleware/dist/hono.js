// ============================================================
// @vet402/middleware/hono — Hono drop-in gate.
//
// Hono's Context is typed structurally (c.json returns a Response, c.set
// stashes per-request state), so this file never imports hono. Mount after
// your x402 verification so the counterparty address is resolvable.
// ============================================================
import { createTrustGate, VouchGateError, } from "./core.js";
/**
 * Hono middleware. Returns a blocking Response on anything that is not ALLOW
 * (fail-closed default; opt out via `policy`) or calls next(). Three lines
 * to mount:
 *
 *   app.use("/api/paid/*", createHonoGate({
 *     apiUrl: process.env.VOUCH_API_URL!, apiKey: process.env.VOUCH_API_KEY!,
 *     getAddress: (c) => c.get("payer"),
 *   }));
 */
export function createHonoGate(options) {
    const gate = createTrustGate(options);
    const setAs = options.setAs ?? "vouchTrust";
    const blockStatus = options.blockStatus ?? 403;
    return async (c, next) => {
        const address = options.getAddress(c);
        if (!address) {
            return c.json({ error: "missing_counterparty_address" }, 400);
        }
        let decision;
        try {
            decision = await gate.evaluate(address);
        }
        catch (error) {
            if (error instanceof VouchGateError && error.code === "invalid_address") {
                return c.json({ error: "invalid_counterparty_address" }, 400);
            }
            return c.json({ error: "trust_check_failed" }, 502);
        }
        c.set(setAs, decision);
        if (decision.action === "block") {
            return c.json({
                error: "trust_blocked",
                reason: decision.reason,
                recommendation: decision.recommendation,
                score: decision.score,
                address: decision.address,
            }, blockStatus);
        }
        if (decision.action === "warn")
            options.onWarn?.(decision, c);
        const attestation = options.getAttestation?.(c);
        if (attestation)
            void gate.attest(attestation);
        await next();
    };
}
