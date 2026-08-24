// ============================================================
// @vet402/middleware — framework-agnostic core.
//
// WHY THIS EXISTS. The score API is a request/response you have to wire in by
// hand, and the facilitator-gate / x402-trust-gate examples showed the same
// glue being copy-pasted per framework. This is that glue, productized: one
// transport-agnostic engine (`createTrustGate`) that turns a counterparty
// address into an ALLOW / WARN / BLOCK decision, plus thin per-framework
// adapters (./express, ./next, ./hono) that call it. The x402 gate stays a
// beacon — this is the drop-in that reads it before a payment settles.
//
// Design rules kept in lock-step with @vet402/sdk and the examples:
//   - fail-CLOSED by default, in BOTH senses (BREAKING, 0.2.0): a score you
//     cannot fetch blocks the payment, AND only a clean ALLOW verdict passes —
//     the default `policy: "allow-only"` blocks WARN too. Letting WARN through
//     ("block-only") or custom banding requires an explicit opt-out;
//   - the three-way verdict is the product's own ALLOW/WARN/BLOCK banding —
//     we never invent numeric thresholds that could drift from the engine,
//     though an integrator MAY set a stricter `minScore` floor of their own;
//   - zero runtime dependencies: the adapters type their frameworks
//     structurally so this package never pulls in express/hono/next.
// ============================================================

export type Recommendation = "ALLOW" | "WARN" | "BLOCK";

/** What the gate decided to do with the transaction. */
export type GateAction = "allow" | "warn" | "block";

/**
 * Which score endpoint to consult for the counterparty.
 *  - "wallet": GET /wallets/{addr}/score — the x402 beacon the facilitator
 *    gate and the x402-trust-gate example already use. Default.
 *  - "payee":  GET /payees/{addr}/score — buyer-side "should my agent pay this
 *    receiving wallet?" (settlement history, drain-pattern, outcome labels).
 */
export type ScoreSource = "wallet" | "payee";

/** Behaviour when the score lookup itself fails (network, 5xx, timeout). */
export type FailMode = "closed" | "open";

/**
 * How the recommendation gates the transaction. BREAKING (0.2.0): the default
 * is "allow-only" — money moves only on ALLOW unless you explicitly opt out.
 *
 *  - "allow-only" (default, fail-closed): anything that is not ALLOW blocks.
 *    A WARN blocks with reason `recommendation_not_allow`.
 *  - "block-only": pre-0.2.0 behaviour — BLOCK blocks, WARN warns but is
 *    allowed downstream.
 *  - "custom": band with your own `blockOn` / `warnOn` arrays.
 */
export type GatePolicy = "allow-only" | "block-only" | "custom";

export type VouchGateConfig = {
  /** Base URL including the version segment, e.g. https://host/api/v1 */
  apiUrl: string;
  apiKey: string;
  /** Score endpoint to consult. Default "wallet". */
  scoreSource?: ScoreSource;
  /**
   * Verdict gating policy. Default "allow-only" (fail-closed): only ALLOW
   * passes. See GatePolicy for the explicit opt-outs.
   */
  policy?: GatePolicy;
  /** Recommendations that BLOCK the transaction. Requires policy "custom". */
  blockOn?: Recommendation[];
  /** Recommendations that WARN (allowed, but flagged). Requires policy "custom". */
  warnOn?: Recommendation[];
  /**
   * Optional stricter floor: BLOCK when the numeric score is below this
   * (0-100), even if the recommendation would have allowed. This is the
   * integrator's own risk appetite layered on top of the engine's banding.
   */
  minScore?: number;
  /**
   * What to do when the score cannot be fetched. Default "closed" — a
   * payment whose counterparty we cannot vet is not settled. Set "open" only
   * if availability matters more than the trust check for your route.
   */
  failMode?: FailMode;
  /** Injectable fetch (tests / custom transport). Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Score-lookup timeout in ms. Default 5000. */
  timeoutMs?: number;
  /**
   * Maximum age of the score body, in ms, before it is treated as stale and
   * blocked fail-closed (H-2/H-4). Measured from the body's `scoredAt`, with
   * its `cacheExpiresAt` honoured as a hard ceiling. Default
   * {@link DEFAULT_MAX_SCORE_AGE_MS} (5 min). Enforced under allow-only /
   * block-only; "custom" keeps pre-0.2.0 banding. A body that carries no
   * freshness fields at all (e.g. the /wallets beacon) is NOT treated as
   * stale — absence is not expiry.
   */
  maxScoreAgeMs?: number;
};

