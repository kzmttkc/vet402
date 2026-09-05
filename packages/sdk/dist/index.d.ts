import { SpendGuard, type SpendGuardPolicy } from "./spend-guard.js";
export { SpendGuard, DEFAULT_MAX_SCORE_AGE_MS, type SpendGuardPolicy, type SpendGuardTrustPolicy, type SpendEvaluateInput, type SpendDenyReason, type SpendDecision, } from "./spend-guard.js";
export { payOrRefuse, readDemoDecisions, readL1Decisions, appendDecision, DEFAULT_DECISION_STORE, BASE_CHAIN, BASE_CHAIN_ID, BASE_USDC, DEFAULT_MAX_PER_TX_USD, type PayOrRefuseInput, type PayOrRefuseResult, type PayDecisionRecord, type PayPolicy, type PayEvidencePolicy, type PayEvidenceRow, type PayEvidenceSource, type PayRefuseReason, type PayerAccount, type X402Accept, type X402Settlement, type StoredDecision, type DecisionStoreOptions, type Eip3009Authorization, } from "./pay-or-refuse.js";
export type Recommendation = "ALLOW" | "WARN" | "BLOCK";
export type TrustScoreResult = {
    agentId: string;
    wallet: string | null;
    trustScore: number;
    recommendation: Recommendation;
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
        /**
         * The highest-weighted axis. vet402 2026-08-14: it is "verifiable economic
         * activity", not x402 settlements alone — `score` reflects the STRONGER of
         * the L1 observed purchases below and the x402 settlements. Kept under
         * `x402` for wire back-compat.
         */
        x402: {
            paymentCount: number;
            uniqueDays: number;
            score: number;
            /** Delivery-verified L1 observed purchases behind the axis score (the
             *  premium signal). Optional for back-compat; 0 until the observatory
             *  writes its first row for this wallet. */
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
    /** N-21: component-level explanation of the chain score. Optional and absent
     *  on hard-blocked verdicts; the four components sum to weightedSubtotal. */
    breakdown?: {
        components: {
            identity: {
                score: number;
                weight: number;
                contribution: number;
            };
            reputation: {
                score: number;
                weight: number;
                contribution: number;
            };
            wallet: {
                score: number;
                weight: number;
                contribution: number;
            };
            x402: {
                score: number;
                weight: number;
                contribution: number;
            };
        };
        weightedSubtotal: number;
        sybilPenalty: number;
        prePolicyScore: number;
    };
    /** Stable machine-readable reason codes behind the verdict. */
    reasons?: string[];
    scoredAt: string;
    cacheExpiresAt: string;
    disclaimer: string;
    blockReason?: string;
    manualOverride?: boolean;
    dataCoverage?: {
        ownerIndexer: {
            status: "synced" | "partial" | "unavailable";
            blocksBehind: number | null;
            lastBlock: string | null;
            indexedAgentRows: number;
            staleRisk: boolean;
        };
        settlement: {
            paymentRows: number;
            distinctWallets: number;
            recentPayments30d: number;
            walletHasHistory: boolean;
        };
    };
};
export type PayeeDataDepth = "thin" | "moderate" | "rich";
export type PayeeScoreResult = {
    payee: string;
    score: number;
    recommendation: Recommendation;
    dataDepth: PayeeDataDepth;
    /**
     * True when the verdict came from a degraded read — one or more inputs
     * could not be read at all, so the score is a fail-closed refusal, not a
     * measurement. SpendGuard's default policy denies on this.
     */
    degraded: boolean;
    /**
     * Machine-readable names of the inputs that could not be measured. When
     * this is non-empty but `degraded` is false, the score is backed by real
     * but partial measurements — SpendGuard's default policy denies on this
     * too (`payee_partial_measurement`).
     */
    signalsUnavailable: string[];
    signals: {
        receiving: {
            paymentCount: number;
            uniqueDays: number;
            distinctPayers: number;
            score: number;
            /** Delivery-verified L1 receipts behind the receiving score (the premium
             *  signal: the observatory actually paid this payee and checked what came
             *  back). Optional for back-compat; 0 until the observatory writes its
             *  first row for this wallet. */
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
            /**
             * Asset legs that could NOT be read on this request — e.g.
             * ["native_drain"], ["usdc_drain"], or both. Empty when every leg was
             * assessed. The API always sends it; optional here so existing callers
             * that build a PayeeScoreResult literal (tests, fixtures) keep compiling.
             *
             * These same names also appear in the top-level `signalsUnavailable`,
             * which is the field SpendGuard denies on — read that one to gate a
             * payment; read this one to say WHICH part of the drain view is missing.
             */
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
/**
 * Answer from the verify-at-settle fast surface
 * (`GET /payees/{address}/verdict-fast`). See {@link VouchClient.getPayeeVerdictFast}.
 *
 * Two shapes, and only one of them is an answer:
 *  - `hit`        — the engine had a confident, unexpired verdict pinned;
 *  - `cache_cold` — nothing pinned. NOT a verdict, and NOT an allow.
 */
export type PayeeVerdictFast = {
    status: "hit";
    recommendation: Recommendation;
    score: number;
    cacheExpiresAt: string;
    /** In-handler microseconds the server spent (a cache read + JSON). */
    handlerMicros: number;
} | {
    status: "cache_cold";
    recommendation: null;
    /** Full-score path to call (fire-and-forget) to warm the same cache. */
    warmVia: string;
    note: string;
    handlerMicros: number;
};
/**
 * Does this fast verdict clear a payment? The one correct reading of the fast
 * surface, written once so nobody has to re-derive it at a call site.
 *
 * True ONLY for `status: "hit"` with an `ALLOW` recommendation that has not
 * passed its own `cacheExpiresAt`. `cache_cold` is false — it means "nothing
 * was pinned", which is the absence of a verdict, not a permissive one. The
 * expiry re-check is belt-and-braces: the server already refuses to return an
 * expired entry, but a fast path that gates money should not depend on the
 * other side having done that.
 *
 * NOTE the deliberate asymmetry with {@link SpendGuard}: a `false` here means
 * "do not pay yet", NOT "this payee is bad". Warm the cache with
 * {@link VouchClient.getPayeeScore} and decide on the full body.
 */
export declare function payeeVerdictFastAllows(verdict: PayeeVerdictFast, nowMs?: number): boolean;
export type VouchClientOptions = {
    /**
     * Base URL of the Vouch REST API, including the `/api/v1` suffix.
     * Optional — defaults to the hosted production API, {@link DEFAULT_API_URL}.
     */
    apiUrl?: string;
    apiKey: string;
    fetch?: typeof fetch;
    /**
     * Per-request timeout in milliseconds. Default
     * {@link DEFAULT_REQUEST_TIMEOUT_MS} (10 s).
     *
     * There is no way to disable it, on purpose: SpendGuard is fail-CLOSED, and
     * a fail-closed judgement that never runs is not a judgement — an upstream
     * that accepts the connection and then never answers would hang the agent's
     * payment path forever, which is neither an allow nor a deny.
     */
    timeoutMs?: number;
};
/**
 * Hosted production API. Used when `apiUrl` is omitted.
 *
 * 2026-08-13 (hackathon persona R2): `createVouchClient({ apiKey })` used to
 * throw a raw `TypeError: Cannot read properties of undefined (reading
 * 'replace')` from inside dist/index.js — the single most likely first line a
 * new integrator writes, failing with a stack trace that names none of our
 * options. The one URL that argument could sensibly take is this one, so it is
 * now the default instead of a crash.
 */
export declare const DEFAULT_API_URL = "https://vet402.com/api/v1";
/**
 * Default per-request timeout (10 s). A timeout surfaces as a lookup failure,
 * which SpendGuard denies as `payee_trust_unavailable` — fail-closed.
 *
 * WHY 10 s AND NOT THE MIDDLEWARE'S 5 s (2026-08-22). @vet402/middleware
 * defaults to 5000 ms and is right to: it runs INSIDE an HTTP handler that has
 * its own deadline, so it must give the framework its answer back quickly. An
 * SDK does not necessarily run inside a request at all. Two measured facts set
 * this value instead:
 *
 *   1. the sibling Python SDK already ships a 10 s default
 *      (packages/python-sdk/src/vet402/client.py, `timeout: float = 10.0`),
 *      and two SDKs with identical SpendGuard semantics must not disagree on
 *      how long "too long" is;
 *   2. `GET /api/v1/payees/{address}/score` declares `maxDuration = 30`
 *      (src/app/api/v1/payees/[address]/score/route.ts) — the server itself
 *      budgets up to 30 s for a COLD score (chain reads + DB). Because the
 *      guard fails closed, a bound tighter than the server's own cold path
 *      does not fail safe in the useful sense: it turns a slow-but-correct
 *      ALLOW into a denial of a payment that should have gone through.
 *
 * Override with `timeoutMs` when your own deadline is stricter.
 */
export declare const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
/**
 * Error thrown when the Vouch API answers with a non-2xx status.
 *
 * `message` is the machine-readable code the API returned (e.g.
 * `missing_api_key`, `invalid_api_key`, `rate_limit_exceeded`) so existing
 * `err.message` checks keep working; `code` and `status` expose the same
 * facts without string parsing. SpendGuard uses them to tell "your key is
 * missing" apart from "the upstream is down".
 */
export type DecisionRecommendation = "ALLOW" | "WARN" | "BLOCK";
export type L0Status = "pass" | "fail" | "unverified";
export type Dialect = "v1" | "v2" | "both" | "unpayable";
export type L2Status = "conform" | "mismatch" | "undeclared";
export type OfferStability = "stable" | "drifting" | "unknown";
/** §8.1 売り手事実（role=payer の facts）。スコアも判定も含まない。 */
export type SellerFacts = {
    l0: {
        status: L0Status;
        observed_at: string | null;
        dialect: Dialect | null;
        fail_reason: string | null;
    };
    l1: {
        n_delivered: number;
        n_settled: number;
        n_attempts: number;
        /** §6.2 こちら側の失敗（決済は確定したが我々のリクエストが 4xx）。n_attempts に数えない。 */
        n_probe_error: number;
        p50_ms: number | null;
        p95_ms: number | null;
        last_purchase_id: string | null;
        observed_at: string | null;
    };
    l2: {
        status: L2Status;
        declaration_hash: string | null;
        response_hash: string | null;
        diff_hash: string | null;
        missing_keys: string[] | null;
        observed_at: string | null;
    };
    availability_7d: number | null;
    availability_30d: number | null;
    offer_stability: OfferStability;
    payees: string[];
    settlement_30d_real: number;
    settlement_30d_raw: number;
    /** raw のうち vet402 自身の測定購入（wash_flag test）。 */
    settlement_30d_test: number;
    unique_payers_30d_real: number;
    wash_dominated: boolean;
};
/** §8.2 買い手事実（role=payee の facts）。 */
export type BuyerFacts = {
    settled_count_30d: number;
    unique_payees_30d: number;
    retry_burst_rate: number | null;
    sybil: {
        multi_agent_owner: boolean;
        shared_funder: boolean;
        cluster_id: string | null;
        unavailable: string[];
    };
    erc8004: {
        agent_id: string | null;
        feedback_with_payment_proof_ratio: number | null;
    };
    first_seen: string | null;
    last_seen: string | null;
};
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
    /** L0–L2 の事実（role=payer は SellerFacts、role=payee は BuyerFacts）。常に存在する。 */
    facts: SellerFacts | BuyerFacts;
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
    /** 移行期間の併記。null のことがある。判定の根拠ではない。 */
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
export type DecisionQuery = {
    role?: "payer" | "payee";
    /** role=payee のとき必須。chain:address か 0x / base58。 */
    payer?: string;
    callerDialect?: "v1" | "v2";
    /** オペレータの明示オプトイン: L1 未実施でも ALLOW を許す。 */
    allowWithoutL1?: boolean;
    /** 同一 (resource, role, payer, key) の再試行でレート単位を二重に消費しない。 */
    idempotencyKey?: string;
};
/** §5 Endpoint / Resource の記録（resolve 系の共通形）。 */
export type EndpointRef = {
    endpoint_id: string;
    resource_id: string | null;
    observatory_id: string;
    canonical_url: string;
    method: string;
    payee_id: string | null;
    catalog_status: "listed" | "delisted" | "unknown";
    first_seen: string | null;
    last_seen: string | null;
};
/** §7.2 索引済み決済 1 件（帰属と wash フラグつき）。 */
export type SettlementRef = {
    purchase_id: string;
    chain: string;
    tx_hash: string;
    payer_id: string | null;
    payee_id: string | null;
    amount: string | null;
    asset: string | null;
    block_time: string | null;
    attribution: string;
    wash_flag: string;
    resource_id: string | null;
    endpoint_id: string | null;
};
export type ResolveResult = {
    query: {
        kind: "url" | "domain" | "address" | "tx" | "payee_id" | "unknown";
        value: string;
    };
    resource?: EndpointRef;
    endpoints?: EndpointRef[];
    payees?: {
        payee_id: string;
        endpoints: number;
    }[];
    settlement?: SettlementRef;
    /**
     * tx の逆引きが空だったときだけ載る。生行は直近 7 日しか保持しないので、
     * 「索引していない取引」と「持っていたが窓の外に出た取引」を区別する。
     * settlement が無いことは「その取引が無かった」ことを意味しない。
     */
    settlement_not_found?: {
        reason: "not_in_raw_window";
        raw_window_days: number;
        note: string;
    };
    disclaimer: string;
};
/** §7.2 / §9.1 GET /census/summary — raw と real を同じ応答で（混ぜない）。 */
export type CensusSummary = {
    chain: string;
    window: "7d" | "30d";
    settlements_raw: number;
    settlements_real: number;
    wash: {
        self_deal: number;
        circular: number;
        test: number;
    };
    attribution: {
        confirmed: number;
        probable: number;
        unmatched: number;
    };
    unique_payers_raw: number;
    unique_payers_real: number;
    unique_payees_real: number;
    endpoints_with_real_settlement: number;
    by_source: {
        l1_purchase: number;
        payments_api: number;
        chain_index: number;
    };
    definition: string;
    disclaimer: string;
    retrievedAt: string;
};
export declare class VouchApiError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(code: string, status: number);
}
export type X402PaymentAttestation = {
    wallet: string;
    txHash: string;
    amount?: string;
    network?: string;
    resource?: string;
};
export type BatchScoreItem = {
    agentId: string;
    wallet?: string;
} | {
    wallet: string;
    agentId?: never;
};
export declare class VouchClient {
    private readonly apiUrl;
    private readonly apiKey;
    private readonly fetchFn;
    private readonly timeoutMs;
    constructor(options: VouchClientOptions);
    getAgentScore(agentId: string, wallet?: string): Promise<TrustScoreResult>;
    getWalletScore(wallet: string): Promise<TrustScoreResult>;
    /**
     * Buyer-side lookup: "should my agent pay this wallet?" — scores the
     * payment *recipient* (settlement receiving history, wallet health,
     * exit-scam-shaped outflow, outcome labels).
     */
    getPayeeScore(payee: string): Promise<PayeeScoreResult>;
    /**
     * verify-at-settle fast surface: the engine's already-pinned verdict, or an
     * honest `cache_cold`. **This surface never computes** — it is a cache peek,
     * with the server's in-handler p95 held under 1 ms by
     * `tests/verdict-fast.test.ts`. For facilitators and payment middleware that
     * need a trust check INSIDE the settlement flow.
     *
     * Fail-closed reading, and the caller owns it: treat anything that is not an
     * explicit `hit` + `ALLOW` — `cache_cold` above all — as "do not pay yet".
     * {@link payeeVerdictFastAllows} is that rule, already written.
     *
     * WHY IT IS SAFE TO ACT ON A HIT. The engine only pins verdicts it was
     * confident in: a degraded or partially-measured reading is never cached
     * (src/lib/scoring/payee-engine.ts — the `cache.set` is guarded by
     * `!degraded && !partiallyMeasured`). So a `hit` cannot be a fail-closed
     * refusal wearing an ALLOW, which is exactly why this body does not need to
     * carry `degraded` / `signalsUnavailable`.
     *
     * WHY {@link SpendGuard} STILL DOES NOT USE IT. The guard also enforces
     * `minPayeeScore` bands and its own `maxScoreAgeMs`, and reports the full
     * `payeeScore` in its decision — none of which this body can supply. The
     * fast surface is a pre-check for a settlement path that already has its own
     * deadline, not a replacement for the score. Warm with
     * {@link VouchClient.getPayeeScore} (same cache, TTL 5 min) and retry.
     */
    getPayeeVerdictFast(payee: string): Promise<PayeeVerdictFast>;
    /**
     * Non-custodial spend-policy guard. Returns allow/deny decisions only —
     * never touches keys, funds, or transaction signing; execution remains the
     * agent's wallet stack's job (Coinbase AgentKit, Privy, ...). Fail-closed
     * by default (0.2.0): money moves only on a clean ALLOW verdict unless the
     * policy explicitly opts out via `trustPolicy`. The daily budget counter is
     * in-memory per guard instance and resets on process restart. See
     * SpendGuard for the full contract.
     */
    /** §9.1 GET /resources/{resource_id}/decision — facts と recommendation を同じ応答で。 */
    getDecision(resourceId: string, query?: DecisionQuery): Promise<DecisionResult>;
    /** §7.3 GET /resolve?q= — URL / domain / address / tx / payee_id から canonical オブジェクトへ。キー不要だが同じ経路で送る。 */
    resolve(q: string): Promise<ResolveResult>;
    createSpendGuard(policy: SpendGuardPolicy): SpendGuard;
    batchScore(agents: BatchScoreItem[]): Promise<{
        results: unknown[];
    }>;
    attestX402Payment(attestation: X402PaymentAttestation): Promise<{
        ok: boolean;
        created: boolean;
        id: string;
    }>;
    private request;
}
export declare function createVouchClient(options: VouchClientOptions): VouchClient;
