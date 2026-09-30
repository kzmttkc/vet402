// Freeze the canonical Stock Token list for /rwa (SPEC patch 018).
//
//   npx tsx packages/rwa/scripts/snapshot-registry.ts
//
// Sources, both public and both first-party for what they describe:
//   - Robinhood's asset list, the one behind https://docs.robinhood.com/chain/contracts
//     ("generated live from the on-chain asset registry"): https://api.robinhood.com/rhj/assets
//   - Chainlink's feed directory for Robinhood Chain:
//     https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json
// Every token address is then read on chain (symbol(), decimals()) and every feed
// (description(), decimals()) before it is written. A token whose on-chain symbol
// disagrees with the list, or a feed whose description does not name the token,
// is not written with that pairing. The output is packages/rwa/registry.json.
//
// Second root (SPEC patch 021). The list says which addresses Robinhood calls
// its Stock Tokens. The chain says what those addresses are. For every token the
// snapshot also records:
//   - code_hash: keccak256 of eth_getCode at `identity.read_at_block`
//   - beacon: the EIP-1967 beacon slot (the runtime code embeds the same address)
//   - factory_log: the Stock Token factory's deployment event that names the token
// A token whose code hash differs from the reference, whose beacon differs, or
// that no factory event names, is written with `needs_review` listing why. It is
// never silently dropped and never silently trusted.
//
//   npx tsx packages/rwa/scripts/snapshot-registry.ts --identity-only
//
// adds the on-chain identity to the existing registry.json without fetching the
// asset list again, so the token set and counts stay exactly as they were.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeAbiParameters, decodeFunctionResult, encodeFunctionData, getAddress, keccak256, parseAbi } from "viem";
import { RWA_CHAIN_ID, RWA_PUBLIC_RPC_URL } from "../config";
import { STOCK_TOKEN_BEACON, STOCK_TOKEN_CODE_HASH, STOCK_TOKEN_FACTORY, TOKEN_DEPLOYED_TOPIC0 } from "../identity";

const ASSETS_URL = "https://api.robinhood.com/rhj/assets";
const FEEDS_URL = "https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json";
const abi = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)", "function description() view returns (string)"]);

type Asset = { tokenSymbol: string; tokenName: string; isin: string; tokenDecimals: number; status: string; deployments: { chainId: number; contractAddress: string }[] };
type Feed = { name: string; proxyAddress: string; heartbeat: number; docs?: { assetClass?: string; baseAsset?: string; quoteAsset?: string } };

async function batch(calls: { to: string; fn: "symbol" | "decimals" | "description" }[]): Promise<(string | number | null)[]> {
  // The public RPC rate-limits items inside a batch (an item comes back with an
  // error while its neighbours answer), so a chunk is retried until every item
  // has a result, in small chunks with a pause.
  const out: (string | number | null)[] = [];
  const SIZE = 10;
  for (let i = 0; i < calls.length; i += SIZE) {
    const chunk = calls.slice(i, i + SIZE);
    const body = chunk.map((c, j) => ({ jsonrpc: "2.0", id: j, method: "eth_call", params: [{ to: c.to, data: encodeFunctionData({ abi, functionName: c.fn }) }, "latest"] }));
    let results: Map<number, string> | null = null;
    for (let attempt = 0; attempt < 8 && !results; attempt++) {
      if (attempt > 0) await new Promise((s) => setTimeout(s, 1500 * attempt));
      const r = await fetch(RWA_PUBLIC_RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) continue;
      const res = (await r.json()) as { id: number; result?: string; error?: unknown }[];
      if (!Array.isArray(res) || res.some((x) => x.error !== undefined || x.result === undefined)) continue;
      results = new Map(res.map((x) => [x.id, x.result as string]));
    }
    if (!results) throw new Error(`RPC kept refusing items ${i}..${i + chunk.length - 1}`);
    chunk.forEach((c, j) => {
      const hex = results!.get(j);
      if (!hex || hex === "0x") return out.push(null);
      try {
        out.push(decodeFunctionResult({ abi, functionName: c.fn, data: hex as `0x${string}` }) as string | number);
      } catch {
        out.push(null);
      }
    });
    await new Promise((s) => setTimeout(s, 700));
  }
  return out;
}