export type GateDecision = {
  action: GateAction;
  /** null when the lookup failed and the verdict came from failMode. */
  recommendation: Recommendation | null;
  /** null when the lookup failed. */
  score: number | null;
  address: string;
  /** Stable machine-readable reason for the action. */
  reason: string;
  /** true when the decision came from failMode, not a real score. */
  degraded: boolean;
};

export type X402PaymentAttestation = {
  wallet: string;
  txHash: string;
  amount?: string;
  network?: string;
  resource?: string;
};

const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;
const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;

/** Raised for programming errors (bad address/config) — never for a BLOCK. */
export class VouchGateError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "VouchGateError";
  }
}

type ScoreResponse = {
  // /wallets returns trustScore, /payees returns score — normalize below.
  trustScore?: number;
  score?: number;
  recommendation?: Recommendation;
  // Data-quality fields the /payees body carries. H-4 (2026-08-13): the gate
  // must honour these to stay symmetric with SpendGuard — a degraded/partial/
  // stale read is fail-closed regardless of the recommendation it carries.
  degraded?: boolean;
  signalsUnavailable?: string[];
  scoredAt?: string;
  cacheExpiresAt?: string;
};

/**
 * Default staleness bound (5 min), matching the score API's cache TTL. See
 * VouchGateConfig.maxScoreAgeMs.
 */
export const DEFAULT_MAX_SCORE_AGE_MS = 5 * 60 * 1000;

/**
 * Is the score body too old to act on? Fail-closed only when the body actually
 * carries freshness fields: a body with no `scoredAt` AND no `cacheExpiresAt`
 * (the /wallets beacon) is treated as fresh, since absence is not expiry. When
 * `scoredAt` is present it is honoured (an unparseable one is stale); when
 * `cacheExpiresAt` is present it caps regardless of maxScoreAgeMs.
 *
 * 軽-2B (2026-08-14 double-check) — two behaviours to be explicit about, because
 * both are silent by construction:
 *   1. NO-FRESHNESS-FIELDS ⇒ FRESH, ALWAYS. A body carrying neither `scoredAt`
 *      nor `cacheExpiresAt` returns false (fresh) NO MATTER what `maxScoreAgeMs`
 *      is — there is no timestamp to measure against, and "absence is not
 *      expiry". So the freshness gate simply does not apply to fieldless bodies;
 *      an upstream that stops emitting timestamps disables staleness for that
 *      response, not throttles it. The score-recommendation gate still runs.
 *   2. `maxScoreAgeMs = +Infinity` DISABLES the age check. `nowMs - scoredAtMs >
 *      +Infinity` is never true, so a present `scoredAt` can no longer make a
 *      score stale — deliberately, for a caller that wants to opt out of the
 *      age bound. A present `cacheExpiresAt` STILL caps (it is a hard ceiling,
 *      independent of maxScoreAgeMs), and an unparseable `scoredAt` is STILL
 *      stale. So +Infinity turns off "too old", not "well-formed".
 *
 * DELIBERATELY NOT THE SAME FUNCTION as `isScoreStale` in `@vet402/sdk`
 * (packages/sdk/src/spend-guard.ts), which for a body carrying NEITHER
 * timestamp answers STALE where this one answers FRESH. The divergence is
 * kept on purpose (2026-08-22 audit — the two were flagged as "one name, two
 * answers"; unifying them would break whichever side lost):
 *
 *   - the SDK's input is a full `PayeeScoreResult`, where both timestamps are
 *     always present (docs/openapi.yaml lists them in `required`). Absence
 *     there means a malformed or tampered payload, so it fails closed;
 *   - this gate reads TWO endpoints through a partial `ScoreResponse`, where
 *     a body without freshness fields is a legitimate shape. Treating that as
 *     expired would block every such response forever, which is not
 *     fail-closed but simply broken.
 *
 * The rule both share: never let an unreadable timestamp pass as a fresh one.
 * They differ only on whether ABSENCE counts as unreadable — a property of
 * the input each one is given, not of the rule.
 */
