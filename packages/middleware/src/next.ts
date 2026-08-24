// ============================================================
// @vet402/middleware/next — Next.js App Router gate.
//
// Two shapes: `withVouchGate` wraps a route handler, and `createNextGate`
// gives you a `check()` you can call inline. Both use the Web `Request` /
// `Response` the App Router already speaks, so there is nothing to import from
// next itself.
// ============================================================
import {
  createTrustGate,
  VouchGateError,
  type GateDecision,
  type VouchGateConfig,
  type X402PaymentAttestation,
} from "./core.js";

export type NextGateOptions = VouchGateConfig & {
  /** HTTP status used when the gate blocks. Default 403. */
  blockStatus?: number;
};

export type NextGate = {
  /**
   * Evaluate an address. Returns the decision plus a ready-to-return blocking
   * Response (or null when the request may proceed). Lets a handler do:
   *
   *   const { decision, response } = await gate.check(payer);
   *   if (response) return response;   // 403, fail-closed
   */
  check(address: string): Promise<{ decision: GateDecision; response: Response | null }>;
  attest(attestation: X402PaymentAttestation): Promise<boolean>;
};

export function createNextGate(options: NextGateOptions): NextGate {
  const gate = createTrustGate(options);
  const blockStatus = options.blockStatus ?? 403;

  return {
    async check(address: string) {
      const decision = await gate.evaluate(address);
      if (decision.action === "block") {
        return {
          decision,
          response: Response.json(
            {
              error: "trust_blocked",
              reason: decision.reason,
              recommendation: decision.recommendation,
              score: decision.score,
              address: decision.address,
            },
            { status: blockStatus },
          ),
        };
      }
      return { decision, response: null };
    },
    attest: (attestation) => gate.attest(attestation),
  };
}

export type WithVouchGateOptions<Req extends Request> = NextGateOptions & {
  /** Extract the counterparty address from the (payment-verified) request. */
  getAddress: (req: Req) => string | undefined | Promise<string | undefined>;
  /** Optional: attest the settlement after an allowed/warned request. */
  getAttestation?: (req: Req, decision: GateDecision) => X402PaymentAttestation | undefined;
};

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
export function withVouchGate<Req extends Request>(
  options: WithVouchGateOptions<Req>,
  handler: (req: Req, decision: GateDecision) => Response | Promise<Response>,
): (req: Req) => Promise<Response> {
  const gate = createNextGate(options);

  return async (req: Req): Promise<Response> => {
    const address = await options.getAddress(req);
    if (!address) {
      return Response.json({ error: "missing_counterparty_address" }, { status: 400 });
    }

    let checked: { decision: GateDecision; response: Response | null };
    try {
      checked = await gate.check(address);
    } catch (error) {
      if (error instanceof VouchGateError && error.code === "invalid_address") {
        return Response.json({ error: "invalid_counterparty_address" }, { status: 400 });
      }
      return Response.json({ error: "trust_check_failed" }, { status: 502 });
    }

    if (checked.response) return checked.response;

    const attestation = options.getAttestation?.(req, checked.decision);
    if (attestation) void gate.attest(attestation);

    return handler(req, checked.decision);
  };
}
