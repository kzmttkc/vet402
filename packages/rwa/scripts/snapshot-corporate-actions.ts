// Walk every canonical Stock Token's UIMultiplierUpdated logs from genesis and
// freeze them in packages/rwa/corporate-actions.json (SPEC patch 022). A live
// reconstruction then reads only the tail after `to_block`.
//
// It also checks the walk against the chain: for each token, the multiplier the
// logs predict (1e18 with no update, else the last `after` once in effect) must
// equal uiMultiplier() at `to_block`, read right after that block was head. Any difference is printed and the file is
// not written.
//
// Run from the repo root: npx tsx packages/rwa/scripts/snapshot-corporate-actions.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchBlockTimestamps, fetchHead, fetchMultiplierLogs } from "../chain";
import { RWA_CHAIN_ID } from "../config";
import { decodeMultiplierUpdate, type MultiplierUpdate } from "../events";
import { CANONICAL_TOKENS } from "../registry";
import { hex, rpcBatch, word } from "../rpc";

async function main() {
  const opts = { retries: 8 };
  const head = await fetchHead(opts);
  const tokens = CANONICAL_TOKENS.map((t) => t.token.toLowerCase());
  const symbol = new Map(CANONICAL_TOKENS.map((t) => [t.token.toLowerCase(), t.symbol]));
  console.error(`head ${head}, tokens ${tokens.length}`);

  const updates: MultiplierUpdate[] = [];
  // One token per pass with a pause: the public RPC answered 429 to a 20-token pass (2026-09-30).
  for (let i = 0; i < tokens.length; i++) {
    const logs = await fetchMultiplierLogs([{ token: tokens[i], from: 0 }], head, opts);
    for (const l of logs) {
      const u = decodeMultiplierUpdate(l);
      if (!u) throw new Error(`undecodable UIMultiplierUpdated log in ${l.transactionHash}`);
      updates.push(u);
    }
    if (i % 20 === 19) console.error(`walked ${i + 1}/${tokens.length}, updates so far ${updates.length}`);
    await new Promise((r) => setTimeout(r, 1_500));
  }
  // The public RPC drops state within minutes ("historical state … is not available" for a block
  // read 13 minutes after it was head, 2026-09-30), so uiMultiplier() is read at a fresh head first,
  // and the logs between the walk's head and that block are read after, as one tail range per token.
  const at = await fetchHead(opts);
  const multipliers: string[] = [];
  for (let i = 0; i < tokens.length; i += 25) {
    const slice = tokens.slice(i, i + 25);
    multipliers.push(...(await rpcBatch<string>(slice.map((t) => ({ method: "eth_call", params: [{ to: t, data: "0xa60bf13d" }, hex(at)] })), opts)));
  }
  if (at > head) {
    for (const l of await fetchMultiplierLogs(tokens.map((token) => ({ token, from: head + 1 })), at, opts)) {
      const u = decodeMultiplierUpdate(l);
      if (!u) throw new Error(`undecodable UIMultiplierUpdated log in ${l.transactionHash}`);
      updates.push(u);
    }
  }
  updates.sort((a, b) => a.block - b.block || a.log_index - b.log_index);
  const times = await fetchBlockTimestamps(updates.map((u) => u.block), opts);

  const headTime = (await fetchBlockTimestamps([at], opts)).get(at)!;
  const mismatches: string[] = [];
  let pending = 0;
  for (let i = 0; i < tokens.length; i += 25) {
    const slice = tokens.slice(i, i + 25);
    const res = multipliers.slice(i, i + 25);
    slice.forEach((t, j) => {
      const mine = updates.filter((u) => u.token === t);
      const last = mine[mine.length - 1];
      if (last && last.effective_at > headTime) {
        pending++;
        return;
      }
      const expected = last ? last.multiplier_after : 10n ** 18n;
      const actual = word(res[j], 0);
      if (actual !== expected) mismatches.push(`${symbol.get(t)} ${t}: logs say ${expected}, uiMultiplier() says ${actual}`);
    });
  }
  console.error(`updates ${updates.length} on ${new Set(updates.map((u) => u.token)).size} tokens; still scheduled ${pending}; mismatches ${mismatches.length}`);
  if (mismatches.length > 0) {
    for (const m of mismatches) console.error(`  ${m}`);
    process.exitCode = 1;
    return;
  }

  const out = {
    taken_at: new Date().toISOString(),
    chain_id: RWA_CHAIN_ID,
    to_block: at,
    tokens_walked: tokens,
    updates: updates.map((u) => ({
      token: u.token,
      symbol: symbol.get(u.token)!,
      block: u.block,
      log_index: u.log_index,
      tx: u.tx,
      time: times.get(u.block)!,
      multiplier_before: u.multiplier_before.toString(),
      multiplier_after: u.multiplier_after.toString(),
      effective_at: u.effective_at,
    })),
  };
  writeFileSync(join(process.cwd(), "packages/rwa/corporate-actions.json"), `${JSON.stringify(out, null, 2)}\n`);
  console.error(`wrote packages/rwa/corporate-actions.json (to_block ${at})`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
