export type TrustScoreResult = {
    agentId: string;
    wallet: string | null;
    trustScore: number;
    recommendation: "ALLOW" | "WARN" | "BLOCK";
    signals: {
        identity: {
            registered: boolean;
            hasMetadataUri: boolean;
        };
        reputation: {
            feedbackCount: number;
            avgScore: number;
            onChainAvgScore: number;
        };
        wallet: {
            ageDays: number;
            txCount: number;
            isBurner: boolean;
        };
        /** The highest-weighted axis: "verifiable economic activity" (2026-08-14),
         *  not x402 settlements alone — `score` is the STRONGER of the L1 observed
         *  purchases and the x402 settlements. Kept under `x402` for back-compat. */
        x402: {
            paymentCount: number;
            uniqueDays: number;
            score: number;
            /** Delivery-verified L1 observed purchases behind the axis score. */
            l1PurchaseCount?: number;
            l1DistinctSellers?: number;
        };
        sybil: {
            risk: string;
            flags: string[];
        };
        manual: {
            list: string;
        };
    };
    scoredAt: string;
    cacheExpiresAt: string;
    disclaimer: string;
    blockReason?: string;
    manualOverride?: boolean;
    dataCoverage?: {
        ownerIndexer: {
            status: string;
            blocksBehind: number | null;
            lastBlock?: string | null;
            indexedAgentRows?: number;
            staleRisk: boolean;
        };
        settlement: {
            paymentRows: number;
            distinctWallets?: number;
            recentPayments30d?: number;
            walletHasHistory: boolean;
        };
    };
};
export type PayeeScoreResult = {
    payee: string;
    score: number;
    recommendation: "ALLOW" | "WARN" | "BLOCK";
    dataDepth: "thin" | "moderate" | "rich";
    /**
     * True when at least one input could not be read at all, so this body is a
     * fail-closed refusal rather than a measurement. `dataDepth` answers "how
     * much history does this wallet have?"; this answers "did we manage to
     * look?". A `degraded: true` result must NEVER be treated as ALLOW,
     * whatever `recommendation` says — the check_payee_trust tool description
     * tells the model exactly that. Always sent by the API.
     */
    degraded: boolean;
    /**
     * Every input that could not be read on this request, named — currently one
     * or more of `wallet_metrics`, `native_drain`, `usdc_drain`,
     * `outcome_history`. Empty means the whole assessment was measured.
     * Non-empty with `degraded: false` is a PARTIAL measurement: real numbers,
     * but not all of them, and capped below ALLOW for that reason. Also not to
     * be treated as ALLOW. Always sent by the API.
     */
    signalsUnavailable: string[];
    signals: {
        receiving: {
            paymentCount: number;
            uniqueDays: number;
            distinctPayers: number;
            score: number;
            /** Delivery-verified L1 receipts behind the receiving score. */
            l1DeliveryCount?: number;
            l1DistinctBuyers?: number;
            /**
             * 2026-08-26: vet402 が実費で払って**届かなかった**記録。最終スコアの天井に
             * 効いている（呼び手が根拠を再現できるように出している）。
             * `l1PendingVerification` は照合待ちで、判定には使われない——
             * vet402 側の検証の遅れを売り手の落ち度にしないため。
             */
            l1Settled?: number;
            l1PaidNeverSettled?: number;
            l1NonSettlingDays?: number;
            l1PendingVerification?: number;
            /** 天井が掛かった理由（null = 掛かっていない）。 */
            l1NonDeliveryReason?: string | null;
        };
        walletHealth: {
            ageDays: number;
            txCount: number;
            isBurner: boolean;
            score: number;
        };
        drainPattern: {
            detected: boolean;
            drainRatio: number | null;
            outgoingCount: number;
            incomingCount: number;
            score: number;
            /** Asset legs that could not be read, e.g. ["native_drain"]. The same
             *  names appear in the top-level `signalsUnavailable`. */
            unmeasured?: string[];
        };
        outcomeHistory: {
            types: string[];
            adjustment: number;
        };
        flags: string[];
    };
    scoredAt: string;
    cacheExpiresAt: string;
    disclaimer: string;
};
export type DecisionRecommendation = "ALLOW" | "WARN" | "BLOCK";
export type DecisionResult = {
    subject: {
        type: "resource";
        id: string | null;
        endpoint_id: string;
        observatory_id: string;
        canonical_url: string;
        method: string;
    };
    role: "payer" | "payee";
    payer: string | null;
    recommendation: DecisionRecommendation;
    reason_codes: string[];
    facts: Record<string, unknown>;
    freshness: {
        l0: string | null;
        l1: string | null;
        l2: string | null;
    };
    evidence: {
        level: "L0" | "L1" | "L2";
        purchase_id?: string;
        observation_id?: string;
        url: string;
    }[];
    score: {
        trustScore: number | null;
        recommendation: DecisionRecommendation | null;
        deprecated: true;
    } | null;
    degraded: boolean;
    policy: "allow_only";
    rules_version: string;
    registry: {
        status: "anchored" | "pending" | "off";
        tx_hash: string | null;
    };
    scoredAt: string;
    cacheExpiresAt: string;
    disclaimer: string;
};
export type VouchClientConfig = {
    apiUrl: string;
    apiKey: string;
    /** Per-request timeout in ms. See DEFAULT_TIMEOUT_MS / VOUCH_TIMEOUT_MS. */
    timeoutMs: number;
};
export type X402PaymentAttestation = {
    wallet: string;
    txHash: string;
    amount?: string;
    network?: string;
    resource?: string;
};
export declare class VouchApiError extends Error {
    /** Present for some error codes (e.g. attestation_unverifiable) with a human-readable detail. */
    reason?: string;
    constructor(code: string, reason?: string);
}
export declare function fetchAgentScore(agentId: string, wallet?: string): Promise<TrustScoreResult>;
export declare function fetchWalletScore(wallet: string): Promise<TrustScoreResult>;
/** Buyer-side lookup: scores the payment *recipient* before an agent pays it. */
export declare function fetchPayeeScore(payee: string): Promise<PayeeScoreResult>;
export declare function attestX402Payment(attestation: X402PaymentAttestation): Promise<{
    ok: boolean;
    created: boolean;
    id: string;
}>;
export declare function fetchDecision(resourceId: string, query?: {
    role?: "payer" | "payee";
    payer?: string;
    callerDialect?: "v1" | "v2";
}): Promise<DecisionResult>;
