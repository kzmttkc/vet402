// Run: npx tsx --test tests/payer-reconcile.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LOG_TAG_PAYER_RECONCILE_UNRECORDED,
  LOG_TAG_PAYER_RECONCILE_UNAVAILABLE,
  PAYER_RECONCILE_END_BUFFER_MINUTES,
  PAYER_RECONCILE_INCREMENTAL_NETWORKS,
  PAYER_RECONCILE_MAX_BOOKMARK_LAG_MS,
  PAYER_RECONCILE_MAX_INCREMENTAL_WINDOW_MS,
  PAYER_RECONCILE_WINDOW_HOURS,
  alertTxHash,
  payerReconcileWindow,
  payerReconcileWindowEnd,
  payerReconcileWindowScope,
  reconcilePayerTransfers,
  runPayerReconcile,
  txHashOnLedger,
  normalizePayerForKey,
} from "@/lib/settlements/payer-reconcile";
import { ARBITRUM_CAIP2, ARBITRUM_CHAIN_ID, ARBITRUM_USDC_ADDRESS } from "@/lib/chain/arbitrum";
import { AVALANCHE_CAIP2 } from "@/lib/chain/avalanche";
import { BNB_CAIP2 } from "@/lib/chain/bnb";
import { exclusionReasonForPayerTransfer, type OwnWalletContext } from "@/lib/settlements/own-wallets";
import { payerReconcilePurchaseNetwork } from "@/lib/settlements/payer-reconcile-network";
import {
  formatPayerOutgoingFailure,
  locateEvmBlockBinarySearch,
  makeBasePayerOutgoingReader,
  makeChainPayerOutgoingReader,
  makeEvmPayerOutgoingReader,
  makeStellarPayerOutgoingReader,
  payerOutgoingFail,
  payerOutgoingOk,
  PAYER_RECONCILE_LOCATE_BINARY_SEARCH_MAX_ITERS,
} from "@/lib/settlements/payer-outgoing-readers";
import { BlockscoutUnavailableError } from "@/lib/chain/blockscout";
import {
  ARC_TRANSFER_READ_CHUNK_BLOCKS,
  ARC_TRANSFER_READ_MARGIN_BLOCKS,
  AVALANCHE_TRANSFER_READ_MARGIN_BLOCKS,
  locateEvmBlock,
} from "@/lib/settlements/recover-late";
import { AVALANCHE_CHAIN_ID, AVALANCHE_USDC_ADDRESS } from "@/lib/chain/avalanche";
import { ROBINHOOD_CAIP2 } from "@/lib/observatory/evm-lane-ingest";
import { redactForLog } from "@/lib/observatory/redact";
import { isGetLogsRetryableLimitError, getLogsChunked, __resetLearnedRangeCapsForTests } from "@/lib/chain/chunked-logs";
import { BASE_BLOCK_TIME_SCHEDULE, firstBlockAtOrAfter } from "@/lib/chain/block-clock";
import { ARC_GATEWAY_WALLET } from "@/lib/observatory/arc-gateway";
import { ARC_CAIP2 } from "@/lib/chain/arc";
import { SOLANA_MAINNET_CAIP2 } from "@/lib/observatory/sol402-payer";

const STELLAR = "stellar:pubnet";
const EVM = "eip155:8453";
const PAYER = "GPAYEREXAMPLE";
const EVM_PAYER = "0xABCDef1234567890123456789012345678901234";
const OWN = "GOWNWALLET1";

const emptyOwn: OwnWalletContext = {
  byNetwork: new Map([[STELLAR, new Set([OWN])], [EVM, new Set([OWN.toLowerCase()])]]),
};

function transfer(
  tx: string,
  to: string,
  overrides: Partial<{ from: string; value: string; blockTime: string }> = {},
): { txHash: string; from: string; to: string; value: string; blockTime: string } {
  return {
    txHash: tx,
    from: overrides.from ?? PAYER,
    to,
    value: overrides.value ?? "1000",
    blockTime: overrides.blockTime ?? "2026-11-25T12:00:00.000Z",
  };
}

const noopPersist = async () => {};
const FAR_FUTURE_DEADLINE = Date.now() + 25_000;

test("payerReconcilePurchaseNetwork: stellar:pubnet は isMainnet が false でも照合対象", () => {
  assert.equal(payerReconcilePurchaseNetwork("stellar:pubnet"), STELLAR);
  assert.equal(payerReconcilePurchaseNetwork("stellar"), STELLAR);
  assert.equal(payerReconcilePurchaseNetwork("stellar:testnet"), null);
});

test("stellar の行が loadNetworks にあれば結果に必ず 1 行出る", async () => {
  const result = await runPayerReconcile({
    persistRun: noopPersist,
    deadlineAt: FAR_FUTURE_DEADLINE,
    loadNetworks: async () => [{ network: STELLAR, payer: PAYER }],
    loadTxHashes: async () => new Set(),
    readOutgoing: async () => payerOutgoingOk([]),
    ownWallets: emptyOwn,
  });
  assert.equal(result.chains.length, 1);
  assert.equal(result.chains[0]?.network, STELLAR);
  assert.equal(result.chains[0]?.status, "ok");
});

test("payerReconcileWindowEnd: recover-late success and 24h fallback", () => {
  const now = new Date("2026-11-26T10:00:00.000Z");
  const success = new Date("2026-11-26T08:00:00.000Z");
  assert.equal(payerReconcileWindowEnd(now, success).toISOString(), "2026-11-26T07:25:00.000Z");
  assert.equal(payerReconcileWindowEnd(now, null).toISOString(), "2026-11-25T10:00:00.000Z");
});

test("payerReconcileWindow: 48h span ending at window end", () => {
  const now = new Date("2026-11-26T10:00:00.000Z");
  const success = new Date("2026-11-26T08:00:00.000Z");
  const { from, to } = payerReconcileWindow(now, success);
  assert.equal(to.toISOString(), "2026-11-26T07:25:00.000Z");
  assert.equal(from.toISOString(), "2026-11-24T07:25:00.000Z");
  assert.equal(PAYER_RECONCILE_WINDOW_HOURS, 48);
  assert.equal(PAYER_RECONCILE_END_BUFFER_MINUTES, 35);
});

test("all chain transfers on ledger → unrecorded 0", () => {
  const txs = ["aaa", "bbb"];
  const r = reconcilePayerTransfers({
    network: STELLAR,
    payer: PAYER,
    transfers: txs.map((h) => transfer(h, "GDEST1")),
    purchaseTxHashes: new Set(txs),
    ownWallets: emptyOwn,
  });
  assert.equal(r.read, 2);
  assert.equal(r.matched, 2);
  assert.equal(r.unrecorded, 0);
  assert.equal(r.excluded, 0);
});

test("no on-chain transfers → unrecorded 0 even with empty ledger", () => {
  const r = reconcilePayerTransfers({
    network: EVM,
    payer: EVM_PAYER,
    transfers: [],
    purchaseTxHashes: new Set(),
    ownWallets: emptyOwn,
  });
  assert.equal(r.unrecorded, 0);
});

test("one transfer missing on ledger → unrecorded 1", () => {
  const r = reconcilePayerTransfers({
    network: STELLAR,
    payer: PAYER,
    transfers: [transfer("missing", "GDEST1")],
    purchaseTxHashes: new Set(),
    ownWallets: emptyOwn,
  });
  assert.equal(r.unrecorded, 1);
});

test("uppercase EVM tx matches lowercased ledger", () => {
  const tx = "0xABCDEF";
  const r = reconcilePayerTransfers({
    network: EVM,
    payer: EVM_PAYER,
    transfers: [transfer(tx, "0xdest", { from: EVM_PAYER })],
    purchaseTxHashes: new Set(["0xabcdef"]),
    ownWallets: emptyOwn,
  });
  assert.equal(r.matched, 1);
  assert.equal(r.unrecorded, 0);
  assert.equal(txHashOnLedger(EVM, tx, new Set(["0xabcdef"])), true);
});

test("one tx with multiple ledger rows (batched) → one read, one match", () => {
  const tx = "batch1";
  const r = reconcilePayerTransfers({
    network: STELLAR,
    payer: PAYER,
    transfers: [transfer(tx, "GDEST1")],
    purchaseTxHashes: new Set([tx]),
    ownWallets: emptyOwn,
  });
  assert.equal(r.read, 1);
  assert.equal(r.matched, 1);
});

