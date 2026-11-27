// ============================================================
// Avalanche の Transfer の読み手（2026-10-26・recover-late.ts makeAvalancheTransferReader）。
//
// 遅延回収の Avalanche のレーンは、この読み手の答えで「着金が窓にあった / 無かった」を決める。空の配列は「窓を読み切って
// 無かった」の意味で、呼び手はその行を二度と読まない——だから **読めたと言えないときに空を返してはいけない**。
//
// 守ること:
//  1. 読むのはネイティブ USDC（0xaf88…5831）の Transfer(from = 購入元, to = 受取先) だけ。1 回の問いは 100 ブロック以内
//     （2026-10-26 実測: 公開 RPC は 100 ブロックの USDC Transfer に答え、5,000 は断る）。
//  2. Avalanche 以外の network・AVALANCHE_RPC_URL なし・chainId が 43114 でない RPC・先端が窓に届いていない RPC は null
//     （＝読めなかった。呼び手は貼らず、印も付けない）。公開 RPC へ黙って倒れない。
//  3. 時刻からのブロック番号の見積もりは、そのブロックの実際の時刻で確かめる。合わなければ直し、直せなければ例外。
//  4. 形の欠けた log は黙って捨てず、例外にする。
// ============================================================
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  AVALANCHE_TRANSFER_READ_CHUNK_BLOCKS,
  makeAvalancheTransferReader,
  makeChainTransferReader,
  type ChainTransfer,
  type TransferReader,
} from "@/lib/settlements/recover-late";
import { AVALANCHE_PUBLIC_RPC_URL, AVALANCHE_USDC_ADDRESS } from "@/lib/chain/avalanche";
import { RoutescanUnavailableError } from "@/lib/chain/routescan";

const PAYER = "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670";
const PAY_TO = "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0";
const ARB = "eip155:43114";
const TX = "0x23421d63dd6932fd7ea4710409a6ec7a8be0d9c59ac339a7bb35bb78ae2cd07a";

/** 2026-10-26 実測のブロック間隔 970 ms で、窓の中に置く錨。 */
const ANCHOR_BLOCK = 517_100_000n;
const ANCHOR_MS = Date.parse("2026-10-26T10:42:25Z");
const BLOCK_MS = 970;
const HEAD = ANCHOR_BLOCK + 50_000n;
const FROM = new Date("2026-10-26T10:40:25Z");
const TO = new Date("2026-10-26T11:12:25Z");

type Log = { blockNumber: bigint | null; transactionHash: string | null; args: { from: string; to: string; value?: bigint } };
type GetLogsCall = { address: string; args: { from: string; to: string }; fromBlock: bigint; toBlock: bigint };

function fakeAvax(o: { chainId?: number; head?: bigint; timeOf?: (n: bigint) => number; logs?: Log[] } = {}) {
  const timeOf = o.timeOf ?? ((n: bigint) => ANCHOR_MS + Number(n - ANCHOR_BLOCK) * BLOCK_MS);
  const head = o.head ?? HEAD;
  const getLogsCalls: GetLogsCall[] = [];
  const blockReads: bigint[] = [];
  const client = {
    getChainId: async () => o.chainId ?? 43114,
    getBlock: async (q: { blockTag?: string; blockNumber?: bigint }) => {
      const n = q.blockNumber ?? head;
      if (q.blockNumber !== undefined) blockReads.push(n);
      if (n < 0n || n > head) throw new Error(`block ${n} is out of range`);
      return { number: n, timestamp: BigInt(Math.floor(timeOf(n) / 1000)) };
    },
    getLogs: async (q: GetLogsCall) => {
      getLogsCalls.push(q);
      return (o.logs ?? []).filter((l) => l.blockNumber === null || (l.blockNumber >= q.fromBlock && l.blockNumber <= q.toBlock));
    },
  };
  return { client: client as never, getLogsCalls, blockReads };
}

