// SPEC patch 020 (reach): any wallet gets a fast, stable, honest answer.
//
// - an address holding no canonical Stock Token gets the same stated answer every time,
//   at the cost of NVDA's receiving side only on the public RPC
// - with RWA_ALCHEMY_URL, alchemy_getAssetTransfers finds every canonical token the
//   address ever moved, so a sold-out position is in scope and the gap is dropped
// - without it, nothing changes: no alchemy_* call, the log walk, the gap stays
// - the read RPC is chosen from env at call time and its URL never leaks into an error
//
// Chain answers are scripted; response shapes follow the JSON-RPC spec and Alchemy's
// public docs for alchemy_getAssetTransfers / alchemy_getTokenBalances.
//
// Run from the repo root: npx tsx --test packages/rwa/test/reach.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeFunctionResult, parseAbi } from "viem";
import { NextRequest } from "next/server";
import { AlchemyNotConfigured, getAddressTransfers, getAssetTransfers, getTokenBalances } from "../alchemy";
import { failureAnswer } from "../answers";
import { ReconstructionTimeout, TooBusy, __resetFactsCacheForTest, cachedFactsWith } from "../cache";
import { MAX_LOG_RANGES, fetchMultiplierLogs, fetchTransfersIn } from "../chain";
import { NVDA, RWA_PUBLIC_RPC_URL, RWA_RPC_FALLBACK_URL, rwaAlchemyUrl, rwaRpcSource, rwaRpcUrl } from "../config";
import { TOPICS } from "../events";
import { MULTICALL3 } from "../feed";
import { MAX_TOKENS_PUBLIC, MAX_TXS_ALCHEMY, NoStockTokenActivity, SCOPE_RULE_ALL, WalletTooLarge, noActivityAnswer, reconstructFacts, type RwaFacts } from "../facts";
import { CANONICAL_TOKENS, tokenByAddress } from "../registry";
import { __resetRefusedUrlsForTest, noteRefused, rpcCall } from "../rpc";
import { GET } from "../../../src/app/api/v1/rwa/facts/[address]/route";

const ME = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const TSLA = tokenByAddress("0x322F0929c4625eD5bAd873c95208D54E1c003b2d")!;
const HEAD = 75_000_000;
const ALCHEMY = "https://alchemy.test/v2/SECRETKEY";
const TS = 1_790_000_000;

const u256 = (n: bigint) => encodeAbiParameters([{ type: "uint256" }], [n]);
const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
const multicallAbi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);

type Call = { url: string; method: string; params: unknown[] };
type Chain = {
  balances?: Record<string, bigint>;
  receipts?: Record<string, object>;
  alchemy?: (params: Record<string, unknown>) => object;
  logs?: (filter: Record<string, unknown>) => object[];
  logsError?: string;
};

