// Build the look-alike fixture for one wallet (SPEC patch 021).
//
//   npx tsx packages/rwa/scripts/lookalikes-fixture.ts <address> <logs.json> <logs_to_block> [out.json]
//   npx tsx packages/rwa/scripts/lookalikes-fixture.ts --extend fixtures/rwa/lookalikes-demo.json
//
// <logs.json> is a full-history search already done: every Transfer log with the
// wallet as topic1 or topic2, no address filter, blocks 0..<logs_to_block>. On
// the public RPC that search is ~5,000 queries of 30,000 blocks and ~55 minutes,
// far too long for a live record, so it is done once and frozen here. This
// script extends it from <logs_to_block>+1 to the current head, reads the
// symbol, name and code hash of every non-canonical token met, keeps the
// look-alikes, and checks each kept log against its transaction receipt.
// --extend walks an existing fixture forward to the current head the same way
// (run it before a demo: the live record adds only the last 120,000 blocks).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RWA_PUBLIC_RPC_URL, USDG, WETH } from "../config";
import { TOPICS } from "../events";
import { judgeToken } from "../lookalike";
import { fromRawLog, readTokenMeta, RECENT_SPAN_BLOCKS, usdgCounterparties, type LookalikeFixture, type RawLog, type SeenTransfer } from "../lookalike-scan";
import { CANONICAL_SET } from "../registry";
import { hex, padAddress, rpcBatch, rpcCall } from "../rpc";

const patient = { retries: 8 };

async function walk(me: string, fromBlock: number, head: number): Promise<{ logs: RawLog[]; queries: number }> {
  const pad = padAddress(me);
  const logs: RawLog[] = [];
  let queries = 0;
  for (let from = fromBlock; from <= head; from += RECENT_SPAN_BLOCKS) {
    const to = Math.min(head, from + RECENT_SPAN_BLOCKS - 1);
    const res = await rpcBatch<RawLog[]>(
      [
        { method: "eth_getLogs", params: [{ topics: [TOPICS.transfer, pad], fromBlock: hex(from), toBlock: hex(to) }] },
        { method: "eth_getLogs", params: [{ topics: [TOPICS.transfer, null, pad], fromBlock: hex(from), toBlock: hex(to) }] },
      ],
      patient,
    );
    queries += 2;
    for (const r of res) logs.push(...r);
    await new Promise((s) => setTimeout(s, 400));
  }
  return { logs, queries };
}

const bare = (t: SeenTransfer) => ({ token: t.token, from: t.from, to: t.to, block: t.block, tx: t.tx, log_index: t.log_index, amount_raw: t.amount_raw });

const skip = (t: string) => CANONICAL_SET.has(t) || t === USDG.toLowerCase() || t === WETH.toLowerCase();

async function verify(me: string, transfers: { tx: string; log_index: number; token: string }[]) {
  // Each kept log must be in its receipt, as stated.
  for (const t of transfers) {
    const r = await rpcCall<{ from: string; logs: { address: string; topics: string[]; data: string; logIndex: string }[] }>("eth_getTransactionReceipt", [t.tx], patient);
    const l = r.logs.find((x) => Number(BigInt(x.logIndex)) === t.log_index);
    if (!l || l.address.toLowerCase() !== t.token || l.topics[0] !== TOPICS.transfer) throw new Error(`receipt of ${t.tx} does not hold log ${t.log_index}`);
    console.log(t.tx, "log", t.log_index, "signer", r.from.toLowerCase() === me ? "the wallet" : r.from);
  }
}

