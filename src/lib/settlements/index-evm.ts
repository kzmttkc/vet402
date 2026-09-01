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
import { resolveEndpointForSettlement } from "./ingest-payments";
import { loadWashClassifier, type WashClassifier } from "./context";
import { buildRow, rowsOf, upsertSettlement } from "./upsert";

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
  // 締切で途中終了したら、チェックポイントは「処理し終えたブロック」までしか進めない
  // （2026-09-02 初回実走: 7,030 ログ中 570 件で締切、残りが次回に持ち越されなかった）。
  // payee スライスごとに「どこまで処理し終えたか」を持ち、チェックポイントはその最小値。
  // 未着手のスライスがあれば fromBlock-1（同じ窓を次回もう一度読む。upsert は冪等）。
  const sliceProgress: bigint[] = [];
  let cutOff = false;
  const blockTimeCache = new Map<bigint, Date>();
  const blockTimeOf = async (n: bigint) => {
    const hit = blockTimeCache.get(n);
    if (hit) return hit;
    const b = await client.getBlock({ blockNumber: n });
    const d = new Date(Number(b.timestamp) * 1000);
    blockTimeCache.set(n, d);
    return d;
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
    // ブロック昇順に処理し、締切時に「ここまでは全件済み」と言える位置を持つ
    const sorted = (logs as unknown as { transactionHash: string; blockNumber: bigint; args: { from: Address; to: Address; value: bigint } }[]).sort((a, b) =>
      a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0,
    );
    let sliceLast: bigint = fromBlock - 1n;
    let sliceDone = true;
    for (const log of sorted) {
      if (now() - startedAt > budgetMs) {
        cutOff = true;
        sliceDone = false;
        break;
      }
      const blockTime = await blockTimeOf(log.blockNumber);
      const payee = log.args.to.toLowerCase();
      const payer = log.args.from.toLowerCase();
      const amount = log.args.value.toString();
      const resolved = await resolveEndpointForSettlement(db, {
        chain: chain.caip2,
        payee,
        amount,
        asset: chain.usdc,
        blockTime,
        resourceUrl: null,
      });
      const washFlag = await classifier.classify({
        payerId: toPartyId(chain.caip2, payer),
        payeeId: toPartyId(chain.caip2, payee),
        blockTime,
      });
      const row = buildRow(
        {
          chain: chain.caip2,
          txHash: log.transactionHash,
          asset: chain.usdc,
          amount,
          payer,
          payee,
          blockTime,
          source: "chain_index",
          raw: { blockNumber: String(log.blockNumber) },
        },
        { attribution: resolved.attribution, washFlag, resourceId: resolved.resourceId, endpointId: resolved.endpointId },
      );
      const outcome = await upsertSettlement(row);
      if (outcome === "inserted") summary.inserted++;
      else summary.updated++;
      if (log.blockNumber > sliceLast) sliceLast = log.blockNumber;
    }
    // 完走したスライスは toBlock まで済み。途中なら処理済み最終ブロックの 1 つ手前まで
    // （同ブロック内の未処理ログを落とさない）。
    sliceProgress.push(sliceDone ? toBlock : sliceLast > fromBlock ? sliceLast - 1n : fromBlock - 1n);
    if (cutOff) break;
  }
  const expectedSlices = Math.ceil(payees.length / 500);
  while (sliceProgress.length < expectedSlices) sliceProgress.push(fromBlock - 1n); // 未着手スライス
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