/** A scripted Robinhood Chain behind fetch. Records every JSON-RPC item it answers. */
function fakeChain(chain: Chain) {
  const calls: Call[] = [];
  const answer = (url: string, method: string, params: unknown[]): { result?: unknown; error?: object } => {
    calls.push({ url, method, params });
    switch (method) {
      case "eth_blockNumber":
        return { result: `0x${HEAD.toString(16)}` };
      case "eth_getBlockByNumber":
        return { result: { timestamp: `0x${TS.toString(16)}` } };
      case "eth_getTransactionCount":
        return { result: "0x3" };
      case "eth_getCode":
        return { result: "0x" };
      case "eth_getLogs":
        if (chain.logsError) return { error: { code: -32602, message: chain.logsError } };
        return { result: chain.logs ? chain.logs(params[0] as Record<string, unknown>) : [] };
      case "eth_getTransactionReceipt":
        return { result: chain.receipts?.[params[0] as string] ?? null };
      case "alchemy_getAssetTransfers":
        return { result: chain.alchemy ? chain.alchemy(params[0] as Record<string, unknown>) : { transfers: [] } };
      case "eth_call": {
        const { to, data } = params[0] as { to: string; data: string };
        if (to.toLowerCase() === MULTICALL3.toLowerCase()) {
          const result = CANONICAL_TOKENS.map((t) => ({ success: true, returnData: u256(chain.balances?.[t.token.toLowerCase()] ?? 0n) }));
          return { result: encodeFunctionResult({ abi: multicallAbi, functionName: "aggregate3", result }) };
        }
        const sel = data.slice(0, 10);
        if (sel === "0x70a08231") return { result: u256(chain.balances?.[to.toLowerCase()] ?? 0n) };
        if (sel === "0xa60bf13d") return { result: u256(10n ** 18n) };
        if (sel === "0x7706ba52") return { result: u256(0n) };
        if (sel === "0x313ce567") return { result: u256(8n) };
        if (sel === "0xfeaf968c")
          return { result: encodeAbiParameters(Array(5).fill({ type: "uint256" }), [1n, 40_000_000_000n, BigInt(TS - 60), BigInt(TS - 60), 1n]) };
        return { error: { code: 3, message: "execution reverted" } };
      }
      default:
        return { error: { code: -32601, message: `unscripted ${method}` } };
    }
  };
  const fetchImpl = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const list = Array.isArray(body) ? body : [body];
    const out = list.map((b: { id: number; method: string; params: unknown[] }) => ({ jsonrpc: "2.0", id: b.id, ...answer(url, b.method, b.params) }));
    return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), { status: 200 });
  }) as unknown as typeof fetch;
  const count = (m: string) => calls.filter((c) => c.method === m).length;
  return { fetchImpl, calls, count, opts: { fetchImpl, sleep: async () => {} } };
}

function receipt(hash: string, from: string, to: string, token: string, sender: string, recipient: string, amount: bigint, block: number) {
  return {
    transactionHash: hash,
    blockNumber: `0x${block.toString(16)}`,
    from,
    to,
    logs: [{ address: token.toLowerCase(), topics: [TOPICS.transfer, pad(sender), pad(recipient)], data: u256(amount), logIndex: "0x0" }],
  };
}

const saved = { alchemy: process.env.RWA_ALCHEMY_URL, rpc: process.env.RWA_RPC_URL, key: process.env.ALCHEMY_API_KEY };
beforeEach(() => {
  delete process.env.RWA_ALCHEMY_URL;
  delete process.env.RWA_RPC_URL;
  delete process.env.ALCHEMY_API_KEY;
  __resetFactsCacheForTest();
  __resetRefusedUrlsForTest();
});
afterEach(() => {
  if (saved.key === undefined) delete process.env.ALCHEMY_API_KEY;
  else process.env.ALCHEMY_API_KEY = saved.key;
  if (saved.alchemy === undefined) delete process.env.RWA_ALCHEMY_URL;
  else process.env.RWA_ALCHEMY_URL = saved.alchemy;
  if (saved.rpc === undefined) delete process.env.RWA_RPC_URL;
  else process.env.RWA_RPC_URL = saved.rpc;
});

// ---------------------------------------------------------------- RPC choice

test("the read RPC: Alchemy, else RWA_RPC_URL, else the public RPC; anything not https is ignored", () => {
  assert.equal(rwaRpcUrl({}), RWA_PUBLIC_RPC_URL);
  assert.equal(rwaRpcSource({}), "public");
  assert.equal(rwaRpcUrl({ RWA_RPC_URL: "https://rpc.example/abc" }), "https://rpc.example/abc");
  assert.equal(rwaRpcSource({ RWA_RPC_URL: "https://rpc.example/abc" }), "custom");
  assert.equal(rwaRpcUrl({ RWA_RPC_URL: "https://rpc.example/abc", RWA_ALCHEMY_URL: ALCHEMY }), ALCHEMY);
  assert.equal(rwaRpcSource({ RWA_ALCHEMY_URL: ALCHEMY }), "alchemy");
  for (const bad of ["", "  ", "http://plain.example", "rpc.example", "https://has space"]) {
    assert.equal(rwaRpcUrl({ RWA_RPC_URL: bad, RWA_ALCHEMY_URL: bad }), RWA_PUBLIC_RPC_URL, JSON.stringify(bad));
    assert.equal(rwaAlchemyUrl({ RWA_ALCHEMY_URL: bad }), null);
  }
});