test("self_transfer is excluded", () => {
  const r = reconcilePayerTransfers({
    network: STELLAR,
    payer: PAYER,
    transfers: [{ ...transfer("selfmove", PAYER, { from: PAYER }), to: PAYER }],
    purchaseTxHashes: new Set(),
    ownWallets: emptyOwn,
  });
  assert.equal(r.unrecorded, 0);
  assert.equal(r.excludedByReason.self_transfer, 1);
});

test("transfer to own wallet is excluded, not unrecorded", () => {
  const r = reconcilePayerTransfers({
    network: STELLAR,
    payer: PAYER,
    transfers: [transfer("selfmove", OWN)],
    purchaseTxHashes: new Set(),
    ownWallets: emptyOwn,
  });
  assert.equal(r.unrecorded, 0);
  assert.equal(r.excluded, 1);
  assert.equal(r.excludedByReason.own_wallet, 1);
});

test("funder wallet destination is NOT excluded (purchase counts)", () => {
  const funderDest = "0xfunderwalletonly";
  const reason = exclusionReasonForPayerTransfer(
    { network: EVM, payer: EVM_PAYER, from: EVM_PAYER, to: funderDest },
    emptyOwn,
  );
  assert.equal(reason, null);
  const r = reconcilePayerTransfers({
    network: EVM,
    payer: EVM_PAYER,
    transfers: [transfer("0xfundme", funderDest, { from: EVM_PAYER })],
    purchaseTxHashes: new Set(),
    ownWallets: emptyOwn,
  });
  assert.equal(r.excluded, 0);
  assert.equal(r.unrecorded, 1);
});

test("ARC gateway deposit is excluded and counted", () => {
  const reason = exclusionReasonForPayerTransfer(
    { network: ARC_CAIP2, payer: EVM_PAYER, from: EVM_PAYER, to: ARC_GATEWAY_WALLET },
    emptyOwn,
  );
  assert.equal(reason, "gateway_deposit");
  const r = reconcilePayerTransfers({
    network: ARC_CAIP2,
    payer: EVM_PAYER,
    transfers: [
      transfer("0xgw1", ARC_GATEWAY_WALLET, { from: EVM_PAYER }),
      transfer("0xgw2", "0xother", { from: EVM_PAYER }),
    ],
    purchaseTxHashes: new Set(),
    ownWallets: emptyOwn,
  });
  assert.equal(r.excludedByReason.gateway_deposit, 1);
  assert.equal(r.unrecorded, 1);
});

test("reader fail → unavailable, ok false", async () => {
  const result = await runPayerReconcile({
    persistRun: noopPersist,
    deadlineAt: FAR_FUTURE_DEADLINE,
    loadNetworks: async () => [{ network: STELLAR, payer: PAYER }],
    loadTxHashes: async () => new Set(),
    readOutgoing: async () => payerOutgoingFail("reader_returned_null"),
    ownWallets: emptyOwn,
  });
  assert.equal(result.ok, false);
  assert.equal(result.chains[0]?.status, "unavailable");
});

test("reader fail with message → unavailable", async () => {
  const result = await runPayerReconcile({
    persistRun: noopPersist,
    deadlineAt: FAR_FUTURE_DEADLINE,
    loadNetworks: async () => [{ network: STELLAR, payer: PAYER }],
    loadTxHashes: async () => new Set(),
    readOutgoing: async () => payerOutgoingFail("Error: rpc down"),
    ownWallets: emptyOwn,
  });
  assert.equal(result.ok, false);
  assert.equal(result.chains[0]?.status, "unavailable");
});

test("time budget → unavailable reason budget", async () => {
  const result = await runPayerReconcile({
    persistRun: noopPersist,
    deadlineAt: Date.now() - 1,
    loadNetworks: async () => [{ network: STELLAR, payer: PAYER }],
    loadTxHashes: async () => new Set(),
    readOutgoing: async () => payerOutgoingOk([transfer("a", "GDEST1")]),
    ownWallets: emptyOwn,
  });
  const c = result.chains[0];
  assert.equal(c?.status, "unavailable");
  assert.equal(c.status === "unavailable" && c.reason, "budget");
  assert.equal(result.ok, false);
});

test("Solana signature case preserved in alerts", () => {
  const sig = "5Kd3NBUJKP4kD87vTss9HDqH8kBWcNnpr6nYgKxFG7wz";
  assert.equal(alertTxHash(SOLANA_MAINNET_CAIP2, sig), sig);
  const r = reconcilePayerTransfers({
    network: SOLANA_MAINNET_CAIP2,
    payer: "So1Payer",
    transfers: [{ txHash: sig, from: "So1Payer", to: "SoDest", value: "1", blockTime: "2026-11-25T12:00:00.000Z" }],
    purchaseTxHashes: new Set(),
    ownWallets: emptyOwn,
  });
  assert.equal(r.unrecordedTxs[0], sig);
});

test("EVM payer dedupe by lower case", () => {
  assert.equal(normalizePayerForKey(EVM, "0xABC"), "0xabc");
  assert.equal(normalizePayerForKey(STELLAR, "GABC"), "GABC");
});

test("one transfer missing on ledger → unrecorded 1 and alert hook", async () => {
  const alerts: string[] = [];
  const now = new Date("2026-11-26T10:00:00.000Z");
  const result = await runPayerReconcile({
    now,
    persistRun: noopPersist,
    deadlineAt: FAR_FUTURE_DEADLINE,
    ownWallets: emptyOwn,
    loadNetworks: async () => [{ network: STELLAR, payer: PAYER }],
    loadTxHashes: async () => new Set(["known"]),
    readOutgoing: async () => payerOutgoingOk([transfer("known", "GDEST1"), transfer("missing", "GDEST2")]),
    onUnrecorded: (d) => alerts.push(d),
  });
  assert.equal(result.ok, false);
  assert.equal(result.totalUnrecorded, 1);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0]!, /missing/);
  const ok = result.chains.find((c) => c.status === "ok");
  assert.ok(ok && ok.unrecorded === 1);
});

test("unavailable with zero unrecorded still makes ok false", async () => {
  const unavail: string[] = [];
  const result = await runPayerReconcile({
    persistRun: noopPersist,
    deadlineAt: FAR_FUTURE_DEADLINE,
    loadNetworks: async () => [
      { network: STELLAR, payer: PAYER },
      { network: STELLAR, payer: "GOTHERPAYER" },
    ],
    loadTxHashes: async () => new Set(["known"]),
    readOutgoing: async ({ payer }) =>
      payer === PAYER ? payerOutgoingOk([transfer("known", "GDEST1")]) : payerOutgoingFail("secondary_payer_read_failed"),
    onUnavailable: (d) => unavail.push(d),
    ownWallets: emptyOwn,
  });
  assert.equal(result.totalUnrecorded, 0);
  assert.equal(result.ok, false);
  assert.equal(result.anyUnavailable, true);
  assert.equal(unavail.length, 1);
});

test("EVM empty rpc path → unavailable not zero transfers", async () => {
  const { makeEvmPayerOutgoingReader } = await import("@/lib/settlements/payer-outgoing-readers");
  const reader = makeEvmPayerOutgoingReader({
    network: ARBITRUM_CAIP2,
    chainId: 42_161,
    token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    chunkBlocks: 100n,
    marginBlocks: 1n,
    blockSeconds: 1,
    toleranceSeconds: 30,
    chainName: "Arbitrum",
    client: () => null,
  });
  const out = await reader({
    network: ARBITRUM_CAIP2,
    payer: EVM_PAYER,
    from: new Date("2026-11-20T00:00:00Z"),
    to: new Date("2026-11-25T00:00:00Z"),
  });
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.detail, /missing_rpc/);
});

test("Solana without RPC → not_configured, no recent purchases", async () => {
  const result = await runPayerReconcile({
    persistRun: noopPersist,
    deadlineAt: FAR_FUTURE_DEADLINE,
    loadNetworks: async () => [{ network: SOLANA_MAINNET_CAIP2, payer: "SoPayer111" }],
    loadTxHashes: async () => new Set(),
    countRecentPurchases: async () => 0,
    readOutgoing: async () => payerOutgoingFail("reader_returned_null"),
    ownWallets: emptyOwn,
  });
  assert.equal(result.chains[0]?.status, "not_configured");
  assert.equal(result.chains[0]?.status === "not_configured" && result.chains[0].recentPurchases, 0);
  assert.equal(result.ok, true);
  assert.equal(result.totalNotConfigured, 1);
});

