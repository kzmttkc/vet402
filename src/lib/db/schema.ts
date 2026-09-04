import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const agents = pgTable(
  "agents",
  {
    agentId: bigint("agent_id", { mode: "bigint" }).primaryKey(),
    wallet: text("wallet"),
    chainId: bigint("chain_id", { mode: "number" }).notNull().default(8453),
    metadataUri: text("metadata_uri"),
    lastIndexed: timestamp("last_indexed", { withTimezone: true }),
  },
  (t) => [index("agents_wallet_idx").on(t.wallet)],
);

export const scoreSnapshots = pgTable("score_snapshots", {
  id: uuid("id").defaultRandom().primaryKey(),
  agentId: bigint("agent_id", { mode: "bigint" }),
  trustScore: bigint("trust_score", { mode: "number" }),
  recommendation: text("recommendation"),
  signals: jsonb("signals"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const trustEvents = pgTable(
  "trust_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    apiKeyId: uuid("api_key_id"),
    agentId: bigint("agent_id", { mode: "bigint" }),
    wallet: text("wallet"),
    trustScore: bigint("trust_score", { mode: "number" }),
    recommendation: text("recommendation"),
    signals: jsonb("signals"),
    manualOverride: text("manual_override"),
    blockReason: text("block_reason"),
    disclaimer: text("disclaimer"),
    cacheExpiresAt: timestamp("cache_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("trust_events_api_key_created_idx").on(t.apiKeyId, t.createdAt),
    index("trust_events_agent_id_idx").on(t.agentId),
  ],
);

export const ownerUsage = pgTable(
  "owner_usage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull(),
    period: text("period").notNull(),
    count: bigint("count", { mode: "number" }).notNull().default(0),
  },
  (t) => [uniqueIndex("owner_usage_user_period_unique").on(t.userId, t.period)],
);

export const ipRateLimits = pgTable("ip_rate_limits", {
  bucketKey: text("bucket_key").primaryKey(),
  count: bigint("count", { mode: "number" }).notNull().default(0),
  resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
});

export const cacheEpochs = pgTable("cache_epochs", {
  scope: text("scope").primaryKey(),
  epoch: bigint("epoch", { mode: "number" }).notNull().default(0),
});

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    plan: text("plan").notNull().default("free"),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [uniqueIndex("accounts_email_unique").on(t.email)],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id"),
    name: text("name"),
    keyHash: text("key_hash").notNull(),
    plan: text("plan").notNull().default("free"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [index("api_keys_key_hash_idx").on(t.keyHash)],
);

export const apiUsage = pgTable(
  "api_usage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    apiKeyId: uuid("api_key_id").notNull(),
    period: text("period").notNull(),
    count: bigint("count", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    uniqueIndex("api_usage_key_period_unique").on(t.apiKeyId, t.period),
    index("api_usage_period_idx").on(t.period),
  ],
);

export const customerLists = pgTable(
  "customer_lists",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    apiKeyId: uuid("api_key_id"),
    wallet: text("wallet").notNull(),
    listType: text("list_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("customer_lists_wallet_idx").on(t.wallet),
    index("customer_lists_api_key_idx").on(t.apiKeyId),
    uniqueIndex("customer_lists_scope_unique").on(t.apiKeyId, t.wallet),
  ],
);

/**
 * vet402 2026-08-14 — L1 observed purchases: the PREMIUM economic-activity
 * signal. A row is vet402's own observatory recording that a wallet made a real
 * purchase from an independent seller AND that the good/service was delivered.
 * This is a strictly stronger fact than an x402 settlement row (which proves the
 * money moved, not that anything was delivered), so it feeds the highest-weighted
 * axis above the x402 curve (scoreEconomicActivity / scoreL1Purchases).
 *
 * WRITTEN ONLY BY THE TRUSTED OBSERVATORY (recordObservedPurchase), never by API
 * scoring — the same trust boundary as funder_wallets and feedback_events. The
 * table is empty today (0 rows); the intake exists so the first real observation
 * becomes an ALLOW basis without a schema scramble later.
 *
 * SQL: scripts/sql/2026-08-14-observed-purchases.sql (readers tolerate a missing
 * table via isMissingSchemaError, degrading to "no L1 history" — never a throw).
 */
export const observedPurchases = pgTable(
  "observed_purchases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** The BUYER whose economic activity this evidences (the payer). */
    wallet: text("wallet").notNull(),
    /** The independent SELLER/counterparty. NULL = unresolved → never counts. */
    counterparty: text("counterparty"),
    /** USDC base units (6 decimals) the buyer actually paid, on-chain. */
    amount: text("amount"),
    /** The settlement tx; unique so a purchase is observed at most once. */
    txHash: text("tx_hash").notNull(),
    /** What was purchased, when the observatory can name it. */
    resource: text("resource"),
    /** On-chain block time — the authoritative day axis, like x402_payments. */
    blockTimestamp: timestamp("block_timestamp", { withTimezone: true }),
    /**
     * TRUE only when the observatory confirmed the purchased good/service was
     * actually delivered. A row counts toward economic-activity scoring ONLY
     * when this is TRUE — an observed settlement with no delivery confirmation
     * is exactly an x402-strength fact, not an L1 one, and must not be scored
     * as the premium signal.
     */
    deliveryVerified: boolean("delivery_verified").notNull().default(false),
    /** Which observatory/probe recorded it (provenance, ops visibility). */
    observedBy: text("observed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("observed_purchases_tx_hash_idx").on(t.txHash),
    index("observed_purchases_wallet_idx").on(t.wallet, t.blockTimestamp),
    index("observed_purchases_counterparty_idx").on(t.counterparty, t.blockTimestamp),
  ],
);

/**
 * vet402 2026-08-14 — operator override transparency log (append-only, PUBLIC).
 *
 * The EF/Vitalik blocker: an operator could add a GLOBAL blacklist entry
 * (operator_policy BLOCK) with no reason, no signal trail, invisible to the
 * scored party — a silent single censorship point that contradicts credible
 * neutrality. This table turns every such GLOBAL operator act into an auditable
 * public record: target address, action, reason, timestamp. Served openly by
 * GET /api/transparency/operator-overrides and /operator-log, and covered by the
 * same keyless dispute routes as any score (ToS §8).
 *
 * CUSTOMER-scoped lists are NOT recorded here: a customer whitelisting/blacklisting
 * for their OWN integration is their private management right, not an operator
 * act of global censorship. Only apiKeyId=NULL (global) writes land here.
 *
 * SQL: scripts/sql/2026-08-14-operator-overrides.sql (readers tolerate a missing
 * table, degrading to an empty log rather than throwing).
 */
export const operatorOverrides = pgTable(
  "operator_overrides",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    wallet: text("wallet").notNull(),
    /** 'blacklist_added' | 'blacklist_removed'. */
    action: text("action").notNull(),
    /** Why the operator applied it — required, never blank. */
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [index("operator_overrides_created_idx").on(t.createdAt)],
);

export const funderWallets = pgTable(
  "funder_wallets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    funder: text("funder").notNull(),
    wallet: text("wallet").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [uniqueIndex("funder_wallets_unique").on(t.funder, t.wallet)],
);

/**
 * Negative cache for funder indexing: wallets whose first incoming transfer
 * could not be resolved (fetchFirstIncomingTransfer returned null). Without
 * this, unresolvable wallets stay in collectWalletsToIndex's candidate set
 * forever and get re-scanned (and re-billed against the RPC budget) on every
 * run. Entries are retried with growing backoff rather than excluded
 * permanently, since resolvability can change once a wallet finally receives
 * a transfer.
 */
export const funderIndexSkips = pgTable("funder_index_skips", {
  wallet: text("wallet").primaryKey(),
  attempts: integer("attempts").notNull().default(1),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }).defaultNow(),
  nextRetryAt: timestamp("next_retry_at", { withTimezone: true }).notNull(),
});

