// Alchemy client (SPEC patches 020 and 021), against mocked responses shaped like
// Alchemy's published examples for alchemy_getAssetTransfers and
// alchemy_getTokenBalances. No network, no key.
//
// Run from the repo root: npx tsx --test packages/rwa/test/alchemy.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { AlchemyError, AlchemyRefused, alchemyRefused, alchemyUrl, getAssetTransferPages, getAssetTransfers, getTokenBalances } from "../alchemy";
import { ALCHEMY_ROBINHOOD_BASE, rwaAlchemyUrl, rwaRpcUrl, RWA_PUBLIC_RPC_URL } from "../config";
import { __resetRefusedUrlsForTest } from "../rpc";

const SECRET_URL = "https://robinhood-mainnet.g.alchemy.com/v2/sk_SECRET_KEY_123";
const W = "0xe9b08727131e34010b34006c660d4c1b436ec25f";

function transfer(i: number) {
  return {
    blockNum: `0x${(73953009 + i).toString(16)}`,
    uniqueId: `0x1b83${i}:log:107`,
    hash: `0x${i.toString(16).padStart(64, "0")}`,
    from: "0x3433e16efacb71e0e2cd605489514b648b30abd0",
    to: W,
    value: 25,
    erc721TokenId: null,
    erc1155Metadata: null,
    tokenId: null,
    asset: "NVDA",
    category: "erc20",
    rawContract: { value: "0x15af1d78b58c40000", address: "0x5dd716fe12275b69f04b26beeca343843c8e3539", decimal: "0x12" },
  };
}

type Sent = { url: string; body: { method: string; params: unknown[] } };
function mockFetch(pages: unknown[], sent: Sent[]): typeof fetch {
  let i = 0;
  return (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    sent.push({ url, body });
    const result = pages[i++];
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200 });
  }) as unknown as typeof fetch;
}

test("getAssetTransfers follows pageKey to the end and sends the documented params", async () => {
  const sent: Sent[] = [];
  const f = mockFetch([{ transfers: [transfer(0), transfer(1)], pageKey: "p2" }, { transfers: [transfer(2)] }], sent);
  const r = await getAssetTransferPages({ toAddress: W, category: ["erc20"], toBlock: "0x4888617" }, { url: SECRET_URL, fetchImpl: f });
  assert.equal(r.transfers.length, 3);
  assert.equal(r.pages, 2);
  assert.equal(r.complete, true);
  assert.equal(sent[0].body.method, "alchemy_getAssetTransfers");
  const p0 = sent[0].body.params[0] as Record<string, unknown>;
  assert.deepEqual(p0.category, ["erc20"]);
  assert.equal(p0.toAddress, W);
  assert.equal(p0.fromBlock, "0x0");
  assert.equal(p0.toBlock, "0x4888617");
  assert.equal(p0.maxCount, "0x3e8");
  assert.equal("contractAddresses" in p0, false, "no contract filter: every ERC-20");
  assert.equal("pageKey" in p0, false);
  assert.equal((sent[1].body.params[0] as Record<string, unknown>).pageKey, "p2");
});

test("getAssetTransfers stops at maxPages and says it is incomplete", async () => {
  const sent: Sent[] = [];
  const f = mockFetch([{ transfers: [transfer(0)], pageKey: "a" }, { transfers: [transfer(1)], pageKey: "b" }], sent);
  const r = await getAssetTransferPages({ toAddress: W, maxPages: 2 }, { url: SECRET_URL, fetchImpl: f });
  assert.equal(r.pages, 2);
  assert.equal(r.complete, false);
  const f2 = mockFetch([{ transfers: [transfer(0)], pageKey: "a" }, { transfers: [transfer(1)], pageKey: "b" }], []);
  await assert.rejects(getAssetTransfers({ toAddress: W, maxPages: 2 }, { url: SECRET_URL, fetchImpl: f2 }), /too_many_transfers/);
});

test("getTokenBalances pages with the erc20 option", async () => {
  const sent: Sent[] = [];
  const f = mockFetch(
    [
      { address: W, tokenBalances: [{ contractAddress: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", tokenBalance: "0x2392a4aa0e0f2f0b9", error: null }], pageKey: "k" },
      { address: W, tokenBalances: [{ contractAddress: "0x5dd716fe12275b69f04b26beeca343843c8e3539", tokenBalance: "0x15af1d78b58c40000", error: null }] },
    ],
    sent,
  );
  const r = await getTokenBalances(W, undefined, { url: SECRET_URL, fetchImpl: f });
  assert.equal(r.length, 2);
  assert.deepEqual(sent[0].body.params, [W, "erc20"]);
  assert.deepEqual(sent[1].body.params, [W, "erc20", { pageKey: "k" }]);
});

test("no error message ever carries the URL or the key", async () => {
  const cases: (typeof fetch)[] = [
    (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch,
    (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 0, error: { code: -32600, message: `bad key sk_SECRET_KEY_123 at ${SECRET_URL}` } }), { status: 200 })) as unknown as typeof fetch,
    (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 0, error: { code: -32000, message: `upstream said ${SECRET_URL}` } }), { status: 200 })) as unknown as typeof fetch,
    (async () => {
      throw new TypeError(`fetch failed for ${SECRET_URL}`);
    }) as unknown as typeof fetch,
    (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch,
    (async () => new Response(`Server error at ${SECRET_URL}`, { status: 502 })) as unknown as typeof fetch,
  ];
  for (const f of cases) {
    __resetRefusedUrlsForTest();
    await assert.rejects(getAssetTransfers({ toAddress: W }, { url: SECRET_URL, fetchImpl: f, retries: 0, sleep: async () => {} }), (err: Error) => {
      assert.ok(err instanceof AlchemyError);
      assert.ok(!err.message.includes("SECRET"), err.message);
      assert.ok(!err.message.includes("alchemy.com"), err.message);
      assert.ok(!JSON.stringify(err).includes("SECRET"));
      assert.ok(!String(err.stack).includes("SECRET"), "not in the stack either");
      return true;
    });
  }
});

