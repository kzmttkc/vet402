/**
 * Base USDC 着金集計（vet402 payTo・自社除外・日次）。
 *
 * Usage:
 *   npx tsx scripts/kpi/x402-revenue.ts --from 2026-11-01 --to 2026-12-01
 *   npx tsx scripts/kpi/x402-revenue.ts --month 2026-11
 *   npx tsx scripts/kpi/x402-revenue.ts --from 2026-05-11 --to 2026-11-28 --budget-ms 600000
 *
 * 読み手: Alchemy（鍵があるとき）→ Base 公開 RPC（https://base-rpc.publicnode.com）の
 * 50,000 ブロック刻みの eth_getLogs。鍵が無くても読める。
 *
 * 標準出力は JSON。readStatus が unreadable のとき件数は出さない（0 と混ぜない）。
 */
import { fetchX402RevenueAggregate } from "../../src/lib/kpi/x402-revenue";
import { kpiMonthPeriod } from "../../src/lib/kpi/monthly-document";

function usage(): never {
  console.error("x402-revenue: --from YYYY-MM-DD --to YYYY-MM-DD  or  --month YYYY-MM  [--budget-ms N]");
  process.exit(1);
}

async function main() {
  const argv = process.argv.slice(2);
  let from: string | null = null;
  let to: string | null = null;
  let month: string | null = null;
  let budgetMs = 120_000;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--from") from = argv[++i] ?? null;
    else if (argv[i] === "--to") to = argv[++i] ?? null;
    else if (argv[i] === "--month") month = argv[++i] ?? null;
    else if (argv[i] === "--budget-ms") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) usage();
      budgetMs = n;
    }
  }

  if (month) {
    const period = kpiMonthPeriod(month);
    if (!period) usage();
    from = period.periodStart;
    to = period.periodEndExclusive;
  }

  if (!from || !to) usage();

  const agg = await fetchX402RevenueAggregate(from, to, { budgetMs });
  console.log(JSON.stringify(agg, null, 2));
  if (agg.readStatus === "unreadable") process.exit(2);
}

main().catch((err) => {
  console.error("x402-revenue: fatal", err instanceof Error ? err.message : err);
  process.exit(1);
});