const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

async function rpcBatchRaw(body: { method: string; params: unknown[] }[]): Promise<unknown[]> {
  const req = body.map((b, id) => ({ jsonrpc: "2.0", id, ...b }));
  for (let attempt = 0; attempt < 10; attempt++) {
    if (attempt > 0) await new Promise((s) => setTimeout(s, 1500 * attempt));
    const r = await fetch(RWA_PUBLIC_RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
    if (!r.ok) continue;
    const res = (await r.json()) as { id: number; result?: unknown; error?: unknown }[];
    if (!Array.isArray(res) || res.some((x) => x.error !== undefined || x.result === undefined)) continue;
    return res.sort((a, b) => a.id - b.id).map((x) => x.result);
  }
  throw new Error(`RPC kept refusing ${body[0]?.method} x${body.length}`);
}

type Identity = {
  code_hash: string;
  beacon: string;
  factory_log: { block: number; tx: string; log_index: number } | null;
  needs_review: string[];
};

/**
 * Read the second root for `tokens`: code hash, beacon slot, and the factory's
 * deployment event. Pinned to one block so the reads describe one moment.
 */
async function readIdentity(tokens: string[]): Promise<{ block: number; implementation: string; factoryEvents: number; byToken: Map<string, Identity> }> {
  const [headHex] = (await rpcBatchRaw([{ method: "eth_blockNumber", params: [] }])) as string[];
  const block = Number(BigInt(headHex));
  const tag = `0x${block.toString(16)}`;
  const byToken = new Map<string, Identity>();
  const SIZE = 5;
  for (let i = 0; i < tokens.length; i += SIZE) {
    const chunk = tokens.slice(i, i + SIZE);
    const res = await rpcBatchRaw(chunk.flatMap((t) => [
      { method: "eth_getCode", params: [t, tag] },
      { method: "eth_getStorageAt", params: [t, BEACON_SLOT, tag] },
    ]));
    chunk.forEach((t, j) => {
      const code = res[2 * j] as string;
      const slot = res[2 * j + 1] as string;
      byToken.set(t.toLowerCase(), {
        code_hash: code && code !== "0x" ? keccak256(code as `0x${string}`) : "0x",
        beacon: getAddress(`0x${slot.slice(-40)}`),
        factory_log: null,
        needs_review: [],
      });
    });
    await new Promise((s) => setTimeout(s, 600));
  }
  const [implWord] = (await rpcBatchRaw([{ method: "eth_call", params: [{ to: STOCK_TOKEN_BEACON, data: "0x5c60da1b" }, tag] }])) as string[];
  const implementation = getAddress(`0x${implWord.slice(-40)}`);

  // The factory's deployment events: one address filter, spans of 10M blocks (the public RPC's cap).
  let factoryEvents = 0;
  for (let from = 0; from <= block; from += 10_000_000) {
    const to = Math.min(block, from + 9_999_999);
    const [logs] = (await rpcBatchRaw([{ method: "eth_getLogs", params: [{ address: STOCK_TOKEN_FACTORY, topics: [TOKEN_DEPLOYED_TOPIC0], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }] }])) as { data: string; blockNumber: string; transactionHash: string; logIndex: string }[][];
    for (const l of logs) {
      factoryEvents++;
      const [token] = decodeAbiParameters([{ type: "address" }, { type: "string" }, { type: "string" }], l.data as `0x${string}`);
      const id = byToken.get((token as string).toLowerCase());
      if (id && !id.factory_log) id.factory_log = { block: Number(BigInt(l.blockNumber)), tx: l.transactionHash, log_index: Number(BigInt(l.logIndex)) };
    }
    await new Promise((s) => setTimeout(s, 600));
  }
  for (const id of byToken.values()) {
    if (id.code_hash !== STOCK_TOKEN_CODE_HASH) id.needs_review.push("code_hash_differs");
    if (id.beacon.toLowerCase() !== STOCK_TOKEN_BEACON.toLowerCase()) id.needs_review.push("beacon_differs");
    if (!id.factory_log) id.needs_review.push("no_factory_event");
  }
  return { block, implementation, factoryEvents, byToken };
}

type TokenRow = { symbol: string; name: string; isin: string; token: string; feed: string | null; feed_description: string | null };

async function withIdentity<T extends { counts: Record<string, number>; tokens: TokenRow[] }>(snapshot: T) {
  const id = await readIdentity(snapshot.tokens.map((t) => t.token));
  const tokens = snapshot.tokens.map((t) => {
    const x = id.byToken.get(t.token.toLowerCase())!;
    return { ...t, code_hash: x.code_hash, beacon: x.beacon, factory_log: x.factory_log, needs_review: x.needs_review };
  });
  return {
    ...snapshot,
    identity: {
      read_at_block: id.block,
      reference_code_hash: STOCK_TOKEN_CODE_HASH,
      beacon: STOCK_TOKEN_BEACON,
      beacon_implementation: id.implementation,
      factory: STOCK_TOKEN_FACTORY,
      factory_event_topic0: TOKEN_DEPLOYED_TOPIC0,
      factory_events: id.factoryEvents,
      method:
        "keccak256(eth_getCode) and the EIP-1967 beacon slot of every token, and the beacon's implementation(), at read_at_block; " +
        "the factory's deployment events (data: token, name, symbol) over blocks 0..read_at_block, via " + RWA_PUBLIC_RPC_URL,
    },
    counts: {
      ...snapshot.counts,
      code_hash_matches: tokens.filter((t) => t.code_hash === STOCK_TOKEN_CODE_HASH).length,
      factory_deployed: tokens.filter((t) => t.factory_log).length,
      needs_review: tokens.filter((t) => t.needs_review.length > 0).length,
    },
    tokens,
  };
}

async function identityOnly() {
  const path = join(process.cwd(), "packages/rwa/registry.json");
  const snapshot = JSON.parse(readFileSync(path, "utf8"));
  // Strip any earlier identity so a rerun replaces it rather than stacking.
  delete snapshot.identity;
  for (const k of ["code_hash_matches", "factory_deployed", "needs_review"]) delete snapshot.counts[k];
  snapshot.tokens = snapshot.tokens.map(({ symbol, name, isin, token, feed, feed_description }: TokenRow) => ({ symbol, name, isin, token, feed, feed_description }));
  const before = snapshot.tokens.length;
  const out = await withIdentity(snapshot);
  if (out.tokens.length !== before) throw new Error("token count changed");
  writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out.counts), JSON.stringify({ read_at_block: out.identity.read_at_block, factory_events: out.identity.factory_events, implementation: out.identity.beacon_implementation }));
}