const settled: Log = { blockNumber: ANCHOR_BLOCK, transactionHash: TX, args: { from: PAYER, to: PAY_TO, value: 6000n } };
const query = { network: ARB, payer: PAYER, payTo: PAY_TO, from: FROM, to: TO, timeoutMs: 10_000 };
const blockAt = (t: Date) => ANCHOR_BLOCK + BigInt(Math.round((t.getTime() - ANCHOR_MS) / BLOCK_MS));

/** 索引を使わず RPC だけを試す（既存の getLogs 系テスト用）。 */
const routescanUnavailable = async () => {
  throw new RoutescanUnavailableError();
};
function avaxRpcReader(client: Parameters<typeof makeAvalancheTransferReader>[0]) {
  return makeAvalancheTransferReader(client, routescanUnavailable);
}

let savedAlchemyForRpcTests: string | undefined;
before(() => {
  savedAlchemyForRpcTests = process.env.ALCHEMY_API_KEY;
  delete process.env.ALCHEMY_API_KEY;
});
after(() => {
  if (savedAlchemyForRpcTests === undefined) delete process.env.ALCHEMY_API_KEY;
  else process.env.ALCHEMY_API_KEY = savedAlchemyForRpcTests;
});

test("Avalanche reader: reads the native USDC Transfer from the payer to the payee inside the window, in chunks of at most 100 blocks", async () => {
  const rpc = fakeAvax({ logs: [settled] });
  const out = await avaxRpcReader(rpc.client)(query);
  assert.deepEqual(out, [{ txHash: TX, from: PAYER, to: PAY_TO, value: "6000", blockTime: "2026-10-26T10:42:25.000Z" }] satisfies ChainTransfer[]);
  // 32 min window at 970 ms/block is about 1,980 blocks, so more than one 100-block call.
  assert.ok(rpc.getLogsCalls.length >= 15, `expected several chunks, got ${rpc.getLogsCalls.length}`);
  for (const c of rpc.getLogsCalls) {
    assert.equal(c.address, AVALANCHE_USDC_ADDRESS, "only native USDC — never USDC.e");
    assert.deepEqual(c.args, { from: PAYER, to: PAY_TO });
    assert.ok(c.toBlock - c.fromBlock + 1n <= AVALANCHE_TRANSFER_READ_CHUNK_BLOCKS, `chunk ${c.fromBlock}..${c.toBlock}`);
    assert.ok(c.toBlock - c.fromBlock + 1n <= 100n);
  }
  const sorted = [...rpc.getLogsCalls].sort((a, b) => (a.fromBlock < b.fromBlock ? -1 : 1));
  for (let i = 1; i < sorted.length; i++) assert.equal(sorted[i].fromBlock, sorted[i - 1].toBlock + 1n);
  assert.ok(sorted[0].fromBlock <= blockAt(FROM));
  assert.ok(sorted[sorted.length - 1].toBlock >= blockAt(TO));
});

test("Avalanche reader: an empty window is [] (read and found nothing) — and only then", async () => {
  const rpc = fakeAvax({ logs: [] });
  assert.deepEqual(await avaxRpcReader(rpc.client)(query), []);
  assert.ok(rpc.getLogsCalls.length >= 1, "it did read the window");
  const far = fakeAvax({ logs: [{ ...settled, blockNumber: ANCHOR_BLOCK + 100_000n }] });
  assert.deepEqual(await avaxRpcReader(far.client)(query), []);
});

test("Avalanche reader: another network is null and the RPC is not touched", async () => {
  for (const network of ["eip155:8453", "base", "eip155:5042", "eip155:42220", "eip155:56", "eip155:431144"]) {
    const rpc = fakeAvax({ logs: [settled] });
    assert.equal(await avaxRpcReader(rpc.client)({ ...query, network }), null, network);
    assert.equal(rpc.getLogsCalls.length, 0, network);
  }
});

