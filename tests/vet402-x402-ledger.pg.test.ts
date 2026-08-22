// ============================================================
// vet402 2026-08-13 — the x402 settlement ledger, against a real Postgres.
//
// These three properties cannot be proven with a fake db, because they ARE the
// SQL: the score-eligibility filter, the block-time day axis, and the
// funder-collapsed payer diversity. So this file talks to a real Postgres and
// SKIPS itself when one is not reachable (npm test stays green offline).
//
// Point it at a throwaway database:
//   createdb vet402_scoring_test   # or the docker-compose postgres on :5433
//   TEST_DATABASE_URL=postgresql://user@localhost:5432/vet402_scoring_test npm test
//
// The three defects under test (all measured in production 2026-08-13):
//   1. getX402PaymentStats/getPayeeStats counted EVERY row for a wallet — a
//      self-minted token, an unconfirmed amount, or a STRANGER's real transfer
//      posted by someone who does not control the wallet. Now only USDC +
//      amount-verified + owner-signed rows count.
//   2. uniqueDays came from created_at (DB insert time), so one day of real
//      settlement, its inserts dripped across a fortnight, read as 14 days.
//      Now it comes from block_timestamp.
//   3. The payer-diversity bonus counted raw payer wallets, so ten wallets
//      funded by one address bought a full "ten independent customers" bonus.
//      Now it counts distinct funding sources.
// ============================================================
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/lib/db/schema";
import { __setDbForTests } from "@/lib/db/client";
import { getX402PaymentStats, getPayeeStats } from "@/lib/db/x402-payments";
import { BASE_USDC_ADDRESS } from "@/lib/chain/config";

const URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://takeshi@localhost:5432/vet402_scoring_test";
const USDC = BASE_USDC_ADDRESS.toLowerCase();
const FAKE_TOKEN = "0x9999999999999999999999999999999999999999";

// ONE postgres client, shared by raw seeding and the drizzle instance under
// test. Sharing it is what lets `after` close every handle in a single end()
// — an unclosed pool keeps the event loop alive, and node's test reporter
// buffers its output until the process exits, so a leaked connection looks
// exactly like a total hang (learned 2026-08-13, this file's first run).
let sql: ReturnType<typeof postgres> | null = null;
let reachable = false;

/** A clean, unique, lowercase 20-byte address from an integer seed. */
function wal(seed: number): string {
  return "0x" + seed.toString(16).padStart(40, "0");
}

