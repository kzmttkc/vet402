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
  // Arc（Circle のステーブルコイン L1）。実測 2026-09-17（RPC）: mainnet 5042・testnet 5042002。
  "eip155:5042": "Arc",
  arc: "Arc",
  "eip155:5042002": "Arc Testnet",
  "arc-testnet": "Arc Testnet",
  // 2026-09-17: 4663 は Robinhood Chain（Arbitrum Orbit・本番網）。RPC の eth_chainId で実測
  // （https://rpc.mainnet.chain.robinhood.com → 0x1237、IoTeX https://babel-api.mainnet.iotex.io → 0x1251=4689）。
  // それまで "IoTeX" と誤表示していた（稼働中 822 件が 2 番目以降の accept で宣言）。
  "eip155:4663": "Robinhood Chain",
  "eip155:4689": "IoTeX",
  // Tempo（Stripe + Paradigm・MPP の決済チェーン、2026-09-17）。x402 の壁は無く、
  // vet402 は MPP 方言（mpp-payer.ts）で観測する。Moderato はテストネット。
  "eip155:4217": "Tempo",
  "eip155:42431": "Tempo Moderato",
  // 2026-09-17 XRPL レーン。CAIP-2 の xrpl 名前空間は NetworkID（mainnet 0 / testnet 1 / devnet 2）。
  // カタログには `xrpl:0`（1,636 件・2026-09-17 実測）と非標準の `xrpl:mainnet`（1 件）が居る。
  "xrpl:0": "XRPL",
  "xrpl:1": "XRPL Testnet",
  "xrpl:2": "XRPL Devnet",
  // 2026-09-29 監査 5 周目: 「Mainnets only」の L0 チェーン別表に eip155:11142220（Celo Sepolia・カタログに 1 件）が
  // 載っていた。未知の id は mainnet と見なされていた（isTestnet は既知のテストネット名だけを落とす）。
  // よく出る EVM テストネットを名前で持ち、下の isMainnet は「mainnet と分かっている id」だけを通す。
  "eip155:42220": "Celo",
  "eip155:11142220": "Celo Sepolia",
  "eip155:44787": "Celo Alfajores",
  "eip155:11155111": "Ethereum Sepolia",
  "eip155:17000": "Ethereum Holesky",
  "eip155:80002": "Polygon Amoy",
  "eip155:421614": "Arbitrum Sepolia",
  "eip155:11155420": "Optimism Sepolia",
  "eip155:10": "Optimism",
  "eip155:43114": "Avalanche",
  "eip155:43113": "Avalanche Fuji",
  "eip155:97": "BSC Testnet",
  "eip155:1952": "X Layer Testnet",
  "eip155:195": "X Layer Testnet",
};

/** XRPL mainnet の CAIP-2（NetworkID 0）。台帳・別枠・照合はこの完全一致だけを XRPL と扱う（2026-09-17 レビュー #1）。 */
export const XRPL_MAINNET_CAIP2 = "xrpl:0";

/** Solana genesis hashes (case-sensitive base58) — lower-casing would corrupt them, so match separately. */
const SOLANA_MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

/**
 * 2026-09-02 監査 A3: /observatory/state「Mainnets only」に Solana devnet の active 33 件が
 * 混ざっていた（TESTNET_LABELS が Base Sepolia だけ）。devnet はテストネット。
 */
const TESTNET_LABELS = new Set([
  "Base Sepolia",
  "Solana Devnet",
  "Arc Testnet",
  "Tempo Moderato",
  "XRPL Testnet",
  "XRPL Devnet",
  "Celo Sepolia",
  "Celo Alfajores",
  "Ethereum Sepolia",
  "Ethereum Holesky",
  "Polygon Amoy",
  "Arbitrum Sepolia",
  "Optimism Sepolia",
  "Avalanche Fuji",
  "BSC Testnet",
  "X Layer Testnet",
  "Algorand Testnet",
]);

