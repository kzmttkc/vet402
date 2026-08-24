// ============================================================
// @vet402/middleware/hono — Hono drop-in gate.
//
// Hono's Context is typed structurally (c.json returns a Response, c.set
// stashes per-request state), so this file never imports hono. Mount after
// your x402 verification so the counterparty address is resolvable.
// ============================================================
import {
  createTrustGate,
  VouchGateError,
  type GateDecision,
  type VouchGateConfig,
  type X402PaymentAttestation,
} from "./core.js";

type HonoContext = {
  json(body: unknown, status?: number): Response;
  set(key: string, value: unknown): void;
};
type HonoNext = () => Promise<void>;

export type HonoGateOptions<Ctx extends HonoContext> = VouchGateConfig & {
  /** Extract the counterparty address from the (payment-verified) context. */
  getAddress: (c: Ctx) => string | undefined;
  /** Context variable the decision is stashed under (c.get(...)). Default "vouchTrust". */
  setAs?: string;
  /** HTTP status used when the gate blocks. Default 403. */
  blockStatus?: number;
  /**
   * Called for a WARN verdict (request still proceeds). Only reachable when
   * `policy` opts out of the ALLOW-only default ("block-only" or "custom") —
   * the default blocks WARN before this ever fires.
   */
  onWarn?: (decision: GateDecision, c: Ctx) => void;
  /** Optional: attest the settlement after an allowed/warned request. */
  getAttestation?: (c: Ctx) => X402PaymentAttestation | undefined;
};

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
export function createHonoGate<Ctx extends HonoContext = HonoContext>(
  options: HonoGateOptions<Ctx>,
) {
  const gate = createTrustGate(options);
  const setAs = options.setAs ?? "vouchTrust";
  const blockStatus = options.blockStatus ?? 403;

  return async (c: Ctx, next: HonoNext): Promise<Response | void> => {
    const address = options.getAddress(c);
    if (!address) {
      return c.json({ error: "missing_counterparty_address" }, 400);
    }

    let decision: GateDecision;
    try {
      decision = await gate.evaluate(address);
    } catch (error) {
      if (error instanceof VouchGateError && error.code === "invalid_address") {
        return c.json({ error: "invalid_counterparty_address" }, 400);
      }
      return c.json({ error: "trust_check_failed" }, 502);
    }

    c.set(setAs, decision);

    if (decision.action === "block") {
      return c.json(
        {
          error: "trust_blocked",
          reason: decision.reason,
          recommendation: decision.recommendation,
          score: decision.score,
          address: decision.address,
        },
        blockStatus,
      );
    }

    if (decision.action === "warn") options.onWarn?.(decision, c);

    const attestation = options.getAttestation?.(c);
    if (attestation) void gate.attest(attestation);

    await next();
  };
}
