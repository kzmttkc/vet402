import { eq } from "drizzle-orm";
import { getDb } from "./client";
import { funderIndexSkips, funderWallets } from "./schema";
import { logServerErrorSafe } from "@/lib/util/log-safe";

/** Trusted indexer write path — never called from API scoring. */
export async function recordFunderWallet(funder: string, wallet: string): Promise<boolean> {
  const db = getDb();
  if (!db) return false;

  const funderKey = funder.toLowerCase();
  const walletKey = wallet.toLowerCase();

  const inserted = await db
    .insert(funderWallets)
    .values({ funder: funderKey, wallet: walletKey })
    .onConflictDoNothing()
    .returning();

  return inserted.length > 0;
}

const SKIP_COOLDOWN_DAYS = 7;
const MAX_SKIP_COOLDOWN_DAYS = 28;

/**
 * Mark a wallet as unresolved (no incoming transfer found) so the next
 * funder-indexer run skips it until nextRetryAt. Cooldown grows with repeated
 * failures, capped at MAX_SKIP_COOLDOWN_DAYS — never a permanent exclusion.
 */
export async function recordFunderIndexSkip(wallet: string): Promise<void> {
  const db = getDb();
  if (!db) return;

  const walletKey = wallet.toLowerCase();

  // funder_index_skips is an optional cooldown cache (see
  // scripts/sql/2026-07-14-funder-index-skips.sql). If the table doesn't
  // exist yet on this database, fail silently (log only) rather than
  // throwing — losing the cooldown just means the wallet gets rescanned
  // next run, which is the pre-cache behavior, not a correctness issue.
  try {
    const existing = await db
      .select({ attempts: funderIndexSkips.attempts })
      .from(funderIndexSkips)
      .where(eq(funderIndexSkips.wallet, walletKey))
      .limit(1);

    const attempts = (existing[0]?.attempts ?? 0) + 1;
    const cooldownDays = Math.min(SKIP_COOLDOWN_DAYS * attempts, MAX_SKIP_COOLDOWN_DAYS);
    const now = new Date();
    const nextRetryAt = new Date(now.getTime() + cooldownDays * 24 * 60 * 60 * 1000);

    await db
      .insert(funderIndexSkips)
      .values({ wallet: walletKey, attempts, lastAttemptAt: now, nextRetryAt })
      .onConflictDoUpdate({
        target: funderIndexSkips.wallet,
        set: { attempts, lastAttemptAt: now, nextRetryAt },
      });
  } catch (err) {
    logServerErrorSafe("funder-index-writer: recordFunderIndexSkip failed, skipping cache write", err);
  }
}

/** Clear a wallet's skip record once it resolves successfully. */
export async function clearFunderIndexSkip(wallet: string): Promise<void> {
  const db = getDb();
  if (!db) return;

  try {
    await db.delete(funderIndexSkips).where(eq(funderIndexSkips.wallet, wallet.toLowerCase()));
  } catch (err) {
    logServerErrorSafe("funder-index-writer: clearFunderIndexSkip failed, skipping cache write", err);
  }
}