async function main() {
  if (process.argv.includes("--identity-only")) return identityOnly();
  const assets = ((await (await fetch(ASSETS_URL)).json()) as { assets: Asset[] }).assets;
  const feeds = (await (await fetch(FEEDS_URL)).json()) as Feed[];
  const listed = assets
    .filter((a) => a.status === "ASSET_STATUS_ACTIVE")
    .map((a) => ({ a, address: a.deployments.find((d) => d.chainId === RWA_CHAIN_ID)?.contractAddress }))
    .filter((x): x is { a: Asset; address: string } => !!x.address);

  const onchain = await batch(listed.flatMap(({ address }) => [{ to: address, fn: "symbol" as const }, { to: address, fn: "decimals" as const }]));
  const equityFeeds = feeds.filter((f) => f.docs?.assetClass === "Equity" && f.docs?.quoteAsset === "USD" && f.proxyAddress);
  const feedReads = await batch(equityFeeds.flatMap((f) => [{ to: f.proxyAddress, fn: "description" as const }, { to: f.proxyAddress, fn: "decimals" as const }]));
  const rejected: string[] = [];
  const feedBySymbol = new Map<string, { proxy: string; description: string; decimals: number; heartbeat: number }>();
  const ambiguous = new Set<string>();
  equityFeeds.forEach((f, i) => {
    const description = feedReads[2 * i] as string | null;
    const decimals = feedReads[2 * i + 1] as number | null;
    if (!description || decimals === null) {
      rejected.push(`feed ${f.proxyAddress}: description/decimals unreadable`);
      return;
    }
    // Two formats on chain (read 2026-09-29): "RHNVDA / USD" and "Robinhood QQQ / USD"
    // (one feed says "Robinhood DELL-USD"). Only a description that names the token counts,
    // and it must agree with the directory's own baseAsset.
    const head = description.split(/\s*\/\s*USD$|-USD$/)[0].trim();
    const base = head.startsWith("Robinhood ") ? head.slice("Robinhood ".length).trim() : head.replace(/^RH(?=[A-Z])/, "");
    const dirBase = (f.docs?.baseAsset ?? "").replace(/^RH(?=[A-Z])/, "");
    if (dirBase && dirBase !== base) {
      rejected.push(`feed ${f.proxyAddress}: description "${description}" vs directory baseAsset ${f.docs?.baseAsset}`);
      return;
    }
    if (Number(decimals) !== 8) {
      rejected.push(`feed ${f.proxyAddress} (${description}): ${decimals} decimals, the USD formula needs 8`);
      return;
    }
    if (feedBySymbol.has(base) || ambiguous.has(base)) {
      rejected.push(`feed ${f.proxyAddress} (${description}): more than one feed for ${base}; none is paired`);
      feedBySymbol.delete(base);
      ambiguous.add(base);
      return;
    }
    feedBySymbol.set(base, { proxy: getAddress(f.proxyAddress), description, decimals: Number(decimals), heartbeat: f.heartbeat });
  });

  const tokens = listed
    .map(({ a, address }, i) => {
      const sym = onchain[2 * i] as string | null;
      const dec = onchain[2 * i + 1] as number | null;
      if (sym !== a.tokenSymbol || Number(dec) !== a.tokenDecimals) {
        rejected.push(`${a.tokenSymbol} ${address}: on-chain symbol ${sym} decimals ${dec}`);
        return null;
      }
      const feed = feedBySymbol.get(a.tokenSymbol) ?? null;
      return {
        symbol: a.tokenSymbol,
        name: a.tokenName.replace(/\s*•\s*Robinhood Token$/, ""),
        isin: a.isin,
        token: getAddress(address),
        feed: feed ? feed.proxy : null,
        feed_description: feed ? feed.description : null,
      };
    })
    .filter((t): t is NonNullable<typeof t> => t !== null)
    .sort((x, y) => x.symbol.localeCompare(y.symbol));

  const out = await withIdentity({
    taken_at: new Date().toISOString(),
    chain_id: RWA_CHAIN_ID,
    sources: { tokens: ASSETS_URL, tokens_page: "https://docs.robinhood.com/chain/contracts", feeds: FEEDS_URL },
    checked_on_chain: "symbol() and decimals() of every token; description() and decimals() of every equity feed, via " + RWA_PUBLIC_RPC_URL,
    counts: { listed: listed.length, written: tokens.length, with_feed: tokens.filter((t) => t.feed).length, rejected: rejected.length },
    rejected,
    tokens,
  });
  const path = join(process.cwd(), "packages/rwa/registry.json");
  writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out.counts), rejected.slice(0, 5));
}

main().catch((e) => {
  console.error(String(e).slice(0, 400));
  process.exit(1);
});
