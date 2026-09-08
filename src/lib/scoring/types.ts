export type Recommendation = "ALLOW" | "WARN" | "BLOCK";

export type DataCoverage = {
  ownerIndexer: {
    status: "synced" | "partial" | "unavailable";
    blocksBehind: number | null;
    lastBlock: string | null;
    indexedAgentRows: number;
    /** True when recent Transfers may not yet be reflected for enforcement. */
    staleRisk: boolean;
  };
  settlement: {
    /** Attested x402 payment rows in store (global). */
    paymentRows: number;
    distinctWallets: number;
    recentPayments30d: number;
    /** True when the wallet being scored has at least one attestation. */
    walletHasHistory: boolean;
  };
};

export type TrustSignals = {
  identity: {
    registered: boolean;
    hasMetadataUri: boolean;
  };
  reputation: {
    feedbackCount: number;
    /** Internal 0–100 reputation component used in scoring. */
    avgScore: number;
    /** Raw on-chain average from the reputation registry summary. */
    onChainAvgScore: number;
  };
  wallet: {
    ageDays: number;
    txCount: number;
    isBurner: boolean;
  };
  x402: {
    paymentCount: number;
    uniqueDays: number;
    /**
     * Internal 0–100 component the highest-weighted axis fed the weighting.
     * vet402 2026-08-14: this axis is "verifiable economic activity", not x402
     * settlements alone — `score` reflects the strongest of L1 observed purchases
     * (below) and x402 settlements. Kept under `x402` for wire back-compat.
     */
    score: number;
    /**
     * vet402 2026-08-14 — L1 delivery-verified observed purchases behind the axis
     * score (the premium signal). Optional/back-compat; 0 today until the
     * observatory writes its first row.
     */
    l1PurchaseCount?: number;
    l1DistinctSellers?: number;
  };
  sybil: {
    risk: "low" | "medium" | "high";
    flags: string[];
  };
  manual: {
    list: "none" | "whitelist" | "blacklist";
  };
};

/** N-21 (2026-08-06): explainability. Why the chain score is what it is,
 *  broken into the four weighted components plus the sybil adjustment — the
 *  exact arithmetic of computeWeightedScore + applySybilPenalty, echoed so an
 *  integrator can audit a verdict without re-deriving it. Every `score` is the
 *  0–100 component the engine actually fed the weighting; `contribution` is
 *  `score × weight ÷ Σweights` (the four contributions sum to
 *  `weightedSubtotal`). Chain-derived only: the manual whitelist/blacklist
 *  layer is reported via the existing `manualOverride`/`signals.manual`, never
 *  folded into this breakdown. Omitted on hard-blocked verdicts (wallet
 *  mismatch, unregistered agent) where no weighting ran. */
export type ScoreComponent = {
  /** 0–100 component score fed into the weighting. */
  score: number;
  /** Its weight in SCORE_WEIGHTS (chain components only). */
  weight: number;
  /** score × weight ÷ Σ(chain weights); the four sum to weightedSubtotal. */
  contribution: number;
};

export type ScoreBreakdown = {
  components: {
    identity: ScoreComponent;
    reputation: ScoreComponent;
    wallet: ScoreComponent;
    x402: ScoreComponent;
  };
  /** Weighted average of the four components before the sybil penalty. */
  weightedSubtotal: number;
  /** Points removed by sybil/availability flags (≤ 0). See signals.sybil.flags. */
  sybilPenalty: number;
  /** weightedSubtotal + sybilPenalty, clamped — the chain score before the
   *  manual policy layer. Equals trustScore unless a manual list moved it. */
  prePolicyScore: number;
};

export type TrustScoreResult = {
  agentId: string;
  wallet: string | null;
  trustScore: number;
  recommendation: Recommendation;
  signals: TrustSignals;
  /** N-21: component-level explanation of the chain score (see ScoreBreakdown).
   *  Optional for backward compatibility and absent on hard-blocked verdicts. */
  breakdown?: ScoreBreakdown;
  scoredAt: string;
  cacheExpiresAt: string;
  /** N-18: stable machine-readable reasons behind the verdict (for
   *  integrators' compliance logs). Derived from the same signals the
   *  verdict used — cannot disagree with it. */
  reasons?: string[];
  disclaimer: string;
  blockReason?: string;
  /** True when customer whitelist/blacklist changed the outcome. */
  manualOverride?: boolean;
  /** Indexer / chain data freshness — scores are valid for synced ranges. */
  dataCoverage?: DataCoverage;
};

export type ScoreRequestContext = {
  apiKeyId?: string;
  verifyWallet?: string;
  /** EVM chain id for the ERC-8004 reads. Default (and today the only chain
   *  with settlement + full wallet metrics) is Base — see chain/chains.ts. */
  chainId?: number;
  /**
   * 2026-09-09 — degrade した signal の error を、そのまま呼び出し側へ渡す口。
   *
   * これが無かったとき、`*_unavailable` の flag は engine の boolean から
   * 作り直されていたので、**どの経路で落ちたかは flag の外側にしか無かった**。
   * health probe だけが使う（サーバー内部の入力であって、
   * TrustScoreResult には出さない——公開レスポンスの形は変えない）。
   * 例外は握りつぶさない: sink が投げればスコアも落ちる。
   */
  onSignalDegraded?: (signal: string, error: unknown) => void;
};