test("every read goes to the env RPC, chosen at call time; head reads may still fall back to the public backup", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (url: string, init: { body: string }) => {
    seen.push(url);
    const b = JSON.parse(init.body);
    if (seen.length === 1 && b.method === "eth_blockNumber") return new Response("busy", { status: 503 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, result: "0x1" }), { status: 200 });
  }) as unknown as typeof fetch;
  await rpcCall("eth_getTransactionReceipt", ["0x0"], { fetchImpl, sleep: async () => {} });
  assert.deepEqual(seen, [RWA_PUBLIC_RPC_URL]);

  process.env.RWA_RPC_URL = "https://rpc.example/key";
  seen.length = 0;
  await rpcCall("eth_blockNumber", [], { fetchImpl, retries: 0, sleep: async () => {} });
  assert.deepEqual(seen, ["https://rpc.example/key", RWA_RPC_FALLBACK_URL]);

  process.env.RWA_ALCHEMY_URL = ALCHEMY;
  seen.length = 0;
  await rpcCall("eth_call", [{}, "latest"], { fetchImpl, sleep: async () => {} });
  assert.deepEqual(seen, [ALCHEMY]);
});

test("a transport error never carries the RPC URL (it may hold a key)", async () => {
  const fetchImpl = (async (url: string) => {
    throw new TypeError(`Failed to parse URL from ${url}`);
  }) as unknown as typeof fetch;
  await assert.rejects(
    rpcCall("eth_call", [], { fetchImpl, urls: [ALCHEMY], retries: 1, sleep: async () => {} }),
    (e: unknown) => e instanceof Error && !e.message.includes("SECRETKEY") && /transport TypeError/.test(e.message),
  );
});

test("a provider that allows only a few thousand blocks per log query is refused at once, not walked for minutes", async () => {
  const c = fakeChain({ logsError: "query spans 10000000 blocks (0 to 9999999), but only 10000 are allowed for this request; narrow the block range" });
  await assert.rejects(fetchTransfersIn(NVDA.token, ME, HEAD, c.opts), /log span limit too small/);
  assert.ok(c.count("eth_getLogs") <= 4, `sent ${c.count("eth_getLogs")} log queries`);
  assert.ok(MAX_LOG_RANGES >= 8, "the public RPC's 10M-block ranges must still fit");
});

// ---------------------------------------------------------------- Alchemy client

test("getAssetTransfers: canonical list split per request, every page followed, documented params", async () => {
  const pages: Record<string, unknown>[] = [];
  const c = fakeChain({
    alchemy: (p) => {
      pages.push(p);
      if (pages.length === 1) return { transfers: [{ hash: "0xa", uniqueId: "0xa:log:0" }], pageKey: "next-1" };
      return { transfers: [{ hash: `0x${pages.length}`, uniqueId: `0x${pages.length}:log:0` }] };
    },
  });
  const got = await getAssetTransfers(
    { toAddress: ME.toUpperCase().replace("0X", "0x"), contractAddresses: CANONICAL_TOKENS.map((t) => t.token), toBlock: HEAD },
    { url: ALCHEMY, ...c.opts },
  );
  assert.equal(pages.length, 3, "195 contracts → 2 requests, the first with a second page");
  assert.equal(got.length, 3);
  assert.equal((pages[0].contractAddresses as string[]).length, 100);
  assert.equal((pages[2].contractAddresses as string[]).length, 95);
  assert.equal(pages[1].pageKey, "next-1");
  assert.equal(pages[0].toAddress, ME);
  assert.equal(pages[0].toBlock, `0x${HEAD.toString(16)}`);
  assert.equal(pages[0].fromBlock, "0x0");
  assert.deepEqual(pages[0].category, ["erc20"]);
  assert.equal(pages[0].excludeZeroValue, false);
  assert.equal(pages[0].maxCount, "0x3e8");
  assert.ok(c.calls.every((x) => x.url === ALCHEMY));
});

