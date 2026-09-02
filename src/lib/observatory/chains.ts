// ============================================================
// vet402 Observatory L0 — chain identity normalization.
//
// The catalog's raw `network` field is inconsistent: Bazaar items declare
// the SAME chain both as its CAIP-2 id ("eip155:8453") and a legacy slug
// ("base") — verified live 2026-08-14 (14,296 vs 455 rows for the identical
// chain). Every consumer that needs a per-chain COUNT must go through
// chainLabel() or it silently undercounts the chain with the split identity.
// ============================================================

const KNOWN: Record<string, string> = {
  "eip155:1": "Ethereum",
  "eip155:8453": "Base",
  base: "Base",
  "eip155:84532": "Base Sepolia",
  "base-sepolia": "Base Sepolia",
  "eip155:56": "BSC",
  "eip155:42161": "Arbitrum",
  "eip155:137": "Polygon",
  "eip155:196": "X Layer",
  "eip155:4663": "IoTeX",
};

/** Solana genesis hashes (case-sensitive base58) — lower-casing would corrupt them, so match separately. */
const SOLANA_MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

/**
 * 2026-09-02 監査 A3: /observatory/state「Mainnets only」に Solana devnet の active 33 件が
 * 混ざっていた（TESTNET_LABELS が Base Sepolia だけ）。devnet はテストネット。
 */
const TESTNET_LABELS = new Set(["Base Sepolia", "Solana Devnet"]);

/** Human label for a raw CAIP-2 / legacy network identifier. Never guesses — unknown ids pass through verbatim so nothing is silently mislabeled. */
export function chainLabel(network: unknown): string {
  if (typeof network !== "string" || network === "") return "unknown";
  if (network === `solana:${SOLANA_MAINNET_GENESIS}`) return "Solana";
  if (network === `solana:${SOLANA_DEVNET_GENESIS}`) return "Solana Devnet";
  const key = network.toLowerCase();
  if (key === "solana-devnet") return "Solana Devnet";
  if (KNOWN[key]) return KNOWN[key];
  if (key.startsWith("algorand:")) return `Algorand (${network})`;
  return network;
}

/**
 * カタログ・封筒双方に残る v1 スラグを CAIP-2 に寄せる（§5「方言差は観測属性に
 * 持つ」——ネットワークの同一性は表記で変わらない）。未知の値はそのまま返す。
 */
export function toCaip2(network: unknown): string | null {
  if (typeof network !== "string" || network === "") return null;
  const key = network.toLowerCase();
  if (key === "base") return "eip155:8453";
  if (key === "base-sepolia") return "eip155:84532";
  if (key === "polygon") return "eip155:137";
  if (key === "solana" || key === "solana-mainnet") return `solana:${SOLANA_MAINNET_GENESIS}`;
  if (key === "solana-devnet") return `solana:${SOLANA_DEVNET_GENESIS}`;
  return network;
}

export function isTestnet(network: unknown): boolean {
  return TESTNET_LABELS.has(chainLabel(network));
}

// ------------------------------------------------------------
// 受領証（tx）へのリンク。2026-09-02 敵対的監査: /decisions・/impact に受領証リンクが
// なく、endpoint 頁は basescan 固定で Solana の tx が壊れたリンクになっていた。
// 行き先はチェーンで決まり、形が合わない tx には URL を作らない（壊れたリンクを
// 出すより「—」の方が正直）。
// ------------------------------------------------------------
const EVM_TX_RE = /^0x[0-9a-fA-F]{64}$/;
/** Solana signature: base58, 64 bytes → 86–88 chars. */
const SOLANA_TX_RE = /^[1-9A-HJ-NP-Za-km-z]{86,88}$/;

const EVM_EXPLORERS: Record<string, string> = {
  Base: "https://basescan.org/tx/",
  Polygon: "https://polygonscan.com/tx/",
};

/** Block-explorer URL for a settlement tx on the given network, or null when the chain has no explorer here or the tx is not well-formed for it. */
export function explorerTxUrl(network: unknown, tx: unknown): string | null {
  if (typeof tx !== "string" || tx === "") return null;
  // "polygon" などの v1 スラグは KNOWN に無いので、先に CAIP-2 へ寄せてからラベルを引く。
  const label = chainLabel(toCaip2(network));
  if (label === "Solana") {
    return SOLANA_TX_RE.test(tx) ? `https://solscan.io/tx/${tx}` : null;
  }
  const base = EVM_EXPLORERS[label];
  if (!base) return null;
  return EVM_TX_RE.test(tx) ? `${base}${tx}` : null;
}
