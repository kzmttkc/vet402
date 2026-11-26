// ============================================================
// 払い手から出た USDC 送金が、公開台帳（x402_l1_purchases.tx_hash）に全部あるか毎日見る。
// 2026-11-26: Stellar で 14/428 本が未記録のまま外部監査で先に見つかった件の再発防止。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { getIndexerCheckpointWithCursor, setIndexerCheckpoint } from "@/lib/db/owner-index";
import { ARBITRUM_CAIP2 } from "@/lib/chain/arbitrum";
import { AVALANCHE_CAIP2 } from "@/lib/chain/avalanche";
import { BNB_CAIP2 } from "@/lib/chain/bnb";
import { toCaip2 } from "@/lib/observatory/chains";
import { SOLANA_MAINNET_CAIP2 } from "@/lib/observatory/sol402-payer";
import { redactForLog } from "@/lib/observatory/redact";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { payeeId } from "@/lib/ids/canonical";
import { loadOwnWalletContext, exclusionReasonForPayerTransfer, type OwnWalletContext } from "./own-wallets";
import {
  PAYER_OUTGOING_UNAVAILABLE,
  formatPayerOutgoingFailure,
  makeChainPayerOutgoingReader,
  payerOutgoingNotConfiguredReason,
  type PayerOutgoingReader,
} from "./payer-outgoing-readers";
import { payerReconcilePurchaseNetwork } from "./payer-reconcile-network";
import { STELLAR_PUBNET_CAIP2 } from "@/lib/observatory/stellar402-payer";
import { insertPayerReconcileRun } from "./payer-reconcile-runs";
import { rowsOf } from "./upsert";
import type { ChainTransfer } from "./recover-late";

export const PAYER_RECONCILE_WINDOW_HOURS = 48;
export const PAYER_RECONCILE_END_BUFFER_MINUTES = 35;
export const PAYER_RECONCILE_WINDOW_END_FALLBACK_HOURS = 24;
export const PAYER_RECONCILE_MAX_INCREMENTAL_WINDOW_MS = 24 * 60 * 60 * 1000;
export const PAYER_RECONCILE_MAX_BOOKMARK_LAG_MS = 36 * 60 * 60 * 1000;
export const PAYER_RECONCILE_NOT_CONFIGURED_LOOKBACK_HOURS = 48;
export const RECOVER_LATE_LAST_SUCCESS_SCOPE = "recover-late:last_success";
export const LOG_TAG_PAYER_RECONCILE_UNRECORDED = "observatory.payer-reconcile.unrecorded";
export const LOG_TAG_PAYER_RECONCILE_UNAVAILABLE = "observatory.payer-reconcile.unavailable";

/** BNB・Arbitrum・Avalanche は前回読めた終わりからの増分窓にする。 */
export const PAYER_RECONCILE_INCREMENTAL_NETWORKS = new Set<string>([BNB_CAIP2, ARBITRUM_CAIP2, AVALANCHE_CAIP2]);

export type PayerReconcileChainOk = {
  status: "ok";
  network: string;
  payer: string;
  read: number;
  matched: number;
  unrecorded: number;
  unrecordedTxs: string[];
  excluded: number;
  excludedByReason: Record<string, number>;
  windowFrom: string;
  windowTo: string;
  /** 増分チェーンのみ。照合窓の終わりと読み終えた印の差（ミリ秒）。 */
  bookmarkLagMs?: number;
};

export type PayerReconcileChainUnavailable = {
  status: "unavailable";
  network: string;
  payer: string;
  reason: string;
  detail?: string;
} & Partial<
  Pick<
    PayerReconcileChainOk,
    | "read"
    | "matched"
    | "unrecorded"
    | "unrecordedTxs"
    | "excluded"
    | "excludedByReason"
    | "windowFrom"
    | "windowTo"
    | "bookmarkLagMs"
  >
>;

export type PayerReconcileChainNotConfigured = {
  status: "not_configured";
  network: string;
  payer: string;
  reason: string;
  /** 直近 48 時間の購入行数（未設定チェーンの監視用）。 */
  recentPurchases: number;
};

export type PayerReconcileChainResult =
  | PayerReconcileChainOk
  | PayerReconcileChainUnavailable
  | PayerReconcileChainNotConfigured;