test("getAddressTransfers asks both sides and keeps each transfer once; not configured → AlchemyNotConfigured", async () => {
  const c = fakeChain({ alchemy: () => ({ transfers: [{ hash: "0xa", uniqueId: "0xa:log:0" }] }) });
  const got = await getAddressTransfers(ME, {}, { url: ALCHEMY, ...c.opts });
  assert.equal(got.length, 1);
  const sides = c.calls.map((x) => x.params[0] as Record<string, unknown>);
  assert.ok(sides.some((p) => p.fromAddress === ME) && sides.some((p) => p.toAddress === ME));
  await assert.rejects(getAssetTransfers({ toAddress: ME }), (e: unknown) => e instanceof AlchemyNotConfigured);
  await assert.rejects(getTokenBalances(ME), (e: unknown) => e instanceof AlchemyNotConfigured);
});

test("getTokenBalances parses the documented answer, an errored contract reads as null", async () => {
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const b = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: b.id,
        result: {
          address: ME,
          tokenBalances: [
            { contractAddress: TSLA.token, tokenBalance: "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000", error: null },
            { contractAddress: NVDA.token, tokenBalance: null, error: "execution reverted" },
          ],
        },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const got = await getTokenBalances(ME, [TSLA.token, NVDA.token], { url: ALCHEMY, fetchImpl, sleep: async () => {} });
  assert.deepEqual(got, [
    { contractAddress: TSLA.token.toLowerCase(), tokenBalance: 10n ** 18n },
    { contractAddress: NVDA.token.toLowerCase(), tokenBalance: null },
  ]);
});

// ---------------------------------------------------------------- reconstruction

test("public RPC, an address holding nothing: the stated answer, NVDA's receiving side only, the same answer twice", async () => {
  const c = fakeChain({});
  const run = () => reconstructFacts(ME, { ...c.opts, alchemyUrl: null }).then(() => assert.fail("expected no activity"), (e) => e);
  const first = await run();
  assert.ok(first instanceof NoStockTokenActivity);
  assert.equal(c.count("eth_getLogs"), 8, "one side of NVDA at 10M blocks per range, not both sides");
  assert.equal(c.count("alchemy_getAssetTransfers"), 0);
  assert.deepEqual(first.answer, {
    error: "no_stock_token_activity",
    address: ME,
    chain_id: 4663,
    as_of: new Date(TS * 1000).toISOString(),
    as_of_block: HEAD,
    method_version: first.answer.method_version,
    registry_tokens: 195,
    held_tokens: 0,
    history_checked: "nvda_only",
    sent_tx_count: 3,
    is_contract: false,
    gaps: ["exited_positions_not_scanned"],
    detail:
      `Holds none of the 195 canonical Stock Tokens at block ${HEAD}. NVDA was never transferred to this address. ` +
      "Positions in the other tokens that were opened and fully closed are not scanned.",
  });
  const second = await run();
  assert.deepEqual(second.answer, first.answer);
});

test("with Alchemy, an address holding nothing: every canonical token checked, no log walk, no gap", async () => {
  const c = fakeChain({});
  const e = await reconstructFacts(ME, { ...c.opts, alchemyUrl: ALCHEMY }).catch((x) => x);
  assert.ok(e instanceof NoStockTokenActivity);
  assert.equal(e.answer.history_checked, "every_canonical_token");
  assert.deepEqual(e.answer.gaps, []);
  assert.equal(c.count("eth_getLogs"), 0);
  assert.equal(c.count("alchemy_getAssetTransfers"), 2, "2 sides, every ERC-20, one read shared with the look-alike search");
  assert.ok(c.calls.filter((x) => x.method === "alchemy_getAssetTransfers").every((x) => x.url === ALCHEMY));
});