test("not_configured with recent purchases makes ok false", async () => {
  const result = await runPayerReconcile({
    persistRun: noopPersist,
    deadlineAt: FAR_FUTURE_DEADLINE,
    loadNetworks: async () => [{ network: ARBITRUM_CAIP2, payer: EVM_PAYER }],
    countRecentPurchases: async () => 2,
    ownWallets: emptyOwn,
  });
  const c = result.chains[0];
  assert.equal(c?.status, "not_configured");
  assert.equal(c?.status === "not_configured" && c.recentPurchases, 2);
  assert.equal(result.ok, false);
});

test("LOG_TAG constants are fixed for uptime monitors", () => {
  assert.equal(LOG_TAG_PAYER_RECONCILE_UNRECORDED, "observatory.payer-reconcile.unrecorded");
  assert.equal(LOG_TAG_PAYER_RECONCILE_UNAVAILABLE, "observatory.payer-reconcile.unavailable");
});

test("checkpoint scope is per network and payer", () => {
  assert.equal(
    payerReconcileWindowScope(BNB_CAIP2, "0xAbC"),
    `payer-reconcile:window:${BNB_CAIP2}:0xabc`,
  );
});

const INCREMENTAL_RPC_ENVS = [
  "BNB_RPC_URL",
  "ARBITRUM_RPC_URL",
  "AVALANCHE_RPC_URL",
  "ARC_RPC_URL",
  "INDEXER_RPC_URL",
] as const;

function withIncrementalRpcEnv<T>(fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const key of INCREMENTAL_RPC_ENVS) {
    prev[key] = process.env[key];
    process.env[key] = "http://127.0.0.1:9";
  }
  return fn().finally(() => {
    for (const key of INCREMENTAL_RPC_ENVS) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  });
}

function withBnbRpc<T>(fn: () => Promise<T>): Promise<T> {
  return withIncrementalRpcEnv(fn);
}

test("checkpoint advances only after persist succeeds", async () => {
  const saved: string[] = [];
  const result = await withBnbRpc(() =>
    runPayerReconcile({
      deadlineAt: FAR_FUTURE_DEADLINE,
      persistRun: async () => {
        throw new Error("db down");
      },
      saveWindowEnd: async (network, payer, end) => {
        saved.push(`${network}:${payer}:${end.toISOString()}`);
      },
      loadNetworks: async () => [{ network: BNB_CAIP2, payer: EVM_PAYER }],
      loadTxHashes: async () => new Set(),
      readOutgoing: async () => payerOutgoingOk([]),
      ownWallets: emptyOwn,
    }),
  );
  assert.equal(result.chains[0]?.status, "ok");
  assert.equal(saved.length, 0);
});

test("two payers: only successful chain gets checkpoint", async () => {
  const saved: string[] = [];
  const p1 = EVM_PAYER;
  const p2 = "0x2222222222222222222222222222222222222222";
  await withBnbRpc(() =>
    runPayerReconcile({
      deadlineAt: FAR_FUTURE_DEADLINE,
      persistRun: noopPersist,
      saveWindowEnd: async (network, payer, end) => {
        saved.push(`${payer}:${end.toISOString()}`);
      },
      loadNetworks: async () => [
        { network: BNB_CAIP2, payer: p1 },
        { network: BNB_CAIP2, payer: p2 },
      ],
      loadTxHashes: async () => new Set(),
      readOutgoing: async ({ payer }) => (payer === p1 ? payerOutgoingOk([]) : payerOutgoingFail("payer_two_failed")),
      ownWallets: emptyOwn,
    }),
  );
  assert.equal(saved.length, 1);
  assert.match(saved[0]!, new RegExp(p1, "i"));
});

test("incremental chains read 24h slices until window end", async () => {
  const now = new Date("2026-11-26T10:00:00.000Z");
  const { to: windowTo } = payerReconcileWindow(now, new Date("2026-11-26T08:00:00.000Z"));
  const startBehind = new Date(windowTo.getTime() - 50 * 60 * 60 * 1000);
  const slices: { network: string; from: string; to: string }[] = [];

  const networks = [EVM, ARC_CAIP2, BNB_CAIP2, ARBITRUM_CAIP2, AVALANCHE_CAIP2].map((network) => ({
    network,
    payer: EVM_PAYER,
  }));

  await withIncrementalRpcEnv(() =>
    runPayerReconcile({
      now,
      persistRun: noopPersist,
      deadlineAt: FAR_FUTURE_DEADLINE,
      loadRecoverLateLastSuccess: async () => new Date("2026-11-26T08:00:00.000Z"),
      loadNetworks: async () => networks,
      loadTxHashes: async () => new Set(),
      loadWindowFrom: async () => startBehind,
      readOutgoing: async ({ network, from, to }) => {
        slices.push({ network, from: from.toISOString(), to: to.toISOString() });
        return payerOutgoingOk([]);
      },
      ownWallets: emptyOwn,
    }),
  );

  for (const net of PAYER_RECONCILE_INCREMENTAL_NETWORKS) {
    const forNet = slices.filter((s) => s.network === net);
    assert.equal(forNet.length, 3, `${net} should read three 24h slices`);
    assert.equal(
      forNet[forNet.length - 1]!.to,
      windowTo.toISOString(),
      `${net} last slice should reach window end`,
    );
  }
});

test("bookmark lag over 36h makes ok false", async () => {
  const now = new Date("2026-11-26T10:00:00.000Z");
  const { to: windowTo } = payerReconcileWindow(now, new Date("2026-11-26T08:00:00.000Z"));
  const lagMs = PAYER_RECONCILE_MAX_BOOKMARK_LAG_MS + 60 * 60 * 1000;
  const startBehind = new Date(windowTo.getTime() - lagMs);

  const result = await withBnbRpc(() =>
    runPayerReconcile({
      now,
      persistRun: noopPersist,
      deadlineAt: Date.now() - 1,
      loadRecoverLateLastSuccess: async () => new Date("2026-11-26T08:00:00.000Z"),
      loadNetworks: async () => [{ network: BNB_CAIP2, payer: EVM_PAYER }],
      loadTxHashes: async () => new Set(),
      loadWindowFrom: async () => startBehind,
      readOutgoing: async () => payerOutgoingOk([]),
      ownWallets: emptyOwn,
    }),
  );

  const chain = result.chains[0];
  assert.equal(chain?.status, "ok");
  assert.ok(
    chain?.status === "ok" && typeof chain.bookmarkLagMs === "number" && chain.bookmarkLagMs > PAYER_RECONCILE_MAX_BOOKMARK_LAG_MS,
  );
  assert.equal(result.ok, false);
});

test("budget aborts in-flight reader", async () => {
  let aborted = false;
  await runPayerReconcile({
    deadlineAt: Date.now() + 30,
    persistRun: noopPersist,
    loadNetworks: async () => [{ network: STELLAR, payer: PAYER }],
    loadTxHashes: async () => new Set(),
    readOutgoing: async ({ signal }) =>
      new Promise((resolve) => {
        signal?.addEventListener("abort", () => {
          aborted = true;
          resolve(payerOutgoingFail("AbortError: aborted"));
        });
      }),
    ownWallets: emptyOwn,
  });
  assert.equal(aborted, true);
});

test("not_configured chain with no purchases does not block ok", async () => {
  const result = await runPayerReconcile({
    deadlineAt: FAR_FUTURE_DEADLINE,
    persistRun: noopPersist,
    loadNetworks: async () => [
      { network: STELLAR, payer: PAYER },
      { network: ARBITRUM_CAIP2, payer: EVM_PAYER },
    ],
    loadTxHashes: async () => new Set(["known"]),
    countRecentPurchases: async () => 0,
    readOutgoing: async () => payerOutgoingOk([transfer("known", "GDEST1")]),
    ownWallets: emptyOwn,
  });
  const arb = result.chains.find((c) => c.network === ARBITRUM_CAIP2);
  assert.equal(arb?.status, "not_configured");
  assert.equal(result.totalNotConfigured, 1);
  assert.equal(result.ok, true);
});

test("incremental slice size is 24 hours", () => {
  assert.equal(PAYER_RECONCILE_MAX_INCREMENTAL_WINDOW_MS, 24 * 60 * 60 * 1000);
});

