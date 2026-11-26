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
import { ARBITRUM_CAIP2 } from "@/lib/chain/arbitrum";
import { AVALANCHE_CAIP2 } from "@/lib/chain/avalanche";
import { BNB_CAIP2 } from "@/lib/chain/bnb";
import { exclusionReasonForPayerTransfer, type OwnWalletContext } from "@/lib/settlements/own-wallets";
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

test("reader returning null → unavailable, ok false", async () => {
  const result = await runPayerReconcile({
    persistRun: noopPersist,
    deadlineAt: FAR_FUTURE_DEADLINE,
    loadNetworks: async () => [{ network: STELLAR, payer: PAYER }],
    loadTxHashes: async () => new Set(),
    readOutgoing: async () => null,
    ownWallets: emptyOwn,
  });
  assert.equal(result.ok, false);
  assert.equal(result.chains[0]?.status, "unavailable");
});

test("reader throw → unavailable", async () => {
  const result = await runPayerReconcile({
    persistRun: noopPersist,
    deadlineAt: FAR_FUTURE_DEADLINE,
    loadNetworks: async () => [{ network: STELLAR, payer: PAYER }],
    loadTxHashes: async () => new Set(),
    readOutgoing: async () => {
      throw new Error("rpc down");
    },
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
    readOutgoing: async () => [transfer("a", "GDEST1")],
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
    readOutgoing: async () => [transfer("known", "GDEST1"), transfer("missing", "GDEST2")],
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
    readOutgoing: async ({ payer }) => (payer === PAYER ? [transfer("known", "GDEST1")] : null),
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
    client: () => null,
  });
  const out = await reader({
    network: ARBITRUM_CAIP2,
    payer: EVM_PAYER,
    from: new Date("2026-11-20T00:00:00Z"),
    to: new Date("2026-11-25T00:00:00Z"),
  });
  assert.equal(out, null);
});

test("Solana without RPC → not_configured, no recent purchases", async () => {
  const result = await runPayerReconcile({
    persistRun: noopPersist,
    deadlineAt: FAR_FUTURE_DEADLINE,
    loadNetworks: async () => [{ network: SOLANA_MAINNET_CAIP2, payer: "SoPayer111" }],
    loadTxHashes: async () => new Set(),
    countRecentPurchases: async () => 0,
    readOutgoing: async () => null,
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

const INCREMENTAL_RPC_ENVS = ["BNB_RPC_URL", "ARBITRUM_RPC_URL", "AVALANCHE_RPC_URL"] as const;

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
      readOutgoing: async () => [],
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
      readOutgoing: async ({ payer }) => (payer === p1 ? [] : null),
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

  const networks = [BNB_CAIP2, ARBITRUM_CAIP2, AVALANCHE_CAIP2].map((network) => ({
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
        return [];
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
      readOutgoing: async () => [],
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
          resolve(null);
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
    readOutgoing: async () => [transfer("known", "GDEST1")],
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