test("with Alchemy, a position opened and fully closed is found and replayed; the exited gap is dropped", async () => {
  const tsla = TSLA.token.toLowerCase();
  const c = fakeChain({
    alchemy: (p) => {
      const inChunk = !p.contractAddresses || (p.contractAddresses as string[]).includes(tsla);
      if (!inChunk) return { transfers: [] };
      const t = (hash: string, from: string, to: string) => ({
        blockNum: "0x10",
        uniqueId: `${hash}:log:0`,
        hash,
        from,
        to,
        value: 5,
        asset: "TSLA",
        category: "erc20",
        rawContract: { value: "0x4563918244f40000", address: tsla, decimal: "0x12" },
      });
      return { transfers: p.toAddress ? [t("0x" + "a".repeat(64), OTHER, ME)] : [t("0x" + "b".repeat(64), ME, OTHER)] };
    },
    receipts: {
      ["0x" + "a".repeat(64)]: receipt("0x" + "a".repeat(64), OTHER, tsla, tsla, OTHER, ME, 5n * 10n ** 18n, 16),
      ["0x" + "b".repeat(64)]: receipt("0x" + "b".repeat(64), ME, tsla, tsla, ME, OTHER, 5n * 10n ** 18n, 17),
    },
  });
  const f: RwaFacts = await reconstructFacts(ME, { ...c.opts, alchemyUrl: ALCHEMY });
  assert.deepEqual(f.scope.scanned, ["TSLA"]);
  assert.equal(f.scope.rule, SCOPE_RULE_ALL);
  assert.ok(!f.gaps.includes("exited_positions_not_scanned"), f.gaps.join(","));
  assert.equal(f.tokens.length, 1);
  assert.equal(f.tokens[0].raw, "0");
  assert.equal(f.tokens[0].replayed_raw, "0");
  assert.equal(f.events_summary.transfer, 2);
  assert.equal(c.count("eth_getLogs"), 0, "NVDA is not walked when Alchemy has answered for every token");
});

test("without Alchemy nothing changes: no alchemy_* call, NVDA walked both sides, the exited gap stays", async () => {
  const nvda = NVDA.token.toLowerCase();
  const hash = "0x" + "c".repeat(64);
  const c = fakeChain({
    balances: { [nvda]: 2n * 10n ** 18n },
    logs: (f) => ((f.topics as (string | null)[])[2] === pad(ME) && f.fromBlock === "0x0" ? [{ transactionHash: hash, blockNumber: "0x10", logIndex: "0x0", topics: [], data: "0x", address: nvda }] : []),
    receipts: { [hash]: receipt(hash, OTHER, nvda, nvda, OTHER, ME, 2n * 10n ** 18n, 16) },
  });
  const f = await reconstructFacts(ME, c.opts);
  assert.equal(c.count("alchemy_getAssetTransfers"), 0);
  const nvdaLogs = c.calls.filter((x) => x.method === "eth_getLogs" && (x.params[0] as { address?: string }).address === nvda).length;
  assert.equal(nvdaLogs, 16, "both sides of NVDA, 8 ranges each (the look-alike search reads its own recent window)");
  assert.ok(f.gaps.includes("exited_positions_not_scanned"));
  assert.notEqual(f.scope.rule, SCOPE_RULE_ALL);
  assert.deepEqual(f.scope.scanned, ["NVDA"]);
  assert.equal(f.tokens[0].replayed_raw, f.tokens[0].raw);
});

test("RWA_ALCHEMY_URL in env is picked up by the default path (the one the paid lane uses)", async () => {
  process.env.RWA_ALCHEMY_URL = ALCHEMY;
  const c = fakeChain({});
  const e = await reconstructFacts(ME, c.opts).catch((x) => x);
  assert.ok(e instanceof NoStockTokenActivity);
  assert.equal(e.answer.history_checked, "every_canonical_token");
  assert.ok(c.calls.length > 0 && c.calls.every((x) => x.url === ALCHEMY), "no read may go to the public RPC");
});

test("Alchemy failing falls back to the log walk, and the record says so with the gap", async () => {
  const c = fakeChain({ alchemy: () => ({ nope: true }) });
  const e = await reconstructFacts(ME, { ...c.opts, alchemyUrl: ALCHEMY }).catch((x) => x);
  assert.ok(e instanceof NoStockTokenActivity);
  assert.equal(e.answer.history_checked, "nvda_only");
  assert.deepEqual(e.answer.gaps, ["exited_positions_not_scanned"]);
});

// ---------------------------------------------------------------- the free route

