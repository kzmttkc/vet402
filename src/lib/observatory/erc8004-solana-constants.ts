// 8004-solana mainnet (QuantuLabs). Base58 addresses must keep exact case in joins and display.
export const ERC8004_SOLANA_CAIP = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const;

/** erc8004_chain_agents.chain_id for Solana (not an EIP-155 id). */
export const ERC8004_SOLANA_DB_CHAIN_ID = 8_004_501;

export const ERC8004_SOLANA_INDEXER_ORIGIN = "https://8004-indexer-main.qnt.sh";

export const ERC8004_SOLANA_PROGRAM_ID = "8oo4dC4JvBLwy5tGgiH3WwK4B9PWxL9Z4XjA2jzkQMbQ";

export const ERC8004_SOLANA_AGENTS_PATH = "/rest/v1/agents";

export const ERC8004_SOLANA_STATS_PATH = "/rest/v1/stats";

export const ERC8004_SOLANA_PAGE_PATH = "/8004-solana" as const;

export const ERC8004_SOLANA_INDEX_SCOPE = `identity_registry:${ERC8004_SOLANA_CAIP}` as const;

/** x402Support=true count from the indexer (refreshed by the Solana index job). */
export const ERC8004_SOLANA_X402_SCOPE = "erc8004_solana:x402_declared" as const;

export const ERC8004_SOLANA_INDEX_PAGE_LIMIT = 500;

export const ERC8004_SOLANA_INDEX_MIN_INTERVAL_MS = 1_000;