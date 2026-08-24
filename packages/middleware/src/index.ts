// @vet402/middleware — drop-in x402 transaction gate.
//
// The framework-agnostic core is the default export surface. Per-framework
// adapters live at their own subpaths so importing one never drags in the
// others' (structural) types:
//   import { createExpressGate } from "@vet402/middleware/express";
//   import { withVouchGate }     from "@vet402/middleware/next";
//   import { createHonoGate }    from "@vet402/middleware/hono";
export {
  createTrustGate,
  VouchGateError,
  DEFAULT_MAX_SCORE_AGE_MS,
  type TrustGate,
  type VouchGateConfig,
  type ResolvedGateConfig,
  type GateDecision,
  type GateAction,
  type GatePolicy,
  type Recommendation,
  type ScoreSource,
  type FailMode,
  type X402PaymentAttestation,
} from "./core.js";
