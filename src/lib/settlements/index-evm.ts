// ============================================================
// 経路 3（EVM）: 既知の payTo への USDC Transfer をチェーンから読む（§7.1 / §7.2）。
//
// 全 USDC 転送を舐めない。カタログが宣言した受取先（x402_endpoints.pay_to）を
// `to` にした Transfer ログだけを、チェックポイントから続きで読む。1 回の走査は
// 上限ブロック数と締切で止め、未読は次回に持ち越す（cron 1 回で終わらなくてよい）。
//
// チェーンは表で足す。Polygon（eip155:137）は POLYGON_RPC_URL が入れば有効。
// Arc（eip155:5042・2026-09-17）は ARC_RPC_URL が入れば有効。scoring の CHAINS 登録簿には
// 載せない（chain/arc.ts 参照）ので、クライアントは行の makeClient で組む。
// ============================================================
import { createPublicClient, http, parseAbiItem, type Address } from "viem";
import { tempo as tempoChain } from "viem/chains";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { getLogScanClient } from "@/lib/chain/client";
import { ARC_CHAIN_ID, ARC_USDC_ADDRESS, getArcPublicClient } from "@/lib/chain/arc";
import { logServerError } from "@/lib/util/log";
import { getLogsChunked } from "@/lib/chain/chunked-logs";
import { getIndexerCheckpoint, setIndexerCheckpoint } from "@/lib/db/owner-index";
import { payeeId as toPartyId } from "@/lib/ids/canonical";
import { loadWashClassifier, type WashClassifier } from "./context";
import { buildRow, knownPurchaseIds, rowsOf, upsertSettlementsBatch } from "./upsert";
import type { SettlementRow } from "./types";
import { attribute } from "./attribution";
import { classifyWash } from "./wash";
import { purchaseId as toPurchaseId } from "@/lib/ids/canonical";
import { TEMPO_CHAIN_ID, TEMPO_USDC_E, isMppAttributionMemo, tempoRpcUrl } from "@/lib/observatory/mpp-payer";

