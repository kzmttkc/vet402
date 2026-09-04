// 2026-09-04 W15: settlements の日次集約を手で回す口。
//
//   npm run settlements:rollup                        # dry-run（既定・何も書かない）
//   npm run settlements:rollup -- --apply             # 実際に畳んで消す
//   npm run settlements:rollup -- --apply --max-days=5  # 古い方から 5 日だけ
//
// 生行の保持日数を一時的に変えたいとき（例: 初回に VACUUM FULL を安く済ませる）:
//   SETTLEMENTS_RAW_RETENTION_DAYS=2 npm run settlements:rollup -- --apply
//
// cron（/api/cron/settlements-rollup）と同じ処理を呼ぶ。初回は 40 日ぶんを
// まとめて畳むので Vercel の 300 秒に収まらないことがある——そのときは
// 管理リポからこれを叩く。
import { planRollup, runRollup, RAW_RETENTION_DAYS, DAILY_RETENTION_DAYS } from "../src/lib/settlements/rollup";

async function main() {
  const apply = process.argv.includes("--apply");
  const maxDaysArg = process.argv.find((a) => a.startsWith("--max-days="));
  const maxDays = maxDaysArg ? Number.parseInt(maxDaysArg.slice("--max-days=".length), 10) : undefined;
  if (maxDaysArg && !(Number.isFinite(maxDays) && maxDays! > 0)) {
    console.error("--max-days= には 1 以上の整数を渡すこと");
    process.exit(2);
  }
  const result = apply ? await runRollup({ apply: true, maxDays }) : await planRollup();

  const head = apply ? "APPLIED" : "DRY-RUN (何も書いていない。--apply で実行)";
  console.log(`\nsettlements rollup — ${head}`);
  console.log(`  生行の保持: 直近 ${RAW_RETENTION_DAYS} 日 / 集約の保持: ${DAILY_RETENTION_DAYS} 日`);
  console.log(`  畳む対象: ${result.cutoff ?? "-"} 以前`);
  console.log(`  畳む日数: ${result.days.length} 日`);
  console.log(`  削る生行: ${result.rowsFolded.toLocaleString()} 行`);
  console.log(`  書く集約: ${result.groupsWritten.toLocaleString()} 行`);
  console.log(`  削減見込み: ${result.estimatedFreedMb} MB（生行 1 行あたりの実測バイトから算出）`);
  console.log(`  保持超過で落とす集約: ${result.dailyPruned.toLocaleString()} 行`);
  if (result.days.length > 0) {
    const head5 = result.days.slice(0, 5);
    const tail5 = result.days.slice(-5);
    const show = result.days.length <= 10 ? result.days : [...head5, { day: "…", rows: 0, groups: 0 }, ...tail5];
    console.log("\n  日ごと（先頭と末尾）:");
    for (const d of show) {
      console.log(d.day === "…" ? "    …" : `    ${d.day}  ${String(d.rows).padStart(7)} 行 → ${String(d.groups).padStart(6)} 集約`);
    }
  }
  console.log(`\n  ${result.note}\n`);
  console.log(JSON.stringify({ ...result, days: undefined }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
