// ============================================================
// vet402 Observatory L0 — per-chain breakdown (design: first-mover claim
// for chain-foundation grant outreach, 2026-08-14).
//
// L0 has always been chain-agnostic and $0; the catalog's raw `network`
// field is inconsistent (Bazaar items declare both "eip155:8453" and the
// legacy "base" slug for the SAME chain — verified live, 14296 vs 455 rows).
// chainLabel() is the single normalization point so a grant-outreach page
// counting "Base" doesn't undercount by missing the alias.
// ============================================================
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chainLabel, isMainnet, isTestnet, networkFilterCellLabel, networkFilterCellTitle, networkFilterIds } from "@/lib/observatory/chains";

test("chainLabel collapses known CAIP-2 / legacy-slug aliases to one name", () => {
  assert.equal(chainLabel("eip155:8453"), "Base");
  assert.equal(chainLabel("base"), "Base");
  assert.equal(chainLabel("eip155:1"), "Ethereum");
  assert.equal(chainLabel("eip155:56"), "BSC");
  assert.equal(chainLabel("eip155:42161"), "Arbitrum");
  assert.equal(chainLabel("eip155:196"), "X Layer");
  assert.equal(chainLabel("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"), "Solana");
  assert.match(chainLabel("algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8="), /^Algorand/);
});

test("chainLabel returns the raw identifier verbatim for anything unrecognized (never invents a name)", () => {
  assert.equal(chainLabel("eip155:999999"), "eip155:999999");
  assert.equal(chainLabel(""), "unknown");
  assert.equal(chainLabel(null), "unknown");
});

test("isTestnet flags known testnets so grant pitches can exclude them", () => {
  assert.equal(isTestnet("eip155:84532"), true); // Base Sepolia
  assert.equal(isTestnet("base-sepolia"), true);
  assert.equal(isTestnet("eip155:8453"), false); // Base mainnet
  assert.equal(isTestnet("base"), false);
  assert.equal(isTestnet("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"), false);
});

// ---- reader integration ----------------------------------------------------

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("observatory chain stats (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = TEST_DB;

  test("getObservatoryStatsByChain groups aliased networks into one row and excludes testnets", async () => {
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { getObservatoryStatsByChain } = await import("@/lib/observatory/reader");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");

    const db = getDb()!;
    await db.execute(
      sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_l1_purchases`,
    );

    const mk = (n: number, network: string) =>
      parseCatalogItem({
        resource: `https://svc${n}.example/api`,
        accepts: [{ amount: "1000", asset: "0xUSDC", network, payTo: `0xPAY${n}` }],
        extensions: { bazaar: { info: { input: { method: "GET" } } } },
      });
    await syncCatalog({
      fetchResult: {
        items: [
          mk(1, "eip155:8453"), // Base (CAIP-2)
          mk(2, "base"), // Base (legacy slug) — must collapse with #1
          mk(3, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"), // Solana
          mk(4, "eip155:84532"), // Base Sepolia — testnet, excluded by default
          mk(5, "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"), // Solana Devnet — testnet (2026-09-02 A3)
        ],
        totalCount: 5,
        fetchedCount: 5,
        complete: true,
      },
      today: "2026-08-14",
    });

    const stats = await getObservatoryStatsByChain();
    const base = stats.find((c) => c.chain === "Base")!;
    assert.equal(base.totalEndpoints, 2, "eip155:8453 and base must collapse into one row");
    const solana = stats.find((c) => c.chain === "Solana")!;
    assert.equal(solana.totalEndpoints, 1, "devnet must not be folded into Solana mainnet");
    assert.equal(stats.some((c) => c.chain === "Solana Devnet"), false, "mainnet-only view excludes Solana devnet");
    assert.equal(
      stats.some((c) => c.chain.includes("Sepolia") || c.chain.includes("Testnet")),
      false,
      "mainnet-only view excludes testnets by default",
    );
    // Sorted by volume, largest first.
    assert.equal(stats[0].chain, "Base");
  });

  test("getObservatoryStatsByChain(includeTestnets:true) surfaces testnets separately", async () => {
    const { getObservatoryStatsByChain } = await import("@/lib/observatory/reader");
    const stats = await getObservatoryStatsByChain({ includeTestnets: true });
    assert.ok(stats.some((c) => /Sepolia/.test(c.chain)));
    assert.ok(stats.some((c) => c.chain === "Solana Devnet"));
  });
}

// ---- 2026-09-02 監査 A3: Solana devnet はテストネット ----------------------

test("Solana devnet is labeled and treated as a testnet (excluded from mainnet-only views)", () => {
  assert.equal(chainLabel("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"), "Solana Devnet");
  assert.equal(isTestnet("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"), true);
  assert.equal(isTestnet("solana-devnet"), true);
  assert.equal(chainLabel("solana-devnet"), "Solana Devnet");
  // Mainnet stays mainnet; the genesis hash is case-sensitive base58.
  assert.equal(isTestnet("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"), false);
  assert.equal(chainLabel("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"), "Solana");
});