const route = (address: string) =>
  GET(new NextRequest(`http://localhost/api/v1/rwa/facts/${address}`, { headers: { "x-forwarded-for": "203.0.113.9" } }), {
    params: Promise.resolve({ address }),
  });

test("free route, empty wallet: 404 with the stated answer, cacheable, identical on the second call", async () => {
  const answer = noActivityAnswer({ address: ME, block: HEAD, blockTimestamp: TS, historyChecked: "nvda_only", sentTxCount: 0, isContract: false });
  await cachedFactsWith(ME, async () => {
    throw new NoStockTokenActivity(answer);
  }).catch(() => {});
  const a = await route(ME);
  const b = await route(ME);
  assert.equal(a.status, 404);
  assert.equal(b.status, 404);
  const body = await a.json();
  assert.deepEqual(body, { ...answer, address: "0x1111111111111111111111111111111111111111" });
  assert.deepEqual(await b.json(), body);
  assert.match(a.headers.get("Cache-Control") ?? "", /s-maxage=300/);
});

test("free route, no slot: 503 too_busy with the reason and Retry-After; failures each have one body", async () => {
  let release!: () => void;
  const slot = cachedFactsWith(OTHER, () => new Promise((r) => (release = () => r({} as never))));
  try {
    const res = await route(ME);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("Retry-After"), "30");
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(await res.json(), failureAnswer(new TooBusy()));
  } finally {
    release();
    await slot;
  }
  assert.equal(failureAnswer(new ReconstructionTimeout()).error, "still_reading");
  const down = failureAnswer(new Error("HTTP 429"));
  assert.equal(down.error, "chain_unavailable");
  assert.equal(down.retry_after_sec, 60);
});

test("example wallets: three, EIP-55, distinct, and no note names an owner", async () => {
  const { EXAMPLE_WALLETS } = await import("../examples");
  const { getAddress } = await import("viem");
  assert.equal(EXAMPLE_WALLETS.length, 3);
  assert.equal(new Set(EXAMPLE_WALLETS.map((w) => w.address.toLowerCase())).size, 3);
  for (const w of EXAMPLE_WALLETS) {
    assert.equal(getAddress(w.address), w.address);
    assert.doesNotMatch(w.note, /\b(owner|owned|belongs|whale|fund|team|founder)\b/i);
    assert.match(w.note, /as of 2026-09-30/);
  }
});

test("public RPC, a wallet holding more tokens than one request can walk: a fast, stated 422 answer, no log walk", async () => {
  const many = Object.fromEntries(CANONICAL_TOKENS.slice(0, MAX_TOKENS_PUBLIC + 1).map((t) => [t.token.toLowerCase(), 1n]));
  const c = fakeChain({ balances: many });
  const e = await reconstructFacts(ME, { ...c.opts, alchemyUrl: null }).catch((x) => x);
  assert.ok(e instanceof WalletTooLarge);
  assert.equal(c.count("eth_getLogs"), 0);
  assert.equal(e.answer.held_tokens, MAX_TOKENS_PUBLIC + 1);
  assert.equal(e.answer.limit.kind, "tokens");
  assert.match(e.answer.detail, /It is not rebuilt\.$/);

  // cached like an answer, and the route says 422 with the holdings
  await cachedFactsWith(ME, async () => {
    throw e;
  }).catch(() => {});
  const res = await route(ME);
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.error, "wallet_too_large");
  assert.deepEqual(body.held, e.answer.held);
  assert.match(res.headers.get("Cache-Control") ?? "", /s-maxage=300/);
});

test("with Alchemy, a wallet with more transactions than one request can replay: 422, no receipts fetched", async () => {
  const tsla = TSLA.token.toLowerCase();
  const c = fakeChain({
    alchemy: (p) =>
      (!p.contractAddresses || (p.contractAddresses as string[]).includes(tsla)) && p.toAddress
        ? { transfers: Array.from({ length: MAX_TXS_ALCHEMY + 1 }, (_, i) => ({ hash: `0x${i.toString(16).padStart(64, "0")}`, uniqueId: `${i}:log:0`, rawContract: { address: tsla } })) }
        : { transfers: [] },
  });
  const e = await reconstructFacts(ME, { ...c.opts, alchemyUrl: ALCHEMY }).catch((x) => x);
  assert.ok(e instanceof WalletTooLarge);
  assert.equal(e.answer.limit.kind, "transactions");
  assert.equal(c.count("eth_getTransactionReceipt"), 0);
});