export const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
/** TIP-20（Tempo）の memo 付き転送。MPP の client は transferWithMemo を呼ぶ（2026-09-17）。 */
export const TRANSFER_WITH_MEMO_EVENT = parseAbiItem(
  "event TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 memo)",
);

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
  /** 1 日のブロック数（遅れの判定 evmIndexLag に使う）。 */
  blocksPerDay: bigint;
  /** TransferWithMemo も読む（TIP-20・Tempo）。memo が MPP の tag を持つ転送は raw.mppAttributed=true。 */
  memoTransfers?: boolean;
  /** 既定は getLogScanClient(chainId)。CHAINS 登録簿に無いチェーン（Arc・Tempo）はここで組む。 */
  makeClient?: () => ReturnType<typeof getLogScanClient>;
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
    blocksPerDay: 43_200n,
  },
  {
    caip2: "eip155:137",
    chainId: 137,
    usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    rpcEnv: "POLYGON_RPC_URL",
    initialLookbackBlocks: 40_000n * 7n,
    maxBlocksPerRun: 40_000n,
    confirmations: 64n,
    blocksPerDay: 40_000n,
  },
  // Arc（Circle のステーブルコイン L1・メインネット公開 2026-09-16）。2026-09-17 Arc レーン。
  //  - ブロックは約 1 秒（オーナー実測 2026-09-17）。7 日の遡りは 86,400 × 7 ブロック。
  //    チェーンが若いので初回は safeTip − lookback が 0 を割り、実際には genesis 付近から読む。
  //  - 1 回の走査は 172,800 ブロック（= 2 日ぶん）。cron は 1 日 1 回（vercel.json 13:00 UTC）
  //    なので、Base と同じ 40,000 では 1 日 86,400 ブロックに永遠に追いつかない（レビュー
  //    2026-09-17 指摘）。2 日ぶん読めば、遅れた日も翌日に回収できる。往復数: 既定の
  //    GET_LOGS_CHUNK_BLOCKS 2,000 で 87 チャンク／payee 500 件のスライス 1 つ、
  //    GET_LOGS_CHUNK_CONCURRENCY 4 で約 22 ラウンド。1 ラウンド 0.2〜0.5 秒なら 5〜11 秒。
  //    （Base は 2 秒/ブロックで 40,000 = ≈ 22 時間・20 チャンク。）
  //  - 遅れが 1 日ぶん（blocksPerDay）を超えたら summary.lagBlocks と partial で鳴らす
  //    （evmIndexLag・全チェーン共通）。
  //  - 確定待ち 64 ブロック（≈ 64 秒）。Arc の合意は BFT 系で確定的と Circle は説明するが、
  //    我々はそれを実測していない。Polygon と同じ余裕を取っても遅れは 1 分で、reorg を
  //    「確認済み」と刻む事故に比べれば安い。
  //  - ARC_RPC_URL が無ければ skipped（`ARC_RPC_URL_unset`）——公開 RPC へ無言で倒れない。
  {
    caip2: "eip155:5042",
    chainId: ARC_CHAIN_ID,
    usdc: ARC_USDC_ADDRESS,
    rpcEnv: "ARC_RPC_URL",
    initialLookbackBlocks: 86_400n * 7n,
    maxBlocksPerRun: 86_400n * 2n,
    confirmations: 64n,
    blocksPerDay: 86_400n,
    makeClient: () => getArcPublicClient("batch"),
  },
  // Tempo（MPP・2026-09-17 Tempo レーン）。~1 秒/ブロック = 86,400/日（blocksPerDay）。
  //   initialLookbackBlocks 259,200 = 3 日（Base の 7 日は 302,400 ブロックで、同じ桁に収める）。
  //   maxBlocksPerRun 172,800 = 2 日ぶん（Arc と同じ理由: 日次 cron が 1 日 86,400 に追いつき、
  //     遅れた日も翌日に回収できる）。2,000 ブロック/chunk × 87 chunk・Base 実測 0.14 秒/chunk →
  //     受取先 500 件までなら ~12 秒。
  //   confirmations 64 ≈ 1 分。Tempo の確定の仕様は未確認なので、1 秒ブロックに対して深めに取る。
  //   TEMPO_RPC_URL が無ければ skipped（`TEMPO_RPC_URL_unset`）——公開 RPC へ無言で倒れない（Arc と同じ）。
  //   TransferWithMemo も読む（MPP の client は transferWithMemo を呼ぶ）。
  // 受取先は L0 が MPP の challenge から学んだ pay_to（directory には載らない）。
  {
    caip2: `eip155:${TEMPO_CHAIN_ID}`,
    chainId: TEMPO_CHAIN_ID,
    usdc: TEMPO_USDC_E as Address,
    rpcEnv: "TEMPO_RPC_URL",
    initialLookbackBlocks: 86_400n * 3n,
    maxBlocksPerRun: 86_400n * 2n,
    confirmations: 64n,
    blocksPerDay: 86_400n,
    memoTransfers: true,
    makeClient: () => {
      const rpc = tempoRpcUrl();
      if (!rpc) throw new Error("TEMPO_RPC_URL_unset");
      return createPublicClient({ chain: tempoChain, transport: http(rpc, { timeout: 20_000, retryCount: 3 }) }) as unknown as ReturnType<typeof getLogScanClient>;
    },
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
  /** 走査後もチェックポイントが安全な先端から 1 日ぶん以上遅れているとき、その差（ブロック）。 */
  lagBlocks?: string;
};

/**
 * 走査後の遅れ（2026-09-17 レビュー）。safeTip − checkpoint が 1 日ぶんを超えたら
 * その差を返す（summary.lagBlocks に載せ、partial として鳴らす）。超えなければ null。
 * 純関数。cron の日次 1 回で追いつけていないチェーンを、静かに遅れさせない。
 */
export function evmIndexLag(chain: Pick<EvmIndexChain, "blocksPerDay">, safeTip: bigint, checkpoint: bigint): bigint | null {
  const lag = safeTip - checkpoint;
  return lag > chain.blocksPerDay ? lag : null;
}

/**
 * チェーンごとの実行予算（2026-09-17 レビュー）。割る数は**実行可能な**チェーン数
 * （isEvmChainIndexable・最低 1）。以前は表の行数で割っていたので、Arc の行が増えただけで
 * ARC_RPC_URL 未設定でも Base の予算が 60 秒 → 40 秒に減った。skip される行に予算を配らない。
 */
export function perChainBudgetMs(budgetMs: number, chains: readonly EvmIndexChain[] = EVM_INDEX_CHAINS): number {
  const indexable = chains.filter(isEvmChainIndexable).length;
  return Math.max(20_000, Math.floor(budgetMs / Math.max(1, indexable)));
}

export function isEvmChainIndexable(chain: EvmIndexChain): boolean {
  // Base は既定 RPC がある。それ以外は env が要る（未設定は skipped として開示）。
  return chain.chainId === 8453 || Boolean(process.env[chain.rpcEnv]?.trim());
}

