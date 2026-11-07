/**
 * ERC-8004 deterministic CREATE2 addresses (identical on all EVM mainnets).
 * @see https://github.com/erc-8004/erc-8004-contracts
 */
export const BASE_CHAIN_ID = 8453;

export const ERC8004_ADDRESSES = {
  identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as const,
  reputationRegistry: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" as const,
  validationRegistry: "0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58" as const,
} as const;

/**
 * Circle's native USDC on Base mainnet — the settlement currency of x402
 * payments. Drain-pattern checks aggregate this token alongside native ETH;
 * deliberately not a general ERC20 allowlist (x402 settles in USDC only).
 * @see https://developers.circle.com/stablecoins/usdc-on-main-networks
 */
export const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

export const SCORE_THRESHOLDS = {
  allow: 70,
  warn: 40,
} as const;

export const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Owner-index staleness threshold for SCORING (2026-08-05 R&D).
 * One day of lag, measured in chain time (2026-11-07: this was 43,200 blocks,
 * which stopped being a day when Base moved to 0.2 s blocks at 53,556,127). Below this, the index is fresh enough that multi_agent_owner /
 * funding-cluster checks are trustworthy; above it, recently registered
 * agents may be invisible to those checks, so the engine adds a SOFT
 * `owner_index_stale` flag — the data exists but may miss the newest
 * registrations, which is a different (and milder) failure than
 * owner_count_unavailable, where the read itself failed.
 * The monitor's own alert threshold (500,000 in uptime-cron) is about
 * paging a human; this one is about being honest inside the score.
 */
export const OWNER_INDEX_STALE_SECONDS = 86_400;
/** Aligned with score cache so wallet metrics cannot outlive chain score freshness. */
export const WALLET_METRICS_CACHE_TTL_MS = CACHE_TTL_MS;

/** Base block when ERC-8004 Identity Registry was deployed (verified on-chain). */
export const IDENTITY_REGISTRY_FROM_BLOCK = BigInt(41_663_783);

/**
 * Chain signal weights before manual WL/BL policy.
 * Manual remains a post-score policy layer (not mixed into this sum).
 *
 * vet402 2026-08-13 — forgery cost and weight must correlate POSITIVELY.
 * The old split (identity .2 + reputation .3 = .5 of the score) put HALF the
 * weight on the two cheapest-to-fake signals: ERC-8004 registration is one
 * Base tx of a few cents, and the reputation summary is self-attestable. The
 * one signal that costs a real, chain-confirmed USDC settlement to fake —
 * x402 — carried only .1. So the product rewarded exactly the signals an
 * attacker controls and discounted the one it does not. Registering alone
 * (0 settlements) reached 83/ALLOW while unregistered real companies capped at
 * 49/WARN.
 *
 * The order below is now cheapest-to-fake → hardest-to-fake, LOW weight → HIGH
 * weight:
 *   identity   .05  self-attested: a registration tx anyone can send.
 *   reputation .10  self-attestable summary; distinct-client feedback is what
 *                   the sybil layer and the ALLOW-evidence gate actually trust.
 *   wallet     .25  age + tx count: on-chain and observed, gameable but not
 *                   free (a wallet has to actually exist and transact).
 *   x402       .40  a chain-confirmed USDC settlement whose owner signed for
 *                   it (getX402PaymentStats now counts only those). Hardest to
 *                   fake, so it moves the score the most.
 *
 * The four still sum to 0.8 (manual is the .2 policy layer, excluded from
 * computeWeightedScore), so the ÷0.8 normalization and every downstream
 * breakdown are unchanged; only the distribution across the four moved.
 * Self-attestation alone still cannot clear ALLOW — see hasVerifiableEvidence
 * / SELF_ATTESTED_CEILING in scoring/helpers.ts, which caps a score with no
 * verifiable evidence at WARN regardless of how the weights land.
 */
export const SCORE_WEIGHTS = {
  identity: 0.05,
  reputation: 0.1,
  wallet: 0.25,
  x402: 0.4,
  /** Policy layer — not included in computeWeightedScore. */
  manual: 0.2,
} as const;
