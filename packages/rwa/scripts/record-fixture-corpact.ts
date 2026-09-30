// Record Fixture C (SPEC patch 022): the demo wallet's NVDA and QQQ history, the
// state of both tokens at one block, and every UIMultiplierUpdated of the two
// tokens read from genesis on the chain (not from corporate-actions.json), so the
// corporate-action test replays offline and also cross-checks the frozen walk.
//
// Run from the repo root: npx tsx packages/rwa/scripts/record-fixture-corpact.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchBlockTimestamp, fetchBlockTimestamps, fetchCanonicalTransfers, fetchHead, fetchMultiplierLogs, fetchReceipts } from "../chain";
import { classifyReceipt } from "../classify";
import { decodeMultiplierUpdate, type MultiplierUpdate } from "../events";
import { readTokenState } from "../feed";
import { chainPoolResolver } from "../pools";
import { tokenByAddress } from "../registry";

const HOLDER = "0xe9b08727131e34010b34006c660d4c1b436ec25f";
const TOKENS = ["0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", "0xd5f3879160bc7c32ebb4dc785f8a4f505888de68"]; // NVDA, QQQ
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
  const opts = { retries: 8 };
  const block = await fetchHead(opts);
  const blockTimestamp = await fetchBlockTimestamp(block, opts);

  // State first: the public RPC drops a block's state within minutes of it being head.
  const states = [];
  for (const token of TOKENS) {
    const s = await readTokenState(token, tokenByAddress(token)!.feed, HOLDER, block, opts);
    states.push({
      token: s.token,
      raw: s.raw.toString(),
      uiMultiplier: s.uiMultiplier.toString(),
      oraclePaused: s.oraclePaused,
      feed: s.feed && { decimals: s.feed.decimals, round: Object.fromEntries(Object.entries(s.feed.round).map(([k, v]) => [k, v.toString()])) },
    });
    await pause(500);
  }

  const txs = new Set<string>();
  for (const token of TOKENS) {
    for (const l of await fetchCanonicalTransfers(token, HOLDER, block, opts)) txs.add(l.transactionHash);
    await pause(1_500);
  }
  const receipts = await fetchReceipts([...txs], opts, 20);
  console.error(`txs ${txs.size}, receipts ${receipts.length}`);

  const resolver = chainPoolResolver(opts, { v3: {}, v4: {} });
  const canonical = new Set(TOKENS);
  for (const r of receipts) await classifyReceipt(r, HOLDER, canonical, resolver);

  const updates = (await fetchMultiplierLogs(TOKENS.map((token) => ({ token, from: 0 })), block, opts)).map(decodeMultiplierUpdate).filter((u): u is MultiplierUpdate => u !== null);
  const times = await fetchBlockTimestamps(updates.map((u) => u.block), opts);

  const out = {
    fixture_id: "C.corpact",
    recorded_at: new Date().toISOString(),
    holder: HOLDER,
    tokens: TOKENS,
    block,
    block_timestamp: blockTimestamp,
    receipts,
    pools: resolver.facts,
    states,
    multiplier_updates: updates
      .sort((a, b) => a.block - b.block || a.log_index - b.log_index)
      .map((u) => ({ ...u, multiplier_before: u.multiplier_before.toString(), multiplier_after: u.multiplier_after.toString(), time: times.get(u.block)! })),
  };
  const path = join(process.cwd(), "fixtures/rwa/C.corpact.json");
  writeFileSync(path, `${JSON.stringify(out)}\n`);
  console.error(`wrote ${path}: block ${block}, receipts ${receipts.length}, updates ${updates.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
