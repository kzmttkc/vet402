#!/usr/bin/env npx tsx
// ============================================================
// Robinhood EVM レーンの公開 roots を Observatory L1 へ写す（既定は dry-run）。
//
//   VET402_EVM_ROBINHOOD_ROOTS_JSON=/path/to/robinhood.json \
//     npx tsx scripts/ingest-evm-lane-robinhood.ts --execute
// ============================================================
import { getDb } from "@/lib/db/client";
import { evmLanePublicCountsFromRoots, ingestEvmLaneRobinhood, loadEvmLaneRootsJson } from "@/lib/observatory/evm-lane-ingest";

async function main() {
  const execute = process.argv.includes("--execute");
  const path = process.env.VET402_EVM_ROBINHOOD_ROOTS_JSON;
  if (!path) {
    throw new Error("VET402_EVM_ROBINHOOD_ROOTS_JSON is required");
  }
  const roots = loadEvmLaneRootsJson(path);
  const counts = evmLanePublicCountsFromRoots(roots);
  if (!execute) {
    console.log(
      JSON.stringify({
        dryRun: true,
        path,
        counts,
        hint: "Pass --execute to write",
      }),
    );
    return;
  }
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL is not configured");
  const result = await ingestEvmLaneRobinhood(db, roots);
  console.log(JSON.stringify({ ok: true, counts, ...result }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
