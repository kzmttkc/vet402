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
import { test } from "node:test";
import assert from "node:assert/strict";
import { chainLabel, isTestnet } from "@/lib/observatory/chains";

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
