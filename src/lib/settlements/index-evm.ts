// ============================================================
// 経路 3（EVM）: 既知の payTo への USDC Transfer をチェーンから読む（§7.1 / §7.2）。
//
// 全 USDC 転送を舐めない。カタログが宣言した受取先（x402_endpoints.pay_to）を
// `to` にした Transfer ログだけを、チェックポイントから続きで読む。1 回の走査は
// 上限ブロック数と締切で止め、未読は次回に持ち越す（cron 1 回で終わらなくてよい）。
//
// チェーンは表で足す。Polygon（eip155:137）は POLYGON_RPC_URL が入れば有効。
// ============================================================
import { parseAbiItem, type Address } from "viem";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { getLogScanClient } from "@/lib/chain/client";
import { getLogsChunked } from "@/lib/chain/chunked-logs";
import { getIndexerCheckpoint, setIndexerCheckpoint } from "@/lib/db/owner-index";
import { payeeId as toPartyId } from "@/lib/ids/canonical";
import { loadWashClassifier, type WashClassifier } from "./context";
import { buildRow, knownPurchaseIds, rowsOf, upsertSettlementsBatch } from "./upsert";
import type { SettlementRow } from "./types";
import { attribute } from "./attribution";
import { classifyWash } from "./wash";
import { purchaseId as toPurchaseId } from "@/lib/ids/canonical";

export const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

export type EvmIndexChain = {
  caip2: string;
  chainId: number;
  usdc: Address;
  rpcEnv: string;
  /** 初回の遡り幅（ブロック）。Base は ~2s/ブロック。 */
  initialLookbackBlocks: bigint;
  /** 1 回の走査で読む最大ブロック数。 */
  maxBlocksPerRun: bigint;
  /** 確定待ち（reorg 余裕）。 */
  confirmations: bigint;
};

export const EVM_INDEX_CHAINS: EvmIndexChain[] = [
  {
    caip2: "eip155:8453",
    chainId: 8453,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    rpcEnv: "BASE_RPC_URL",
    initialLookbackBlocks: 43_200n * 7n,
    maxBlocksPerRun: 40_000n,
    confirmations: 32n,
  },
  {
    caip2: "eip155:137",
    chainId: 137,
    usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    rpcEnv: "POLYGON_RPC_URL",
    initialLookbackBlocks: 40_000n * 7n,
    maxBlocksPerRun: 40_000n,
    confirmations: 64n,
  },
];

export type EvmIndexSummary = {
  chain: string;
  skipped?: string;
  fromBlock?: string;
  toBlock?: string;
  payees: number;
  logs: number;
  inserted: number;
  updated: number;
  partial?: boolean;
  checkpoint?: string;
  skippedKnown?: number;
};

export function isEvmChainIndexable(chain: EvmIndexChain): boolean {
  // Base は既定 RPC がある。それ以外は env が要る（未設定は skipped として開示）。
  return chain.chainId === 8453 || Boolean(process.env[chain.rpcEnv]?.trim());
}