export type PayerReconcileResult = {
  at: string;
  windowFrom: string;
  windowTo: string;
  chains: PayerReconcileChainResult[];
  ok: boolean;
  totalUnrecorded: number;
  totalNotConfigured: number;
  anyUnavailable: boolean;
};

export function payerReconcileWindowScope(network: string, payer: string): string {
  const caip = toCaip2(network) ?? network;
  const payerKey = normalizePayerForKey(caip, payer);
  return `payer-reconcile:window:${caip}:${payerKey}`;
}

export function payerReconcileWindowEnd(now: Date, lastRecoverLateSuccess: Date | null): Date {
  if (!lastRecoverLateSuccess) {
    return new Date(now.getTime() - PAYER_RECONCILE_WINDOW_END_FALLBACK_HOURS * 60 * 60_000);
  }
  const fromNow = new Date(now.getTime() - PAYER_RECONCILE_END_BUFFER_MINUTES * 60_000);
  const fromRecover = new Date(
    lastRecoverLateSuccess.getTime() - PAYER_RECONCILE_END_BUFFER_MINUTES * 60_000,
  );
  return fromNow < fromRecover ? fromNow : fromRecover;
}

export function payerReconcileWindow(
  now = new Date(),
  lastRecoverLateSuccess: Date | null = null,
): { from: Date; to: Date } {
  const to = payerReconcileWindowEnd(now, lastRecoverLateSuccess);
  const from = new Date(to.getTime() - PAYER_RECONCILE_WINDOW_HOURS * 60 * 60_000);
  return { from, to };
}

export function normalizePayerForKey(network: string, payer: string): string {
  const caip = toCaip2(network) ?? network;
  if (caip.startsWith("eip155:")) return payer.toLowerCase();
  return payer;
}

export function txHashOnLedger(network: string, txHash: string, ledger: ReadonlySet<string>): boolean {
  const caip = toCaip2(network) ?? network;
  if (caip === SOLANA_MAINNET_CAIP2 || caip.startsWith("solana:")) return ledger.has(txHash);
  return ledger.has(txHash.trim().toLowerCase());
}

export function alertTxHash(network: string, txHash: string): string {
  const caip = toCaip2(network) ?? network;
  if (caip === SOLANA_MAINNET_CAIP2 || caip.startsWith("solana:")) return txHash;
  return txHash.trim().toLowerCase();
}

function uniqueByTx(network: string, transfers: ChainTransfer[]): ChainTransfer[] {
  const map = new Map<string, ChainTransfer>();
  for (const t of transfers) {
    const key = alertTxHash(network, t.txHash);
    if (!map.has(key)) map.set(key, t);
  }
  return [...map.values()];
}

export function reconcilePayerTransfers(input: {
  network: string;
  payer: string;
  transfers: ChainTransfer[];
  purchaseTxHashes: ReadonlySet<string>;
  ownWallets: OwnWalletContext;
}): Omit<
  PayerReconcileChainOk,
  "status" | "network" | "payer" | "windowFrom" | "windowTo" | "bookmarkLagMs"
> {
  const unique = uniqueByTx(input.network, input.transfers);
  let matched = 0;
  let unrecorded = 0;
  let excluded = 0;
  const excludedByReason: Record<string, number> = {};
  const unrecordedTxs: string[] = [];
  for (const t of unique) {
    const reason = exclusionReasonForPayerTransfer(
      { network: input.network, payer: input.payer, from: t.from, to: t.to },
      input.ownWallets,
    );
    if (reason) {
      excluded++;
      excludedByReason[reason] = (excludedByReason[reason] ?? 0) + 1;
      continue;
    }
    if (txHashOnLedger(input.network, t.txHash, input.purchaseTxHashes)) {
      matched++;
      continue;
    }
    unrecorded++;
    unrecordedTxs.push(alertTxHash(input.network, t.txHash));
  }
  unrecordedTxs.sort();
  return {
    read: unique.length,
    matched,
    unrecorded,
    unrecordedTxs,
    excluded,
    excludedByReason,
  };
}

