/**
 * 月次の購入台帳を凍結する（F5）。翌月 1 日 00:00 UTC 以降に走らせる。
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/monthly-freeze.ts 2026-11
 *   npx tsx scripts/monthly-freeze.ts 2026-11 --dry-run
 *
 * 同じ月を二度走らせても ON CONFLICT で変えない。
 */
import {
  computeMonthlyFreezeFromDb,
  insertMonthlyFreeze,
  monthlyFreezePublicationError,
  parseMonthlyFreezeMonth,
} from "../src/lib/observatory/monthly-freeze";
import { getDb } from "../src/lib/db/client";

async function main() {
  const monthArg = process.argv[2];
  const dryRun = process.argv.includes("--dry-run");
  const parsed = parseMonthlyFreezeMonth(monthArg ?? null);
  if (!parsed.ok) {
    console.error("monthly-freeze: pass YYYY-MM from 2026 through 2100");
    process.exit(1);
  }
  const publication = monthlyFreezePublicationError(parsed.month);
  if (publication === "month_not_closed") {
    console.error("monthly-freeze: month is still open");
    process.exit(1);
  }
  if (publication === "not_frozen_yet") {
    console.error("monthly-freeze: publication waits until 00:00 UTC on the 1st of the next month");
    process.exit(1);
  }
  const db = getDb();
  if (!db) {
    console.error("monthly-freeze: DATABASE_URL is not configured");
    process.exit(1);
  }
  const record = await computeMonthlyFreezeFromDb(db, parsed.month);
  if (dryRun) {
    console.log(JSON.stringify(record, null, 2));
    console.error("monthly-freeze: dry run — nothing written");
    return;
  }
  const outcome = await insertMonthlyFreeze(db, record);
  const { loadMonthlyFreezeSummary } = await import("../src/lib/observatory/monthly-freeze");
  const summary = await loadMonthlyFreezeSummary(db, parsed.month);
  console.log(JSON.stringify(summary ?? record, null, 2));
  console.error(`monthly-freeze: ${outcome} for ${parsed.month}`);
}

main().catch((error) => {
  console.error("monthly-freeze: fatal", error instanceof Error ? error.message : error);
  process.exit(1);
});