/**
 * Algorand の genesis hash（CAIP-2 の reference・大文字小文字と記号を区別する）。
 * ラベルは既存どおり `Algorand (<id>)` のまま（公開面の表記を変えない）で、mainnet かどうかだけをここで決める。
 */
const ALGORAND_MAINNET = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const ALGORAND_TESTNET = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";

/** Human label for a raw CAIP-2 / legacy network identifier. Never guesses — unknown ids pass through verbatim so nothing is silently mislabeled. */
export function chainLabel(network: unknown): string {
  if (typeof network !== "string" || network === "") return "unknown";
  if (network === `solana:${SOLANA_MAINNET_GENESIS}`) return "Solana";
  if (network === `solana:${SOLANA_DEVNET_GENESIS}`) return "Solana Devnet";
  const key = network.toLowerCase();
  if (key === "solana-devnet") return "Solana Devnet";
  if (KNOWN[key]) return KNOWN[key];
  if (network === ALGORAND_TESTNET) return "Algorand Testnet";
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
  if (key === "arc") return "eip155:5042";
  if (key === "arc-testnet") return "eip155:5042002";
  if (key === "solana" || key === "solana-mainnet") return `solana:${SOLANA_MAINNET_GENESIS}`;
  if (key === "solana-devnet") return `solana:${SOLANA_DEVNET_GENESIS}`;
  // XRPL（2026-09-17）: 壁が `xrpl` / `xrpl:mainnet` と書く非標準表記を mainnet の CAIP-2 に寄せる。
  if (key === "xrpl" || key === "xrpl:mainnet") return "xrpl:0";
  return network;
}

/**
 * Public name for a chain. `chainLabel()` stays the join key (JSON `chain`,
 * `isMainnet`, L0/L1 grouping). Screens, `l1.byChain[].label`, and generated
 * public sentences use this function and no other list of names.
 *
 * Named chains: Base, Solana, Tempo, XRPL, Celo, Arc, Stellar, BNB Chain,
 * Arbitrum One. Any other id falls through to `chainLabel()` so an unknown
 * chain is not given a name it does not have.
 */
const PUBLIC_CHAIN_LABELS: Record<string, string> = {
  Base: "Base",
  "eip155:8453": "Base",
  base: "Base",
  Solana: "Solana",
  [`solana:${SOLANA_MAINNET_GENESIS}`]: "Solana",
  solana: "Solana",
  "solana-mainnet": "Solana",
  Tempo: "Tempo",
  "eip155:4217": "Tempo",
  tempo: "Tempo",
  XRPL: "XRPL",
  "xrpl:0": "XRPL",
  xrpl: "XRPL",
  "xrpl:mainnet": "XRPL",
  Celo: "Celo",
  "eip155:42220": "Celo",
  celo: "Celo",
  Arc: "Arc",
  "eip155:5042": "Arc",
  arc: "Arc",
  "stellar:pubnet": "Stellar",
  stellar: "Stellar",
  Stellar: "Stellar",
  BSC: "BNB Chain",
  "eip155:56": "BNB Chain",
  bsc: "BNB Chain",
  bnb: "BNB Chain",
  "BNB Chain": "BNB Chain",
  Arbitrum: "Arbitrum One",
  "eip155:42161": "Arbitrum One",
  arbitrum: "Arbitrum One",
  "Arbitrum One": "Arbitrum One",
};

/** Canonical CAIP-2 for each public name. One id per chain, not the alias that happened to arrive first. */
const PUBLIC_CHAIN_NETWORKS: Record<string, string> = {
  Base: "eip155:8453",
  Solana: `solana:${SOLANA_MAINNET_GENESIS}`,
  Tempo: "eip155:4217",
  XRPL: "xrpl:0",
  Celo: "eip155:42220",
  Arc: "eip155:5042",
  Stellar: "stellar:pubnet",
  "BNB Chain": "eip155:56",
  "Arbitrum One": "eip155:42161",
};