test("without RWA_ALCHEMY_URL or ALCHEMY_API_KEY the client refuses and says only that", async () => {
  const saved = { url: process.env.RWA_ALCHEMY_URL, key: process.env.ALCHEMY_API_KEY };
  delete process.env.RWA_ALCHEMY_URL;
  delete process.env.ALCHEMY_API_KEY;
  try {
    assert.equal(alchemyUrl(), null);
    await assert.rejects(getTokenBalances(W), /RWA_ALCHEMY_URL is not set and ALCHEMY_API_KEY is not set/);
  } finally {
    if (saved.url !== undefined) process.env.RWA_ALCHEMY_URL = saved.url;
    if (saved.key !== undefined) process.env.ALCHEMY_API_KEY = saved.key;
  }
});

test("the endpoint: RWA_ALCHEMY_URL, else ALCHEMY_API_KEY on the Robinhood Chain host, else none", () => {
  assert.equal(ALCHEMY_ROBINHOOD_BASE, "https://robinhood-mainnet.g.alchemy.com/v2/");
  assert.equal(rwaAlchemyUrl({}), null);
  assert.equal(rwaAlchemyUrl({ ALCHEMY_API_KEY: "sk_SECRET_KEY_123" }), "https://robinhood-mainnet.g.alchemy.com/v2/sk_SECRET_KEY_123");
  assert.equal(rwaAlchemyUrl({ ALCHEMY_API_KEY: "  sk_SECRET_KEY_123\n" }), "https://robinhood-mainnet.g.alchemy.com/v2/sk_SECRET_KEY_123");
  assert.equal(rwaAlchemyUrl({ RWA_ALCHEMY_URL: "https://other.test/v2/x", ALCHEMY_API_KEY: "sk_SECRET_KEY_123" }), "https://other.test/v2/x");
  // Anything that is not a plain key is ignored rather than spliced into a URL.
  for (const bad of ["", " ", "a/b", "k?x=1", "k#f", "https://evil.test/", "k k"]) assert.equal(rwaAlchemyUrl({ ALCHEMY_API_KEY: bad }), null, JSON.stringify(bad));
  // The key alone serves the two enhanced calls. The plain reads stay where they were.
  assert.equal(rwaRpcUrl({ ALCHEMY_API_KEY: "sk_SECRET_KEY_123" }), RWA_PUBLIC_RPC_URL);
});

test("a refused key (401, 403, network not enabled) is an AlchemyRefused and is remembered", async () => {
  const saved = process.env.ALCHEMY_API_KEY;
  process.env.ALCHEMY_API_KEY = "sk_SECRET_KEY_123";
  const url = rwaAlchemyUrl()!;
  const answers: (typeof fetch)[] = [
    (async () => new Response(JSON.stringify({ error: "Must be authenticated!" }), { status: 401 })) as unknown as typeof fetch,
    (async () => new Response("forbidden", { status: 403 })) as unknown as typeof fetch,
    (async (_u: string, init: { body: string }) =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(init.body).id, error: { code: -32600, message: "ROBINHOOD_MAINNET is not enabled for this app. Visit this page to enable the network: https://dashboard.alchemy.com/apps/abc/networks" } }),
        { status: 200 },
      )) as unknown as typeof fetch,
  ];
  try {
    for (const f of answers) {
      __resetRefusedUrlsForTest();
      assert.equal(alchemyRefused(), false);
      let calls = 0;
      const counted = ((u: string, i: { body: string }) => {
        calls++;
        return (f as unknown as (u: string, i: { body: string }) => Promise<Response>)(u, i);
      }) as unknown as typeof fetch;
      await assert.rejects(getAssetTransfers({ toAddress: W }, { fetchImpl: counted, sleep: async () => {} }), (err: Error) => {
        assert.ok(err instanceof AlchemyRefused, err.name);
        assert.ok(!err.message.includes("SECRET") && !err.message.includes("alchemy.com") && !err.message.includes("dashboard"), err.message);
        return true;
      });
      assert.equal(calls, 1, "a refusal is not retried");
      assert.equal(alchemyRefused(), true);
      assert.ok(url.endsWith("sk_SECRET_KEY_123"));
    }
  } finally {
    __resetRefusedUrlsForTest();
    if (saved === undefined) delete process.env.ALCHEMY_API_KEY;
    else process.env.ALCHEMY_API_KEY = saved;
  }
});