export const ownerAgents = pgTable(
  "owner_agents",
  {
    owner: text("owner").notNull(),
    agentId: bigint("agent_id", { mode: "bigint" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("owner_agents_unique").on(t.owner, t.agentId),
    index("owner_agents_owner_idx").on(t.owner),
    index("owner_agents_agent_idx").on(t.agentId),
  ],
);

/**
 * ERC-8004 NewFeedback events (2026-08-12). Written only by the trusted
 * indexer (src/lib/indexer/feedback-indexer.ts); read by
 * fetchRecentFeedbackStats to answer "how much feedback, from how many
 * distinct clients, in the last N days" without an eth_getLogs scan on the
 * request path.
 *
 * The window is expressed in BLOCK NUMBERS, not timestamps, because that is
 * exactly how the chain scan it replaces defined "recent"
 * (`latestBlock - blocksPerDay * windowDays`). Storing a timestamp and
 * filtering on it would be a quieter definition change to a sybil signal, and
 * the whole point of this table is that the signal's meaning does not move.
 *
 * SQL: scripts/sql/2026-08-12-feedback-events.sql (fallback-tolerant readers —
 * every consumer tolerates a missing table).
 */
export const feedbackEvents = pgTable(
  "feedback_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    chainId: bigint("chain_id", { mode: "number" }).notNull().default(8453),
    agentId: bigint("agent_id", { mode: "bigint" }).notNull(),
    clientAddress: text("client_address").notNull(),
    blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
    logIndex: integer("log_index").notNull(),
    txHash: text("tx_hash").notNull(),
    indexedAt: timestamp("indexed_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("feedback_events_log_unique").on(t.chainId, t.txHash, t.logIndex),
    index("feedback_events_agent_block_idx").on(t.chainId, t.agentId, t.blockNumber),
    index("feedback_events_block_idx").on(t.chainId, t.blockNumber),
  ],
);

export const indexerCheckpoints = pgTable("indexer_checkpoints", {
  scope: text("scope").primaryKey(),
  lastBlock: bigint("last_block", { mode: "bigint" }).notNull(),
  chainTipAtRun: bigint("chain_tip_at_run", { mode: "bigint" }),
  // 2026-09-02 (audit C1): Solana keeps the newest signature next to the
  // slot so getSignaturesForAddress can be resumed with `until`. Nullable —
  // EVM scopes and pre-existing Solana rows carry only the slot.
  lastCursor: text("last_cursor"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const dashboardSessions = pgTable(
  "dashboard_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tokenHash: text("token_hash").notNull(),
    apiKeyId: uuid("api_key_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("dashboard_sessions_token_hash_idx").on(t.tokenHash),
    index("dashboard_sessions_api_key_idx").on(t.apiKeyId),
  ],
);

/**
 * Result-label collection (phase 1): what actually happened to an agent/wallet
 * after a trust_events verdict was issued. Populated two ways — auto-detected
 * by the outcome-detector indexer (src/lib/indexer/outcome-detector.ts) and
 * partner-reported via POST /v1/events/{trustEventId}/outcome. This is the
 * foundation for measuring score accuracy later; nothing reads from it yet.
 */
export const verdictOutcomes = pgTable(
  "verdict_outcomes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    trustEventId: uuid("trust_event_id").notNull(),
    outcomeType: text("outcome_type").notNull(),
    relatedWallet: text("related_wallet"),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    windowMinutes: integer("window_minutes").notNull(),
    /** 'auto' | 'partner:{apiKeyId}' */
    source: text("source").notNull().default("auto"),
    /** Set only when source is a partner report. */
    apiKeyId: uuid("api_key_id"),
    /** tx hash / feedback log / notes+evidenceUrl, depending on outcomeType. */
    evidence: jsonb("evidence"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("verdict_outcomes_trust_event_idx").on(t.trustEventId),
    index("verdict_outcomes_type_detected_idx").on(t.outcomeType, t.detectedAt),
    uniqueIndex("verdict_outcomes_unique").on(t.trustEventId, t.outcomeType, t.source),
  ],
);

/**
 * Webhook endpoints (2026-08-05 R&D, C-9). One row per registered endpoint;
 * at most MAX_WEBHOOKS_PER_KEY per api key (enforced in lib/webhooks.ts).
 * `secret` is generated by us and shown once. At rest it is sealed with
 * AES-256-GCM (`enc.v1.…`) when API_KEY_PEPPER or WEBHOOK_SECRET_KEK is set;
 * readers still accept legacy plaintext rows and, during rotation, rows
 * sealed with WEBHOOK_SECRET_KEK_PREVIOUS (then reseal onto the current KEK).
 * SQL: scripts/sql/2026-08-05-webhooks.sql (fallback-tolerant readers).
 */
export const webhooks = pgTable(
  "webhooks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    apiKeyId: uuid("api_key_id").notNull(),
    url: text("url").notNull(),
    secret: text("secret").notNull(),
    /** subset of WEBHOOK_EVENTS the endpoint subscribed to */
    events: jsonb("events").notNull(),
    active: boolean("active").notNull().default(true),
    failureCount: integer("failure_count").notNull().default(0),
    lastDeliveredAt: timestamp("last_delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [index("webhooks_api_key_idx").on(t.apiKeyId)],
);

/**
 * Watchlist (N-15, 2026-08-05). A customer registers targets to monitor; the
 * watchlist-scan cron re-scores them and fires a `watch.verdict_changed`
 * webhook when the recommendation moves. This is what turns the score API
 * into a monitoring service — and what the Scale plan actually sells.
 * SQL: scripts/sql/2026-08-05-watchlist.sql.
 */
export const watchlistEntries = pgTable(
  "watchlist_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    apiKeyId: uuid("api_key_id").notNull(),
    /** 'agent' | 'wallet' */
    targetType: text("target_type").notNull(),
    target: text("target").notNull(),
    chainId: integer("chain_id").notNull().default(8453),
    lastScore: integer("last_score"),
    lastRecommendation: text("last_recommendation"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("watchlist_api_key_idx").on(t.apiKeyId),
    uniqueIndex("watchlist_unique").on(t.apiKeyId, t.targetType, t.target, t.chainId),
  ],
);

/**
 * Verified payees (N-16, 2026-08-05). A payee proves control of their wallet
 * by signing a canonical message; verified entries get a public profile and
 * an embeddable badge. The two-sided registry: spending agents check payees
 * here, payees display the badge — the moat is the network, not the row.
 * SQL: scripts/sql/2026-08-05-verified-payees.sql.
 */
export const verifiedPayees = pgTable(
  "verified_payees",
  {
    wallet: text("wallet").primaryKey(),
    name: text("name").notNull(),
    url: text("url"),
    signature: text("signature").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).defaultNow(),
    // 2026-08-18 (audit residual): the `issued` value embedded in the signed
    // message. Enforced monotonic on write (verify POST) so replaying an
    // older still-valid signature can never roll back a newer correction or
    // refresh verifiedAt on a stale claim. Nullable: pre-migration rows have
    // no issued_at and always lose to any newer write.
    issuedAt: timestamp("issued_at", { withTimezone: true }),
  },
);

/**
 * Agent passports (A-10, 2026-08-06). The symmetric twin of verifiedPayees:
 * where a payee proves control of a RECEIVING wallet, an agent proves control
 * of its ERC-8004 identity by signing a canonical message with the wallet that
 * `getAgentWallet(agentId)` returns on-chain. The signature binds (agentId,
 * wallet, name); the on-chain wallet lookup binds agentId→wallet. Together
 * they let an agent proactively present a verifiable "trust passport" —
 * identity + live score + x402 history — to win better terms, the mirror of
 * the buyer-side Verified Payee check.
 *
 * Keyed on agentId (an agent has one identity); `wallet` is the resolved
 * canonical wallet at verification time, stored so a reader can re-verify the
 * signature without a chain round-trip. SQL: scripts/sql/2026-08-06-agent-passports.sql
 * (fallback-tolerant readers — every consumer tolerates a missing table).
 */
export const agentPassports = pgTable(
  "agent_passports",
  {
    agentId: bigint("agent_id", { mode: "bigint" }).primaryKey(),
    wallet: text("wallet").notNull(),
    name: text("name").notNull(),
    url: text("url"),
    signature: text("signature").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).defaultNow(),
    // 2026-08-18 (audit residual): see verifiedPayees.issuedAt — same
    // monotonic-write guard, symmetric twin.
    issuedAt: timestamp("issued_at", { withTimezone: true }),
  },
  (t) => [index("agent_passports_wallet_idx").on(t.wallet)],
);

export const x402Payments = pgTable(
  "x402_payments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    wallet: text("wallet").notNull(),
    amount: text("amount"),
    txHash: text("tx_hash").notNull(),
    apiKeyId: uuid("api_key_id"),
    network: text("network").notNull().default("base"),
    resource: text("resource"),
    /**
     * Receiving wallet — the `to` side of the verified ERC20 Transfer log
     * (see extractPayeeFromReceipt in src/lib/chain/x402-verify.ts). `wallet`
     * above stays the payer for backward compatibility with existing
     * payer-side scoring (scoreX402Payments). Nullable: pre-existing rows
     * predate this column (see scripts/backfill-payee.ts) and a small number
     * of settlements cannot be resolved to a Transfer log at all (native
     * transfer edge case — see that function's fallback comment).
     */
    payee: text("payee"),
    /**
     * 2026-08-05. `amount` above is whatever the caller POSTed and was never
     * checked against anything: the route accepted a free-form string and
     * stored it next to an on-chain-verified tx hash, so a "verified" payment
     * row could carry a made-up figure. These three columns are what the CHAIN
     * says, read from the same settlement Transfer log the payee comes from.
     *
     *  - onchainAmount: the transferred amount in the token's base units.
     *  - token: the ERC20 contract that actually moved. Only BASE_USDC counts
     *    as an x402 settlement; any other token means the wallet-match
     *    condition was satisfied by an unrelated transfer.
     *  - amountVerified: true only when the caller declared an amount AND the
     *    settlement leg is USDC AND the two agree exactly. null on rows that
     *    predate this column, false when we could not confirm — never
     *    conflated with "no amount was sent".
     */
    onchainAmount: text("onchain_amount"),
    token: text("token"),
    amountVerified: boolean("amount_verified"),
    /**
     * vet402 2026-08-13. The on-chain block time of the settlement tx (read
     * from the receipt's block), NOT the DB insert time. uniqueDays and
     * lastPaymentAt are computed from this so a caller cannot manufacture a
     * multi-day settlement streak by dripping inserts of one day's txs across
     * a fortnight — block time is not something the caller picks. NULL on rows
     * that predate this column; readers coalesce to created_at for those.
     */
    blockTimestamp: timestamp("block_timestamp", { withTimezone: true }),
    /**
     * vet402 2026-08-13. TRUE only when the write-back carried a valid EIP-191
     * signature by `wallet` (proof the poster controls the paying wallet — the
     * same proof-of-control gate verified payees use). A row counts toward any
     * score only when this is TRUE, so posting a stranger's real on-chain
     * transfer records a row but cannot move that stranger's score. NULL on
     * legacy rows (never TRUE → never score-eligible).
     */
    ownershipVerified: boolean("ownership_verified"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("x402_payments_tx_hash_idx").on(t.txHash),
    index("x402_payments_wallet_created_idx").on(t.wallet, t.createdAt),
    index("x402_payments_api_key_idx").on(t.apiKeyId),
    index("x402_payments_payee_created_idx").on(t.payee, t.createdAt),
  ],
);

// ============================================================
// vet402 Observatory L0 (2026-08-14) — the no-purchase, $0 observation layer.
//
// Four tables, all NEW — nothing above this line changed. The observatory
// ingests the CDP Bazaar discovery catalog daily, probes every endpoint
// without paying (the 402 challenge itself is the observable), and records
// delisting as an EVENT with before/after evidence. Facts only: the public
// pages built on these tables publish pass/fail/unverified — never a
// composite score, never an evaluative word (legal gate, mvt design §11).
//
// Probe methods come from the catalog's declared `input.method` — never
// guessed. A GET probe against a POST-declared endpoint reports a false
// death (x402 issue #3113 class); undeclared methods are recorded as
// `unverified`, not `fail`.
// ============================================================

/** Catalog current-state: one row per discovered x402 endpoint. */
export const x402Endpoints = pgTable(
  "x402_endpoints",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /**
     * Normalized identity (host+path, routeTemplate preferred over raw
     * resource) so query-string noise cannot double-register an endpoint —
     * a duplicate key would poison the daily diff into phantom delistings.
     */
    resourceKey: text("resource_key").notNull(),
    resourceUrl: text("resource_url").notNull(),
    /** Discovery source; future-proofs multi-source ingestion (x402scan etc). */
    source: text("source").notNull().default("cdp_bazaar"),
    /** Declared HTTP method from extensions.bazaar.info.input.method. NULL = undeclared → probe stays `unverified`. */
    method: text("method"),
    network: text("network"),
    /** Representative receiver (accepts[0].payTo) — the claim-join key against verifiedPayees.wallet. */
    payTo: text("pay_to"),
    priceAmount: text("price_amount"),
    priceAsset: text("price_asset"),
    description: text("description"),
    declaredSchema: jsonb("declared_schema"),
    qualityCalls30d: bigint("quality_calls_30d", { mode: "number" }),
    qualityPayers30d: bigint("quality_payers_30d", { mode: "number" }),
    qualityLastCalledAt: timestamp("quality_last_called_at", { withTimezone: true }),
    /** Full accepts[] as received — multi-payTo/multi-chain evidence, auditability. */
    rawAccepts: jsonb("raw_accepts"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow(),
    /** active | delisted — current catalog presence (history lives in x402_delisting_events). */
    status: text("status").notNull().default("active"),
    delistedAt: timestamp("delisted_at", { withTimezone: true }),
    /**
     * 製品定義書 §5（2026-09-02）。uuid `id` は主キーのまま、公開 ID と逆引きの鍵として
     * 並走する。算出は src/lib/ids/canonical.ts の 1 箇所。NULL = 未算出（backfill 前）。
     */
    canonicalUrl: text("canonical_url"),
    /** sha256(method + " " + canonical_url) */
    resourceId: text("resource_id"),
    /** sha256(origin + pathname_prefix) — 仕様の endpoint_id */
    endpointHash: text("endpoint_hash"),
    /** chain_caip2:address（EVM は小文字）。payTo と network から算出。 */
    payeeId: text("payee_id"),
    /** canonical_url から外した可変クエリ名（§5 undeclared）。 */
    undeclaredQuery: jsonb("undeclared_query"),
  },
  (t) => [
    uniqueIndex("x402_endpoints_key_source_unique").on(t.resourceKey, t.source),
    index("x402_endpoints_payto_idx").on(t.payTo),
    index("x402_endpoints_status_idx").on(t.status),
    index("x402_endpoints_resource_id_idx").on(t.resourceId),
    index("x402_endpoints_endpoint_hash_idx").on(t.endpointHash),
    index("x402_endpoints_payee_id_idx").on(t.payeeId),
  ],
);

/**
 * Daily catalog snapshot — the raw material the diff is computed FROM, kept
 * so a disputed delisting can be re-derived. fetchedCount < totalCount marks
 * an incomplete fetch: delisting judgement is WITHHELD that day (a fetch gap
 * must never read as "the endpoint vanished" — verify-the-instrument).
 */
export const x402CatalogSnapshots = pgTable(
  "x402_catalog_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** 'YYYY-MM-DD' — one snapshot per source per day. */
    snapshotDate: text("snapshot_date").notNull(),
    source: text("source").notNull().default("cdp_bazaar"),
    totalCount: integer("total_count").notNull(),
    fetchedCount: integer("fetched_count").notNull(),
    /** All resourceKeys seen that day (set for diffing; full item JSON is NOT kept — it would bloat). */
    resourceKeys: jsonb("resource_keys").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [uniqueIndex("x402_catalog_snapshots_date_source_unique").on(t.snapshotDate, t.source)],
);

/** L0 probe results — the fact timeline. Facts only; the verdict vocabulary is closed: pass | fail | unverified. */
export const x402L0Probes = pgTable(
  "x402_l0_probes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    endpointId: uuid("endpoint_id").notNull(),
    probedAt: timestamp("probed_at", { withTimezone: true }).defaultNow(),
    /** The method actually sent — always the catalog-declared one (see header note on #3113). */
    method: text("method").notNull(),
    /** pass | fail | unverified. Fail-closed points TOWARD unverified: no proof ≠ dead. */
    verdict: text("verdict").notNull(),
    /** v1 | v2 | both | unpayable | NULL（402 以外・到達不能）。§5「方言差は観測属性に持つ」。 */
    dialect: text("dialect"),
    httpStatus: integer("http_status"),
    has402Challenge: boolean("has_402_challenge"),
    acceptsValid: boolean("accepts_valid"),
    priceConsistent: boolean("price_consistent"),
    metadataConsistent: boolean("metadata_consistent"),
    latencyMs: integer("latency_ms"),
    /** Factual reason code: timeout | dns | tls | no_402 | price_mismatch | ... — never an evaluative word. */
    failReason: text("fail_reason"),
    /** Status/headers digest — the evidence half of the legal 4-piece set for any published fail. */
    rawResponseMeta: jsonb("raw_response_meta"),
  },
  (t) => [
    index("x402_l0_probes_endpoint_probed_idx").on(t.endpointId, t.probedAt),
    index("x402_l0_probes_verdict_idx").on(t.verdict),
  ],
);

/** Delisting/relisting/settle-drop events — alert feed + State of x402 material. Evidence (prev/new) travels with the event. */
export const x402DelistingEvents = pgTable(
  "x402_delisting_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    endpointId: uuid("endpoint_id").notNull(),
    /** delisted | relisted | probe_pass_to_fail | settle_drop */
    eventType: text("event_type").notNull(),
    /** 'YYYY-MM-DD' */
    detectedOn: text("detected_on").notNull(),
    prevValue: jsonb("prev_value"),
    newValue: jsonb("new_value"),
    /** Set TRUE after webhook delivery to the claiming payee — the double-send guard. */
    notified: boolean("notified").notNull().default(false),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("x402_delisting_events_endpoint_idx").on(t.endpointId),
    index("x402_delisting_events_detected_idx").on(t.detectedOn),
  ],
);

/**
 * Observatory watchers (design §6.1) — the claim join, made explicit. A row
 * binds a RECEIVING wallet to an api key, created only through
 * POST /api/v1/observatory/watch where the caller signs the canonical
 * observatoryWatchMessage with that wallet (EIP-191 — the same
 * proof-of-control gate verified payees use). Delisting events whose
 * endpoint.payTo equals `wallet` are delivered to the key's webhooks as
 * `endpoint.delisted` through the existing HMAC/SSRF/auto-disable stack.
 */
export const x402PayeeWatchers = pgTable(
  "x402_payee_watchers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Lowercased receiving wallet — matches x402_endpoints.pay_to (also lowercased). */
    wallet: text("wallet").notNull(),
    apiKeyId: uuid("api_key_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("x402_payee_watchers_wallet_key_unique").on(t.wallet, t.apiKeyId),
    index("x402_payee_watchers_wallet_idx").on(t.wallet),
  ],
);

/**
 * Observatory L1 purchases (W3, 2026-08-14) — one row per real-purchase
 * attempt. `spent_units` is the BUDGET truth: it is written the moment an
 * authorization is signed and sent, whether or not settlement succeeded —
 * a signed EIP-3009 authorization is live money until validBefore, so the
 * conservative ledger counts it. The daily budget check sums this column.
 * Facts only; `status` is a closed factual vocabulary.
 */
export const x402L1Purchases = pgTable(
  "x402_l1_purchases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    endpointId: uuid("endpoint_id").notNull(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).defaultNow(),
    /**
     * settled | settle_claimed | settle_claim_refuted | settle_failed |
     * delivered_no_receipt | settle_claimed_unverifiable | no_402 |
     * no_eligible_accept | price_mismatch | payto_mismatch |
     * payto_operator_self | over_cap | budget_denied |
     * request_error | in_flight.
     * 2026-08-23 監査 C-4 — `settled` の定義を置き換えた。
     * 旧: 売り手が PAYMENT-RESPONSE で success:true と何かの文字列を返した。
     * 新: **我々がチェーンで確認した**（宛先・金額・トークン・チェーン・確定数）。
     *   `settle_claimed`            購入直後。売り手が主張し形式も正しいが未照合。
     *   `settled`                   照合 cron がオンチェーンで確認した。
     *   `settle_claim_refuted`      見に行って一致しなかった（売り手についての所見）。
     *   `settle_claimed_unverifiable` 主張はあるが tx がそのチェーンの識別子の形ですらない。
     * いずれも支払い済み（spent_units は立つ）。照合の結果は
     * settlement_verified / settlement_verified_at / settlement_verify_reason
     * / settlement_block_number に残る。
     * `payto_mismatch` / `payto_operator_self` are the 2026-08-22 payee gates:
     * the wall named a recipient other than the catalog-declared one, or named
     * vet402's own receiving address. Both are refusals BEFORE signing, so
     * spent_units stays 0.
     * `in_flight` is the spend reservation written before the EIP-3009
     * signature exists (see l1-runner.reserveSpend); it is replaced by the
     * outcome status seconds later, and only survives if the runner was killed
     * mid-purchase — in which case it is the honest record that money may have
     * moved with no receipt.
     */
    status: text("status").notNull(),
    network: text("network"),
    asset: text("asset"),
    payTo: text("pay_to"),
    /** USDC base units offered/signed for this attempt. */
    amountUnits: text("amount_units"),
    /** USDC base units counted against the daily budget (signed → counted). */
    spentUnits: text("spent_units").notNull().default("0"),
    /** Our paying wallet (rotates weekly by design). */
    payer: text("payer"),
    /** Settlement tx hash from PAYMENT-RESPONSE — the receipt evidence. */
    txHash: text("tx_hash"),
    /**
     * 我々が署名したときの一回性の値（2026-09-04 監査 P1-1）。
     *   EVM    EIP-3009 authorization の nonce（randomBytes(32) の 0x hex）
     *   Solana 我々が生成した memo 文字列（売り手の extra.memo は使わない）
     *
     * なぜ列にするか: これが無いと、照合は「payer→payTo へ期待額が動いた tx が
     * 存在する」までしか言えない。同じ payTo・同じ価格の endpoint は本番実測で
     * 253 グループ・1,477 試行あり、売り手は自分が受け取った過去の tx を返す
     * だけで、払っていない購入を settled にできた。nonce は我々しか作れないので、
     * これを行に残して初めて「その tx はこの購入のもの」と言える。
     * null は 2026-09-04 より前の行——照合は従来の判定に落ちる（持っていない
     * 証拠を理由に、無実の売り手を refuted にしない）。
     */
    authNonce: text("auth_nonce"),
    /** HTTP status of the PAID retry (the delivery half of the measurement). */
    httpStatusPaid: integer("http_status_paid"),
    latencyMs: integer("latency_ms"),
    payloadNonEmpty: boolean("payload_non_empty"),
    contentTypeMatch: boolean("content_type_match"),
    /** L2: match | mismatch | no_declaration | not_checked */
    l2Schema: text("l2_schema"),
    rawSettlement: jsonb("raw_settlement"),
    rawResponseMeta: jsonb("raw_response_meta"),
    /**
     * 2026-08-23 C-4: オンチェーン照合の結果。null = まだ見ていない。
     * true/false は「見た上での結論」で、null との違いが本質——
     * 測っていないことを測った結果として扱わないため、3値で持つ。
     */
    settlementVerified: boolean("settlement_verified"),
    settlementVerifiedAt: timestamp("settlement_verified_at", { withTimezone: true }),
    /** 照合が通らなかった理由（wrong_chain / tx_reverted / no_matching_transfer 等）。 */
    settlementVerifyReason: text("settlement_verify_reason"),
    settlementBlockNumber: bigint("settlement_block_number", { mode: "bigint" }),
  },
  (t) => [
    index("x402_l1_purchases_endpoint_idx").on(t.endpointId, t.attemptedAt),
    index("x402_l1_purchases_attempted_idx").on(t.attemptedAt),
    /**
     * 1 本の決済 tx は 1 つの購入にしか属せない（2026-09-04 監査 P1-1）。
     * 一意制約が無かったので、同じ tx を何行にでも貼れた——最大 27 endpoint を
     * 1 本で settled にできる状態だった（本番の重複は 0 件）。
     * lower() なのは EVM の hex が大小どちらでも同じ tx を指すから。
     * tx_hash IS NULL（レシート無しの試行）は多数あるので部分 index。
     */
    uniqueIndex("x402_l1_purchases_tx_unique")
      .on(t.network, sql`lower(${t.txHash})`)
      .where(sql`${t.txHash} IS NOT NULL`),
  ],
);

/**
 * health_snapshots — the /status page's only data source (B5, 2026-08-15).
 *
 * No cron writes this. Vercel Hobby silently breaks deploys once a cron goes
 * more frequent than once a day (measured 2026-07-29), so a "check every 5
 * minutes" cron was never an option here. Instead, a row is opportunistically
 * recorded (recordHealthSnapshotIfDue) from GET /api/health — the same
 * two-probe answer the public banner and uptime pollers read. Real traffic
 * and pollers supply the sampling interval instead of a scheduler. A snapshot
 * is written only when the status changed since the last row or the last row
 * is over 5 minutes old, so this stays a light table under normal traffic.
 *
 * A quiet page produces no snapshots. /status must read that honestly (as
 * "no observation in this window", never as an assumed "ok") — see
 * getStatusHistory in src/lib/health/snapshot.ts.
 */
export const healthSnapshots = pgTable(
  "health_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).defaultNow().notNull(),
    /** ok | degraded | error — the same three values runScoringProbe() returns. */
    status: text("status").notNull(),
  },
  (t) => [index("health_snapshots_checked_at_idx").on(t.checkedAt)],
);