test("Avalanche reader: without AVALANCHE_RPC_URL it reads nothing — no silent fallback to the public RPC", async () => {
  const saved = process.env.AVALANCHE_RPC_URL;
  const realFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    requested.push(String(input instanceof Request ? input.url : input));
    throw new Error("no network in this test");
  }) as never;
  try {
    for (const value of [undefined, "", "   "]) {
      if (value === undefined) delete process.env.AVALANCHE_RPC_URL;
      else process.env.AVALANCHE_RPC_URL = value;
      assert.equal(await avaxRpcReader(undefined)(query), null, JSON.stringify(value));
    }
    assert.equal(requested.length, 0, `nothing may be requested (the public RPC is ${AVALANCHE_PUBLIC_RPC_URL}): ${requested.join(",")}`);
    process.env.AVALANCHE_RPC_URL = "https://arb-rpc.invalid/v2/key";
    await assert.rejects(avaxRpcReader(undefined)(query));
    assert.ok(requested.length >= 1 && requested.every((u) => u.startsWith("https://arb-rpc.invalid/")), requested.join(","));
  } finally {
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.AVALANCHE_RPC_URL;
    else process.env.AVALANCHE_RPC_URL = saved;
  }
});

test("Avalanche reader: an RPC that reports another chain id is null — another chain's empty result is not 'no transfer'", async () => {
  for (const chainId of [8453, 5042, 42220, 431144, 1]) {
    const rpc = fakeAvax({ chainId, logs: [] });
    assert.equal(await avaxRpcReader(rpc.client)(query), null, `chainId ${chainId}`);
    assert.equal(rpc.getLogsCalls.length, 0, `chainId ${chainId}`);
  }
});

test("Avalanche reader: a node whose tip has not reached the end of the window is null — a lagging node's empty result is not 'no transfer'", async () => {
  const lagging = fakeAvax({ head: ANCHOR_BLOCK + 1_000n, logs: [] });
  assert.equal(await avaxRpcReader(lagging.client)(query), null);
  assert.equal(lagging.getLogsCalls.length, 0);
  const justThere = fakeAvax({ head: blockAt(TO), logs: [settled] });
  assert.equal((await avaxRpcReader(justThere.client)(query))?.length, 1);
});

test("Avalanche reader: the block estimate is checked against the block's real time and corrected", async () => {
  const stallAt = ANCHOR_BLOCK + 20_000n;
  const timeOf = (n: bigint) => ANCHOR_MS + Number(n - ANCHOR_BLOCK) * BLOCK_MS + (n >= stallAt ? 600_000 : 0);
  const lateInWindow: Log = { blockNumber: blockAt(new Date("2026-10-26T11:44:31Z")), transactionHash: `0x${"5e".repeat(32)}`, args: { from: PAYER, to: PAY_TO, value: 6000n } };
  const rpc = fakeAvax({ timeOf, logs: [settled, lateInWindow] });
  const out = await avaxRpcReader(rpc.client)(query);
  assert.ok((out?.length ?? 0) >= 1, "the transfer at the anchor is inside the window and must be found");
  assert.ok(out?.some((t) => t.txHash === TX));
});

test("Avalanche reader: when the block for the window cannot be located it throws — it never answers [] for a range it did not read", async () => {
  const rpc = fakeAvax({ timeOf: (n) => ANCHOR_MS + Number(n % 7n) * 5_000_000, logs: [] });
  await assert.rejects(avaxRpcReader(rpc.client)(query), /could not locate/);
  assert.equal(rpc.getLogsCalls.length, 0);
});

test("Avalanche reader: a malformed log is an error, not a silently dropped transfer", async () => {
  for (const bad of [
    { ...settled, blockNumber: null },
    { ...settled, transactionHash: null },
    { ...settled, args: { from: PAYER, to: PAY_TO } },
  ] as Log[]) {
    const rpc = fakeAvax({ logs: [bad] });
    await assert.rejects(avaxRpcReader(rpc.client)(query), /without a block, a hash or a value/);
  }
});

test("Avalanche reader: it stops when its time limit has passed", async () => {
  const rpc = fakeAvax({ logs: [settled] });
  await assert.rejects(avaxRpcReader(rpc.client)({ ...query, timeoutMs: -1 }), /time limit/);
  assert.equal(rpc.getLogsCalls.length, 0);
});