test("read_failed unavailable exposes detail next to reason", async () => {
  const result = await runPayerReconcile({
    persistRun: noopPersist,
    deadlineAt: FAR_FUTURE_DEADLINE,
    loadNetworks: async () => [{ network: EVM, payer: EVM_PAYER }],
    loadTxHashes: async () => new Set(),
    readOutgoing: async () => payerOutgoingFail("RpcRequestError: code=-32011 request limit reached"),
    ownWallets: emptyOwn,
  });
  const c = result.chains[0];
  assert.equal(c?.status, "unavailable");
  assert.equal(c?.status === "unavailable" && c.reason, "read_failed");
  assert.match(c?.status === "unavailable" && c.detail ? c.detail : "", /-32011/);
});

test("code -32011 counts as retryable limit (chunked-logs retry path)", () => {
  const err = Object.assign(new Error("RPC Request failed."), {
    name: "RpcRequestError",
    code: -32011,
    details: "request limit reached",
  });
  assert.equal(isGetLogsRetryableLimitError(err), true);
});

test("Base payer getLogs retries -32011 up to 3 times inside deadline", async () => {
  __resetLearnedRangeCapsForTests();
  let calls = 0;
  const client = {
    getChainId: async () => 8453,
    getBlock: async () => ({ number: 1000n, timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
    getBlockNumber: async () => 1000n,
    getLogs: async () => {
      calls++;
      if (calls <= 2) {
        throw Object.assign(new Error("RPC Request failed."), {
          name: "RpcRequestError",
          code: -32011,
          details: "request limit reached",
        });
      }
      return [{ blockNumber: 1n, transactionHash: "0xabc", args: { from: "0x1", to: "0x2", value: 1n } }];
    },
  };
  const logs = await getLogsChunked(
    client as never,
    { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", fromBlock: 1n, toBlock: 10n } as never,
    20_000n,
    1,
    { rateLimitMaxRetries: 3, deadlineMs: 30_000 },
  );
  assert.equal(calls, 3);
  assert.equal(logs.length, 1);
});

test("getLogsChunked without rateLimitMaxRetries does not retry -32011", async () => {
  __resetLearnedRangeCapsForTests();
  let calls = 0;
  const client = {
    getChainId: async () => 8453,
    getBlock: async () => ({ number: 1000n, timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
    getBlockNumber: async () => 1000n,
    getLogs: async () => {
      calls++;
      throw Object.assign(new Error("RPC Request failed."), {
        name: "RpcRequestError",
        code: -32011,
        details: "request limit reached",
      });
    },
  };
  await assert.rejects(
    () =>
      getLogsChunked(
        client as never,
        { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", fromBlock: 1n, toBlock: 10n } as never,
        20_000n,
        1,
        { deadlineMs: 30_000 },
      ),
    (e: Error) => {
      assert.match(e.message, /request limit|RPC Request failed/i);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("formatPayerOutgoingFailure redacts URL keys from detail", () => {
  const detail = formatPayerOutgoingFailure(
    new Error("RpcRequestError: failed https://base-mainnet.g.alchemy.com/v2/SECRETKEY_HERE"),
  );
  assert.doesNotMatch(detail, /SECRETKEY_HERE/);
  assert.match(detail, /<url>/);
  assert.equal(redactForLog(detail), detail);
});

test("different chains read in parallel", async () => {
  let stellarDone = false;
  let bnbStartedDuringStellar = false;

  await withIncrementalRpcEnv(() =>
    runPayerReconcile({
      persistRun: noopPersist,
      deadlineAt: FAR_FUTURE_DEADLINE,
      loadNetworks: async () => [
        { network: STELLAR, payer: PAYER },
        { network: BNB_CAIP2, payer: EVM_PAYER },
      ],
      loadTxHashes: async () => new Set(),
      readOutgoing: async ({ network, signal }) => {
        if (network === STELLAR) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 40);
            signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              resolve();
            }, { once: true });
          });
          stellarDone = true;
          return payerOutgoingOk([]);
        }
        if (!stellarDone) bnbStartedDuringStellar = true;
        return payerOutgoingOk([]);
      },
      ownWallets: emptyOwn,
    }),
  );

  assert.equal(bnbStartedDuringStellar, true);
});

test("same-chain payers read sequentially", async () => {
  const order: string[] = [];
  await runPayerReconcile({
    persistRun: noopPersist,
    deadlineAt: FAR_FUTURE_DEADLINE,
    loadNetworks: async () => [
      { network: STELLAR, payer: PAYER },
      { network: STELLAR, payer: "GOTHERPAYER" },
    ],
    loadTxHashes: async () => new Set(),
    readOutgoing: async ({ payer }) => {
      order.push(`start:${payer}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end:${payer}`);
      return payerOutgoingOk([]);
    },
    ownWallets: emptyOwn,
  });
  assert.deepEqual(order, [`start:${PAYER}`, `end:${PAYER}`, `start:GOTHERPAYER`, `end:GOTHERPAYER`]);
});

test("node behind window: bookmark stops at readThroughMs and status is node_behind_window", async () => {
  const now = new Date("2026-11-26T10:00:00.000Z");
  const { to: windowTo } = payerReconcileWindow(now, new Date("2026-11-26T08:00:00.000Z"));
  const through = new Date(windowTo.getTime() - 6 * 60 * 60 * 1000);
  const saved: string[] = [];

  const result = await runPayerReconcile({
    now,
    persistRun: noopPersist,
    deadlineAt: FAR_FUTURE_DEADLINE,
    loadRecoverLateLastSuccess: async () => new Date("2026-11-26T08:00:00.000Z"),
    loadNetworks: async () => [{ network: STELLAR, payer: PAYER }],
    loadTxHashes: async () => new Set(["known"]),
    readOutgoing: async ({ to }) =>
      payerOutgoingOk([transfer("known", "GDEST1")], Math.min(through.getTime(), to.getTime())),
    saveWindowEnd: async (_n, _p, end) => {
      saved.push(end.toISOString());
    },
    ownWallets: emptyOwn,
  });

  const c = result.chains[0];
  assert.equal(c?.status, "unavailable");
  assert.equal(c?.status === "unavailable" && c.reason, "node_behind_window");
  assert.equal(c?.status === "unavailable" && c.windowTo, through.toISOString());
  assert.equal(c?.status === "unavailable" && c.matched, 1);
  assert.equal(result.ok, false);
  assert.equal(saved.length, 0);
});

test("Base fromBlock > toBlock → unavailable (not empty ok)", async () => {
  const futureHead = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const client = {
    getChainId: async () => 8453,
    getBlock: async () => ({ number: 1n, timestamp: futureHead }),
    getLogs: async () => {
      throw new Error("getLogs should not run");
    },
  };
  const reader = makeBasePayerOutgoingReader(client as never, async () => {
    throw new BlockscoutUnavailableError("blockscout_unavailable");
  });
  const to = new Date();
  const from = new Date(to.getTime() - 48 * 60 * 60 * 1000);
  const out = await reader({ network: EVM, payer: EVM_PAYER, from, to, timeoutMs: 5_000 });
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.detail, /fromBlock > toBlock|invalid_block_range/);

  const result = await runPayerReconcile({
    persistRun: noopPersist,
    deadlineAt: FAR_FUTURE_DEADLINE,
    loadNetworks: async () => [{ network: EVM, payer: EVM_PAYER }],
    loadTxHashes: async () => new Set(),
    readOutgoing: reader,
    ownWallets: emptyOwn,
  });
  const c = result.chains[0];
  assert.equal(c?.status, "unavailable");
  assert.equal(c?.status === "unavailable" && c.reason, "read_failed");
});

test("Stellar horizon failure detail includes HTTP status", async () => {
  const reader = makeStellarPayerOutgoingReader({
    getOperationsPage: async () => {
      throw new Error("horizon_http_error: http=503");
    },
  });
  const out = await reader({
    network: STELLAR,
    payer: PAYER,
    from: new Date("2026-11-20T00:00:00Z"),
    to: new Date("2026-11-25T00:00:00Z"),
    timeoutMs: 5_000,
  });
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.detail, /http=503/);
});

test("own-wallets: stellar rows normalize to stellar:pubnet key", () => {
  const ctx: OwnWalletContext = {
    byNetwork: new Map([[STELLAR, new Set([OWN])]]),
  };
  const reason = exclusionReasonForPayerTransfer(
    { network: "stellar", payer: PAYER, from: PAYER, to: OWN },
    ctx,
  );
  assert.equal(reason, "own_wallet");
});

test("incremental networks include Base and Arc", () => {
  assert.equal(PAYER_RECONCILE_INCREMENTAL_NETWORKS.has(EVM), true);
  assert.equal(PAYER_RECONCILE_INCREMENTAL_NETWORKS.has(ARC_CAIP2), true);
});

test("payer outgoing Arc uses recover-late chunk and margin constants", () => {
  assert.equal(ARC_TRANSFER_READ_CHUNK_BLOCKS, 5_000n);
  assert.equal(ARC_TRANSFER_READ_MARGIN_BLOCKS, 120n);
  assert.equal(AVALANCHE_TRANSFER_READ_MARGIN_BLOCKS, 80n);
});

test("locateEvmBlock failure includes head block and time", async () => {
  const headTs = 1_700_000_000n;
  const head = { number: 9_000_000n, timestamp: headTs };
  const client = {
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
      number: blockNumber,
      timestamp: headTs,
    }),
  };
  await assert.rejects(
    () =>
      locateEvmBlock(
        client as never,
        head,
        new Date(Number(headTs) * 1000 - 48 * 60 * 60 * 1000),
        0.97,
        30,
        () => {},
        "Avalanche",
      ),
    (e: Error) => {
      assert.match(e.message, /could not locate the Avalanche block/);
      assert.match(e.message, /head_block=9000000/);
      assert.match(e.message, /head_time=/);
      return true;
    },
  );
});