/** Public name. Accepts a CAIP-2 id, a legacy slug, or a `chainLabel()` key such as `BSC`. */
export function publicChainLabel(networkOrChain: unknown): string {
  if (typeof networkOrChain !== "string" || networkOrChain === "") return chainLabel(networkOrChain);
  if (PUBLIC_CHAIN_LABELS[networkOrChain]) return PUBLIC_CHAIN_LABELS[networkOrChain];
  const lower = networkOrChain.toLowerCase();
  if (PUBLIC_CHAIN_LABELS[lower]) return PUBLIC_CHAIN_LABELS[lower];
  const caip = toCaip2(networkOrChain);
  if (caip && PUBLIC_CHAIN_LABELS[caip]) return PUBLIC_CHAIN_LABELS[caip];
  const joined = chainLabel(caip ?? networkOrChain);
  if (PUBLIC_CHAIN_LABELS[joined]) return PUBLIC_CHAIN_LABELS[joined];
  return joined;
}

/**
 * Canonical CAIP-2 for a chain key or a raw network id.
 * Unknown ids that already look like CAIP-2 pass through. A name with no id returns null.
 */
export function chainNetwork(networkOrChain: unknown): string | null {
  if (typeof networkOrChain !== "string" || networkOrChain === "") return null;
  const label = publicChainLabel(networkOrChain);
  if (PUBLIC_CHAIN_NETWORKS[label]) return PUBLIC_CHAIN_NETWORKS[label];
  for (const [k, v] of Object.entries(KNOWN)) {
    if (v === label && k.includes(":")) return k;
  }
  if (label === "Solana") return `solana:${SOLANA_MAINNET_GENESIS}`;
  if (label === "Solana Devnet") return `solana:${SOLANA_DEVNET_GENESIS}`;
  const caip = toCaip2(networkOrChain);
  if (typeof caip === "string" && caip.includes(":")) return caip;
  if (networkOrChain.includes(":")) return networkOrChain;
  return null;
}

/** `l1.byChain` / L0 `byChain` identity. `chain` is the join key and does not change. */
export function chainIdentity(chain: string): { chain: string; label: string; network: string } {
  return {
    chain,
    label: publicChainLabel(chain),
    network: chainNetwork(chain) ?? chain,
  };
}

export function isTestnet(network: unknown): boolean {
  return TESTNET_LABELS.has(chainLabel(network));
}

/**
 * mainnet と**分かっている** id か（2026-09-29 監査 5 周目）。「Mainnets only」の表（L0 の byChain）はこれで絞る。
 * isTestnet の否定では足りない: 名前を持たない id（例 eip155:11142220 を名前で持つ前）はテストネットとも
 * 言えないので mainnet の表に入っていた。ここでは、名前を持つ mainnet（KNOWN の値のうちテストネットでないもの・
 * Solana mainnet・XRPL mainnet）と Algorand mainnet の genesis だけを mainnet とし、それ以外（未知の id）は落とす。
 * 落とした件数は state API の byChainUnclassified に出す（黙って消さない）。
 */
export function isMainnet(network: unknown): boolean {
  if (typeof network !== "string" || network === "") return false;
  if (network === ALGORAND_MAINNET) return true;
  const label = chainLabel(network);
  if (TESTNET_LABELS.has(label)) return false;
  if (label === "Solana") return true;
  return MAINNET_LABELS.has(label);
}

const MAINNET_LABELS = new Set(Object.values(KNOWN).filter((l) => !TESTNET_LABELS.has(l)));

