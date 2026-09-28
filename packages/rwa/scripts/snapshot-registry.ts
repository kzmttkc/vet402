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
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeFunctionResult, encodeFunctionData, getAddress, parseAbi } from "viem";
import { RWA_CHAIN_ID, RWA_RPC_URL } from "../config";

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
      const r = await fetch(RWA_RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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

async function main() {
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

  const out = {
    taken_at: new Date().toISOString(),
    chain_id: RWA_CHAIN_ID,
    sources: { tokens: ASSETS_URL, tokens_page: "https://docs.robinhood.com/chain/contracts", feeds: FEEDS_URL },
    checked_on_chain: "symbol() and decimals() of every token; description() and decimals() of every equity feed, via " + RWA_RPC_URL,
    counts: { listed: listed.length, written: tokens.length, with_feed: tokens.filter((t) => t.feed).length, rejected: rejected.length },
    rejected,
    tokens,
  };
  const path = join(process.cwd(), "packages/rwa/registry.json");
  writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out.counts), rejected.slice(0, 5));
}

main().catch((e) => {
  console.error(String(e).slice(0, 400));
  process.exit(1);
});