test("chainLabel normalizes the raw legacy slug `base` (any case) to Base", () => {
  assert.equal(chainLabel("base"), "Base");
  assert.equal(chainLabel("BASE"), "Base");
  assert.equal(chainLabel("Base"), "Base");
  assert.equal(chainLabel("eip155:8453"), "Base");
});

// ---- Arc（Circle のステーブルコイン L1・メインネット公開 2026-09-16）— 2026-09-17 Arc レーン ----
// 実測 2026-09-17（RPC）: mainnet eip155:5042 / testnet eip155:5042002。

test("chainLabel: Arc mainnet and testnet resolve to their names; toCaip2 accepts the 'arc' slug", async () => {
  const { toCaip2, explorerTxUrl } = await import("@/lib/observatory/chains");
  assert.equal(chainLabel("eip155:5042"), "Arc");
  assert.equal(chainLabel("eip155:5042002"), "Arc Testnet");
  assert.equal(toCaip2("arc"), "eip155:5042");
  assert.equal(toCaip2("ARC"), "eip155:5042");
  assert.equal(toCaip2("arc-testnet"), "eip155:5042002");
  assert.equal(toCaip2("eip155:5042"), "eip155:5042", "CAIP-2 passes through");
  assert.equal(isTestnet("eip155:5042002"), true, "Arc testnet is excluded from mainnet-only views");
  assert.equal(isTestnet("eip155:5042"), false);
  assert.equal(explorerTxUrl("eip155:5042", `0x${"ab".repeat(32)}`), `https://explorer.arc.io/tx/0x${"ab".repeat(32)}`);
});

test("eip155:4663 is Robinhood Chain (measured eth_chainId 0x1237); IoTeX is 4689 (0x1251)", () => {
  assert.equal(chainLabel("eip155:4663"), "Robinhood Chain");
  assert.equal(chainLabel("eip155:4689"), "IoTeX");
});

// ---- Tempo（MPP・2026-09-17）----------------------------------------------
test("Tempo mainnet / Moderato are recognized by CAIP-2 id; Moderato is a testnet", async () => {
  const { explorerTxUrl } = await import("@/lib/observatory/chains");
  assert.equal(chainLabel("eip155:4217"), "Tempo");
  assert.equal(chainLabel("eip155:42431"), "Tempo Moderato");
  assert.equal(isTestnet("eip155:4217"), false);
  assert.equal(isTestnet("eip155:42431"), true);
  const tx = `0x${"ab".repeat(32)}`;
  assert.equal(explorerTxUrl("eip155:4217", tx), `https://explore.tempo.xyz/tx/${tx}`);
  assert.equal(explorerTxUrl("eip155:4217", "not-a-hash"), null);
  // テストネットの受領証リンクは作らない（探索器の URL を持たない）。
  assert.equal(explorerTxUrl("eip155:42431", tx), null);
});

// 2026-10-21: stellar:pubnet を KNOWN の "Stellar" にすると isMainnet が true になり、
// L0 の mainnet 表と l1.byChain の鍵が動く。リンクは explorerTxUrl が id の完全一致で作る。
test("stellar:pubnet stays unlabeled so the mainnet census does not move", () => {
  assert.equal(chainLabel("stellar:pubnet"), "stellar:pubnet");
  assert.equal(chainLabel("stellar:testnet"), "stellar:testnet");
  assert.equal(isMainnet("stellar:pubnet"), false);
  assert.equal(isTestnet("stellar:pubnet"), false);
  assert.equal(isTestnet("stellar:testnet"), false);
});

function includesAll(ids: readonly string[], want: readonly string[], label: string) {
  for (const w of want) assert.ok(ids.includes(w), `${label}: ${w} missing from ${ids.join(",")}`);
}

