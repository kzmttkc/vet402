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
export type DecisionSource = "score" | "decision";
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
 *  - "evidence": accepts a WARN only when the payee's MEASURED receiving
 *    record clears the floors in `requireEvidence`, while keeping every
 *    data-quality refusal allow-only makes (degraded / stale / partial). See
 *    GateEvidenceFloors. Requires `scoreSource: "payee"`.
 *  - "custom": band with your own `blockOn` / `warnOn` arrays. NOTE: also
 *    switches OFF the staleness and degraded/partial gates.
 */
export type GatePolicy = "allow-only" | "block-only" | "evidence" | "custom";
/**
 * Minimum measured evidence a WARN must carry under `policy: "evidence"`.
 * Mirrors SpendGuardEvidenceFloors in @vet402/sdk field for field — H-4 keeps
 * the gate and the guard answering the same way about the same body.
 *
 * WHY (2026-08-25, measured on production): both engines cap an un-evidenced
 * counterparty below the ALLOW line by design — 62 for an unregistered bare
 * wallet, 69 (PAYEE_THIN_SCORE_CEILING) for a payee with no independent
 * receiving record — and ALLOW is 70. /accuracy's known-good benchmark
 * returned 0 of 17 allowed / 17 warned, and a payee with 48 delivery-verified
 * L1 receipts still scores WARN. Under the default policy the gate therefore
 * blocks every counterparty that exists. The default stays; this is the
 * disclosed way to accept a WARN you can actually justify.
 *
 * At least one floor must be >= 1 — all-zero floors are "block-only" and must
 * be spelled that way.
 */
export type GateEvidenceFloors = {
    /** Delivery-verified L1 receipts behind the payee. */
    minL1Deliveries?: number;
    /** Distinct buyers behind those L1 receipts. */
    minL1DistinctBuyers?: number;
    /** Score-eligible x402 settlements received. */
    minX402Payments?: number;
    /** Distinct payers behind those settlements. */
    minDistinctPayers?: number;
};
export type VouchGateConfig = {
    /** Base URL including the version segment, e.g. https://host/api/v1 */
    apiUrl: string;
    apiKey: string;
    /** Score endpoint to consult. Default "wallet". */
    scoreSource?: ScoreSource;
    /**
     * 製品定義書 §9.3（2026-09-02）売り手モード。"decision" にすると、決済確認後の
     * payer を GET /resources/{resourceId}/decision?role=payee&payer=… で判定する
     * （facts と recommendation が同じ応答に来る）。既定 "score" は従来の /score。
     * 買い手モード（リクエスト前に role=payer を引いて送金を止める）はここに無い——
     * 9/4 00:00 UTC 以降に入れる。この gate が role=payer を送る経路は存在しない。
     */
    decisionSource?: DecisionSource;
    /** decisionSource "decision" のとき必須: 判定対象 Resource の resource_id（sha256 hex）。 */
    resourceId?: string;
    /**
     * 冪等キー。同一 (resource, payer, key) の再試行はサーバ側で二重に判定課金しない
     * （§9.3）。省略時は送らない。
     */
    idempotencyKey?: (address: string) => string;
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
     * Evidence floors a WARN must clear. Required by `policy: "evidence"` and
     * rejected under every other policy, so the opt-out stays visible at the
     * call site. See {@link GateEvidenceFloors}.
     */
    requireEvidence?: GateEvidenceFloors;
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
/** Raised for programming errors (bad address/config) — never for a BLOCK. */
export declare class VouchGateError extends Error {
    readonly code: string;
    constructor(message: string, code: string);
}
/**
 * Default staleness bound (5 min), matching the score API's cache TTL. See
 * VouchGateConfig.maxScoreAgeMs.
 */
export declare const DEFAULT_MAX_SCORE_AGE_MS: number;
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
    decisionSource: DecisionSource;
    resourceId: string | null;
    policy: GatePolicy;
    blockOn: Recommendation[];
    warnOn: Recommendation[];
    minScore: number | null;
    failMode: FailMode;
    timeoutMs: number;
    maxScoreAgeMs: number;
};
export declare function createTrustGate(config: VouchGateConfig): TrustGate;