async function extend(path: string) {
  const fx = JSON.parse(readFileSync(path, "utf8")) as LookalikeFixture;
  const me = fx.address;
  const head = Number(BigInt(await rpcCall<string>("eth_blockNumber", [], patient)));
  const { logs, queries } = await walk(me, fx.scanned_to_block + 1, head);
  const fresh = logs.filter((l) => l.topics.length === 3 && l.topics[0] === TOPICS.transfer).map((l) => fromRawLog(l, "fixture"));
  const seen = new Set(fx.tokens_seen);
  const newTokens = [...new Set(fresh.map((t) => t.token))].filter((t) => !skip(t) && !seen.has(t));
  const meta = await readTokenMeta(newTokens, head, patient);
  for (const t of newTokens) {
    seen.add(t);
    const m = meta.get(t)!;
    const j = judgeToken({ address: t, symbol: m.symbol, name: m.name, codeHash: m.codeHash });
    if (j.lookalike || j.needs_review) fx.tokens[t] = m;
  }
  const added = fresh.filter((t) => fx.tokens[t.token]).map(bare);
  await verify(me, added);
  fx.transfers.push(...added);
  fx.counterparties = [...new Set([...fx.counterparties, ...usdgCounterparties(fresh, me)])].sort();
  fx.tokens_seen = [...seen].sort();
  fx.source = fx.source.replace(/blocks 0-\d+:/, `blocks 0-${head}:`);
  fx.scanned_to_block = head;
  writeFileSync(path, JSON.stringify(fx, null, 2) + "\n");
  console.log(JSON.stringify({ head, queries, new_logs: fresh.length, new_tokens: newTokens.length, added: added.length }));
}

async function main() {
  if (process.argv[2] === "--extend") return extend(process.argv[3]);
  const [address, logsPath, logsTo, outArg] = process.argv.slice(2);
  if (!address || !logsPath || !logsTo) throw new Error("usage: <address> <logs.json> <logs_to_block> [out.json]");
  const me = address.toLowerCase();
  const logs: RawLog[] = JSON.parse(readFileSync(logsPath, "utf8"));
  const head = Number(BigInt(await rpcCall<string>("eth_blockNumber", [], patient)));
  const delta = await walk(me, Number(logsTo) + 1, head);
  logs.push(...delta.logs);
  const deltaQueries = delta.queries;
  const all = [...new Map(logs.filter((l) => l.topics.length === 3 && l.topics[0] === TOPICS.transfer).map((l) => [`${l.transactionHash}:${Number(BigInt(l.logIndex))}`, fromRawLog(l, "fixture")])).values()];
  const tokens = [...new Set(all.map((t) => t.token))].filter((t) => !skip(t));
  const meta = await readTokenMeta(tokens, head, patient);
  const kept = tokens.filter((t) => {
    const m = meta.get(t)!;
    const j = judgeToken({ address: t, symbol: m.symbol, name: m.name, codeHash: m.codeHash });
    return j.lookalike || j.needs_review;
  });
  const transfers = all.filter((t) => kept.includes(t.token)).sort((a, b) => a.block - b.block || a.log_index - b.log_index);

  await verify(me, transfers);

  const fixture: LookalikeFixture = {
    address: me,
    source: `full-history search, blocks 0-${head}: eth_getLogs with topics [Transfer, wallet] and [Transfer, null, wallet], no address filter, ${RECENT_SPAN_BLOCKS}-block spans, via ${RWA_PUBLIC_RPC_URL} (blocks 0-${logsTo} on 2026-09-30, the rest by packages/rwa/scripts/lookalikes-fixture.ts)`,
    scanned_from_block: 0,
    scanned_to_block: head,
    metadata_read_at_block: head,
    tokens_seen: [...tokens].sort(),
    counterparties: usdgCounterparties(all, me).sort(),
    tokens: Object.fromEntries(kept.map((t) => [t, meta.get(t)!])),
    transfers: transfers.map(bare),
  };
  const out = outArg ?? join(process.cwd(), "fixtures/rwa/lookalikes-demo.json");
  writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(JSON.stringify({ head, deltaQueries, logs: all.length, tokens_seen: tokens.length, kept: kept.map((t) => meta.get(t)!.symbol), transfers: transfers.length, counterparties: fixture.counterparties.length }));
}

main().catch((e) => {
  console.error(String((e as Error)?.stack ?? e).slice(0, 1200));
  process.exit(1);
});