test("Avalanche payer outgoing: locate miss falls back to binary search", async () => {
  const headTs = 1_700_000_000n;
  const headNum = 1_000_000n;
  const reader = makeEvmPayerOutgoingReader({
    network: AVALANCHE_CAIP2,
    chainId: AVALANCHE_CHAIN_ID,
    token: AVALANCHE_USDC_ADDRESS as `0x${string}`,
    chunkBlocks: 100n,
    marginBlocks: AVALANCHE_TRANSFER_READ_MARGIN_BLOCKS,
    blockSeconds: 0.97,
    toleranceSeconds: 30,
    chainName: "Avalanche",
    binarySearchOnLocateFailure: true,
    client: () =>
      ({
        getChainId: async () => AVALANCHE_CHAIN_ID,
        getBlock: async (q: { blockTag?: string; blockNumber?: bigint }) => {
          if (q.blockTag === "latest") return { number: headNum, timestamp: headTs };
          const n = q.blockNumber ?? 0n;
          const behind = Number(headNum - n);
          return { number: n, timestamp: headTs - BigInt(behind) };
        },
        getLogs: async () => [],
      }) as never,
  });
  const out = await reader({
    network: AVALANCHE_CAIP2,
    payer: EVM_PAYER,
    from: new Date(Number(headTs) * 1000 - 2 * 60 * 60 * 1000),
    to: new Date(Number(headTs) * 1000 - 60 * 60 * 1000),
    timeoutMs: 5_000,
  });
  assert.equal(out.ok, true);
});

test("Arc payer getLogs retries -32005 rate limit", async () => {
  __resetLearnedRangeCapsForTests();
  let calls = 0;
  const nowSec = Math.floor(Date.now() / 1000);
  const headNum = 100_000n;
  const client = {
    getChainId: async () => 5042,
    getBlock: async (q: { blockNumber?: bigint; blockTag?: string }) => {
      if (q.blockTag === "latest") return { number: headNum, timestamp: BigInt(nowSec) };
      const n = q.blockNumber ?? 0n;
      const behind = Number(headNum - n);
      return { number: n, timestamp: BigInt(nowSec - behind) };
    },
    getBlockNumber: async () => headNum,
    getLogs: async () => {
      calls++;
      if (calls <= 2) {
        throw Object.assign(new Error("Request exceeds defined limit."), {
          name: "LimitExceededRpcError",
          code: -32005,
          details: "rate limit exceeded",
        });
      }
      return [];
    },
  };
  const reader = makeEvmPayerOutgoingReader({
    network: ARC_CAIP2,
    chainId: 5042,
    token: "0x3600000000000000000000000000000000000000",
    chunkBlocks: ARC_TRANSFER_READ_CHUNK_BLOCKS,
    marginBlocks: ARC_TRANSFER_READ_MARGIN_BLOCKS,
    blockSeconds: 0.51,
    toleranceSeconds: 30,
    chainName: "Arc",
    client: () => client as never,
    chunkedGetLogs: { concurrency: 1, rateLimitMaxRetries: 3, delayMs: 0 },
  });
  const from = new Date((nowSec - 7_200) * 1000);
  const to = new Date((nowSec - 3_600) * 1000);
  const out = await reader({ network: ARC_CAIP2, payer: EVM_PAYER, from, to, timeoutMs: 30_000 });
  assert.equal(out.ok, true);
  assert.ok(calls >= 3, `expected retries, got ${calls} getLogs calls`);
});

test("Robinhood payer outgoing: binary search after flat locate estimate", async () => {
  const headTs = 1_700_000_000n;
  const headNum = 50_000n;
  const reader = makeEvmPayerOutgoingReader({
    network: ROBINHOOD_CAIP2,
    chainId: 4663,
    token: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
    chunkBlocks: 2_000n,
    marginBlocks: 120n,
    blockSeconds: 2,
    toleranceSeconds: 30,
    chainName: "Robinhood",
    binarySearchOnLocateFailure: true,
    client: () =>
      ({
        getChainId: async () => 4663,
        getBlock: async (q: { blockTag?: string; blockNumber?: bigint }) => {
          if (q.blockTag === "latest") return { number: headNum, timestamp: headTs };
          const n = q.blockNumber ?? 0n;
          const behind = Number(headNum - n);
          return { number: n, timestamp: headTs - BigInt(behind * 2) };
        },
        getLogs: async () => [],
      }) as never,
  });
  const out = await reader({
    network: ROBINHOOD_CAIP2,
    payer: EVM_PAYER,
    from: new Date(Number(headTs) * 1000 - 2 * 60 * 60 * 1000),
    to: new Date(Number(headTs) * 1000 - 60 * 60 * 1000),
    timeoutMs: 5_000,
  });
  assert.equal(out.ok, true);
});

test("locateEvmBlockBinarySearch finds block at or before target on sparse timestamps", async () => {
  const headTs = 2_000_000n;
  const headNum = 10_000n;
  const client = {
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
      const gap = 5;
      const block = Number(blockNumber);
      const ts = headTs - BigInt(Math.floor((Number(headNum) - block) / gap) * gap);
      return { number: blockNumber, timestamp: ts };
    },
  };
  const target = new Date(Number(headTs - 400n) * 1000);
  const n = await locateEvmBlockBinarySearch(client as never, { number: headNum, timestamp: headTs }, target, () => {}, "Test");
  const block = await client.getBlock({ blockNumber: n });
  assert.ok(Number(block.timestamp) * 1000 <= target.getTime());
  const newer = await client.getBlock({ blockNumber: n + 1n });
  assert.ok(Number(newer.timestamp) * 1000 > target.getTime() || n === headNum);
});

test("locateEvmBlockBinarySearch throws when iteration cap is hit", async () => {
  const headTs = 2_000_000n;
  const client = {
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
      number: blockNumber,
      timestamp: headTs - blockNumber,
    }),
  };
  await assert.rejects(
    () =>
      locateEvmBlockBinarySearch(
        client as never,
        { number: 1_000_000n, timestamp: headTs },
        new Date(Number(headTs - 500_000n) * 1000),
        () => {},
        "Test",
        3,
      ),
    (e: Error) => {
      assert.match(e.message, /binary search iteration cap/);
      return true;
    },
  );
});