function isScoreStale(body: ScoreResponse, nowMs: number, maxScoreAgeMs: number): boolean {
  const hasScoredAt = typeof body.scoredAt === "string";
  const hasExpiry = typeof body.cacheExpiresAt === "string";
  if (!hasScoredAt && !hasExpiry) return false;

  if (hasScoredAt) {
    const scoredAtMs = Date.parse(body.scoredAt as string);
    if (Number.isNaN(scoredAtMs)) return true;
    if (nowMs - scoredAtMs > maxScoreAgeMs) return true;
  }
  if (hasExpiry) {
    const expiresMs = Date.parse(body.cacheExpiresAt as string);
    if (Number.isNaN(expiresMs)) return true;
    if (nowMs >= expiresMs) return true;
  }
  return false;
}

export type TrustGate = {
  /**
   * Score a counterparty address and decide ALLOW / WARN / BLOCK. Never
   * throws for a normal verdict — only for an invalid address (a caller bug,
   * not a trust degradation). A failed lookup resolves per failMode.
   */
  evaluate(address: string): Promise<GateDecision>;
  /**
   * Attest a settled x402 payment back to Vouch so future scores can weight
   * it (10% of the score). Fire-and-forget from a gate: resolves false on any
   * failure instead of throwing, so a settlement is never rolled back just
   * because the attestation POST failed.
   */
  attest(attestation: X402PaymentAttestation): Promise<boolean>;
  /** The resolved, validated config (defaults applied). */
  readonly config: ResolvedGateConfig;
};

export type ResolvedGateConfig = {
  apiUrl: string;
  scoreSource: ScoreSource;
  policy: GatePolicy;
  blockOn: Recommendation[];
  warnOn: Recommendation[];
  minScore: number | null;
  failMode: FailMode;
  timeoutMs: number;
  maxScoreAgeMs: number;
};