/**
 * x402_daily_metrics — 公開メトリクスの日次ロールアップ（Phase 1.1 仕様§4）。
 *
 * /observatory/state と /api/v1/observatory/history が読む唯一の履歴ソース。
 * raw（x402_l0_probes / x402_l1_purchases）から rollupDailyMetrics() が
 * UTC日×チェーン単位で冪等にupsertする。rawから毎回集計しないのは、公開
 * ページのリクエスト毎に17k件×日数のスキャンを繰り返さないため。行は常に
 * rawから再導出可能（このテーブルは事実のキャッシュであって正本ではない）。
 */
/**
 * 製品定義書 §7.2 Settlement index（2026-09-02）。チェーン上の x402 関連決済を
 * Resource / Endpoint / Payee / Payer に帰属させる。3 経路が同じ形に落ちる:
 *   l1_purchase  我々の L1 購入（wash_flag は必ず test・§13 測定ウォレットは実需から除く）
 *   payments_api POST /payments/x402 で所有証明済みの行
 *   chain_index  既知 payTo への USDC Transfer をチェーンから読んだ行
 * 「実需」= wash_flag = 'none'。生値と実需は同じ行から両方出す。混ぜない。
 */
export const settlements = pgTable(
  "settlements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** CAIP-2 */
    chain: text("chain").notNull(),
    txHash: text("tx_hash").notNull(),
    /** chain:tx_hash（§5 purchase_id）。 */
    purchaseId: text("purchase_id").notNull(),
    asset: text("asset"),
    /** base units, decimal string */
    amount: text("amount"),
    payer: text("payer"),
    payee: text("payee"),
    payerId: text("payer_id"),
    payeeId: text("payee_id"),
    facilitator: text("facilitator"),
    observedAt: timestamp("observed_at", { withTimezone: true }).defaultNow().notNull(),
    blockTime: timestamp("block_time", { withTimezone: true }),
    /** confirmed | probable | unmatched */
    attribution: text("attribution").notNull().default("unmatched"),
    resourceId: text("resource_id"),
    endpointId: uuid("endpoint_id"),
    /** none | self_deal | circular | test */
    washFlag: text("wash_flag").notNull().default("none"),
    /** l1_purchase | payments_api | chain_index */
    source: text("source").notNull(),
    raw: jsonb("raw"),
  },
  (t) => [
    uniqueIndex("settlements_purchase_id_unique").on(t.purchaseId),
    index("settlements_payee_block_idx").on(t.payeeId, t.blockTime),
    index("settlements_payer_block_idx").on(t.payerId, t.blockTime),
    index("settlements_endpoint_idx").on(t.endpointId),
    index("settlements_wash_idx").on(t.washFlag),
    index("settlements_tx_hash_idx").on(t.txHash),
  ],
);