export async function loadPayerNetworks(): Promise<{ network: string; payer: string }[]> {
  const db = getDb();
  if (!db) throw new Error("loadPayerNetworks: DATABASE_URL is not configured");
  const rows = rowsOf<{ network: string; payer: string }>(
    await db.execute(sql`
      SELECT DISTINCT network, payer FROM x402_l1_purchases
      WHERE payer IS NOT NULL AND network IS NOT NULL
    `),
  );
  const out: { network: string; payer: string }[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const caip = payerReconcilePurchaseNetwork(r.network);
    if (!caip) continue;
    const payer = normalizePayerForKey(caip, r.payer);
    const key = `${caip}\0${payer}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ network: caip, payer: r.payer.trim() });
  }
  out.sort((a, b) => a.network.localeCompare(b.network) || a.payer.localeCompare(b.payer));
  return out;
}

async function loadPurchaseTxHashes(network: string): Promise<Set<string>> {
  const db = getDb();
  if (!db) throw new Error("loadPurchaseTxHashes: DATABASE_URL is not configured");
  const caip = toCaip2(network) ?? network;
  const aliases =
    caip === "eip155:8453"
      ? ["eip155:8453", "base"]
      : caip === "eip155:5042"
        ? ["eip155:5042", "arc"]
        : [caip];
  const rows = rowsOf<{ tx_hash: string }>(
    await db.execute(sql`
      SELECT DISTINCT tx_hash FROM x402_l1_purchases
      WHERE tx_hash IS NOT NULL AND trim(tx_hash) <> '' AND network IN (${sql.join(
        aliases.map((a) => sql`${a}`),
        sql`, `,
      )})
    `),
  );
  const out = new Set<string>();
  const solana = caip === SOLANA_MAINNET_CAIP2 || caip.startsWith("solana:");
  for (const r of rows) {
    out.add(solana ? r.tx_hash : r.tx_hash.trim().toLowerCase());
  }
  return out;
}

function networkAliases(network: string): string[] {
  const caip = toCaip2(network) ?? network;
  if (caip === "eip155:8453") return ["eip155:8453", "base"];
  if (caip === "eip155:5042") return ["eip155:5042", "arc"];
  if (caip === STELLAR_PUBNET_CAIP2) return ["stellar:pubnet", "stellar"];
  return [caip];
}

export async function countRecentPurchases(network: string, since: Date): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  const aliases = networkAliases(network);
  const rows = rowsOf<{ count: string }>(
    await db.execute(sql`
      SELECT COUNT(*)::text AS count FROM x402_l1_purchases
      WHERE network IN (${sql.join(aliases.map((a) => sql`${a}`), sql`, `)})
        AND attempted_at >= ${since.toISOString()}::timestamptz
    `),
  );
  const n = Number(rows[0]?.count ?? "0");
  return Number.isFinite(n) ? n : 0;
}

export async function loadRecoverLateLastSuccessAt(): Promise<Date | null> {
  if (!getDb()) return null;
  const cp = await getIndexerCheckpointWithCursor(RECOVER_LATE_LAST_SUCCESS_SCOPE);
  if (!cp?.lastCursor) return null;
  const parsed = Date.parse(cp.lastCursor);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function capIncrementalReadEnd(from: Date, windowTo: Date): Date {
  const maxEnd = new Date(from.getTime() + PAYER_RECONCILE_MAX_INCREMENTAL_WINDOW_MS);
  return maxEnd < windowTo ? maxEnd : windowTo;
}

async function loadIncrementalWindowFrom(network: string, payer: string, defaultFrom: Date): Promise<Date> {
  if (!PAYER_RECONCILE_INCREMENTAL_NETWORKS.has(network)) return defaultFrom;
  if (!getDb()) return defaultFrom;
  const cp = await getIndexerCheckpointWithCursor(payerReconcileWindowScope(network, payer));
  if (!cp?.lastCursor) return defaultFrom;
  const parsed = Date.parse(cp.lastCursor);
  return Number.isFinite(parsed) ? new Date(parsed) : defaultFrom;
}

async function saveIncrementalWindowEnd(network: string, payer: string, windowEnd: Date): Promise<void> {
  if (!PAYER_RECONCILE_INCREMENTAL_NETWORKS.has(network)) return;
  if (!getDb()) return;
  await setIndexerCheckpoint(payerReconcileWindowScope(network, payer), 0n, undefined, windowEnd.toISOString());
}

function unavailableReason(network: string, budget: boolean, readFailed: boolean, detail?: string): string {
  if (budget) return "budget";
  if (detail?.startsWith("node_behind_window:")) return "node_behind_window";
  if (readFailed) return "read_failed";
  return PAYER_OUTGOING_UNAVAILABLE[network] ?? "no payer-outgoing reader for this network";
}

function redactOutgoingDetail(detail: string | undefined): string | undefined {
  return detail ? redactForLog(detail) : undefined;
}

function nodeBehindWindowDetail(readThrough: Date, wantedTo: Date): string {
  return `unread_from=${readThrough.toISOString()} unread_to=${wantedTo.toISOString()}`;
}

function chainUnrecorded(c: PayerReconcileChainResult): number {
  if (c.status !== "ok" && c.status !== "unavailable") return 0;
  return typeof c.unrecorded === "number" ? c.unrecorded : 0;
}

async function readOutgoingWithBudget(
  readOutgoing: PayerOutgoingReader,
  q: Parameters<PayerOutgoingReader>[0],
  deadlineAt: number,
): Promise<{ transfers: ChainTransfer[] | null; budget: boolean; detail?: string; readThroughMs?: number }> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return { transfers: null, budget: true };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budgetPromise = new Promise<"budget">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("budget");
    }, remaining);
  });
  try {
    const raced = await Promise.race([
      readOutgoing({ ...q, timeoutMs: remaining, signal: controller.signal }),
      budgetPromise,
    ]);
    if (raced === "budget") return { transfers: null, budget: true };
    if (!raced.ok) return { transfers: null, budget: false, detail: raced.detail };
    return { transfers: raced.transfers, budget: false, readThroughMs: raced.readThroughMs };
  } catch (e) {
    if (controller.signal.aborted) return { transfers: null, budget: true };
    return { transfers: null, budget: false, detail: formatPayerOutgoingFailure(e) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function reconcileOneNetworkPayer(
  ctx: {
    network: string;
    payer: string;
    defaultWindow: { from: Date; to: Date };
    deadlineAt: number;
    readOutgoing: PayerOutgoingReader;
    ownWallets: OwnWalletContext;
    loadTxHashes: (network: string) => Promise<Set<string>>;
    loadWindowFrom: (network: string, payer: string, defaultFrom: Date) => Promise<Date>;
    countRecent: (network: string, since: Date) => Promise<number>;
    purchaseLookbackSince: Date;
    txCache: Map<string, Set<string>>;
    checkpointEnds: { network: string; payer: string; windowEnd: Date }[];
  },
): Promise<PayerReconcileChainResult> {
  const { network, payer, defaultWindow, deadlineAt, readOutgoing, ownWallets } = ctx;
  const presetReason = PAYER_OUTGOING_UNAVAILABLE[network];
  if (presetReason) {
    return { status: "unavailable", network, payer, reason: presetReason };
  }

  const notConfigured = payerOutgoingNotConfiguredReason(network);
  if (notConfigured) {
    const recentPurchases = await ctx.countRecent(network, ctx.purchaseLookbackSince);
    return {
      status: "not_configured",
      network,
      payer,
      reason: notConfigured,
      recentPurchases,
    };
  }

  const windowTo = defaultWindow.to;
  const defaultFrom = defaultWindow.from;
  const incremental = PAYER_RECONCILE_INCREMENTAL_NETWORKS.has(network);
  let cursorFrom = await ctx.loadWindowFrom(network, payer, defaultFrom);
  const windowFromStr = cursorFrom.toISOString();
  const transfers: ChainTransfer[] = [];
  let bookmarkEnd = cursorFrom;
  let nodeBehindDetail: string | undefined;

  if (incremental) {
    while (cursorFrom.getTime() < windowTo.getTime()) {
      if (Date.now() >= deadlineAt) break;
      const readTo = capIncrementalReadEnd(cursorFrom, windowTo);
      const { transfers: chunk, budget, detail, readThroughMs } = await readOutgoingWithBudget(
        readOutgoing,
        { network, payer, from: cursorFrom, to: readTo, timeoutMs: Math.max(1, deadlineAt - Date.now()) },
        deadlineAt,
      );
      if (chunk === null) {
        return {
          status: "unavailable",
          network,
          payer,
          reason: unavailableReason(network, budget, !budget, detail),
          ...(detail ? { detail: redactOutgoingDetail(detail) } : {}),
        };
      }
      transfers.push(...chunk);
      const throughMs = readThroughMs ?? readTo.getTime();
      bookmarkEnd = new Date(throughMs);
      if (throughMs < readTo.getTime()) {
        nodeBehindDetail = nodeBehindWindowDetail(bookmarkEnd, readTo);
        break;
      }
      if (readTo.getTime() >= windowTo.getTime()) break;
      cursorFrom = readTo;
    }
  } else {
    const { transfers: chunk, budget, detail, readThroughMs } = await readOutgoingWithBudget(
      readOutgoing,
      { network, payer, from: cursorFrom, to: windowTo, timeoutMs: Math.max(1, deadlineAt - Date.now()) },
      deadlineAt,
    );
    if (chunk === null) {
      return {
        status: "unavailable",
        network,
        payer,
        reason: unavailableReason(network, budget, !budget, detail),
        ...(detail ? { detail: redactOutgoingDetail(detail) } : {}),
      };
    }
    transfers.push(...chunk);
    const throughMs = readThroughMs ?? windowTo.getTime();
    bookmarkEnd = new Date(throughMs);
    if (throughMs < windowTo.getTime()) {
      nodeBehindDetail = nodeBehindWindowDetail(bookmarkEnd, windowTo);
    }
  }

  let hashes = ctx.txCache.get(network);
  if (!hashes) {
    hashes = await ctx.loadTxHashes(network);
    ctx.txCache.set(network, hashes);
  }

  const body = reconcilePayerTransfers({
    network,
    payer,
    transfers,
    purchaseTxHashes: hashes,
    ownWallets,
  });

  const bookmarkLagMs = incremental ? Math.max(0, windowTo.getTime() - bookmarkEnd.getTime()) : undefined;

  if (incremental && bookmarkEnd.getTime() > new Date(windowFromStr).getTime()) {
    ctx.checkpointEnds.push({ network, payer, windowEnd: bookmarkEnd });
  }

  if (nodeBehindDetail) {
    return {
      status: "unavailable",
      network,
      payer,
      reason: "node_behind_window",
      detail: redactOutgoingDetail(nodeBehindDetail),
      windowFrom: windowFromStr,
      windowTo: bookmarkEnd.toISOString(),
      ...(bookmarkLagMs !== undefined ? { bookmarkLagMs } : {}),
      ...body,
    };
  }

  return {
    status: "ok",
    network,
    payer,
    windowFrom: windowFromStr,
    windowTo: bookmarkEnd.toISOString(),
    ...(bookmarkLagMs !== undefined ? { bookmarkLagMs } : {}),
    ...body,
  };
}

function groupNetworksByChain(networks: { network: string; payer: string }[]): { network: string; payer: string }[][] {
  const byNetwork = new Map<string, { network: string; payer: string }[]>();
  for (const row of networks) {
    const list = byNetwork.get(row.network);
    if (list) list.push(row);
    else byNetwork.set(row.network, [row]);
  }
  return [...byNetwork.values()];
}

export async function runPayerReconcile(options: {
  now?: Date;
  readOutgoing?: PayerOutgoingReader;
  deadlineAt?: number;
  ownWallets?: OwnWalletContext;
  loadNetworks?: () => Promise<{ network: string; payer: string }[]>;
  loadTxHashes?: (network: string) => Promise<Set<string>>;
  loadRecoverLateLastSuccess?: () => Promise<Date | null>;
  countRecentPurchases?: (network: string, since: Date) => Promise<number>;
  onUnrecorded?: (detail: string) => void;
  onUnavailable?: (detail: string) => void;
  persistRun?: (result: PayerReconcileResult) => Promise<void>;
  loadWindowFrom?: (network: string, payer: string, defaultFrom: Date) => Promise<Date>;
  saveWindowEnd?: (network: string, payer: string, windowEnd: Date) => Promise<void>;
} = {}): Promise<PayerReconcileResult> {
  const now = options.now ?? new Date();
  const loadRecoverLateLastSuccess = options.loadRecoverLateLastSuccess ?? loadRecoverLateLastSuccessAt;
  const lastRecoverSuccess = await loadRecoverLateLastSuccess();
  const defaultWindow = payerReconcileWindow(now, lastRecoverSuccess);
  const readOutgoing = options.readOutgoing ?? makeChainPayerOutgoingReader();
  const ownWallets = options.ownWallets ?? (await loadOwnWalletContext());
  const loadNetworks = options.loadNetworks ?? loadPayerNetworks;
  const loadTxHashes = options.loadTxHashes ?? loadPurchaseTxHashes;
  const countRecent = options.countRecentPurchases ?? countRecentPurchases;
  const loadWindowFrom = options.loadWindowFrom ?? loadIncrementalWindowFrom;
  const saveWindowEnd = options.saveWindowEnd ?? saveIncrementalWindowEnd;
  const persistRun = options.persistRun ?? (getDb() ? insertPayerReconcileRun : async () => {});
  const deadlineAt = options.deadlineAt ?? Date.now() + 280_000;
  const purchaseLookbackSince = new Date(
    now.getTime() - PAYER_RECONCILE_NOT_CONFIGURED_LOOKBACK_HOURS * 60 * 60_000,
  );

  const networks = await loadNetworks();
  const txCache = new Map<string, Set<string>>();
  const checkpointEnds: { network: string; payer: string; windowEnd: Date }[] = [];

  const reconcileCtx = {
    defaultWindow,
    deadlineAt,
    readOutgoing,
    ownWallets,
    loadTxHashes,
    loadWindowFrom,
    countRecent,
    purchaseLookbackSince,
    txCache,
    checkpointEnds,
  };

  const chains: PayerReconcileChainResult[] = (
    await Promise.all(
      groupNetworksByChain(networks).map(async (group) => {
        const out: PayerReconcileChainResult[] = [];
        for (const { network, payer } of group) {
          out.push(await reconcileOneNetworkPayer({ ...reconcileCtx, network, payer }));
        }
        return out;
      }),
    )
  ).flat();

  const totalUnrecorded = chains.reduce((n, c) => n + chainUnrecorded(c), 0);
  const totalNotConfigured = chains.filter((c) => c.status === "not_configured").length;
  const anyUnavailable = chains.some((c) => c.status === "unavailable");
  const chainsOkForStatus = chains.every((c) => c.status === "ok" || c.status === "not_configured");
  const notConfiguredBlocksOk = chains.some(
    (c) => c.status === "not_configured" && c.recentPurchases > 0,
  );
  const bookmarkLagBlocksOk = chains.some(
    (c) =>
      c.status === "ok" &&
      typeof c.bookmarkLagMs === "number" &&
      c.bookmarkLagMs > PAYER_RECONCILE_MAX_BOOKMARK_LAG_MS,
  );

  if (totalUnrecorded > 0) {
    const detail = chains
      .filter((c) => chainUnrecorded(c) > 0)
      .map(
        (c) =>
          `${c.network} payer=${payeeId(c.network, c.payer) ?? c.payer}: ${chainUnrecorded(c)} unrecorded (${(c.status === "ok" || c.status === "unavailable") && c.unrecordedTxs ? c.unrecordedTxs.join(", ") : ""})`,
      )
      .join("; ");
    if (options.onUnrecorded) options.onUnrecorded(detail);
    else logServerErrorSafe(LOG_TAG_PAYER_RECONCILE_UNRECORDED, new Error(detail));
  }

  if (anyUnavailable) {
    const detail = chains
      .filter((c): c is PayerReconcileChainUnavailable => c.status === "unavailable")
      .map((c) => `${c.network} payer=${c.payer}: ${c.reason}${c.detail ? ` (${redactForLog(c.detail)})` : ""}`)
      .join("; ");
    if (options.onUnavailable) options.onUnavailable(detail);
    else logServerErrorSafe(LOG_TAG_PAYER_RECONCILE_UNAVAILABLE, new Error(detail));
  }

  chains.sort((a, b) => a.network.localeCompare(b.network) || a.payer.localeCompare(b.payer));

  const globalFrom = chains.reduce(
    (min, c) => {
      const f = c.status === "ok" ? c.windowFrom : defaultWindow.from.toISOString();
      return f < min ? f : min;
    },
    defaultWindow.from.toISOString(),
  );

  const result: PayerReconcileResult = {
    at: now.toISOString(),
    windowFrom: globalFrom,
    windowTo: defaultWindow.to.toISOString(),
    chains,
    ok:
      totalUnrecorded === 0 &&
      chainsOkForStatus &&
      !notConfiguredBlocksOk &&
      !bookmarkLagBlocksOk,
    totalUnrecorded,
    totalNotConfigured,
    anyUnavailable,
  };

  try {
    await persistRun(result);
    for (const end of checkpointEnds) {
      await saveWindowEnd(end.network, end.payer, end.windowEnd);
    }
  } catch (e) {
    logServerErrorSafe("payer-reconcile.persist", e);
  }

  return result;
}