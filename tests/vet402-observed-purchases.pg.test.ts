// ============================================================
// vet402 2026-08-14 — L1 observed-purchase ledger, against a real Postgres.
//
// The premium economic-activity signal must be at least as sybil-resistant as
// the x402 interim proxy it outscores, or broadening the axis would just open a
// cheaper ALLOW route. These properties ARE the SQL (delivery gate, self-dealing
// exclusion, dust floor, funder-independence, block-time day axis), so they run
// against a real Postgres and SKIP when one is not reachable.
//
//   TEST_DATABASE_URL=postgresql://user@localhost:5432/vet402_scoring_test npm test
// ============================================================
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/lib/db/schema";
import { __setDbForTests } from "@/lib/db/client";
import {
  getObservedPurchaseStats,
  getObservedDeliveryStats,
  recordObservedPurchase,
} from "@/lib/db/observed-purchases";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://takeshi@localhost:5432/vet402_scoring_test";

const MIN = "1000"; // matches X402_MIN_SETTLEMENT_UNITS default (0.001 USDC)

let sql: ReturnType<typeof postgres> | null = null;
let reachable = false;

function wal(seed: number): string {
  return "0x" + seed.toString(16).padStart(40, "0");
}

before(async () => {
  try {
    // TRUNCATE より前に、接続先が本番（Neon）でないことを機械で確かめる（2026-09-04 監査 D・P2）。
    assertTestDatabaseIsNotProduction(URL);
    sql = postgres(URL, { max: 1, connect_timeout: 3, onnotice: () => {} });
    await sql`select 1`;
    reachable = true;
  } catch {
    reachable = false;
    if (sql) {
      await sql.end({ timeout: 1 }).catch(() => {});
      sql = null;
    }
    return;
  }

  // Isolate in a dedicated schema so this file never races the other .pg test
  // (both DROP/CREATE funder_wallets; node's runner may run files concurrently).
  // The single max:1 connection carries this search_path into the drizzle
  // instance below, so the production readers resolve their unqualified table
  // names here rather than in public.
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`;
  await sql`CREATE SCHEMA IF NOT EXISTS vet402_obs`;
  await sql`SET search_path TO vet402_obs`;
  await sql`DROP TABLE IF EXISTS observed_purchases`;
  await sql`DROP TABLE IF EXISTS funder_wallets`;
  await sql`CREATE TABLE observed_purchases (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    wallet text NOT NULL,
    counterparty text,
    amount text,
    tx_hash text NOT NULL,
    resource text,
    block_timestamp timestamptz,
    delivery_verified boolean NOT NULL DEFAULT false,
    observed_by text,
    created_at timestamptz DEFAULT now()
  )`;
  // 本番と同じ一意制約。recordObservedPurchase の ON CONFLICT はこれを
  // 仲裁者として使うので、フィクスチャに無いと「本番では通る書き込みが
  // テストでだけ落ちる／その逆」になる。
  await sql`CREATE UNIQUE INDEX observed_purchases_tx_hash_idx ON observed_purchases (tx_hash)`;
  await sql`CREATE TABLE funder_wallets (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    funder text NOT NULL,
    wallet text NOT NULL,
    first_seen_at timestamptz DEFAULT now()
  )`;
  __setDbForTests(drizzle(sql, { schema }));
});

after(async () => {
  __setDbForTests(null);
  if (sql) {
    await sql.end({ timeout: 5 }).catch(() => {});
    sql = null;
  }
});

type Row = {
  wallet: string;
  counterparty?: string | null;
  amount?: string | null;
  txHash: string;
  blockTimestamp?: string | null;
  deliveryVerified?: boolean;
};

let seq = 0;
function tx(): string {
  seq += 1;
  return "0x" + seq.toString(16).padStart(64, "0");
}

async function seed(rows: Row[]): Promise<void> {
  for (const r of rows) {
    await sql!`INSERT INTO observed_purchases
      (wallet, counterparty, amount, tx_hash, block_timestamp, delivery_verified)
      VALUES (
        ${r.wallet.toLowerCase()}, ${r.counterparty?.toLowerCase() ?? null},
        ${r.amount ?? MIN}, ${r.txHash.toLowerCase()},
        ${r.blockTimestamp ?? new Date().toISOString()}, ${r.deliveryVerified ?? true}
      )`;
  }
}

async function reset(): Promise<void> {
  await sql!`TRUNCATE observed_purchases`;
  await sql!`TRUNCATE funder_wallets`;
}

// ---------------------------------------------------------------------------

test("only DELIVERY-VERIFIED purchases to independent sellers count", async (t) => {
  if (!reachable) return t.skip("no Postgres (set TEST_DATABASE_URL)");
  await reset();
  const W = wal(101);
  await seed([
    { wallet: W, counterparty: wal(201), txHash: tx(), deliveryVerified: true }, // counts
    { wallet: W, counterparty: wal(202), txHash: tx(), deliveryVerified: false }, // settled but not delivered
    { wallet: W, counterparty: null, txHash: tx(), deliveryVerified: true }, // unresolved seller
    { wallet: W, counterparty: W, txHash: tx(), deliveryVerified: true }, // self-dealing
    { wallet: W, counterparty: wal(203), txHash: tx(), amount: "500", deliveryVerified: true }, // dust (<1000)
  ]);
  const stats = await getObservedPurchaseStats(W);
  assert.equal(stats.purchaseCount, 1, "only the delivered, independent, non-dust purchase counts");
  assert.equal(stats.distinctCounterparties, 1);
});

test("recordObservedPurchase は tx_hash で冪等（同じ決済を二重に数えない）", async (t) => {
  if (!reachable) return t.skip("no Postgres (set TEST_DATABASE_URL)");
  await reset();
  const BUYER = wal(601);
  const SELLER = wal(602);
  const TX = tx();
  const input = {
    wallet: BUYER,
    counterparty: SELLER,
    amount: "3000",
    txHash: TX,
    resource: "https://seller.example/api",
    deliveryVerified: true,
    observedBy: "observatory-l1:test",
  };

  const first = await recordObservedPurchase(input);
  assert.equal(first.created, true);

  // 同じ決済の再観測（cron の再実行・バックフィルの重ね掛け）。
  const second = await recordObservedPurchase(input);
  assert.equal(second.created, false);
  assert.equal(second.id, first.id, "勝った行のidを返す");

  // 大文字小文字違いの同じ tx_hash も同じ1件。
  const third = await recordObservedPurchase({ ...input, txHash: TX.toUpperCase() });
  assert.equal(third.created, false);

  const rows = await sql!`SELECT count(*)::int AS n FROM observed_purchases WHERE tx_hash = ${TX.toLowerCase()}`;
  assert.equal(rows[0].n, 1, "行は1つだけ");
  const stats = await getObservedPurchaseStats(BUYER);
  assert.equal(stats.purchaseCount, 1, "スコアの分子も二重計上されない");
});

test("payees funded by the buyer's own funder are dropped (self-dealing via funding cluster)", async (t) => {
  if (!reachable) return t.skip("no Postgres");
  await reset();
  const BUYER = wal(301);
  const FUNDER = wal(401);
  const SOCK = wal(302); // funded by the same source as the buyer
  const REAL = wal(303); // independently funded
  await sql!`INSERT INTO funder_wallets (funder, wallet) VALUES
    (${FUNDER}, ${BUYER}), (${FUNDER}, ${SOCK}), (${wal(999)}, ${REAL})`;
  await seed([
    { wallet: BUYER, counterparty: SOCK, txHash: tx(), deliveryVerified: true },
    { wallet: BUYER, counterparty: REAL, txHash: tx(), deliveryVerified: true },
  ]);
  const stats = await getObservedPurchaseStats(BUYER);
  assert.equal(stats.purchaseCount, 1, "the sockpuppet seller is dropped; the independent one kept");
  assert.equal(stats.distinctCounterparties, 1);
});

test("uniqueDays comes from block time, distinctCounterparties from the seller", async (t) => {
  if (!reachable) return t.skip("no Postgres");
  await reset();
  const W = wal(501);
  const rows: Row[] = [];
  for (let i = 0; i < 6; i++) {
    rows.push({
      wallet: W,
      counterparty: wal(600 + (i % 3)), // 3 distinct sellers
      txHash: tx(),
      blockTimestamp: new Date(Date.UTC(2026, 7, 1 + i, 9)).toISOString(), // 6 distinct days
      deliveryVerified: true,
    });
  }
  await seed(rows);
  const stats = await getObservedPurchaseStats(W);
  assert.equal(stats.purchaseCount, 6);
  assert.equal(stats.uniqueDays, 6);
  assert.equal(stats.distinctCounterparties, 3);
});

test("the seller/delivery view: distinct independent BUYERS who received delivery", async (t) => {
  if (!reachable) return t.skip("no Postgres");
  await reset();
  const SELLER = wal(700);
  await seed([
    { wallet: wal(701), counterparty: SELLER, txHash: tx(), deliveryVerified: true },
    { wallet: wal(702), counterparty: SELLER, txHash: tx(), deliveryVerified: true },
    { wallet: wal(703), counterparty: SELLER, txHash: tx(), deliveryVerified: false }, // not delivered
  ]);
  const stats = await getObservedDeliveryStats(SELLER);
  assert.equal(stats.deliveryCount, 2);
  assert.equal(stats.distinctBuyers, 2);
});

test("seller distinctBuyers is FUNDER-COLLAPSED — sockpuppet buyers sharing a funder count once (中-2A)", async (t) => {
  if (!reachable) return t.skip("no Postgres");
  await reset();
  const SELLER = wal(800);
  const FUNDER = wal(900);
  const SOCK_A = wal(801); // two buyer wallets, one funder = one sybil cluster
  const SOCK_B = wal(802);
  const REAL = wal(803); // an independently funded, genuinely distinct buyer
  await sql!`INSERT INTO funder_wallets (funder, wallet) VALUES
    (${FUNDER}, ${SOCK_A}), (${FUNDER}, ${SOCK_B}), (${wal(998)}, ${REAL})`;
  await seed([
    { wallet: SOCK_A, counterparty: SELLER, txHash: tx(), deliveryVerified: true },
    { wallet: SOCK_B, counterparty: SELLER, txHash: tx(), deliveryVerified: true },
    { wallet: REAL, counterparty: SELLER, txHash: tx(), deliveryVerified: true },
  ]);
  const stats = await getObservedDeliveryStats(SELLER);
  // Three delivered settlements happened, but only TWO independent funding
  // sources are behind them — the sybil cluster must not buy a 3-buyer diversity
  // bonus. The docstring on scoreL1Receiving promises this collapse; here it is.
  assert.equal(stats.deliveryCount, 3, "every delivered settlement is still counted");
  assert.equal(stats.distinctBuyers, 2, "the two same-funder buyers collapse to one source");
});

test("seller distinctBuyers with no funder index falls back to the raw buyer count (permissive degrade)", async (t) => {
  if (!reachable) return t.skip("no Postgres");
  await reset(); // funder_wallets is empty: every buyer is its own source
  const SELLER = wal(850);
  await seed([
    { wallet: wal(851), counterparty: SELLER, txHash: tx(), deliveryVerified: true },
    { wallet: wal(852), counterparty: SELLER, txHash: tx(), deliveryVerified: true },
  ]);
  const stats = await getObservedDeliveryStats(SELLER);
  assert.equal(stats.distinctBuyers, 2, "an unpopulated funder index never penalizes diversity");
});

test("a missing observed_purchases table degrades to empty, never throws", async (t) => {
  if (!reachable) return t.skip("no Postgres");
  await sql!`DROP TABLE IF EXISTS observed_purchases`;
  const stats = await getObservedPurchaseStats(wal(101));
  assert.deepEqual(stats, { purchaseCount: 0, uniqueDays: 0, distinctCounterparties: 0 });
  const dStats = await getObservedDeliveryStats(wal(700));
  assert.deepEqual(dStats, { deliveryCount: 0, uniqueDays: 0, distinctBuyers: 0 });
  // restore for any later run
  await sql!`CREATE TABLE observed_purchases (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY, wallet text NOT NULL, counterparty text,
    amount text, tx_hash text NOT NULL, resource text, block_timestamp timestamptz,
    delivery_verified boolean NOT NULL DEFAULT false, observed_by text,
    created_at timestamptz DEFAULT now())`;
});