export async function indexEvmChain(
  chain: EvmIndexChain,
  options: {
    budgetMs?: number;
    classifier?: WashClassifier;
    now?: () => number;
    /** Test seam: chain client（getBlockNumber / getBlock / getLogs）。 */
    client?: ReturnType<typeof getLogScanClient>;
    /** Test seam: getLogsChunked の差し替え。 */
    getLogs?: typeof getLogsChunked;
  } = {},
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

  const client = options.client ?? (chain.makeClient ? chain.makeClient() : getLogScanClient(chain.chainId));
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
    const getLogs = options.getLogs ?? getLogsChunked;
    const logs = await getLogs(
      client,
      { address: chain.usdc, event: TRANSFER_EVENT, args: { to: slice }, fromBlock, toBlock } as never,
      undefined,
      undefined,
      { deadlineMs: Math.max(5_000, budgetMs - (now() - startedAt)) },
    );
    // TIP-20（Tempo）: transferWithMemo は Transfer と TransferWithMemo の両方を出す（2026-09-17 実測）。
    // 同じ tx の 2 つのログは purchase_id（chain:tx）で 1 行に畳まれる。memo は MPP 帰属の材料。
    type Raw = { transactionHash: string; blockNumber: bigint; args: { from: Address; to: Address; value?: bigint; amount?: bigint; memo?: string } };
    const memoLogs = chain.memoTransfers
      ? ((await getLogs(
          client,
          { address: chain.usdc, event: TRANSFER_WITH_MEMO_EVENT, args: { to: slice }, fromBlock, toBlock } as never,
          undefined,
          undefined,
          { deadlineMs: Math.max(5_000, budgetMs - (now() - startedAt)) },
        )) as unknown as Raw[])
      : [];
    const memoByTx = new Map<string, string>();
    for (const m of memoLogs) if (typeof m.args.memo === "string") memoByTx.set(m.transactionHash.toLowerCase(), m.args.memo);
    summary.logs += logs.length + memoLogs.length;
    const seenTx = new Set<string>();
    const merged: { transactionHash: string; blockNumber: bigint; args: { from: Address; to: Address; value: bigint } }[] = [];
    for (const l of [...(logs as unknown as Raw[]), ...memoLogs]) {
      const key = l.transactionHash.toLowerCase();
      if (seenTx.has(key)) continue;
      seenTx.add(key);
      merged.push({ transactionHash: l.transactionHash, blockNumber: l.blockNumber, args: { from: l.args.from, to: l.args.to, value: l.args.value ?? l.args.amount ?? 0n } });
    }
    const sorted = merged.sort((a, b) =>
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
      const memo = memoByTx.get(log.transactionHash.toLowerCase()) ?? null;
      pending.push(
        buildRow(
          {
            chain: chain.caip2,
            txHash: log.transactionHash,
            asset: chain.usdc,
            amount,
            payer,
            payee,
            blockTime,
            source: "chain_index",
            raw: {
              blockNumber: String(log.blockNumber),
              blockTimeSource: "interpolated",
              // MPP の帰属 memo（keccak256("mpp")[0..3] + 0x01）を持つ転送は MPP 由来と記録する。
              // 素の Transfer は unmatched のまま（Resource への帰属は payTo × amount の規則だけ）。
              ...(memo !== null ? { memo, mppAttributed: isMppAttributionMemo(memo) } : {}),
            },
          },
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
  const lag = evmIndexLag(chain, safeTip, nextCheckpoint);
  if (lag !== null) {
    // 1 日 1 回の cron で追いつけていない。partial に乗せて cron の応答に出し、ログでも鳴らす。
    summary.lagBlocks = String(lag);
    summary.partial = true;
    logServerError("settlements.index_evm.lag", new Error(`${chain.caip2} is ${lag} blocks behind the safe tip (> ${chain.blocksPerDay}/day)`));
  }
  return summary;
}

export async function indexEvm(options: { budgetMs?: number; classifier?: WashClassifier } = {}): Promise<EvmIndexSummary[]> {
  const out: EvmIndexSummary[] = [];
  const perChain = perChainBudgetMs(options.budgetMs ?? 120_000);
  for (const chain of EVM_INDEX_CHAINS) {
    try {
      out.push(await indexEvmChain(chain, { ...options, budgetMs: perChain }));
    } catch (error) {
      // 2026-09-04: 原因文字列を切らない（120 字で切って原因が読めなかった）。呼び手は
      // `skipped` が error: で始まる chain を「失敗」と数えて ok:false にする。
      out.push({ chain: chain.caip2, skipped: `error:${error instanceof Error ? error.message : String(error)}`, payees: 0, logs: 0, inserted: 0, updated: 0 });
    }
  }
  return out;
}