/**
 * 製品定義書 §7.4（2026-09-02）: /decision の問い合わせ回数（endpoint × UTC 日）。
 * 「問い合わせの多い URL」を C2 に昇格させる材料。単文 upsert で加算。
 */
export const decisionLookups = pgTable(
  "decision_lookups",
  {
    endpointId: uuid("endpoint_id").notNull(),
    /** UTC day, YYYY-MM-DD */
    day: text("day").notNull(),
    n: integer("n").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.endpointId, t.day] }), index("decision_lookups_day_idx").on(t.day)],
);

/**
 * 製品定義書 §10（2026-09-02）: 訂正ログ。公開判定が後から変わったとき before/after を残す。
 *   dispute_remeasure   売り手異議の再測定で公開判定が覆った
 *   settlement_backfill 照合バックフィルで L1 の状態が確定した（settled / refuted）
 *   reverify            C4 再検証で覆った
 * 自社に不利な変更も同じ表に残す。消さない。
 */
export const correctionLog = pgTable(
  "correction_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** endpoint | purchase */
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    /** l0 | l1 | l2 | listing */
    level: text("level").notNull(),
    before: jsonb("before").notNull(),
    after: jsonb("after").notNull(),
    reason: text("reason").notNull(),
    disputeId: uuid("dispute_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("correction_log_subject_idx").on(t.subjectType, t.subjectId, t.createdAt),
    index("correction_log_created_idx").on(t.createdAt),
  ],
);