test("Base payer Blockscout v2: cursor pages descend to window start", async () => {
  const windowFrom = new Date("2026-11-25T00:00:00.000Z");
  const windowTo = new Date("2026-11-26T00:00:00.000Z");
  const fromSec = Math.floor(windowFrom.getTime() / 1000);
  const toSec = Math.floor(windowTo.getTime() / 1000);
  const midSec = Math.floor((fromSec + toSec) / 2);
  const inWindowRow = {
    hash: "0xIN",
    timeStamp: String(midSec),
    from: EVM_PAYER,
    to: "0xdest2",
    value: "2000000",
    blockNumber: "101",
  };
  const padRow = (i: number) => ({
    hash: `0xPAD${i}`,
    timeStamp: String(toSec + 60),
    from: EVM_PAYER,
    to: "0xdest",
    value: "1",
    blockNumber: String(200 + i),
  });
  const page1Rows = Array.from({ length: 49 }, (_, i) => padRow(i)).concat([inWindowRow]);
  const page2Rows = [
    {
      hash: "0xOLD",
      timeStamp: String(fromSec - 60),
      from: EVM_PAYER,
      to: "0xdest3",
      value: "3",
      blockNumber: "50",
    },
  ];
  let pageCalls = 0;
  let getBlockCalls = 0;
  const reader = makeBasePayerOutgoingReader(
    {
      getChainId: async () => 8453,
      getBlock: async () => {
        getBlockCalls++;
        throw new Error("RPC head should not run after Blockscout");
      },
      getLogs: async () => {
        throw new Error("getLogs should not run");
      },
    } as never,
    async (_addr, opts) => {
      pageCalls++;
      if (!opts.cursor) {
        return {
          rows: page1Rows,
          rawItemCount: 50,
          pageOldestSec: midSec,
          nextCursor: { block_number: "100" },
        };
      }
      return {
        rows: page2Rows,
        rawItemCount: 1,
        pageOldestSec: fromSec - 60,
        nextCursor: null,
      };
    },
    async () => windowTo.getTime(),
  );
  const out = await reader({
    network: EVM,
    payer: EVM_PAYER,
    from: windowFrom,
    to: windowTo,
    timeoutMs: 10_000,
  });
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.transfers.length, 1);
    assert.equal(out.transfers[0]?.txHash, "0xIN");
    assert.equal(out.readThroughMs, undefined);
  }
  assert.equal(pageCalls, 2);
  assert.equal(getBlockCalls, 0);
});

test("Base payer Blockscout: scan incomplete uses raw count before token filter", async () => {
  let getLogsCalled = false;
  const nowSec = Math.floor(Date.now() / 1000);
  const reader = makeBasePayerOutgoingReader(
    {
      getChainId: async () => 8453,
      getBlock: async () => ({ number: 1n, timestamp: BigInt(nowSec) }),
      getLogs: async () => {
        getLogsCalled = true;
        return [];
      },
    } as never,
    async () => ({
      rows: [],
      rawItemCount: 50,
      pageOldestSec: nowSec,
      nextCursor: { block_number: "1" },
    }),
    async () => nowSec * 1000,
  );
  const out = await reader({
    network: EVM,
    payer: EVM_PAYER,
    from: new Date("2020-01-01T00:00:00.000Z"),
    to: new Date("2026-11-26T00:00:00.000Z"),
    timeoutMs: 10_000,
  });
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.detail, /blockscout_scan_incomplete/);
  assert.equal(getLogsCalled, false);
});

test("Base payer Blockscout: indexed head behind window → node_behind_window", async () => {
  const now = new Date("2026-11-26T10:00:00.000Z");
  const { to: windowTo } = payerReconcileWindow(now, new Date("2026-11-26T08:00:00.000Z"));
  const indexedBehind = new Date(windowTo.getTime() - 6 * 60 * 60 * 1000);

  const result = await runPayerReconcile({
    now,
    persistRun: noopPersist,
    deadlineAt: FAR_FUTURE_DEADLINE,
    loadRecoverLateLastSuccess: async () => new Date("2026-11-26T08:00:00.000Z"),
    loadNetworks: async () => [{ network: EVM, payer: EVM_PAYER }],
    loadTxHashes: async () => new Set(),
    readOutgoing: makeBasePayerOutgoingReader(
      {
        getChainId: async () => 8453,
        getBlock: async () => {
          throw new Error("RPC head should not run");
        },
        getLogs: async () => [],
      } as never,
      async () => ({
        rows: [],
        rawItemCount: 0,
        pageOldestSec: null,
        nextCursor: null,
      }),
      async () => indexedBehind.getTime(),
    ),
    ownWallets: emptyOwn,
  });

  const c = result.chains[0];
  assert.equal(c?.status, "unavailable");
  assert.equal(c?.status === "unavailable" && c.reason, "node_behind_window");
  assert.equal(c?.status === "unavailable" && c.windowTo, indexedBehind.toISOString());
  assert.equal(result.ok, false);
});

test("Base payer falls back to RPC getLogs when Blockscout is unavailable", async () => {
  let getLogsCalled = false;
  const nowSec = Math.floor(Date.now() / 1000);
  const headTs = BigInt(nowSec);
  const headNum = firstBlockAtOrAfter(BASE_BLOCK_TIME_SCHEDULE, nowSec) + 1000n;
  const reader = makeBasePayerOutgoingReader(
    {
      getChainId: async () => 8453,
      getBlockNumber: async () => headNum,
      getBlock: async (q: { blockTag?: string; blockNumber?: bigint }) => {
        if (q.blockTag === "latest") return { number: headNum, timestamp: headTs };
        return { number: q.blockNumber ?? 0n, timestamp: headTs };
      },
      getLogs: async () => {
        getLogsCalled = true;
        return [
          {
            blockNumber: 100n,
            transactionHash: "0xrpc",
            args: { from: EVM_PAYER, to: "0xdest", value: 5_000_000n },
          },
        ];
      },
    } as never,
    async () => {
      throw new BlockscoutUnavailableError("blockscout_http_503");
    },
    async () => {
      throw new Error("indexed head should not run when transfer read falls back to RPC");
    },
  );
  const now = Date.now();
  const out = await reader({
    network: EVM,
    payer: EVM_PAYER,
    from: new Date(now - 3_600_000),
    to: new Date(now - 1_800_000),
    timeoutMs: 15_000,
  });
  assert.equal(getLogsCalled, true);
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.transfers[0]?.txHash, "0xrpc");
});
test("Base payer reader: Alchemy first when its key is set (2026-11-27 base.blockscout.com 403), pages by pageKey, window kept, raw amounts", async () => {
  const realFetch = globalThis.fetch;
  const prevKey = process.env.ALCHEMY_API_KEY;
  process.env.ALCHEMY_API_KEY = "test-key";
  const to = new Date("2026-11-25T20:00:00.000Z");
  const from = new Date("2026-11-23T20:00:00.000Z");
  const usdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const bodies: Record<string, unknown>[] = [];
  const tr = (hash: string, iso: string, value: string) => ({
    uniqueId: `${hash}:log:0`, hash, blockNum: "0x10", from: EVM_PAYER.toLowerCase(), to: "0x000000000000000000000000000000000000beef",
    category: "erc20", rawContract: { value, address: usdc, decimal: "0x6" }, metadata: { blockTimestamp: iso },
  });
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (!u.includes("base-mainnet.g.alchemy.com")) throw new Error(`unexpected fetch ${u}`);
    const body = JSON.parse(String(init?.body));
    bodies.push(body.params[0]);
    const page = body.params[0].pageKey
      ? { transfers: [tr("0xbb", "2026-11-24T00:00:00.000Z", "0x1e8480"), tr("0xcc", "2026-11-20T00:00:00.000Z", "0x01")] }
      : { transfers: [tr("0xaa", "2026-11-26T10:00:00.000Z", "0x2710")], pageKey: "k2" };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: page }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const out = await makeBasePayerOutgoingReader()({ network: EVM, payer: EVM_PAYER, from, to, timeoutMs: 5_000 });
    assert.equal(out.ok, true, out.ok ? "" : out.detail);
    if (out.ok) {
      assert.deepEqual(out.transfers.map((t) => [t.txHash, t.value]), [["0xbb", "2000000"]], "only the transfer inside the window, raw units");
    }
    assert.equal(bodies.length, 2, "second page read through pageKey, then stopped at a transfer older than the window");
    assert.equal(bodies[0]!.fromAddress, EVM_PAYER);
    assert.deepEqual((bodies[0]!.contractAddresses as string[]).map((a) => a.toLowerCase()), [usdc]);
    assert.equal(bodies[1]!.pageKey, "k2");
  } finally {
    globalThis.fetch = realFetch;
    if (prevKey === undefined) delete process.env.ALCHEMY_API_KEY;
    else process.env.ALCHEMY_API_KEY = prevKey;
  }
});

