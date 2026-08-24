// ============================================================
// @vet402/middleware/express — Express drop-in gate.
//
// Mount AFTER your x402 payment verification so the counterparty address is
// known (req.payer or similar). The framework is typed structurally so this
// file never imports express — your real Request/Response satisfy these.
// ============================================================
import {
  createTrustGate,
  VouchGateError,
  type GateDecision,
  type VouchGateConfig,
  type X402PaymentAttestation,
} from "./core.js";

type ExpressResponse = {
  status(code: number): ExpressResponse;
  json(body: unknown): unknown;
};
type ExpressNext = (err?: unknown) => void;

export type ExpressGateOptions<Req extends object> = VouchGateConfig & {
  /** Extract the counterparty address from the (already payment-verified) request. */
  getAddress: (req: Req) => string | undefined;
  /** Property the decision is attached to on the request. Default "vouchTrust". */
  attachAs?: string;
  /** HTTP status used when the gate blocks. Default 403. */
  blockStatus?: number;
  /**
   * Called for a WARN verdict (request still proceeds). Only reachable when
   * `policy` opts out of the ALLOW-only default ("block-only" or "custom") —
   * the default blocks WARN before this ever fires.
   */
  onWarn?: (decision: GateDecision, req: Req) => void;
  /**
   * When set, a successful (allowed/warned) request attests the settlement
   * back to Vouch. Return undefined to skip an individual request.
   */
  getAttestation?: (req: Req) => X402PaymentAttestation | undefined;
};

/**
 * Express middleware: score the counterparty, block anything that is not
 * ALLOW (fail-closed default; opt out via `policy`), attach the decision,
 * otherwise call next(). Three lines to mount:
 *
 *   app.use("/api/paid", createExpressGate({
 *     apiUrl: process.env.VOUCH_API_URL!, apiKey: process.env.VOUCH_API_KEY!,
 *     getAddress: (req) => req.payer,
 *   }));
 */
export function createExpressGate<Req extends object = Record<string, unknown>>(
  options: ExpressGateOptions<Req>,
) {
  const gate = createTrustGate(options);
  const attachAs = options.attachAs ?? "vouchTrust";
  const blockStatus = options.blockStatus ?? 403;

  return async (req: Req, res: ExpressResponse, next: ExpressNext): Promise<void> => {
    const address = options.getAddress(req);
    if (!address) {
      res.status(400).json({ error: "missing_counterparty_address" });
      return;
    }

    let decision: GateDecision;
    try {
      decision = await gate.evaluate(address);
    } catch (error) {
      if (error instanceof VouchGateError && error.code === "invalid_address") {
        res.status(400).json({ error: "invalid_counterparty_address" });
        return;
      }
      // Unexpected: fail closed here too — a gate that throws must not open.
      res.status(502).json({ error: "trust_check_failed" });
      return;
    }

    (req as unknown as Record<string, unknown>)[attachAs] = decision;

    if (decision.action === "block") {
      res.status(blockStatus).json({
        error: "trust_blocked",
        reason: decision.reason,
        recommendation: decision.recommendation,
        score: decision.score,
        address: decision.address,
      });
      return;
    }

    if (decision.action === "warn") options.onWarn?.(decision, req);

    const attestation = options.getAttestation?.(req);
    if (attestation) {
      // Fire-and-forget: a failed attestation must not fail the paid request.
      void gate.attest(attestation);
    }

    next();
  };
}