/** 2026-11-24 top-mentions settle_failed: 購入 12:01:02Z、32 秒後に同額同宛先の Avalanche 送金。 */
/** 台帳 x402_l1_purchases 4bc71849-… の pay_to（2026-11-27 本番 DB を読んで確認）。 */
const LATE_CASE_PAY_TO = "0x7371cce396ad04a6c78c4875d7837ade837a6a38";
const LATE_CASE_TX = "0xfa9c70c99dcb2d9ea84721140e2d0c6a655c69b74feba7332be79e34929b1df2";
const LATE_CASE_AMOUNT = "14500";
const LATE_CASE_ATTEMPT = new Date("2026-11-24T12:01:02.000Z");
const LATE_CASE_TRANSFER_SEC = Math.floor(Date.parse("2026-11-24T12:01:34.000Z") / 1000);
const lateCaseWindow = {
  from: new Date(LATE_CASE_ATTEMPT.getTime() - 2 * 60 * 1000),
  to: new Date(LATE_CASE_ATTEMPT.getTime() + 30 * 60 * 1000),
};

function routescanLateRow(
  hash: string,
  timeStampSec: number,
  overrides: Partial<{ from: string; to: string; value: string }> = {},
) {
  return {
    hash,
    timeStamp: String(timeStampSec),
    from: overrides.from ?? PAYER,
    to: overrides.to ?? LATE_CASE_PAY_TO,
    value: overrides.value ?? LATE_CASE_AMOUNT,
    blockNumber: "73500123",
    contractAddress: AVALANCHE_USDC_ADDRESS,
  };
}