test("Base payer reader: an Alchemy row without a block time is not dropped; the read falls back instead (2026-11-27)", async () => {
  const realFetch = globalThis.fetch;
  const prevKey = process.env.ALCHEMY_API_KEY;
  process.env.ALCHEMY_API_KEY = "test-key";
  let alchemyCalls = 0;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("base-mainnet.g.alchemy.com")) {
      alchemyCalls++;
      const body = JSON.parse(String(init?.body));
      const t = { uniqueId: "0xdd:log:0", hash: "0xdd", blockNum: "0x10", from: EVM_PAYER.toLowerCase(), to: "0x000000000000000000000000000000000000beef", category: "erc20", rawContract: { value: "0x01" }, metadata: {} };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { transfers: [t] } }), { status: 200 });
    }
    return new Response("<!DOCTYPE html>Just a moment...", { status: 403 });
  }) as typeof fetch;
  const client = { getChainId: async () => { throw new Error("rpc refused"); } };
  try {
    const out = await makeBasePayerOutgoingReader(client as never)({ network: EVM, payer: EVM_PAYER, from: new Date("2026-11-23T20:00:00.000Z"), to: new Date("2026-11-25T20:00:00.000Z"), timeoutMs: 5_000 });
    assert.equal(alchemyCalls, 1);
    assert.equal(out.ok, false, "not an empty success");
  } finally {
    globalThis.fetch = realFetch;
    if (prevKey === undefined) delete process.env.ALCHEMY_API_KEY;
    else process.env.ALCHEMY_API_KEY = prevKey;
  }
});

function alchemyPayerFetchMock(
  host: string,
  bodies: Record<string, unknown>[],
  pages: { transfers: Record<string, unknown>[]; pageKey?: string }[],
) {
  let call = 0;
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (!u.includes(host)) throw new Error(`unexpected fetch ${u}`);
    const body = JSON.parse(String(init?.body));
    bodies.push(body.params[0]);
    const page = pages[call] ?? { transfers: [] };
    call++;
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: { transfers: page.transfers, ...(page.pageKey ? { pageKey: page.pageKey } : {}) },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

function alchemyErc20Row(hash: string, iso: string, value: string, usdc: string) {
  return {
    uniqueId: `${hash}:log:0`,
    hash,
    blockNum: "0x10",
    from: EVM_PAYER.toLowerCase(),
    to: "0x000000000000000000000000000000000000beef",
    category: "erc20",
    rawContract: { value, address: usdc, decimal: "0x6" },
    metadata: { blockTimestamp: iso },
  };
}

test("Arbitrum payer reader: Alchemy first when its key is set, pages by pageKey, window kept", async () => {
  const realFetch = globalThis.fetch;
  const prevKey = process.env.ALCHEMY_API_KEY;
  process.env.ALCHEMY_API_KEY = "test-key";
  const from = new Date("2026-11-23T20:00:00.000Z");
  const to = new Date("2026-11-25T20:00:00.000Z");
  const usdc = ARBITRUM_USDC_ADDRESS.toLowerCase();
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = alchemyPayerFetchMock("arb-mainnet.g.alchemy.com", bodies, [
    {
      transfers: [alchemyErc20Row("0xaa", "2026-11-26T10:00:00.000Z", "0x2710", usdc)],
      pageKey: "k2",
    },
    {
      transfers: [
        alchemyErc20Row("0xbb", "2026-11-24T00:00:00.000Z", "0x1e8480", usdc),
        alchemyErc20Row("0xcc", "2026-11-20T00:00:00.000Z", "0x01", usdc),
      ],
    },
  ]);
  try {
    const out = await makeChainPayerOutgoingReader()({ network: ARBITRUM_CAIP2, payer: EVM_PAYER, from, to, timeoutMs: 5_000 });
    assert.equal(out.ok, true, out.ok ? "" : out.detail);
    if (out.ok) {
      assert.deepEqual(out.transfers.map((t) => [t.txHash, t.value]), [["0xbb", "2000000"]]);
    }
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0]!.fromAddress, EVM_PAYER);
    assert.deepEqual((bodies[0]!.contractAddresses as string[]).map((a) => a.toLowerCase()), [usdc]);
  } finally {
    globalThis.fetch = realFetch;
    if (prevKey === undefined) delete process.env.ALCHEMY_API_KEY;
    else process.env.ALCHEMY_API_KEY = prevKey;
  }
});

test("Arbitrum payer reader: Alchemy row without block time falls back and fails, not empty success", async () => {
  const realFetch = globalThis.fetch;
  const prevKey = process.env.ALCHEMY_API_KEY;
  const prevArb = process.env.ARBITRUM_RPC_URL;
  process.env.ALCHEMY_API_KEY = "test-key";
  process.env.ARBITRUM_RPC_URL = "https://arb1.arbitrum.io/rpc";
  let alchemyCalls = 0;
  const usdc = ARBITRUM_USDC_ADDRESS.toLowerCase();
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).includes("arb-mainnet.g.alchemy.com")) {
      alchemyCalls++;
      const body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            transfers: [
              {
                uniqueId: "0xdd:log:0",
                hash: "0xdd",
                blockNum: "0x10",
                from: EVM_PAYER.toLowerCase(),
                to: "0xbeef",
                category: "erc20",
                rawContract: { value: "0x01", address: usdc },
                metadata: {},
              },
            ],
          },
        }),
        { status: 200 },
      );
    }
    throw new Error("unexpected fetch");
  }) as typeof fetch;
  try {
    const out = await makeChainPayerOutgoingReader()({
      network: ARBITRUM_CAIP2,
      payer: EVM_PAYER,
      from: new Date("2026-11-23T20:00:00.000Z"),
      to: new Date("2026-11-25T20:00:00.000Z"),
      timeoutMs: 5_000,
    });
    assert.equal(alchemyCalls, 1);
    assert.equal(out.ok, false);
  } finally {
    globalThis.fetch = realFetch;
    if (prevKey === undefined) delete process.env.ALCHEMY_API_KEY;
    else process.env.ALCHEMY_API_KEY = prevKey;
    if (prevArb === undefined) delete process.env.ARBITRUM_RPC_URL;
    else process.env.ARBITRUM_RPC_URL = prevArb;
  }
});

test("Avalanche payer reader: Alchemy first when its key is set, pages by pageKey, window kept", async () => {
  const realFetch = globalThis.fetch;
  const prevKey = process.env.ALCHEMY_API_KEY;
  process.env.ALCHEMY_API_KEY = "test-key";
  const from = new Date("2026-11-23T20:00:00.000Z");
  const to = new Date("2026-11-25T20:00:00.000Z");
  const usdc = AVALANCHE_USDC_ADDRESS.toLowerCase();
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = alchemyPayerFetchMock("avax-mainnet.g.alchemy.com", bodies, [
    {
      transfers: [alchemyErc20Row("0xaa", "2026-11-26T10:00:00.000Z", "0x2710", usdc)],
      pageKey: "k2",
    },
    { transfers: [alchemyErc20Row("0xbb", "2026-11-24T00:00:00.000Z", "0x1e8480", usdc)] },
  ]);
  try {
    const out = await makeChainPayerOutgoingReader()({ network: AVALANCHE_CAIP2, payer: EVM_PAYER, from, to, timeoutMs: 5_000 });
    assert.equal(out.ok, true, out.ok ? "" : out.detail);
    if (out.ok) assert.equal(out.transfers[0]?.txHash, "0xbb");
    assert.equal(bodies.length, 2);
  } finally {
    globalThis.fetch = realFetch;
    if (prevKey === undefined) delete process.env.ALCHEMY_API_KEY;
    else process.env.ALCHEMY_API_KEY = prevKey;
  }
});

test("Avalanche payer reader: Alchemy row without block time is not dropped; read fails honestly", async () => {
  const realFetch = globalThis.fetch;
  const prevKey = process.env.ALCHEMY_API_KEY;
  const prevAvax = process.env.AVALANCHE_RPC_URL;
  process.env.ALCHEMY_API_KEY = "test-key";
  process.env.AVALANCHE_RPC_URL = "https://api.avax.network/ext/bc/C/rpc";
  let alchemyCalls = 0;
  const usdc = AVALANCHE_USDC_ADDRESS.toLowerCase();
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).includes("avax-mainnet.g.alchemy.com")) {
      alchemyCalls++;
      const body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            transfers: [
              {
                uniqueId: "x",
                hash: "0xdd",
                blockNum: "0x1",
                from: EVM_PAYER.toLowerCase(),
                to: "0xbeef",
                category: "erc20",
                rawContract: { value: "0x01", address: usdc },
                metadata: {},
              },
            ],
          },
        }),
        { status: 200 },
      );
    }
    return new Response("<!DOCTYPE html>", { status: 503, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  try {
    const out = await makeChainPayerOutgoingReader()({
      network: AVALANCHE_CAIP2,
      payer: EVM_PAYER,
      from: new Date("2026-11-23T20:00:00.000Z"),
      to: new Date("2026-11-25T20:00:00.000Z"),
      timeoutMs: 5_000,
    });
    assert.equal(alchemyCalls, 1);
    assert.equal(out.ok, false);
  } finally {
    globalThis.fetch = realFetch;
    if (prevKey === undefined) delete process.env.ALCHEMY_API_KEY;
    else process.env.ALCHEMY_API_KEY = prevKey;
    if (prevAvax === undefined) delete process.env.AVALANCHE_RPC_URL;
    else process.env.AVALANCHE_RPC_URL = prevAvax;
  }
});