export function createTrustGate(config: VouchGateConfig): TrustGate {
  if (!config.apiUrl) throw new VouchGateError("apiUrl is required", "missing_api_url");
  if (!config.apiKey) throw new VouchGateError("apiKey is required", "missing_api_key");

  const apiUrl = config.apiUrl.replace(/\/$/, "");
  const scoreSource: ScoreSource = config.scoreSource ?? "wallet";
  const policy: GatePolicy = config.policy ?? "allow-only";
  if (!["allow-only", "block-only", "custom"].includes(policy)) {
    throw new VouchGateError("policy must be allow-only, block-only or custom", "invalid_policy");
  }
  // blockOn/warnOn silently ignored under a non-custom policy would be a
  // config the integrator believes is in force but is not — fail loud instead.
  if (policy !== "custom" && (config.blockOn !== undefined || config.warnOn !== undefined)) {
    throw new VouchGateError(
      'blockOn/warnOn require policy: "custom" (the explicit opt-out from the ALLOW-only default)',
      "invalid_policy_combination",
    );
  }
  const blockOn: Recommendation[] =
    policy === "allow-only"
      ? ["BLOCK", "WARN"]
      : policy === "block-only"
        ? ["BLOCK"]
        : (config.blockOn ?? ["BLOCK"]);
  const warnOn: Recommendation[] =
    policy === "allow-only" ? [] : policy === "block-only" ? ["WARN"] : (config.warnOn ?? ["WARN"]);
  const failMode: FailMode = config.failMode ?? "closed";
  const timeoutMs = config.timeoutMs ?? 5000;
  const maxScoreAgeMs = config.maxScoreAgeMs ?? DEFAULT_MAX_SCORE_AGE_MS;
  if (Number.isNaN(maxScoreAgeMs) || maxScoreAgeMs <= 0) {
    // Allows +Infinity to disable the age bound (cacheExpiresAt still caps).
    throw new VouchGateError("maxScoreAgeMs must be a positive number", "invalid_max_score_age");
  }
  const minScore = config.minScore;
  if (minScore !== undefined && (!Number.isFinite(minScore) || minScore < 0 || minScore > 100)) {
    throw new VouchGateError("minScore must be between 0 and 100", "invalid_min_score");
  }
  const fetchFn = config.fetch ?? fetch;
  const path = scoreSource === "payee" ? "payees" : "wallets";

  async function evaluate(address: string): Promise<GateDecision> {
    if (!WALLET_RE.test(address)) {
      throw new VouchGateError("invalid counterparty address", "invalid_address");
    }

    let body: ScoreResponse;
    try {
      // AbortSignal.timeout keeps a hung Vouch from hanging the payment path;
      // a timeout is a lookup failure and resolves per failMode below.
      const res = await fetchFn(`${apiUrl}/${path}/${address}/score`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        return degraded(address, `vouch_http_${res.status}`);
      }
      body = (await res.json()) as ScoreResponse;
    } catch {
      return degraded(address, "vouch_unreachable");
    }

    const recommendation = body.recommendation ?? null;
    const score = body.trustScore ?? body.score ?? null;
    if (recommendation === null) {
      // A 200 with no verdict is as untrustworthy as no response at all —
      // treat it as a lookup failure, not a silent allow.
      return degraded(address, "vouch_no_recommendation");
    }

    // Data-quality gate (H-4), symmetric with SpendGuard and enforced under the
    // fail-closed policies (allow-only / block-only), not under "custom". A
    // degraded read is a fail-closed refusal by the server — block it as a hard
    // block (not via failMode: it is a successful response that says "do not
    // trust this", not an outage). A stale read is likewise not current.
    if (policy !== "custom") {
      if (body.degraded === true) {
        return { action: "block", recommendation, score, address, reason: "score_degraded", degraded: true };
      }
      if (isScoreStale(body, Date.now(), maxScoreAgeMs)) {
        return { action: "block", recommendation, score, address, reason: "score_stale", degraded: true };
      }
      // A partial measurement (some inputs unmeasured) is a real but incomplete
      // read: allow-only blocks it, block-only tolerates it — mirroring
      // SpendGuard's payee_partial_measurement handling exactly.
      if (policy === "allow-only" && (body.signalsUnavailable?.length ?? 0) > 0) {
        return { action: "block", recommendation, score, address, reason: "partial_measurement", degraded: false };
      }
    }

    if (minScore !== undefined && score !== null && score < minScore) {
      return { action: "block", recommendation, score, address, reason: "below_min_score", degraded: false };
    }
    if (blockOn.includes(recommendation)) {
      return {
        action: "block",
        recommendation,
        score,
        address,
        // A blocked WARN is blocked for not being ALLOW, not for being BLOCK —
        // keep the reason honest so integrators can tell the two apart.
        reason: recommendation === "BLOCK" ? "recommendation_block" : "recommendation_not_allow",
        degraded: false,
      };
    }
    if (warnOn.includes(recommendation)) {
      return { action: "warn", recommendation, score, address, reason: "recommendation_warn", degraded: false };
    }
    return { action: "allow", recommendation, score, address, reason: "ok", degraded: false };
  }

  function degraded(address: string, reason: string): GateDecision {
    // fail-closed → block; fail-open → allow. Either way the decision is
    // flagged `degraded` so callers can log/alert on trust-blind settlements.
    return {
      action: failMode === "closed" ? "block" : "allow",
      recommendation: null,
      score: null,
      address,
      reason,
      degraded: true,
    };
  }

  async function attest(attestation: X402PaymentAttestation): Promise<boolean> {
    if (!WALLET_RE.test(attestation.wallet) || !TX_HASH_RE.test(attestation.txHash)) {
      return false;
    }
    try {
      const res = await fetchFn(`${apiUrl}/payments/x402`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ network: "base", ...attestation }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  return {
    evaluate,
    attest,
    config: { apiUrl, scoreSource, policy, blockOn, warnOn, minScore: minScore ?? null, failMode, timeoutMs, maxScoreAgeMs },
  };
}
