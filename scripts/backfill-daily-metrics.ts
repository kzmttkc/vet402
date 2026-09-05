// ============================================================
// x402_daily_metrics の全既往日 再集計（Phase 1.1・冪等）。
//
// raw の最古の probe/purchase 日から今日まで rollupDailyMetrics を回す。
// cron は直近 N 日（既定 14）しか再計算しないので、定義を変えたとき／
// N より古い日に遅れて確定した決済が入ったときは、これで表を作り直す。
//
// 既定は dry-run。**書かない。** 何がどう変わるかを chain 別に出すだけ。
// 実際に書くのは --apply を明示したときだけ——公開している数字を作り直す
// 操作なので、うっかり走らせて「気づいたら表が変わっていた」を作らない。
//
// Run (dry-run):
//   DATABASE_URL=... npx tsx scripts/backfill-daily-metrics.ts
// Run (書く):
//   DATABASE_URL=... npx tsx scripts/backfill-daily-metrics.ts --apply
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import {
  previewDailyMetrics,
  rollupDailyMetrics,
  shiftDay,
  utcDayString,
} from "@/lib/observatory/metrics-rollup";

type ChainTotals = { attempts: number; settled: number; probes: number; spent: bigint };

const zero = (): ChainTotals => ({ attempts: 0, settled: 0, probes: 0, spent: 0n });

function addRow(into: Map<string, ChainTotals>, chain: string, r: {
  l0Probes: number;
  l1Attempts: number;
  l1Settled: number;
  spentUnits: string;
}) {
  const t = into.get(chain) ?? zero();
  t.probes += r.l0Probes;
  t.attempts += r.l1Attempts;
  t.settled += r.l1Settled;
  t.spent += BigInt(r.spentUnits || "0");
  into.set(chain, t);
}

/** 表に今書かれている値（before）を chain 別に合計する。 */
async function tableTotals(from: string, to: string): Promise<Map<string, ChainTotals>> {
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL is not configured");
  const raw = await db.execute(sql`
    SELECT chain, sum(l0_probes)::bigint AS l0_probes, sum(l1_attempts)::bigint AS l1_attempts,
           sum(l1_settled)::bigint AS l1_settled, sum(spent_units::numeric)::text AS spent_units
    FROM x402_daily_metrics
    WHERE day >= ${from} AND day <= ${to}
    GROUP BY chain
  `);
  const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Record<
    string,
    unknown
  >[];
  const out = new Map<string, ChainTotals>();
  for (const r of rows) {
    addRow(out, String(r.chain), {
      l0Probes: Number(r.l0_probes ?? 0),
      l1Attempts: Number(r.l1_attempts ?? 0),
      l1Settled: Number(r.l1_settled ?? 0),
      spentUnits: String(r.spent_units ?? "0"),
    });
  }
  return out;
}

function fmt(t: ChainTotals | undefined): string {
  if (!t) return "—";
  return `attempts ${t.attempts} / settled ${t.settled} / probes ${t.probes} / spent ${t.spent}`;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL is not configured");

  const raw = await db.execute(sql`
    SELECT to_char(least(
      coalesce((SELECT min(probed_at) FROM x402_l0_probes), now()),
      coalesce((SELECT min(attempted_at) FROM x402_l1_purchases), now())
    )::date, 'YYYY-MM-DD') AS first_day
  `);
  const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as {
    first_day: string;
  }[];
  const firstDay = rows[0]?.first_day;
  if (!firstDay) throw new Error("could not determine first day");

  const argFrom = process.argv.find((a) => a.startsWith("--from="))?.slice("--from=".length);
  const from = argFrom ?? firstDay;
  const to = utcDayString();

  const days: string[] = [];
  for (let d = from; d <= to; d = shiftDay(d, 1)) days.push(d);

  const before = await tableTotals(from, to);

  // after は「書かずに導出したらこうなる」を rollup と同じ CTE で計算する。
  const after = new Map<string, ChainTotals>();
  for (const day of days) {
    for (const r of await previewDailyMetrics(day)) addRow(after, r.chain, r);
  }

  const chains = [...new Set([...before.keys(), ...after.keys()])].sort();
  console.log(`\nrange: ${from} .. ${to}  (${days.length} days)`);
  console.log(apply ? "mode:  APPLY (書く)" : "mode:  dry-run (書かない。書くには --apply)");
  console.log("\nchain-by-chain, before -> after:");
  for (const chain of chains) {
    const b = before.get(chain);
    const a = after.get(chain);
    const changed =
      !b || !a || b.attempts !== a.attempts || b.settled !== a.settled || b.probes !== a.probes || b.spent !== a.spent;
    console.log(`  ${changed ? "*" : " "} ${chain}`);
    console.log(`      before: ${fmt(b)}`);
    console.log(`      after : ${fmt(a)}${a ? "" : "   (この chain は導出されなくなる → 行を削除)"}`);
  }
  const sum = (m: Map<string, ChainTotals>, k: keyof ChainTotals) =>
    [...m.values()].reduce((n, t) => n + Number(t[k]), 0);
  console.log(
    `\ntotal attempts: ${sum(before, "attempts")} -> ${sum(after, "attempts")}` +
      `   settled: ${sum(before, "settled")} -> ${sum(after, "settled")}`,
  );

  if (!apply) {
    console.log("\ndry-run のため何も書いていない。--apply で実行する。\n");
    process.exit(0);
  }

  let count = 0;
  for (const day of days) {
    await rollupDailyMetrics(day);
    count++;
  }
  const written = await tableTotals(from, to);
  console.log(`\napplied: ${count} days rewritten (${from} .. ${to})`);
  console.log("表の実測（書いたあと）:");
  for (const chain of [...written.keys()].sort()) {
    console.log(`  ${chain}: ${fmt(written.get(chain))}`);
  }
  console.log("");
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
