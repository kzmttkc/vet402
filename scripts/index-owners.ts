import { runIdentityIndexes } from "../src/lib/indexer/identity-index-run";

/**
 * cron の /api/cron/index-owners と同じ中身（所有者索引と WalletSet 索引を同じ持ち時間で並べて回す）を
 * 手元から 1 回走らせる（2026-10-31: 以前は所有者索引だけだった）。最後の行に cron と同じ JSON を出す。
 */
async function main() {
  const maxBlocks = Number(process.argv[2] ?? 1_000_000);
  const { status, body, failures } = await runIdentityIndexes({ maxBlocks: BigInt(maxBlocks) });
  if (!("caughtUp" in body)) {
    // 別の回（cron など）が lease を持っている、または lease を確かめられなかった。
    console.log(JSON.stringify(body));
    process.exit(status === 200 ? 0 : 1);
  }

  console.log("Identity indexes run complete");
  console.log(`  owner blocks:      ${body.fromBlock ?? "?"} → ${body.toBlock ?? "?"} (+${body.blocksAdvanced.owner})`);
  console.log(`  wallet blocks:     +${body.blocksAdvanced.wallet}`);
  console.log(`  registered events: ${body.registeredEvents ?? 0}`);
  console.log(`  transfer events:   ${body.transferEvents ?? 0}`);
  console.log(`  stopped by budget: ${body.stoppedByBudget}`);
  console.log(`  caught up:         ${body.caughtUp}`);
  console.log(JSON.stringify(body));
  for (const failure of failures) console.error(failure instanceof Error ? failure.message : failure);
  process.exit(status === 200 ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