export const x402DailyMetrics = pgTable(
  "x402_daily_metrics",
  {
    /** UTC day, YYYY-MM-DD. */
    day: text("day").notNull(),
    /** CAIP-2 network of the endpoint probed/purchased ("unknown" when the catalog row declares none). */
    chain: text("chain").notNull(),
    l0Probes: integer("l0_probes").notNull().default(0),
    l0Pass: integer("l0_pass").notNull().default(0),
    l1Attempts: integer("l1_attempts").notNull().default(0),
    l1Settled: integer("l1_settled").notNull().default(0),
    /** USDC base units spent that day on that chain (signed attempts). */
    spentUnits: text("spent_units").notNull().default("0"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.chain] }),
    index("x402_daily_metrics_day_idx").on(t.day),
  ],
);

/**
 * registry_writes — オンチェーン検証レジストリ書込の冪等台帳（Phase 1.3）。
 *
 * ERC-8004 Validation Registry への (endpoint, level, result) 公開の記録。
 * request_hash（正規化JSONのkeccak256）が一意キーで、同じ測定を二度
 * オンチェーンへ書かない。書込はフラグOFFが既定（REGISTRY_WRITES_ENABLED・
 * ガス代が動くため承認後にON）。status: pending | submitted | confirmed |
 * failed。オンチェーンが落ちても検証フロー本体は止めない（graceful）。
 */
