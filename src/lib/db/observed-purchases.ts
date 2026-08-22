import { and, countDistinct, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./client";
import { isMissingSchemaError } from "./pg-errors";
import { funderWallets, observedPurchases } from "./schema";
import { keepIndependentByFunder } from "./x402-payments";
import { logServerError } from "@/lib/util/log";

/**
 * vet402 2026-08-14 — L1 observed purchases: the PREMIUM economic-activity
 * source (see schema.observedPurchases and scoring/helpers.scoreEconomicActivity).
 *
 * The premium signal must be at least as sybil-resistant as the x402 interim
 * proxy it outscores, or broadening the axis would just open a cheaper ALLOW
 * route. So the score-eligibility filter here is the SAME shape getX402PaymentStats
 * uses, plus a delivery gate:
 *   - delivery_verified = TRUE    the observatory confirmed the good was delivered
 *   - non-dust                    amount >= X402_MIN_SETTLEMENT_UNITS
 *   - a resolved, independent seller (counterparty NOT NULL, <> buyer, and not
 *     funded from the buyer's own funder — reusing keepIndependentByFunder)
 * block_timestamp is the authoritative day axis, exactly as in x402_payments, so
 * a caller cannot manufacture a multi-day streak by dripping inserts.
 */
const MIN_SETTLEMENT_UNITS = (() => {
  const raw = process.env.X402_MIN_SETTLEMENT_UNITS;
  if (raw === undefined || raw === "") return 1_000n;
  try {
    const parsed = BigInt(raw);
    return parsed >= 0n ? parsed : 1_000n;
  } catch {
    return 1_000n;
  }
})();

const settledAt = sql`coalesce(${observedPurchases.blockTimestamp}, ${observedPurchases.createdAt})`;

const deliveryEligible = and(
  eq(observedPurchases.deliveryVerified, true),
  sql`${observedPurchases.amount} IS NOT NULL`,
  sql`(${observedPurchases.amount})::numeric >= ${MIN_SETTLEMENT_UNITS.toString()}`,
);

export type ObservedPurchaseStats = {
  purchaseCount: number;
  uniqueDays: number;
  distinctCounterparties: number;
};

export type ObservedDeliveryStats = {
  deliveryCount: number;
  uniqueDays: number;
  distinctBuyers: number;
};

export type RecordObservedPurchaseInput = {
  wallet: string;
  counterparty?: string | null;
  amount?: string | null;
  txHash: string;
  resource?: string | null;
  blockTimestamp?: Date | null;
  deliveryVerified?: boolean;
  observedBy?: string | null;
};

/**
 * Trusted-writer ingest. Written ONLY by the vet402 observatory (never by API
 * scoring), the same trust boundary as funder_wallets and feedback_events.
 * Idempotent on tx_hash so re-observing the same settlement is a no-op.
 *
 * 2026-08-22: the read-then-insert alone was idempotent only against SEQUENTIAL
 * re-observation — two overlapping L1 batches (or a backfill run alongside the
 * cron) would both see "no row" and the loser would raise 23505 out of a path
 * whose caller is deliberately graceful, i.e. an error log for a no-op. The
 * unique index on tx_hash is now used as the arbiter (ON CONFLICT DO NOTHING)
 * and the loser re-reads the winner's row.
 */
export async function recordObservedPurchase(
  input: RecordObservedPurchaseInput,
): Promise<{ created: boolean; id: string }> {
  const db = getDb();
  if (!db) throw new Error("database_unavailable");

  const txHash = input.txHash.toLowerCase();
  const readBack = async () => {
    const existing = await db
      .select({ id: observedPurchases.id })
      .from(observedPurchases)
      .where(eq(observedPurchases.txHash, txHash))
      .limit(1);
    return existing[0]?.id ?? null;
  };

  const known = await readBack();
  if (known) return { created: false, id: known };

  const inserted = await db
    .insert(observedPurchases)
    .values({
      wallet: input.wallet.toLowerCase(),
      counterparty: input.counterparty ? input.counterparty.toLowerCase() : null,
      amount: input.amount ?? null,
      txHash,
      resource: input.resource ?? null,
      blockTimestamp: input.blockTimestamp ?? null,
      deliveryVerified: input.deliveryVerified ?? false,
      observedBy: input.observedBy ?? null,
    })
    .onConflictDoNothing({ target: observedPurchases.txHash })
    .returning();
  if (inserted[0]) return { created: true, id: inserted[0].id };

  const winner = await readBack();
  if (winner) return { created: false, id: winner };
  // Nothing inserted and nothing to read back: the write was refused for a
  // reason we cannot name. Fail loudly rather than report a phantom row.
  throw new Error("observed_purchase_insert_lost");
}

/**
 * Buyer-side: how much verifiable REAL purchasing this wallet has done. Counts
 * only delivery-verified, non-dust purchases from resolved, independently funded
 * sellers. Global (cross-provider), like getX402PaymentStats — a wallet that has
 * really bought from independent sellers reads as active everywhere. Degrades to
 * empty (never throws) when the table is not migrated yet.
 */
export async function getObservedPurchaseStats(
  wallet: string,
): Promise<ObservedPurchaseStats> {
  const db = getDb();
  const empty: ObservedPurchaseStats = {
    purchaseCount: 0,
    uniqueDays: 0,
    distinctCounterparties: 0,
  };
  if (!db) return empty;

  const walletLower = wallet.toLowerCase();
  try {
    const rows = await db
      .select({
        payee: observedPurchases.counterparty,
        day: sql<string | null>`date_trunc('day', ${settledAt})`,
      })
      .from(observedPurchases)
      .where(
        and(
          eq(observedPurchases.wallet, walletLower),
          deliveryEligible,
          sql`${observedPurchases.counterparty} IS NOT NULL`,
          sql`lower(${observedPurchases.counterparty}) <> ${walletLower}`,
        ),
      );

    const independent = await keepIndependentlyFundedSellers(db, walletLower, rows);

    const uniqueDays = new Set(
      independent.map((r) => r.day).filter((d): d is string => d !== null),
    ).size;
    const distinctCounterparties = new Set(
      independent.map((r) => r.payee?.toLowerCase()).filter((p): p is string => !!p),
    ).size;

    return { purchaseCount: independent.length, uniqueDays, distinctCounterparties };
  } catch (error) {
    if (!isMissingSchemaError(error)) throw error;
    logServerError(
      "observed_purchase_stats_missing",
      new Error("observed_purchases not migrated yet; reading as no L1 history"),
    );
    return empty;
  }
}

/**
 * Seller-side: how many independent buyers this address actually delivered to.
 * The premium receiving signal for the payee engine — vet402 confirmed real
 * buyers received what they paid this seller for. Degrades to empty.
 *
 * vet402 2026-08-14 (中-2A, double-check Sybil hole). `distinctBuyers` is
 * FUNDER-COLLAPSED, not a raw wallet count: scoreL1Receiving's docstring promises
 * "already funder-collapsed by the reader", and the receiving-diversity bonus it
 * pays would otherwise be buyable by one actor spinning up N wallets from a
 * single funder — the exact twin of the payer-side collapse getPayeeStats does
 * via countDistinctFunders. Buyers whose funder is unknown count as their own
 * source (permissive degrade), so an empty/lagging funder index simply yields
 * distinctBuyers == the raw buyer count and never penalizes diversity on data we
 * lack. `deliveryCount` and `uniqueDays` remain the true event totals.
 */
export async function getObservedDeliveryStats(
  counterparty: string,
): Promise<ObservedDeliveryStats> {
  const db = getDb();
  const empty: ObservedDeliveryStats = { deliveryCount: 0, uniqueDays: 0, distinctBuyers: 0 };
  if (!db) return empty;

  const partyLower = counterparty.toLowerCase();
  try {
    const rows = await db
      .select({
        deliveryCount: sql<number>`count(*)`,
        uniqueDays: sql<number>`count(distinct date_trunc('day', ${settledAt}))`,
        distinctBuyers: countDistinct(observedPurchases.wallet),
      })
      .from(observedPurchases)
      .where(
        and(
          eq(observedPurchases.counterparty, partyLower),
          deliveryEligible,
          sql`lower(${observedPurchases.wallet}) <> ${partyLower}`,
        ),
      );
    const row = rows[0];
    const rawBuyers = Number(row?.distinctBuyers ?? 0);
    return {
      deliveryCount: Number(row?.deliveryCount ?? 0),
      uniqueDays: Number(row?.uniqueDays ?? 0),
      distinctBuyers: await countDistinctBuyerFunders(db, partyLower, rawBuyers),
    };
  } catch (error) {
    if (!isMissingSchemaError(error)) throw error;
    logServerError(
      "observed_delivery_stats_missing",
      new Error("observed_purchases not migrated yet; reading as no L1 deliveries"),
    );
    return empty;
  }
}

/**
 * vet402 2026-08-14 (中-2A) — collapse a seller's distinct delivered buyers down
 * to their distinct FUNDING SOURCES, the seller-side twin of x402-payments'
 * countDistinctFunders. Sybil clusters share one funder, so counting funders
 * instead of wallets stops a seller from manufacturing "many independent buyers"
 * from one funded set. A buyer with no funder row counts as its own source
 * (coalesce to the wallet), so an empty/lagging funder index returns the raw
 * buyer count — the diversity bonus is never penalized on data we lack. Reads the
 * same funder_wallets index the payer-side checks use (trusted indexer only). A
 * failed/absent funder index falls back to the raw count rather than failing the
 * whole delivery read — the funder join is a sybil discount, not a correctness
 * gate.
 */
async function countDistinctBuyerFunders(
  db: NonNullable<ReturnType<typeof getDb>>,
  sellerLower: string,
  rawBuyers: number,
): Promise<number> {
  if (rawBuyers === 0) return 0;
  try {
    const buyers = db
      .selectDistinct({ wallet: observedPurchases.wallet })
      .from(observedPurchases)
      .where(
        and(
          eq(observedPurchases.counterparty, sellerLower),
          deliveryEligible,
          sql`lower(${observedPurchases.wallet}) <> ${sellerLower}`,
        ),
      )
      .as("buyers");

    const rows = await db
      .select({
        distinctFunders: sql<number>`count(distinct coalesce(${funderWallets.funder}, ${buyers.wallet}))`,
      })
      .from(buyers)
      .leftJoin(funderWallets, sql`lower(${funderWallets.wallet}) = ${buyers.wallet}`);

    const value = Number(rows[0]?.distinctFunders ?? rawBuyers);
    // Never report MORE funding sources than buyers — a defensive floor in case
    // a wallet somehow carries multiple funder rows in the index.
    return Math.min(value, rawBuyers);
  } catch (error) {
    // The funder index is an optimization for a sybil discount, not a correctness
    // gate: if it cannot be read (e.g. funder_wallets not migrated), fall back to
    // the raw buyer count rather than failing the whole delivery read.
    if (!isMissingSchemaError(error)) {
      logServerError("observed_delivery_distinct_funders", error);
    }
    return rawBuyers;
  }
}

/**
 * Drop purchases whose SELLER shares a funding source with the buyer — the same
 * funder-cluster collapse getX402PaymentStats applies, reusing its pure decision
 * half (keepIndependentByFunder). Unknown funders degrade permissively (own
 * source → kept); the funder index is a sybil discount, never a read we fail on.
 */
async function keepIndependentlyFundedSellers<T extends { payee: string | null }>(
  db: NonNullable<ReturnType<typeof getDb>>,
  buyerLower: string,
  rows: T[],
): Promise<T[]> {
  if (rows.length === 0) return rows;
  const sellerLowers = [
    ...new Set(
      rows
        .map((r) => r.payee?.toLowerCase())
        .filter((p): p is string => p !== undefined && p !== null),
    ),
  ];
  if (sellerLowers.length === 0) return [];

  try {
    const buyerFunderRows = await db
      .select({ funder: funderWallets.funder })
      .from(funderWallets)
      .where(sql`lower(${funderWallets.wallet}) = ${buyerLower}`);
    const buyerFunders = new Set(buyerFunderRows.map((r) => r.funder.toLowerCase()));

    const sellerFunderRows = await db
      .select({ wallet: funderWallets.wallet, funder: funderWallets.funder })
      .from(funderWallets)
      .where(inArray(sql`lower(${funderWallets.wallet})`, sellerLowers));
    const funderOfSeller = new Map<string, string>();
    for (const r of sellerFunderRows) {
      funderOfSeller.set(r.wallet.toLowerCase(), r.funder.toLowerCase());
    }
    // 2026-08-23: 戻り値が {kept, dropped...} になった。買い手自身も
    // クラスタに含める（自分で自分に配送させた実績を独立と数えない）。
    return keepIndependentByFunder(buyerFunders, funderOfSeller, rows, buyerLower).kept;
  } catch (error) {
    // 2026-08-23 監査: ここも「索引が読めなければ全行を通す」形だった。
    // 読めなかったことは独立の証拠ではない。
    if (!isMissingSchemaError(error)) logServerError("observed_independent_sellers", error);
    return rows;
  }
}