// ------------------------------------------------------------
// 受領証（tx）へのリンク。2026-09-02 敵対的監査: /decisions・/impact に受領証リンクが
// なく、endpoint 頁は basescan 固定で Solana の tx が壊れたリンクになっていた。
// 行き先はチェーンで決まり、形が合わない tx には URL を作らない（壊れたリンクを
// 出すより「—」の方が正直）。
// ------------------------------------------------------------
const EVM_TX_RE = /^0x[0-9a-fA-F]{64}$/;
/** Solana signature: base58, 64 bytes → 86–88 chars. */
const SOLANA_TX_RE = /^[1-9A-HJ-NP-Za-km-z]{86,88}$/;
/** XRPL transaction hash: 32 bytes as bare hex（0x 無し・慣例は大文字）。 */
const XRPL_TX_RE = /^[0-9A-Fa-f]{64}$/;
/** Stellar transaction hash: 32 bytes as bare hex（0x 無し）。 */
const STELLAR_TX_RE = /^[0-9A-Fa-f]{64}$/;

const EVM_EXPLORERS: Record<string, string> = {
  Base: "https://basescan.org/tx/",
  Polygon: "https://polygonscan.com/tx/",
  // 2026-09-17 Arc レーン。testnet の explorer は確かめていないので載せない（壊れたリンクより「—」）。
  Arc: "https://explorer.arc.io/tx/",
  Tempo: "https://explore.tempo.xyz/tx/",
  // 2026-10-10 Celo レーン。mainnet（eip155:42220）だけ——ラベル "Celo Sepolia" / "Celo Alfajores" はここに無いので
  // テストネットの tx にはリンクを作らない（Arc と同じ: 壊れたリンクより「—」）。
  Celo: "https://celoscan.io/tx/",
  // 2026-10-21: BSC mainnet（eip155:56）。chainLabel は "BSC"。"BSC Testnet"（eip155:97）はここに無いので
  // テストネットの tx にはリンクを作らない。
  BSC: "https://bscscan.com/tx/",
  // 2026-10-22 Arbitrum レーン。mainnet（eip155:42161）だけ——ラベル "Arbitrum Sepolia" はここに無いので
  // テストネットの tx にはリンクを作らない（Celo と同じ: 壊れたリンクより「—」）。
  Arbitrum: "https://arbiscan.io/tx/",
};

/**
 * Network a receipt link should name. The purchase row's network is the chain
 * that was paid. Null falls back to the catalog network.
 */
export function receiptNetwork(paid: string | null | undefined, catalog: string | null | undefined): string | null {
  // 空文字は欠落と同じ（metrics-rollup.ts の nullif(pu.network, '') と揃える。点検 低3）。
  const p = typeof paid === "string" && paid !== "" ? paid : null;
  const c = typeof catalog === "string" && catalog !== "" ? catalog : null;
  return p ?? c ?? null;
}

/** 購入表の「Payment chain」列の公開名。正は publicChainLabel。chainLabel の結合キーは変えない。 */
export function paymentChainLabel(network: string): string {
  return publicChainLabel(network);
}

/**
 * 名前・短い id・CAIP を、観測所の network 絞り込みが同じ鎖として扱うための綴り。
 * chainLabel の戻り値は変えない（isMainnet と l1.byChain の鍵を動かさない）。
 * "bnb" / "bsc" は eip155:56、"stellar" は stellar:pubnet。テストネットは別の鍵のまま。
 */
const FILTER_ALIAS_TO_CANONICAL: Record<string, string> = {
  bnb: "eip155:56",
  bsc: "eip155:56",
  stellar: "stellar:pubnet",
  celo: "eip155:42220",
  ethereum: "eip155:1",
  arbitrum: "eip155:42161",
  optimism: "eip155:10",
  avalanche: "eip155:43114",
  tempo: "eip155:4217",
};

const NETWORK_FILTER_SPELLINGS: readonly string[] = [
  ...Object.keys(KNOWN),
  `solana:${SOLANA_MAINNET_GENESIS}`,
  `solana:${SOLANA_DEVNET_GENESIS}`,
  "solana",
  "solana-mainnet",
  "solana-devnet",
  "stellar:pubnet",
  "stellar",
  "bnb",
  "bsc",
  "celo",
  "polygon",
  "xrpl",
  "xrpl:mainnet",
  "ethereum",
  "arbitrum",
  "optimism",
  "avalanche",
  "tempo",
];