export const registryWrites = pgTable(
  "registry_writes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestHash: text("request_hash").notNull(),
    endpointId: uuid("endpoint_id").notNull(),
    /** ERC-8004 agent id the payee resolves to (the registry speaks agentId). */
    agentId: text("agent_id").notNull(),
    level: text("level").notNull(),
    /** 0..100 per ERC-8004 (0 = failed, 100 = passed). */
    response: integer("response").notNull(),
    evidenceUri: text("evidence_uri"),
    status: text("status").notNull().default("pending"),
    txHash: text("tx_hash"),
    /**
     * 失敗の理由（全文・300字で切る）。2026-09-03: 8/21 以来 14 件が全部 failed だったのに
     * 理由がどこにも残らず、調査をやり直すはめになった。status だけでは「何で落ちたか」が
     * 誰にも分からない。成功時は null。
     */
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("registry_writes_request_hash_unique").on(t.requestHash),
    index("registry_writes_endpoint_idx").on(t.endpointId),
  ],
);

/**
 * probe_contributions — 外部コントリビュータのL0観測（Phase 3.3 v0・既定OFF）。
 *
 * v0 は「署名付きで受け取り、保存する」だけ。公開 verdict へは一切混ぜない
 * ——公開判定は自前プローブの publishedVerdict のみが正典で、外部観測が
 * 判定へ効き始めるのは重み付け・評判設計（v1）とその監査を経てから。
 * 受理ゲート: CONTRIBUTIONS_ENABLED・EIP-191署名の実検証・IPレート制限。
 */