test("networkFilterIds treats a name, a short id, and a CAIP id as one chain", () => {
  const solana = networkFilterIds("Solana");
  includesAll(solana, ["solana", "solana-mainnet", `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`], "Solana");
  includesAll(networkFilterIds("solana"), ["solana", "solana-mainnet", `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`], "solana");
  assert.equal(solana.includes("solana-devnet"), false);
  assert.equal(solana.includes("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"), false);

  const stellar = networkFilterIds("Stellar");
  includesAll(stellar, ["stellar", "stellar:pubnet"], "Stellar");
  includesAll(networkFilterIds("stellar:pubnet"), ["stellar", "stellar:pubnet"], "stellar:pubnet");
  assert.equal(stellar.includes("stellar:testnet"), false);

  const bnb = networkFilterIds("BNB");
  includesAll(bnb, ["bnb", "bsc", "eip155:56"], "BNB");
  includesAll(networkFilterIds("bsc"), ["bnb", "bsc", "eip155:56"], "bsc");
  includesAll(networkFilterIds("eip155:56"), ["bnb", "bsc", "eip155:56"], "eip155:56");
  assert.equal(bnb.includes("eip155:97"), false);

  const base = networkFilterIds("base");
  includesAll(base, ["base", "eip155:8453"], "base");
  assert.equal(base.includes("base-sepolia"), false);
  assert.equal(base.includes("eip155:84532"), false);

  const celo = networkFilterIds("celo");
  assert.equal(celo.includes("eip155:42220"), true);
  assert.equal(celo.includes("eip155:11142220"), false);
  assert.equal(networkFilterIds("eip155:11142220").includes("eip155:42220"), false);

  assert.deepEqual(networkFilterIds("eip155:999999"), ["eip155:999999"]);
  assert.deepEqual(networkFilterIds("  "), []);
});

test("networkFilterCellTitle: カタログの鎖が絞り込みの外なら、購入の network で入ったと書く", () => {
  assert.equal(
    networkFilterCellTitle("eip155:8453", "Stellar"),
    "In this filter because a purchase network matched. Catalog network: eip155:8453.",
  );
  assert.equal(networkFilterCellTitle("eip155:8453", null), "eip155:8453");
  assert.equal(networkFilterCellTitle("stellar:pubnet", "Stellar"), "stellar:pubnet");
  assert.equal(networkFilterCellTitle("eip155:8453", "base"), "eip155:8453");
  assert.equal(networkFilterCellTitle(null, "Stellar"), "In this filter because a purchase network matched.");
});

test("networkFilterCellLabel: カタログの鎖が絞り込みの外なら、セルは絞り込みの公開名", () => {
  assert.equal(networkFilterCellLabel("eip155:8453", "Stellar"), "Stellar");
  assert.equal(networkFilterCellLabel("eip155:8453", null), "Base");
  assert.equal(networkFilterCellLabel("stellar:pubnet", "Stellar"), "stellar:pubnet");
  assert.equal(networkFilterCellLabel("eip155:8453", "base"), "Base");
  assert.equal(networkFilterCellLabel(null, "Stellar"), "Stellar");
  assert.equal(networkFilterCellLabel(null, null), "—");
});

test("getObservatoryOverview の絞り込み SQL は購入 network と L0 の n_pass を残す", () => {
  const src = readFileSync("src/lib/observatory/reader.ts", "utf8");
  const start = src.indexOf("export async function getObservatoryOverview");
  const end = src.indexOf("export const PAID_ATTEMPT_STATUSES", start);
  assert.ok(start >= 0 && end > start);
  const slice = src.slice(start, end);
  assert.match(slice, /pn\.network IN/);
  assert.match(slice, /p\.network IN/);
  assert.match(slice, /n_pass/);
  assert.match(slice, /n_fail/);
  assert.match(slice, /n_unverified/);
  assert.doesNotMatch(slice, /e\.network = \$\{network\}/);
  const countStart = slice.indexOf("const countRaw");
  const rowStart = slice.indexOf("const raw = await db.execute", countStart);
  assert.ok(countStart >= 0 && rowStart > countStart);
  const countSql = slice.slice(countStart, rowStart);
  assert.match(countSql, /\$\{scopeFilters\}/);
  assert.doesNotMatch(countSql, /tableVerdict/);
  assert.match(countSql, /count\(\*\) FILTER \(WHERE \$\{verdictCase\} = 'pass'\)/);
  const rowSql = slice.slice(rowStart, slice.indexOf("const list", rowStart));
  assert.match(rowSql, /\$\{scopeFilters\}/);
  assert.match(rowSql, /\$\{tableVerdict\}/);
});

test("観測所の絞り込み文は合格率を L0 の探査だと書き、Network 列は title 関数を使う", () => {
  const src = readFileSync("src/app/observatory/page.tsx", "utf8");
  assert.match(
    src,
    /The pass rate above is the L0 probe of the rows in this filter\. It is not the purchase result\.\s+Choosing a verdict does not change that rate\./,
  );
  assert.match(src, /observatoryRateFilters\(query\)/);
  assert.doesNotMatch(src, /after search, network, and the settled filter/);
  assert.match(src, /networkFilterCellLabel\(row\.network, query\.network\)/);
  assert.match(src, /networkFilterCellTitle\(row\.network, query\.network\)/);
  const filtered = src.slice(src.indexOf("if (filtered)"), src.indexOf("if (!stats)"));
  assert.match(filtered, /overview\.verdictCounts\.pass/);
  assert.match(filtered, /overview\.verdictCounts\.fail/);
  assert.match(filtered, /overview\.verdictCounts\.unverified/);
  assert.doesNotMatch(filtered, /stats\.publishedPass/);
});
