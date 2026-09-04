#!/usr/bin/env -S npx tsx
// ============================================================
// §7.2 決済索引をローカル（launchd）で回す。
//
// Vercel の cron は 300 秒の壁があり、Base の USDC Transfer は 40,000 ブロックあたり
// 約 7,000 件（2026-09-02 初回実走）。1 件ごとに帰属・wash・upsert で Neon へ 4 往復
// するので、300 秒では 570 件しか進まない。他の indexer（funders / owners / feedback）と
// 同じく、管理リポの launchd から本番 DB に対してこのスクリプトを回す。
// Vercel 側の日次 cron は残す（チェックポイントはスライス単位で安全）。
//
// Usage: DATABASE_URL=... npx tsx scripts/index-settlements.ts [--budget-ms 1200000]
// ============================================================
import { loadWashClassifier } from "@/lib/settlements/context";
import { ingestL1 } from "@/lib/settlements/ingest-l1";
import { ingestPayments } from "@/lib/settlements/ingest-payments";
import { indexEvm } from "@/lib/settlements/index-evm";
import { indexSolana } from "@/lib/settlements/index-solana";
import { acquireLease } from "@/lib/cron/lease";

async function main() {
  const bi = process.argv.indexOf("--budget-ms");
  const budgetMs = bi >= 0 ? Number(process.argv[bi + 1]) : 20 * 60_000;
  // 2026-09-04 監査 D（P1-3）: Vercel の cron と同じ lease を取る。取れなければ二重に走らせない。
  const lease = await acquireLease("index-settlements", Math.ceil(budgetMs / 1000) + 60);
  if (!lease.acquired) {
    console.log(JSON.stringify({ ok: true, skipped: "already_running", at: new Date().toISOString() }));
    return;
  }
  try {
    const classifier = await loadWashClassifier();
    const l1 = await ingestL1();
    const payments = await ingestPayments({ classifier });
    const evm = await indexEvm({ budgetMs: Math.floor(budgetMs * 0.75), classifier });
    const solana = await indexSolana({ budgetMs: Math.floor(budgetMs * 0.25), classifier });
    // 2026-09-04 監査 D（P0）: chain 単位の失敗は `skipped: "error:…"` に畳まれ ok:true で報告されていた。
    // 失敗は失敗として返す（launchd は ok:false を ALERTS に書く）。
    const failed = evm.filter((c) => typeof c.skipped === "string" && c.skipped.startsWith("error:")).map((c) => `${c.chain}: ${c.skipped}`);
    if (solana.errors > 0) failed.push(`solana: errors=${solana.errors}`);
    console.log(JSON.stringify({ ok: failed.length === 0, failed, at: new Date().toISOString(), testWallets: classifier.testWallets.size, l1, payments, evm, solana }));
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    await lease.release();
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(JSON.stringify({ ok: false, error: String(e).slice(0, 500) }));
    process.exit(1);
  });
