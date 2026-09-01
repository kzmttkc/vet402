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

async function main() {
  const bi = process.argv.indexOf("--budget-ms");
  const budgetMs = bi >= 0 ? Number(process.argv[bi + 1]) : 20 * 60_000;
  const classifier = await loadWashClassifier();
  const l1 = await ingestL1();
  const payments = await ingestPayments({ classifier });
  const evm = await indexEvm({ budgetMs: Math.floor(budgetMs * 0.75), classifier });
  const solana = await indexSolana({ budgetMs: Math.floor(budgetMs * 0.25), classifier });
  console.log(JSON.stringify({ ok: true, at: new Date().toISOString(), testWallets: classifier.testWallets.size, l1, payments, evm, solana }));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(JSON.stringify({ ok: false, error: String(e).slice(0, 500) }));
    process.exit(1);
  });
