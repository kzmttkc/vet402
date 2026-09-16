// Record the chain inputs the reconstruction of Fixture A's holder needs, so the
// classification and facts tests replay them offline: every NVDA Transfer log
// touching the holder up to A.block, the receipts of those transactions, and the
// pool facts the resolver looked up. Does not touch fixtures/rwa/A.json.
//
// Run from the repo root: npx tsx packages/rwa/scripts/record-fixture-a-chain.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchCanonicalTransfers, fetchReceipts } from "../chain";
import { classifyReceipt } from "../classify";
import { NVDA } from "../config";
import { chainPoolResolver } from "../pools";

async function main() {
  const A = JSON.parse(readFileSync(join(process.cwd(), "fixtures/rwa/A.json"), "utf8"));
  const holder: string = A.holder.address;
  const block: number = A.block;
  const opts = { retries: 5 };

  const logs = await fetchCanonicalTransfers(NVDA.token, holder, block, opts);
  const txs = [...new Set(logs.map((l) => l.transactionHash))];
  console.error(`logs ${logs.length}, txs ${txs.length}`);
  const receipts: Awaited<ReturnType<typeof fetchReceipts>> = [];
  for (let i = 0; i < txs.length; i += 20) {
    receipts.push(...(await fetchReceipts(txs.slice(i, i + 20), opts)));
    console.error(`receipts ${receipts.length}/${txs.length}`);
    await new Promise((r) => setTimeout(r, 1500));
  }

  // Exercise the resolver over the receipts so its memo holds every pool fact the replay needs.
  const resolver = chainPoolResolver(opts);
  const canonical = new Set([NVDA.token.toLowerCase()]);
  for (const r of receipts) await classifyReceipt(r, holder, canonical, resolver);

  const out = {
    fixture_id: "A.chain",
    recorded_at: new Date().toISOString(),
    holder,
    token: NVDA.token.toLowerCase(),
    to_block: block,
    transfer_logs: logs.map((l) => ({ tx: l.transactionHash, block: Number(l.blockNumber), log_index: Number(l.logIndex), topics: l.topics, data: l.data })),
    receipts,
    pools: resolver.facts,
  };
  const path = join(process.cwd(), "fixtures/rwa/A.chain.json");
  writeFileSync(path, `${JSON.stringify(out)}\n`);
  console.log(`wrote ${path}: ${logs.length} logs, ${receipts.length} receipts, v3 pools ${Object.keys(resolver.facts.v3).length}, v4 pools ${Object.keys(resolver.facts.v4).length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