// ---------------------------------------------------------------- ALCHEMY_API_KEY and a refused key

const KEY = "sk_SECRET_KEY_123";

/** The scripted chain, except that every request to Alchemy's host gets `refusal`. */
function refusingAlchemy(c: ReturnType<typeof fakeChain>, refusal: () => Response) {
  let alchemyCalls = 0;
  const fetchImpl = (async (url: string, init: { body: string }) => {
    if (url.startsWith("https://robinhood-mainnet.g.alchemy.com/")) {
      alchemyCalls++;
      return refusal();
    }
    return (c.fetchImpl as unknown as (u: string, i: { body: string }) => Promise<Response>)(url, init);
  }) as unknown as typeof fetch;
  return { opts: { fetchImpl, sleep: async () => {} }, alchemyCalls: () => alchemyCalls };
}

test("ALCHEMY_API_KEY alone: the two enhanced calls go to Alchemy's Robinhood host, every plain read stays public", async () => {
  process.env.ALCHEMY_API_KEY = KEY;
  const c = fakeChain({});
  const e = await reconstructFacts(ME, c.opts).catch((x) => x);
  assert.ok(e instanceof NoStockTokenActivity);
  assert.equal(e.answer.history_checked, "every_canonical_token");
  const alchemy = c.calls.filter((x) => x.method.startsWith("alchemy_"));
  assert.equal(alchemy.length, 2);
  assert.ok(alchemy.every((x) => x.url === `https://robinhood-mainnet.g.alchemy.com/v2/${KEY}`));
  assert.ok(c.calls.filter((x) => !x.method.startsWith("alchemy_")).every((x) => x.url === RWA_PUBLIC_RPC_URL));
  assert.ok(!JSON.stringify(e.answer).includes(KEY));
});

