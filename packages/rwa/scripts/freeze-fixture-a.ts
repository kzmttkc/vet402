// Freeze Fixture A (SPEC §11) from Robinhood Chain and write fixtures/rwa/A.json.
//
// Block N = head - 100. The holder is picked by a fixed rule so the choice is
// repeatable: walking NVDA Transfer logs in [N - 2000, N] from newest to oldest,
// the first recipient that has no code at N and holds at least 1e18 raw at N.
// The expected mark is computed here with the SPEC formula written out inline,
// not with packages/rwa/usd.ts, so the test compares two separate code paths.
//
// Run from the repo root: npx tsx packages/rwa/scripts/freeze-fixture-a.ts

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { NVDA, RWA_CHAIN_ID, RWA_RPC_URL } from "../config";

const SEL = {
  symbol: "0x95d89b41", // symbol()
  decimals: "0x313ce567", // decimals()
  balanceOf: "0x70a08231", // balanceOf(address)
  uiMultiplier: "0xa60bf13d", // uiMultiplier()
  oraclePaused: "0x7706ba52", // oraclePaused()
  description: "0x7284e416", // description()
  latestRoundData: "0xfeaf968c", // latestRoundData()
};
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ONE = 10n ** 18n;

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RWA_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error || body.result === undefined) {
    throw new Error(`${method} failed: ${body.error?.message ?? res.status}`);
  }
  return body.result;
}

const hex = (n: number) => `0x${n.toString(16)}`;
const word = (data: string, i: number) => BigInt(`0x${data.slice(2 + 64 * i, 2 + 64 * (i + 1))}`);
const abiString = (data: string) => {
  const len = Number(word(data, 1));
  return Buffer.from(data.slice(2 + 128, 2 + 128 + len * 2), "hex").toString("utf8");
};
const call = (to: string, data: string, block: number) => rpc<string>("eth_call", [{ to, data }, hex(block)]);

async function main() {
  const chainId = Number(await rpc<string>("eth_chainId", []));
  if (chainId !== RWA_CHAIN_ID) throw new Error(`expected chain ${RWA_CHAIN_ID}, got ${chainId}`);

  const head = Number(await rpc<string>("eth_blockNumber", []));
  const N = head - 100;
  const block = await rpc<{ hash: string; timestamp: string }>("eth_getBlockByNumber", [hex(N), false]);

  const logs = await rpc<{ topics: string[]; transactionHash: string; logIndex: string; blockNumber: string }[]>(
    "eth_getLogs",
    [{ address: NVDA.token, topics: [TRANSFER_TOPIC], fromBlock: hex(N - 2000), toBlock: hex(N) }],
  );

  let holder: { address: string; raw: bigint; tx: string; logIndex: number; block: number } | undefined;
  for (const log of [...logs].reverse()) {
    const to = `0x${log.topics[2].slice(26)}`;
    if (/^0x0{40}$/.test(to)) continue;
    const code = await rpc<string>("eth_getCode", [to, hex(N)]);
    if (code !== "0x") continue;
    const raw = word(await call(NVDA.token, SEL.balanceOf + log.topics[2].slice(2), N), 0);
    if (raw < ONE) continue;
    holder = { address: to, raw, tx: log.transactionHash, logIndex: Number(log.logIndex), block: Number(log.blockNumber) };
    break;
  }
  if (!holder) throw new Error("no holder matched the selection rule");

  const symbol = abiString(await call(NVDA.token, SEL.symbol, N));
  const tokenDecimals = Number(word(await call(NVDA.token, SEL.decimals, N), 0));
  const uiMultiplier = word(await call(NVDA.token, SEL.uiMultiplier, N), 0);
  const oraclePaused = word(await call(NVDA.token, SEL.oraclePaused, N), 0) !== 0n;
  const feedDescription = abiString(await call(NVDA.feed, SEL.description, N));
  const feedDecimals = Number(word(await call(NVDA.feed, SEL.decimals, N), 0));
  const round = await call(NVDA.feed, SEL.latestRoundData, N);
  const answer = word(round, 1);

  const usdCents = (holder.raw * answer * 100n) / 10n ** 8n / 10n ** 18n;

  const fixture = {
    fixture_id: "A",
    spec: "docs/rwa/SPEC.md §2, §11",
    method_version: "rwa-recon-0.1",
    chain_id: chainId,
    rpc: RWA_RPC_URL,
    frozen_at: new Date().toISOString(),
    head_at_freeze: head,
    block: N,
    block_hash: block.hash,
    block_timestamp: Number(block.timestamp),
    token: { address: NVDA.token, symbol, decimals: tokenDecimals },
    feed: { address: NVDA.feed, description: feedDescription, decimals: feedDecimals },
    holder: {
      address: holder.address,
      selection_rule:
        "newest NVDA Transfer recipient in [N-2000, N] with no code at N and balanceOf >= 1e18 at N",
      source_tx: holder.tx,
      source_log_index: holder.logIndex,
      source_block: holder.block,
    },
    raw: holder.raw.toString(),
    ui_multiplier: uiMultiplier.toString(),
    oracle_paused: oraclePaused,
    feed_round: {
      round_id: word(round, 0).toString(),
      answer: answer.toString(),
      started_at: word(round, 2).toString(),
      updated_at: word(round, 3).toString(),
      answered_in_round: word(round, 4).toString(),
    },
    expected: {
      usd_cents: usdCents.toString(),
      formula: "raw * feed_answer * 100 / 1e8 / 1e18 (integer floor); uiMultiplier is not applied",
    },
  };

  const out = join(process.cwd(), "fixtures/rwa/A.json");
  writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`wrote ${out}: block ${N}, raw ${holder.raw}, usd_cents ${usdCents}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