before(async () => {
  try {
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

  // A self-contained subset of the schema — only what these functions read.
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`;
  await sql`DROP TABLE IF EXISTS x402_payments`;
  await sql`DROP TABLE IF EXISTS funder_wallets`;
  await sql`CREATE TABLE x402_payments (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    wallet text NOT NULL,
    amount text,
    tx_hash text NOT NULL,
    api_key_id uuid,
    network text NOT NULL DEFAULT 'base',
    resource text,
    payee text,
    onchain_amount text,
    token text,
    amount_verified boolean,
    block_timestamp timestamptz,
    ownership_verified boolean,
    created_at timestamptz DEFAULT now()
  )`;
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
  txHash: string;
  payee?: string | null;
  /** onchain USDC amount in base units. Defaults to a non-dust 1 USDC so a
   *  row shaped as a genuine settlement clears the >= X402_MIN filter without
   *  every test having to spell it out. Pass "0" or a sub-dust value to test
   *  the dust floor. */
  onchainAmount?: string | null;
  token?: string | null;
  amountVerified?: boolean | null;
  ownershipVerified?: boolean | null;
  blockTimestamp?: string | null;
  createdAt?: string | null;
};

// getX402PaymentStats (payer side) requires a resolved, independent, non-self
// payee; when a test does not care WHO the payee is (the counting/day tests), a
// fresh unique address is exactly "an independent seller" and lets the row count.
let payeeSeq = 0;
function autoPayee(): string {
  payeeSeq += 1;
  // 0x700000+ is well clear of this file's wal(NN) seeds, so an auto payee is
  // never accidentally the payer or another seeded wallet.
  return "0x" + (0x700000 + payeeSeq).toString(16).padStart(40, "0");
}

async function seed(rows: Row[]): Promise<void> {
  for (const r of rows) {
    const payee = r.payee === undefined ? autoPayee() : r.payee;
    await sql!`INSERT INTO x402_payments
      (wallet, tx_hash, payee, onchain_amount, token, amount_verified, ownership_verified, block_timestamp, created_at)
      VALUES (
        ${r.wallet.toLowerCase()}, ${r.txHash.toLowerCase()},
        ${payee?.toLowerCase() ?? null}, ${r.onchainAmount ?? "1000000"}, ${r.token ?? null},
        ${r.amountVerified ?? null}, ${r.ownershipVerified ?? null},
        ${r.blockTimestamp ?? null}, ${r.createdAt ?? new Date().toISOString()}
      )`;
  }
}

async function reset(): Promise<void> {
  await sql!`TRUNCATE x402_payments`;
  await sql!`TRUNCATE funder_wallets`;
}

let txSeq = 0;
function tx(): string {
  txSeq += 1;
  return "0x" + txSeq.toString(16).padStart(64, "0");
}

// ---------------------------------------------------------------------------

test("only USDC + amount-verified + owner-signed rows count toward a wallet's score", async (t) => {
  if (!reachable) return t.skip("no Postgres (set TEST_DATABASE_URL)");
  await reset();
  const W = wal(101);
  await seed([
    // the one genuine, fully-verified USDC settlement
    { wallet: W, txHash: tx(), token: USDC, amountVerified: true, ownershipVerified: true },
    // a stranger posted this real transfer but proved no ownership
    { wallet: W, txHash: tx(), token: USDC, amountVerified: true, ownershipVerified: false },
    // a token the payer minted themselves
    { wallet: W, txHash: tx(), token: FAKE_TOKEN, amountVerified: true, ownershipVerified: true },
    // owner-signed USDC but the declared amount was never confirmed
    { wallet: W, txHash: tx(), token: USDC, amountVerified: false, ownershipVerified: true },
    // legacy row — predates the columns (all NULL)
    { wallet: W, txHash: tx(), token: null, amountVerified: null, ownershipVerified: null },
  ]);

  const stats = await getX402PaymentStats(W);
  assert.equal(stats.paymentCount, 1, "only the fully-verified settlement counts");
});

test("posting a stranger's real transfer cannot move that stranger's score", async (t) => {
  if (!reachable) return t.skip("no Postgres");
  await reset();
  const STRANGER = wal(201);
  // Everything is real and amount-verified — the ONLY thing missing is a
  // signature proving the poster controls STRANGER. That alone must zero it.
  await seed([
    { wallet: STRANGER, txHash: tx(), token: USDC, amountVerified: true, ownershipVerified: false },
    { wallet: STRANGER, txHash: tx(), token: USDC, amountVerified: true, ownershipVerified: false },
  ]);
  const stats = await getX402PaymentStats(STRANGER);
  assert.equal(stats.paymentCount, 0);
  assert.equal(stats.uniqueDays, 0);
});

test("one day of settlement, its inserts dripped across 14 days, is still one uniqueDay", async (t) => {
  if (!reachable) return t.skip("no Postgres");
  await reset();
  const W = wal(301);
  // 14 distinct real txs, ALL mined on the same on-chain day, but each row
  // inserted (created_at) on a different calendar day — the fabrication the
  // block-time axis defeats.
  const blockDay = "2026-08-01T10:00:00Z";
  const rows: Row[] = [];
  for (let i = 0; i < 14; i++) {
    const created = new Date(Date.UTC(2026, 7, 1 + i, 12, 0, 0)).toISOString();
    rows.push({
      wallet: W,
      txHash: tx(),
      token: USDC,
      amountVerified: true,
      ownershipVerified: true,
      blockTimestamp: new Date(Date.parse(blockDay) + i * 60_000).toISOString(), // same day, minutes apart
      createdAt: created,
    });
  }
  await seed(rows);

  const stats = await getX402PaymentStats(W);
  assert.equal(stats.paymentCount, 14, "all 14 are genuine settlements");
  assert.equal(stats.uniqueDays, 1, "block time says one day — created_at spread is ignored");
});

test("genuine multi-day settlement is counted honestly by block time", async (t) => {
  if (!reachable) return t.skip("no Postgres");
  await reset();
  const W = wal(401);
  const rows: Row[] = [];
  for (let i = 0; i < 14; i++) {
    const day = new Date(Date.UTC(2026, 7, 1 + i, 9, 0, 0)).toISOString();
    rows.push({
      wallet: W,
      txHash: tx(),
      token: USDC,
      amountVerified: true,
      ownershipVerified: true,
      blockTimestamp: day,
      createdAt: day,
    });
  }
  await seed(rows);
  const stats = await getX402PaymentStats(W);
  assert.equal(stats.uniqueDays, 14, "14 different on-chain days really is 14 uniqueDays");
});

test("ten payers funded by one address collapse to one funding source", async (t) => {
  if (!reachable) return t.skip("no Postgres");
  await reset();
  const PAYEE = wal(501);
  const FUNDER = wal(601);
  const rows: Row[] = [];
  for (let i = 0; i < 10; i++) {
    const payer = wal(1000 + i); // 10 distinct payer wallets
    rows.push({
      wallet: payer,
      txHash: tx(),
      payee: PAYEE,
      token: USDC,
      amountVerified: true,
      ownershipVerified: true,
      blockTimestamp: new Date(Date.UTC(2026, 7, 1 + (i % 5), 9)).toISOString(),
    });
    // every payer funded by the same address
    await sql!`INSERT INTO funder_wallets (funder, wallet) VALUES (${FUNDER}, ${payer.toLowerCase()})`;
  }
  await seed(rows);

  const stats = await getPayeeStats(PAYEE);
  assert.equal(stats.distinctPayers, 10, "ten wallet addresses");
  assert.equal(stats.distinctFunders, 1, "but one funding source — a sybil cluster");
});

test("ten payers from ten independent funders keep their full diversity", async (t) => {
  if (!reachable) return t.skip("no Postgres");
  await reset();
  const PAYEE = wal(502);
  const rows: Row[] = [];
  for (let i = 0; i < 10; i++) {
    const payer = wal(2000 + i);
    rows.push({
      wallet: payer,
      txHash: tx(),
      payee: PAYEE,
      token: USDC,
      amountVerified: true,
      ownershipVerified: true,
      blockTimestamp: new Date(Date.UTC(2026, 7, 1 + (i % 5), 9)).toISOString(),
    });
    await sql!`INSERT INTO funder_wallets (funder, wallet) VALUES (${wal(9000 + i).toLowerCase()}, ${payer.toLowerCase()})`;
  }
  await seed(rows);

  const stats = await getPayeeStats(PAYEE);
  assert.equal(stats.distinctPayers, 10);
  assert.equal(stats.distinctFunders, 10, "ten distinct funders — genuinely independent");
});

test("索引に無い payer は「独立した資金源」として数えない——不明として開示する（2026-08-23）", async (t) => {
  if (!reachable) return t.skip("no Postgres");
  await reset();
  const PAYEE = wal(503);
  const rows: Row[] = [];
  for (let i = 0; i < 5; i++) {
    rows.push({
      wallet: wal(3000 + i),
      txHash: tx(),
      payee: PAYEE,
      token: USDC,
      amountVerified: true,
      ownershipVerified: true,
      blockTimestamp: new Date(Date.UTC(2026, 7, 1 + i, 9)).toISOString(),
    });
  }
  await seed(rows);
  // funder_wallets left empty on purpose.
  //
  // 旧: distinctFunders = 5（`coalesce(funder, wallet)` で不明を「自分自身が
  // 資金源」として数えていた）。funder_wallets は既に台帳へ載ったウォレットしか
  // 索引しないので、**新規ウォレットは判定の瞬間に必ず未索引**——2つ用意する
  // だけで「独立した2つの資金源」になり、ダスト送金3回で dataDepth が moderate に
  // 上がって ALLOW の天井(69)が外れた。
  //
  // 新: 判明した資金源は0。ただし「全員が同じクラスタ」という減点でもない
  // （それも測っていない主張になる）。不明は不明として開示し、深さが thin に
  // 留まる＝天井69が効いたまま＝ALLOW には届かない、で攻撃を閉じる。
  const stats = await getPayeeStats(PAYEE);
  assert.equal(stats.distinctPayers, 5);
  assert.equal(stats.distinctFunders, 0, "証明できた独立資金源は0");
  assert.equal(stats.payersWithUnknownFunder, 5, "不明は件数で開示する");
});

test("deploy-ordering: missing new columns degrade to empty, never a fail-closed throw", async (t) => {
  if (!reachable) return t.skip("no Postgres");
  await reset();
  // Simulate the code shipping BEFORE the migration: the score-eligibility
  // columns do not exist yet. getX402PaymentStats must read "no eligible
  // history", not throw (which would flag x402_unavailable → BLOCK everyone).
  await sql!`ALTER TABLE x402_payments DROP COLUMN block_timestamp`;
  await sql!`ALTER TABLE x402_payments DROP COLUMN ownership_verified`;
  try {
    const stats = await getX402PaymentStats(wal(101));
    assert.deepEqual(stats, {
      paymentCount: 0,
      uniqueDays: 0,
      lastPaymentAt: null,
      paymentsWithUnprovableIndependence: 0,
    });
    const payee = await getPayeeStats(wal(504));
    assert.equal(payee.paymentCount, 0, "payee read also degrades, not throws");
  } finally {
    // Restore for any later run against a persistent database.
    await sql!`ALTER TABLE x402_payments ADD COLUMN block_timestamp timestamptz`;
    await sql!`ALTER TABLE x402_payments ADD COLUMN ownership_verified boolean`;
  }
});

test("the payee aggregate excludes ownership-unproven rows too", async (t) => {
  if (!reachable) return t.skip("no Postgres");
  await reset();
  const PAYEE = wal(504);
  await seed([
    { wallet: wal(4010), txHash: tx(), payee: PAYEE, token: USDC, amountVerified: true, ownershipVerified: true },
    { wallet: wal(4011), txHash: tx(), payee: PAYEE, token: USDC, amountVerified: true, ownershipVerified: false },
    { wallet: wal(4012), txHash: tx(), payee: PAYEE, token: FAKE_TOKEN, amountVerified: true, ownershipVerified: true },
  ]);
  const stats = await getPayeeStats(PAYEE);
  assert.equal(stats.paymentCount, 1, "only the eligible row is a settlement for this payee");
  assert.equal(stats.distinctPayers, 1);
});