for (const [name, refusal] of [
  ["401", () => new Response(JSON.stringify({ error: "Must be authenticated!" }), { status: 401 })],
  ["403", () => new Response("Forbidden", { status: 403 })],
  [
    "network not enabled",
    () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 0, error: { code: -32600, message: "ROBINHOOD_MAINNET is not enabled for this app. Visit this page to enable the network: https://dashboard.alchemy.com/apps/x/networks" } }), {
        status: 200,
      }),
  ],
] as const) {
  test(`a refused key (${name}) falls back to the public path: the record keeps the exited gap and says why, never the key`, async () => {
    process.env.ALCHEMY_API_KEY = KEY;
    const nvda = NVDA.token.toLowerCase();
    const hash = "0x" + "c".repeat(64);
    const c = fakeChain({
      balances: { [nvda]: 2n * 10n ** 18n },
      logs: (f) => ((f.topics as (string | null)[])[2] === pad(ME) && f.fromBlock === "0x0" && f.address === nvda ? [{ transactionHash: hash, blockNumber: "0x10", logIndex: "0x0", topics: [], data: "0x", address: nvda }] : []),
      receipts: { [hash]: receipt(hash, OTHER, nvda, nvda, OTHER, ME, 2n * 10n ** 18n, 16) },
    });
    const r = refusingAlchemy(c, refusal);
    const f = await reconstructFacts(ME, r.opts);
    assert.equal(r.alchemyCalls(), 1, "refused once, not retried, and the look-alike search does not ask again");
    assert.ok(f.gaps.includes("exited_positions_not_scanned"));
    assert.notEqual(f.scope.rule, SCOPE_RULE_ALL);
    assert.deepEqual(f.scope.scanned, ["NVDA"]);
    assert.ok(f.lookalikes_scope.not_scanned.some((n) => /Alchemy search failed \(alchemy_getAssetTransfers: refused/.test(n)), f.lookalikes_scope.not_scanned.join(" | "));
    assert.ok(!f.lookalikes_scope.searched.some((s) => s.source === "alchemy"));
    const text = JSON.stringify(f);
    assert.ok(!text.includes(KEY) && !text.includes("alchemy.com"), "no key and no host in the record");

    // The refusal is remembered: the next record does not ask Alchemy at all.
    __resetFactsCacheForTest();
    await reconstructFacts(ME, r.opts);
    assert.equal(r.alchemyCalls(), 1);
  });
}

// ---------------------------------------------------------------- RWA_ALCHEMY_URL refused: log reads follow the refusal

for (const status of [401, 403]) {
  test(`RWA_ALCHEMY_URL refused (${status}): the log walk and the multiplier reads move to the public RPC and stay there`, async () => {
    process.env.RWA_ALCHEMY_URL = ALCHEMY;
    const nvda = NVDA.token.toLowerCase();
    const hash = "0x" + "d".repeat(64);
    const c = fakeChain({
      balances: { [nvda]: 2n * 10n ** 18n },
      logs: (f) => ((f.topics as (string | null)[])[2] === pad(ME) && f.fromBlock === "0x0" && f.address === nvda ? [{ transactionHash: hash, blockNumber: "0x10", logIndex: "0x0", topics: [], data: "0x", address: nvda }] : []),
      receipts: { [hash]: receipt(hash, OTHER, nvda, nvda, OTHER, ME, 2n * 10n ** 18n, 16) },
    });
    let alchemyCalls = 0;
    const fetchImpl = (async (url: string, init: { body: string }) => {
      if (url.startsWith("https://alchemy.test/")) {
        alchemyCalls++;
        return new Response("Forbidden", { status });
      }
      return (c.fetchImpl as unknown as (u: string, i: { body: string }) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;
    const opts = { fetchImpl, sleep: async () => {} };

    const f = await reconstructFacts(ME, opts);
    assert.equal(alchemyCalls, 1, "refused once, then never asked again");
    assert.deepEqual(f.scope.scanned, ["NVDA"]);
    assert.equal(f.tokens[0].raw, (2n * 10n ** 18n).toString());
    assert.ok(!f.gaps.includes("corporate_actions_not_read"), f.gaps.join(","));
    const logs = c.calls.filter((x) => x.method === "eth_getLogs");
    assert.ok(logs.length > 0 && logs.every((x) => x.url === RWA_PUBLIC_RPC_URL));
    assert.ok(!JSON.stringify(f).includes("SECRETKEY"));

    // The multiplier walk on its own, while the refusal stands: straight to the public RPC.
    const before = c.calls.length;
    await fetchMultiplierLogs([{ token: nvda, from: HEAD - 5 }], HEAD, opts);
    assert.equal(alchemyCalls, 1);
    assert.ok(c.calls.slice(before).every((x) => x.url === RWA_PUBLIC_RPC_URL));
  });
}

test("RWA_ALCHEMY_URL refused in the middle of a log walk: the same walk finishes on the public RPC", async () => {
  process.env.RWA_ALCHEMY_URL = ALCHEMY;
  const nvda = NVDA.token.toLowerCase();
  const c = fakeChain({ logs: () => [{ transactionHash: "0x" + "e".repeat(64), blockNumber: "0x10", logIndex: "0x0", topics: [], data: "0x", address: nvda }] });
  let alchemyCalls = 0;
  const fetchImpl = (async (url: string, init: { body: string }) => {
    if (url.startsWith("https://alchemy.test/")) {
      alchemyCalls++;
      return new Response(JSON.stringify({ error: "Must be authenticated!" }), { status: 401 });
    }
    return (c.fetchImpl as unknown as (u: string, i: { body: string }) => Promise<Response>)(url, init);
  }) as unknown as typeof fetch;
  const logs = await fetchTransfersIn(nvda, ME, HEAD, { fetchImpl, sleep: async () => {} });
  assert.ok(logs.length > 0);
  assert.equal(alchemyCalls, 1);
  // Remembered: a later walk does not ask Alchemy.
  noteRefused(ALCHEMY);
  await fetchTransfersIn(nvda, ME, HEAD, { fetchImpl, sleep: async () => {} });
  assert.equal(alchemyCalls, 1);
});