export const probeContributions = pgTable(
  "probe_contributions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    endpointId: uuid("endpoint_id").notNull(),
    /** 署名者（EVMアドレス小文字）。v0の身元はこれだけ——ステーク/評判はv1。 */
    submitter: text("submitter").notNull(),
    verdict: text("verdict").notNull(),
    httpStatus: integer("http_status"),
    latencyMs: integer("latency_ms"),
    /** 署名対象の正規化メッセージ原文（監査可能性——何に署名したかを残す）。 */
    message: text("message").notNull(),
    signature: text("signature").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("probe_contributions_endpoint_idx").on(t.endpointId, t.createdAt),
    index("probe_contributions_submitter_idx").on(t.submitter),
  ],
);

/**
 * ledger_anchors — 日次台帳のハッシュチェーン（TEE設計 Stage 0 / DD用資産固定）。
 *
 * その日の全 paid-attempt 行と L0 日次集計を正規化JSONに直列化した sha256 を
 * root_hash とし、prev_root と連鎖させる。「この記録がこの時点で存在した」を
 * 第三者が末尾から検算できる——過去行の書換えは以後の全rootを壊す。
 * anchored_tx はオンチェーンへ刻んだ時のtx（ANCHOR_WRITES_ENABLED・既定OFF・
 * 資金承認後）。rootの再計算手順は /observatory/methodology に公開する。
 */