test("Robinhood payer getLogs retries HTTP 429 and completes when RPC cooperates", async () => {
  __resetLearnedRangeCapsForTests();
  let calls = 0;
  const nowSec = Math.floor(Date.now() / 1000);
  const headNum = 20_000n;
  const client = {
    getChainId: async () => 4663,
    getBlock: async (q: { blockNumber?: bigint; blockTag?: string }) => {
      if (q.blockTag === "latest") return { number: headNum, timestamp: BigInt(nowSec) };
      const n = q.blockNumber ?? 0n;
      const behind = Number(headNum - n);
      return { number: n, timestamp: BigInt(nowSec - behind * 2) };
    },
    getLogs: async () => {
      calls++;
      if (calls <= 2) {
        throw Object.assign(new Error("Too Many Requests"), { name: "HttpRequestError", status: 429 });
      }
      return [];
    },
  };
  const reader = makeEvmPayerOutgoingReader({
    network: ROBINHOOD_CAIP2,
    chainId: 4663,
    token: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
    chunkBlocks: 500n,
    marginBlocks: 120n,
    blockSeconds: 2,
    toleranceSeconds: 30,
    chainName: "Robinhood",
    binarySearchOnLocateFailure: true,
    client: () => client as never,
    chunkedGetLogs: { concurrency: 1, rateLimitMaxRetries: 5, delayMs: 0 },
  });
  const from = new Date((nowSec - 7_200) * 1000);
  const to = new Date((nowSec - 3_600) * 1000);
  const out = await reader({ network: ROBINHOOD_CAIP2, payer: EVM_PAYER, from, to, timeoutMs: 60_000 });
  assert.equal(out.ok, true);
  assert.ok(calls >= 3, `expected 429 retries, got ${calls} getLogs calls`);
});

test("Robinhood payer getLogs: 429 on every try ends as a failed read, never ok with what was read", async () => {
  __resetLearnedRangeCapsForTests();
  const nowSec = Math.floor(Date.now() / 1000);
  const headNum = 20_000n;
  let calls = 0;
  const client = {
    getChainId: async () => 4663,
    getBlock: async (q: { blockNumber?: bigint; blockTag?: string }) => {
      if (q.blockTag === "latest") return { number: headNum, timestamp: BigInt(nowSec) };
      const n = q.blockNumber ?? 0n;
      return { number: n, timestamp: BigInt(nowSec - Number(headNum - n) * 2) };
    },
    getLogs: async () => {
      calls++;
      throw Object.assign(new Error("Too Many Requests"), { name: "HttpRequestError", status: 429 });
    },
  };
  const reader = makeEvmPayerOutgoingReader({
    network: ROBINHOOD_CAIP2,
    chainId: 4663,
    token: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
    chunkBlocks: 500n,
    marginBlocks: 120n,
    blockSeconds: 2,
    toleranceSeconds: 30,
    chainName: "Robinhood",
    binarySearchOnLocateFailure: true,
    client: () => client as never,
    chunkedGetLogs: { concurrency: 1, rateLimitMaxRetries: 2, delayMs: 0 },
  });
  const out = await reader({
    network: ROBINHOOD_CAIP2,
    payer: EVM_PAYER,
    from: new Date((nowSec - 7_200) * 1000),
    to: new Date((nowSec - 3_600) * 1000),
    timeoutMs: 30_000,
  });
  assert.equal(out.ok, false);
  assert.ok(calls >= 1);
});

test("Arbitrum payer reader: a thrown Alchemy error falls back to the RPC with only the time left", async () => {
  const realFetch = globalThis.fetch;
  const prevKey = process.env.ALCHEMY_API_KEY;
  const prevArb = process.env.ARBITRUM_RPC_URL;
  process.env.ALCHEMY_API_KEY = "test-key";
  process.env.ARBITRUM_RPC_URL = "https://arb-rpc.test/rpc";
  let rpcCalls = 0;
  globalThis.fetch = (async (url: string | URL) => {
    if (String(url).includes("arb-mainnet.g.alchemy.com")) throw new TypeError("fetch failed");
    rpcCalls++;
    return new Response("<!DOCTYPE html>", { status: 503, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  try {
    const out = await makeChainPayerOutgoingReader()({
      network: ARBITRUM_CAIP2,
      payer: EVM_PAYER,
      from: new Date("2026-11-23T20:00:00.000Z"),
      to: new Date("2026-11-25T20:00:00.000Z"),
      timeoutMs: 5_000,
    });
    assert.ok(rpcCalls >= 1, "expected the RPC fallback to be tried");
    assert.equal(out.ok, false);
  } finally {
    globalThis.fetch = realFetch;
    if (prevKey === undefined) delete process.env.ALCHEMY_API_KEY;
    else process.env.ALCHEMY_API_KEY = prevKey;
    if (prevArb === undefined) delete process.env.ARBITRUM_RPC_URL;
    else process.env.ARBITRUM_RPC_URL = prevArb;
  }
});

test("Robinhood payer reader (production config): a two-day window at ~0.11s blocks takes a handful of getLogs calls", async () => {
  __resetLearnedRangeCapsForTests();
  const realFetch = globalThis.fetch;
  const prevRpc = process.env.RWA_RPC_URL;
  process.env.RWA_RPC_URL = "https://robinhood-rpc.test/rpc";
  const nowSec = Math.floor(Date.now() / 1000);
  const head = 124_000_000;
  const tsOf = (n: number) => Math.floor(nowSec - (head - n) * 0.11);
  const hex = (n: number) => `0x${n.toString(16)}`;
  let getLogsCalls = 0;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (!String(url).includes("robinhood-rpc.test")) throw new Error(`unexpected fetch ${String(url)}`);
    const body = JSON.parse(String(init?.body));
    const one = (req: { id: number; method: string; params: unknown[] }) => {
      if (req.method === "eth_chainId") return { jsonrpc: "2.0", id: req.id, result: hex(4663) };
      if (req.method === "eth_getBlockByNumber") {
        const tag = req.params[0] as string;
        const n = tag === "latest" ? head : Math.min(head, parseInt(tag, 16));
        return {
          jsonrpc: "2.0",
          id: req.id,
          result: {
            number: hex(n),
            timestamp: hex(tsOf(n)),
            hash: `0x${"1".repeat(64)}`,
            parentHash: `0x${"0".repeat(64)}`,
            transactions: [],
            uncles: [],
            logsBloom: `0x${"0".repeat(512)}`,
            gasLimit: "0x1",
            gasUsed: "0x0",
            difficulty: "0x0",
            extraData: "0x",
            miner: `0x${"0".repeat(40)}`,
            nonce: "0x0000000000000000",
            size: "0x1",
            stateRoot: `0x${"0".repeat(64)}`,
            transactionsRoot: `0x${"0".repeat(64)}`,
            receiptsRoot: `0x${"0".repeat(64)}`,
            sha3Uncles: `0x${"0".repeat(64)}`,
            mixHash: `0x${"0".repeat(64)}`,
            baseFeePerGas: "0x0",
          },
        };
      }
      if (req.method === "eth_getLogs") {
        getLogsCalls++;
        return { jsonrpc: "2.0", id: req.id, result: [] };
      }
      return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `no ${req.method}` } };
    };
    const out = Array.isArray(body) ? body.map(one) : one(body);
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const out = await makeChainPayerOutgoingReader()({
      network: ROBINHOOD_CAIP2,
      payer: EVM_PAYER.toLowerCase(),
      from: new Date((nowSec - 2 * 86_400) * 1000),
      to: new Date((nowSec - 60) * 1000),
      timeoutMs: 60_000,
    });
    assert.equal(out.ok, true, out.ok ? "" : out.detail);
    assert.ok(getLogsCalls >= 1 && getLogsCalls <= 5, `expected a handful of getLogs calls, got ${getLogsCalls}`);
  } finally {
    globalThis.fetch = realFetch;
    if (prevRpc === undefined) delete process.env.RWA_RPC_URL;
    else process.env.RWA_RPC_URL = prevRpc;
  }
});