function alchemyRecoverLateFetchMock(
  transfers: {
    hash: string;
    iso: string;
    value: string;
    to: string;
  }[],
) {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (!u.includes("avax-mainnet.g.alchemy.com")) throw new Error(`unexpected fetch ${u}`);
    const body = JSON.parse(String(init?.body));
    const usdc = AVALANCHE_USDC_ADDRESS.toLowerCase();
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          transfers: transfers.map((t) => ({
            uniqueId: `${t.hash}:log:0`,
            hash: t.hash,
            blockNum: "0x10",
            from: PAYER.toLowerCase(),
            to: t.to.toLowerCase(),
            category: "erc20",
            rawContract: { value: t.value, address: usdc, decimal: "0x6" },
            metadata: { blockTimestamp: t.iso },
          })),
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

test("Avalanche reader Routescan: late-case shape returns one in-window transfer (wrong payTo dropped)", async () => {
  const realFetch = globalThis.fetch;
  const prevKey = process.env.ALCHEMY_API_KEY;
  const prevAvax = process.env.AVALANCHE_RPC_URL;
  delete process.env.ALCHEMY_API_KEY;
  delete process.env.AVALANCHE_RPC_URL;
  let routescanCalls = 0;
  const rows = [
    routescanLateRow(LATE_CASE_TX, LATE_CASE_TRANSFER_SEC),
    routescanLateRow("0xwrongto", LATE_CASE_TRANSFER_SEC, { to: "0x00000000000000000000000000000000000000aa" }),
    routescanLateRow("0xold", LATE_CASE_TRANSFER_SEC - 3600),
  ];
  const reader = makeAvalancheTransferReader(
    undefined,
    async (_payer, opts) => {
      routescanCalls++;
      return {
        rows: rows.map((r) => ({
          hash: r.hash,
          blockNumber: r.blockNumber,
          timeStamp: r.timeStamp,
          from: r.from,
          to: r.to,
          value: r.value,
        })),
        rawItemCount: rows.length,
        pageOldestSec: Math.min(...rows.map((r) => Number(r.timeStamp))),
        nextCursor: null,
      };
    },
  );
  try {
    const out = await reader({
      network: ARB,
      payer: PAYER,
      payTo: LATE_CASE_PAY_TO,
      ...lateCaseWindow,
      timeoutMs: 10_000,
    });
    assert.equal(routescanCalls, 1);
    assert.deepEqual(out, [
      {
        txHash: LATE_CASE_TX,
        from: PAYER,
        to: LATE_CASE_PAY_TO,
        value: LATE_CASE_AMOUNT,
        blockTime: new Date(LATE_CASE_TRANSFER_SEC * 1000).toISOString(),
        blockNumber: 73500123n,
      },
    ]);
  } finally {
    globalThis.fetch = realFetch;
    if (prevKey !== undefined) process.env.ALCHEMY_API_KEY = prevKey;
    if (prevAvax === undefined) delete process.env.AVALANCHE_RPC_URL;
    else process.env.AVALANCHE_RPC_URL = prevAvax;
  }
});

test("Avalanche reader: Alchemy success does not call Routescan", async () => {
  const realFetch = globalThis.fetch;
  const prevKey = process.env.ALCHEMY_API_KEY;
  const prevAvax = process.env.AVALANCHE_RPC_URL;
  process.env.ALCHEMY_API_KEY = "test-key";
  delete process.env.AVALANCHE_RPC_URL;
  let routescanCalls = 0;
  globalThis.fetch = alchemyRecoverLateFetchMock([
    {
      hash: LATE_CASE_TX,
      iso: "2026-11-24T12:01:34.000Z",
      value: "0x38a4",
      to: LATE_CASE_PAY_TO,
    },
    {
      hash: "0x" + "ab".repeat(32),
      iso: "2026-11-24T12:01:40.000Z",
      value: "0x38a4",
      to: "0x00000000000000000000000000000000000000aa",
    },
  ]);
  const reader = makeAvalancheTransferReader(undefined, async () => {
    routescanCalls++;
    throw new Error("Routescan must not run when Alchemy succeeds");
  });
  try {
    const out = await reader({
      network: ARB,
      payer: PAYER,
      payTo: LATE_CASE_PAY_TO,
      ...lateCaseWindow,
      timeoutMs: 10_000,
    });
    assert.equal(routescanCalls, 0);
    assert.equal(out?.length, 1);
    assert.equal(out?.[0]?.txHash, LATE_CASE_TX);
    assert.equal(out?.[0]?.value, LATE_CASE_AMOUNT, "0x38a4 = 14500; the same-amount row to another address is dropped");
  } finally {
    globalThis.fetch = realFetch;
    if (prevKey === undefined) delete process.env.ALCHEMY_API_KEY;
    else process.env.ALCHEMY_API_KEY = prevKey;
    if (prevAvax === undefined) delete process.env.AVALANCHE_RPC_URL;
    else process.env.AVALANCHE_RPC_URL = prevAvax;
  }
});

test("Avalanche reader: an Alchemy row without a tx hash is unreadable, so Routescan answers instead", async () => {
  const realFetch = globalThis.fetch;
  const prevKey = process.env.ALCHEMY_API_KEY;
  const prevAvax = process.env.AVALANCHE_RPC_URL;
  process.env.ALCHEMY_API_KEY = "test-key";
  delete process.env.AVALANCHE_RPC_URL;
  let routescanCalls = 0;
  globalThis.fetch = alchemyRecoverLateFetchMock([
    { hash: "", iso: "2026-11-24T12:01:34.000Z", value: "0x38a4", to: LATE_CASE_PAY_TO },
  ]);
  const row = routescanLateRow(LATE_CASE_TX, LATE_CASE_TRANSFER_SEC);
  const reader = makeAvalancheTransferReader(undefined, async () => {
    routescanCalls++;
    return {
      rows: [{ hash: row.hash, blockNumber: row.blockNumber, timeStamp: row.timeStamp, from: row.from, to: row.to, value: row.value }],
      rawItemCount: 1,
      pageOldestSec: Number(row.timeStamp),
      nextCursor: null,
    };
  });
  try {
    const out = await reader({ network: ARB, payer: PAYER, payTo: LATE_CASE_PAY_TO, ...lateCaseWindow, timeoutMs: 10_000 });
    assert.equal(routescanCalls, 1, "a hashless Alchemy row must not be read as no transfer");
    assert.equal(out?.length, 1);
    assert.equal(out?.[0]?.txHash, LATE_CASE_TX);
  } finally {
    globalThis.fetch = realFetch;
    if (prevKey === undefined) delete process.env.ALCHEMY_API_KEY;
    else process.env.ALCHEMY_API_KEY = prevKey;
    if (prevAvax === undefined) delete process.env.AVALANCHE_RPC_URL;
    else process.env.AVALANCHE_RPC_URL = prevAvax;
  }
});

function routescanPage(rows: ReturnType<typeof routescanLateRow>[], o: { full?: boolean } = {}) {
  return {
    rows: rows.map((r) => ({ hash: r.hash, blockNumber: r.blockNumber, timeStamp: r.timeStamp, from: r.from, to: r.to, value: r.value })),
    rawItemCount: o.full ? 50 : rows.length,
    pageOldestSec: rows.length ? Math.min(...rows.map((r) => Number(r.timeStamp))) : null,
    nextCursor: o.full ? { page: "2" } : null,
  };
}

/** 索引の段を Alchemy なしで試す（RPC は fakeAvax で数える）。 */
async function withoutAlchemy<T>(fn: () => Promise<T>): Promise<T> {
  const prevKey = process.env.ALCHEMY_API_KEY;
  delete process.env.ALCHEMY_API_KEY;
  try {
    return await fn();
  } finally {
    if (prevKey !== undefined) process.env.ALCHEMY_API_KEY = prevKey;
  }
}

test("Avalanche reader Routescan: checksummed payer and payTo still match the lower-case index rows", async () => {
  await withoutAlchemy(async () => {
    const rpc = fakeAvax({ logs: [] });
    const reader = makeAvalancheTransferReader(rpc.client, async () => routescanPage([routescanLateRow(LATE_CASE_TX, LATE_CASE_TRANSFER_SEC)]));
    const out = await reader({
      network: ARB,
      payer: "0xC9C7B38C0942914FC8EA12063BC92DCD3B581670",
      payTo: "0x7371CCE396AD04A6C78C4875D7837ADE837A6A38",
      ...lateCaseWindow,
      timeoutMs: 10_000,
    });
    assert.equal(out?.length, 1);
    assert.equal(out?.[0]?.txHash, LATE_CASE_TX);
    assert.equal(rpc.getLogsCalls.length, 0, "the index answered, so the RPC is not read");
  });
});

test("Avalanche reader: an index that finds no transfer to payTo is not 'no transfer' — the RPC decides", async () => {
  await withoutAlchemy(async () => {
    // Only a same-amount row to another address: after the payTo filter the index has nothing.
    const rpc = fakeAvax({ logs: [settled] });
    const reader = makeAvalancheTransferReader(rpc.client, async () =>
      routescanPage([routescanLateRow("0xwrongto", Math.floor(ANCHOR_MS / 1000), { to: "0x00000000000000000000000000000000000000aa" })]),
    );
    const out = await reader(query);
    assert.ok(rpc.getLogsCalls.length >= 1, "an empty index answer must fall through to the RPC");
    assert.equal(out?.[0]?.txHash, TX);
    // Without AVALANCHE_RPC_URL the same empty index answer is null (unread), never [].
    const saved = process.env.AVALANCHE_RPC_URL;
    delete process.env.AVALANCHE_RPC_URL;
    try {
      const noRpc = makeAvalancheTransferReader(undefined, async () => routescanPage([]));
      assert.equal(await noRpc(query), null);
    } finally {
      if (saved !== undefined) process.env.AVALANCHE_RPC_URL = saved;
    }
  });
});

test("Avalanche reader: an index that cannot reach the window start falls through to the RPC", async () => {
  await withoutAlchemy(async () => {
    const rpc = fakeAvax({ logs: [settled] });
    let calls = 0;
    // Every page is full and newer than the window, so the scan hits its page cap without reaching the start.
    const reader = makeAvalancheTransferReader(rpc.client, async () => {
      calls++;
      return routescanPage([routescanLateRow(`0x${"cd".repeat(32)}`, Math.floor(TO.getTime() / 1000) + 3600)], { full: true });
    });
    const out = await reader(query);
    assert.ok(calls > 1, "it paged");
    assert.ok(rpc.getLogsCalls.length >= 1, "an incomplete index scan must fall through to the RPC");
    assert.equal(out?.[0]?.txHash, TX);
  });
});

test("Avalanche reader: when Routescan is unavailable the RPC answers", async () => {
  await withoutAlchemy(async () => {
    const rpc = fakeAvax({ logs: [settled] });
    const out = await avaxRpcReader(rpc.client)(query);
    assert.ok(rpc.getLogsCalls.length >= 1);
    assert.equal(out?.[0]?.txHash, TX);
  });
});

test("Avalanche reader: past its time limit the index is not read and the reader throws", async () => {
  await withoutAlchemy(async () => {
    let calls = 0;
    const rpc = fakeAvax({ logs: [settled] });
    const reader = makeAvalancheTransferReader(rpc.client, async () => {
      calls++;
      return routescanPage([routescanLateRow(LATE_CASE_TX, LATE_CASE_TRANSFER_SEC)]);
    });
    await assert.rejects(reader({ ...query, timeoutMs: -1 }), /time limit/);
    assert.equal(calls, 0);
    assert.equal(rpc.getLogsCalls.length, 0);
  });
});

for (const [name, row] of [
  ["a zero value to payTo", { hash: LATE_CASE_TX, iso: "2026-11-24T12:01:34.000Z", value: "0x0", to: LATE_CASE_PAY_TO }],
  ["a missing value to payTo", { hash: LATE_CASE_TX, iso: "2026-11-24T12:01:34.000Z", value: "", to: LATE_CASE_PAY_TO }],
] as const) {
  test(`Avalanche reader: an Alchemy row with ${name} is unreadable, so Routescan answers instead`, async () => {
    const realFetch = globalThis.fetch;
    const prevKey = process.env.ALCHEMY_API_KEY;
    process.env.ALCHEMY_API_KEY = "test-key";
    let routescanCalls = 0;
    globalThis.fetch = alchemyRecoverLateFetchMock([{ ...row }]);
    const reader = makeAvalancheTransferReader(undefined, async () => {
      routescanCalls++;
      return routescanPage([routescanLateRow(LATE_CASE_TX, LATE_CASE_TRANSFER_SEC)]);
    });
    try {
      const out = await reader({ network: ARB, payer: PAYER, payTo: LATE_CASE_PAY_TO, ...lateCaseWindow, timeoutMs: 10_000 });
      assert.equal(routescanCalls, 1);
      assert.equal(out?.[0]?.value, LATE_CASE_AMOUNT);
    } finally {
      globalThis.fetch = realFetch;
      if (prevKey === undefined) delete process.env.ALCHEMY_API_KEY;
      else process.env.ALCHEMY_API_KEY = prevKey;
    }
  });
}

test("chain transfer reader: Avalanche rows go to the Avalanche reader, Celo to Celo, everything else to the Base reader", async () => {
  const seen: string[] = [];
  const base: TransferReader = async (q) => (seen.push(`base:${q.network}`), q.network === "eip155:8453" || q.network === "base" ? [] : null);
  const celo: TransferReader = async (q) => (seen.push(`celo:${q.network}`), []);
  const avalanche: TransferReader = async (q) => (seen.push(`avalanche:${q.network}`), []);
  const arc: TransferReader = async (q) => (seen.push(`arc:${q.network}`), null);
  const reader = makeChainTransferReader({ base, celo, avalanche, arc });
  assert.deepEqual(await reader({ ...query, network: ARB }), []);
  assert.deepEqual(await reader({ ...query, network: "eip155:42220" }), []);
  assert.deepEqual(await reader({ ...query, network: "eip155:8453" }), []);
  // 2026-11-03: Arc has a lane of its own; a network without a lane (Polygon) still goes to the Base reader, which answers null.
  assert.equal(await reader({ ...query, network: "eip155:137" }), null, "a network without a lane goes to the Base reader, which answers null");
  assert.equal(await reader({ ...query, network: "eip155:5042" }), null, "Arc goes to the Arc reader (null without ARC_RPC_URL), never to Base");
  assert.deepEqual(seen, ["avalanche:eip155:43114", "celo:eip155:42220", "base:eip155:8453", "base:eip155:137", "arc:eip155:5042"]);
});