export const ledgerAnchors = pgTable(
  "ledger_anchors",
  {
    /** UTC day, YYYY-MM-DD. PK＝1日1root。 */
    day: text("day").primaryKey(),
    rootHash: text("root_hash").notNull(),
    prevRoot: text("prev_root"),
    entryCount: integer("entry_count").notNull(),
    anchoredTx: text("anchored_tx"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
);

/**
 * verification_requests — 公開検証リクエストキュー v0（無償枠）。
 * 誰でも「このエンドポイントを測って」を積める。日次cronが未消化分を
 * L0 の優先対象に注入する。支払い優先枠（x402課金＝自社ドッグフード）は
 * self-listing 計画と統合して後日——このテーブルは今からそれを保持できる
 * よう paid/payment_ref を持つが、v0 では常に free。
 */
export const verificationRequests = pgTable(
  "verification_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    endpointId: uuid("endpoint_id").notNull(),
    requesterIp: text("requester_ip"),
    tier: text("tier").notNull().default("free"),
    paymentRef: text("payment_ref"),
    /** pending | probed | invalid */
    status: text("status").notNull().default("pending"),
    probedAt: timestamp("probed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("verification_requests_status_idx").on(t.status, t.createdAt),
    index("verification_requests_endpoint_idx").on(t.endpointId),
  ],
);

/**
 * disputes — 売り手の署名付き異議（中立性の制度化）。
 * endpoint の payTo を握る者だけが「この測定は違う」を申し立てられる
 * （EIP-191。Solana payTo の Ed25519 対応は後続）。受理と同時に自動で
 * L0 を再測定し、結果は通常の公開ゲートを通る——**申し立てで記録が消える
 * ことはない**。訂正も、訂正しない判断も、同じ重みで公開される。
 */
export const disputes = pgTable(
  "disputes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    endpointId: uuid("endpoint_id").notNull(),
    /** 申し立ての対象（l0 | l1 | listing）。 */
    subject: text("subject").notNull(),
    reason: text("reason").notNull(),
    /** 署名者（= endpoint payTo と一致することを検証済み）。 */
    signer: text("signer").notNull(),
    message: text("message").notNull(),
    signature: text("signature").notNull(),
    /** open | remeasured | closed */
    status: text("status").notNull().default("open"),
    /** 再測定した probe の verdict（公開ゲート適用前の生値）。 */
    remeasureVerdict: text("remeasure_verdict"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("disputes_endpoint_idx").on(t.endpointId, t.createdAt)],
);

/**
 * waitlist_entries — 有償面（premium data / design partner）の意思表明の受け皿。
 * 課金は経済化設計書の関門（§5）を通るまで開始しない——ここは需要の実在を
 * 数えるためだけの保存で、メール送信もしない（外部送信は承認事項）。
 */
export const waitlistEntries = pgTable(
  "waitlist_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    /** premium_data | design_partner | other */
    interest: text("interest").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("waitlist_email_interest_unique").on(t.email, t.interest)],
);

/**
 * 段 2「名前を取る」（2026-09-02 敵対的監査 F6 / F7）。endpoint 記録頁で、判定変更の
 * 通知（kind=notify）と記録への異議（kind=dispute）の email を受け取る。
 * 同一 email × endpoint × kind は 1 行（upsert）。IP は sha256 の先頭 32 桁のみ。
 * `last_verdict` は登録時点の公開判定で、notify-subscribers cron が現在値と比べる。
 * SQL: scripts/sql/2026-09-02-record-subscriptions.sql
 */
export const recordSubscriptions = pgTable(
  "record_subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    endpointId: uuid("endpoint_id").notNull(),
    email: text("email").notNull(),
    /** notify | dispute */
    kind: text("kind").notNull(),
    /** dispute のみ必須（20〜2,000 字）。notify は null。 */
    reason: text("reason"),
    /** pass | fail | unverified — 登録（最終通知）時点の公開判定。 */
    lastVerdict: text("last_verdict").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    ipHash: text("ip_hash"),
  },
  (t) => [
    uniqueIndex("record_subscriptions_endpoint_email_kind_unique").on(t.endpointId, t.email, t.kind),
    index("record_subscriptions_kind_idx").on(t.kind),
  ],
);


/**
 * 2026-09-04 W15: `settlements` の日次集約。生行は直近 RAW_RETENTION_DAYS 日だけ残し、
 * それより古い UTC 日は「畳んで消す」——DELETE ... RETURNING を CTE に置いた
 * 単一文で移すので、1 件の決済が生行と集約の両方に載ることはない。
 * だからセンサスは「生行 ∪ 集約」を素直に足すだけでよく、cron がいつ走ったかに
 * 依存しない（未実行の日はまだ生行にある＝そのまま数えられる）。
 *
 * payer_id / payee_id / endpoint_id を鍵に持つのは、センサスの
 * count(DISTINCT payer_id) / unique payees / endpoints_with_real_settlement が
 * 集約からも**正確に**出るようにするため。集約は「行数を減らす」ためのもので、
 * 「答えを丸める」ためのものではない。
 *
 * 個々の tx_hash / raw jsonb は畳む時点で失われる（受領証は生行の窓の中だけ）。
 * SQL: scripts/sql/2026-09-04-w15.sql
 */
export const settlementDaily = pgTable(
  "settlement_daily",
  {
    /** UTC 日（coalesce(block_time, observed_at) の UTC 日付）。 */
    day: date("day", { mode: "string" }).notNull(),
    /** CAIP-2 */
    chain: text("chain").notNull(),
    payeeId: text("payee_id"),
    payerId: text("payer_id"),
    /** none | self_deal | circular | test */
    washFlag: text("wash_flag").notNull(),
    /** l1_purchase | payments_api | chain_index */
    source: text("source").notNull(),
    /** confirmed | probable | unmatched */
    attribution: text("attribution").notNull(),
    endpointId: uuid("endpoint_id"),
    resourceId: text("resource_id"),
    /** この鍵に畳まれた決済の件数。 */
    n: integer("n").notNull().default(0),
    /** base units の合計。数字でない amount は 0 として足す（畳む処理を落とさない）。 */
    amountSum: numeric("amount_sum").notNull().default("0"),
  },
  (t) => [
    // NULLS NOT DISTINCT: payee_id / endpoint_id / resource_id は NULL を取りうる。
    // 既定の NULL 相異では同じ鍵が重複行になり、畳み直しが冪等でなくなる。
    unique("settlement_daily_key")
      .on(t.day, t.chain, t.payeeId, t.payerId, t.washFlag, t.source, t.attribution, t.endpointId, t.resourceId)
      .nullsNotDistinct(),
    // day 単体の索引は置かない: settlement_daily_key の先頭列が day なので、
    // センサスの期間走査も保持期間の削除もその索引で足りる。
    // payer_id の索引も置かない（絞り込む問い合わせが無い）。集約表は
    // 1 日 2 千行積むので、使わない索引 1 本が数十 MB になる。
    index("settlement_daily_endpoint_day_idx").on(t.endpointId, t.day),
    index("settlement_daily_payee_day_idx").on(t.payeeId, t.day),
  ],
);