function canonicalNetworkId(raw: string): string {
  const trimmed = raw.trim();
  const alias = FILTER_ALIAS_TO_CANONICAL[trimmed.toLowerCase()];
  if (alias) return alias;
  return toCaip2(trimmed) ?? trimmed;
}

function networkGroupKey(raw: string): string {
  return paymentChainLabel(canonicalNetworkId(raw)).toLowerCase();
}

/**
 * Network 列の title。絞り込みの鎖がカタログの network と違う行は、購入の network で入ったと書く。
 * カタログの network が絞り込みに入る行は、今までどおり台帳の id を title にする。
 */
export function networkFilterCellTitle(catalogNetwork: string | null, filter: string | null): string | undefined {
  if (!filter) return catalogNetwork ?? undefined;
  const catalogHit =
    !!catalogNetwork && networkFilterIds(filter).some((id) => id.toLowerCase() === catalogNetwork.toLowerCase());
  if (catalogHit) return catalogNetwork ?? undefined;
  const catalog = catalogNetwork ? ` Catalog network: ${catalogNetwork}.` : "";
  return `In this filter because a purchase network matched.${catalog}`;
}

/**
 * Network 列の見える語。公開名は publicChainLabel。台帳の id は title（networkFilterCellTitle）に残す。
 */
export function networkFilterCellLabel(catalogNetwork: string | null, filter: string | null): string {
  if (filter) {
    const catalogHit =
      !!catalogNetwork && networkFilterIds(filter).some((id) => id.toLowerCase() === catalogNetwork.toLowerCase());
    if (!catalogHit) return paymentChainLabel(canonicalNetworkId(filter));
  }
  return catalogNetwork ? publicChainLabel(catalogNetwork) : "—";
}

/** 絞り込みの入力と同じ鎖を指す、台帳に現れうる network 文字列。未知の id はそれ自身だけ。 */
export function networkFilterIds(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const key = networkGroupKey(trimmed);
  const out = new Set<string>();
  for (const spelling of NETWORK_FILTER_SPELLINGS) {
    if (networkGroupKey(spelling) === key) {
      out.add(spelling);
      out.add(canonicalNetworkId(spelling));
    }
  }
  out.add(canonicalNetworkId(trimmed));
  if (!/\s/.test(trimmed)) out.add(trimmed);
  return [...out].sort();
}

/** Block-explorer URL for a settlement tx on the given network, or null when the chain has no explorer here or the tx is not well-formed for it. */
export function explorerTxUrl(network: unknown, tx: unknown): string | null {
  if (typeof tx !== "string" || tx === "") return null;
  // "polygon" などの v1 スラグは KNOWN に無いので、先に CAIP-2 へ寄せてからラベルを引く。
  const caip = toCaip2(network);
  const label = chainLabel(caip);
  if (label === "Solana") {
    return SOLANA_TX_RE.test(tx) ? `https://solscan.io/tx/${tx}` : null;
  }
  if (label === "XRPL") {
    return XRPL_TX_RE.test(tx) ? `https://livenet.xrpl.org/transactions/${tx}` : null;
  }
  // stellar:pubnet は chainLabel が id をそのまま返す。KNOWN に "Stellar" を足すと
  // isMainnet と L0/L1 の公開集計の鍵まで動くので、リンクだけ id の完全一致で作る。
  // stellar:testnet などは一致しない（壊れたリンクより「—」）。
  if (caip === "stellar:pubnet") {
    return STELLAR_TX_RE.test(tx) ? `https://stellar.expert/explorer/public/tx/${tx}` : null;
  }
  const base = EVM_EXPLORERS[label];
  if (!base) return null;
  return EVM_TX_RE.test(tx) ? `${base}${tx}` : null;
}