export async function indexEvmChain(
  chain: EvmIndexChain,
  options: { budgetMs?: number; classifier?: WashClassifier; now?: () => number } = {},
): Promise<EvmIndexSummary> {
  const db = getDb();
  if (!db) throw new Error("indexEvmChain: DATABASE_URL is not configured");
  const summary: EvmIndexSummary = { chain: chain.caip2, payees: 0, logs: 0, inserted: 0, updated: 0 };
  if (!isEvmChainIndexable(chain)) return { ...summary, skipped: `${chain.rpcEnv}_unset` };
  const { budgetMs = 120_000, now = Date.now } = options;
  const startedAt = now();

  const payees = rowsOf<{ pay_to: string }>(
    await db.execute(sql`
      SELECT DISTINCT lower(pay_to) AS pay_to FROM x402_endpoints
      WHERE pay_to IS NOT NULL AND pay_to LIKE '0x%' AND length(pay_to) = 42
        AND (network = ${chain.caip2} OR (${chain.caip2} = 'eip155:8453' AND network = 'base'))
    `),
  ).map((r) => r.pay_to as Address);
  summary.payees = payees.length;
  if (payees.length === 0) return { ...summary, skipped: "no_known_payees" };

  const client = getLogScanClient(chain.chainId);
  const latest = await client.getBlockNumber();
  const safeTip = latest > chain.confirmations ? latest - chain.confirmations : 0n;
  const scope = `settlements:${chain.caip2}`;
  const checkpoint = await getIndexerCheckpoint(scope);
  const fromBlock = checkpoint !== null ? checkpoint + 1n : safeTip > chain.initialLookbackBlocks ? safeTip - chain.initialLookbackBlocks : 0n;
  if (fromBlock > safeTip) return { ...summary, skipped: "caught_up", fromBlock: String(fromBlock), toBlock: String(safeTip) };
  const toBlock = fromBlock + chain.maxBlocksPerRun - 1n < safeTip ? fromBlock + chain.maxBlocksPerRun - 1n : safeTip;
  summary.fromBlock = String(fromBlock);
  summary.toBlock = String(toBlock);

  const classifier = options.classifier ?? (await loadWashClassifier());

  // --- 事前ロード（1 件ごとの Neon 往復を無くす。2026-09-02 実測: 往復 4〜5 回で 2 秒/件） ---
  // payee → endpoints（payTo・宣言 amount/asset・resource_id）。1 文。
  type Ep = { id: string; resource_id: string | null; pay_to: string; price_amount: string | null; price_asset: string | null; network: string | null };
  const epRows = rowsOf<Ep>(
    await db.execute(sql`
      SELECT id::text AS id, resource_id, lower(pay_to) AS pay_to, price_amount, price_asset, network
      FROM x402_endpoints WHERE pay_to IS NOT NULL AND pay_to LIKE '0x%' AND status = 'active'
        AND (network = ${chain.caip2} OR (${chain.caip2} = 'eip155:8453' AND network = 'base'))
    `),
  );
  const epsByPayee = new Map<string, Ep[]>();
  for (const e of epRows) {
    const list = epsByPayee.get(e.pay_to) ?? [];
    list.push(e);
    epsByPayee.set(e.pay_to, list);
  }
  const resolveLocal = (payee: string, amount: string, blockTime: Date) => {
    const eps = epsByPayee.get(payee) ?? [];
    if (eps.length === 0) return { attribution: "unmatched" as const, resourceId: null, endpointId: null };
    if (eps.length === 1) {
      const e = eps[0];
      const a = attribute(
        { payee, amount, asset: chain.usdc, chain: chain.caip2, blockTime },
        { payTo: e.pay_to, amount: e.price_amount, asset: e.price_asset, network: e.network, observedAt: blockTime },
      );
      return { attribution: a === "unmatched" ? ("probable" as const) : a, resourceId: e.resource_id, endpointId: e.id };
    }
    // 複数 resource が同じ payTo: amount が宣言と一致するものがあれば confirmed でそれに帰属
    const exact = eps.find((e) => e.price_amount === amount);
    if (exact) return { attribution: "confirmed" as const, resourceId: exact.resource_id, endpointId: exact.id };
    return { attribution: "probable" as const, resourceId: null, endpointId: null };
  };

  // ブロック時刻は窓の両端を実測し、間は 2 秒/ブロックで補間する（帰属窓は 15 分・十分）。
  const [b0, b1] = await Promise.all([client.getBlock({ blockNumber: fromBlock }), client.getBlock({ blockNumber: toBlock })]);
  const t0 = Number(b0.timestamp) * 1000;
  const t1 = Number(b1.timestamp) * 1000;
  const span = Number(toBlock - fromBlock) || 1;
  const blockTimeOf = (n: bigint) => new Date(t0 + ((Number(n - fromBlock) / span) * (t1 - t0)));

  let cutOff = false;
  const sliceProgress: bigint[] = [];
  const pending: SettlementRow[] = [];
  const flush = async () => {
    if (pending.length === 0) return;
    const r = await upsertSettlementsBatch(pending.splice(0, pending.length));
    summary.inserted += r.inserted;
    summary.updated += r.updated;
  };

  // topics[2]（to）は最大 500 件ずつ OR で問う。
  for (let i = 0; i < payees.length; i += 500) {
    if (now() - startedAt > budgetMs) {
      cutOff = true;
      break;
    }
    const slice = payees.slice(i, i + 500);
    const logs = await getLogsChunked(
      client,
      { address: chain.usdc, event: TRANSFER_EVENT, args: { to: slice }, fromBlock, toBlock } as never,
      undefined,
      undefined,
      { deadlineMs: Math.max(5_000, budgetMs - (now() - startedAt)) },
    );
    summary.logs += logs.length;
    const sorted = (logs as unknown as { transactionHash: string; blockNumber: bigint; args: { from: Address; to: Address; value: bigint } }[]).sort((a, b) =>
      a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0,
    );
    let sliceLast: bigint = fromBlock - 1n;
    let sliceDone = true;
    const known = await knownPurchaseIds(sorted.map((l) => toPurchaseId(chain.caip2, l.transactionHash)));
    summary.skippedKnown = (summary.skippedKnown ?? 0) + known.size;
    // 往復（circular）の材料: 同じ窓の (from,to) 対をメモリに持つ
    const pairs = new Set(sorted.map((l) => `${l.args.from.toLowerCase()}>${l.args.to.toLowerCase()}`));
    for (const log of sorted) {
      if (now() - startedAt > budgetMs) {
        cutOff = true;
        sliceDone = false;
        break;
      }
      if (known.has(toPurchaseId(chain.caip2, log.transactionHash))) {
        if (log.blockNumber > sliceLast) sliceLast = log.blockNumber;
        continue;
      }
      const blockTime = blockTimeOf(log.blockNumber);
      const payee = log.args.to.toLowerCase();
      const payer = log.args.from.toLowerCase();
      const amount = log.args.value.toString();
      const resolved = resolveLocal(payee, amount, blockTime);
      const payerId = toPartyId(chain.caip2, payer);
      const payeeId = toPartyId(chain.caip2, payee);
      const reverseInWindow = pairs.has(`${payee}>${payer}`);
      const washFlag = classifyWash(
        { payerId, payeeId, blockTime },
        { testWallets: classifier.testWallets, sameCluster: classifier.sameCluster, reverseWithinHours: () => reverseInWindow },
      );
      pending.push(
        buildRow(
          { chain: chain.caip2, txHash: log.transactionHash, asset: chain.usdc, amount, payer, payee, blockTime, source: "chain_index", raw: { blockNumber: String(log.blockNumber), blockTimeSource: "interpolated" } },
          { attribution: resolved.attribution, washFlag, resourceId: resolved.resourceId, endpointId: resolved.endpointId },
        ),
      );
      if (pending.length >= 200) await flush();
      if (log.blockNumber > sliceLast) sliceLast = log.blockNumber;
    }
    await flush();
    sliceProgress.push(sliceDone ? toBlock : sliceLast > fromBlock ? sliceLast - 1n : fromBlock - 1n);
    if (cutOff) break;
  }
  const expectedSlices = Math.ceil(payees.length / 500);
  while (sliceProgress.length < expectedSlices) sliceProgress.push(fromBlock - 1n);
  const nextCheckpoint = sliceProgress.reduce((m, v) => (v < m ? v : m), toBlock);
  await setIndexerCheckpoint(scope, nextCheckpoint, latest);
  summary.partial = cutOff;
  summary.checkpoint = String(nextCheckpoint);
  return summary;
}

export async function indexEvm(options: { budgetMs?: number; classifier?: WashClassifier } = {}): Promise<EvmIndexSummary[]> {
  const out: EvmIndexSummary[] = [];
  const perChain = Math.max(20_000, Math.floor((options.budgetMs ?? 120_000) / EVM_INDEX_CHAINS.length));
  for (const chain of EVM_INDEX_CHAINS) {
    try {
      out.push(await indexEvmChain(chain, { ...options, budgetMs: perChain }));
    } catch (error) {
      out.push({ chain: chain.caip2, skipped: `error:${error instanceof Error ? error.message.slice(0, 120) : String(error)}`, payees: 0, logs: 0, inserted: 0, updated: 0 });
    }
  }
  return out;
}
