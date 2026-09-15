// ============================================================
// 経路 3（Solana）: 既知の payTo への USDC 受取を読む（§7.2 P0「Base + 1 非EVM」）。
//
// 受取先ごとに getSignaturesForAddress → getParsedTransaction で、USDC mint の
// トークン残高差分から (payer, payee, amount) を取る。RPC 実費が掛かるので
// 1 回の走査は payee 数・署名ページ数・締切で止める。
//
// 2026-09-02 敵対的監査 C1（構造欠陥・固定 LIMIT 40／until 無し／予算切れでも前進）:
//   - 受取先は「チェックポイントが古い順（未索引を先頭）」で 40 件ずつ回す。
//     走査した受取先は署名 0 件でもチェックポイントに触れて updated_at を進めるので、
//     全受取先が数回の走査で一巡する。
//   - 署名は保存済みの最新署名を `until` に、`before` でページングして取り切る。
//     チェックポイントは slot + 最新署名（indexer_checkpoints.last_cursor）。
//     旧行（slot だけ）は until 無しで読み、slot 以下を捨てる——後方互換。
//   - 予算切れで途中終了した受取先はチェックポイントを進めない（次回、先頭で再開）。
//   - SOLANA_RPC_URL 未設定は公開 RPC へ黙って倒れず skipped を返す（fail-loud）。
//   - RPC/DB の失敗は数えるだけでなく理由をログに出す。
//
// 2026-09-15: 署名は受取人の**本体ではなく USDC 受取口座（ATA）**に問い合わせる。x402 の SVM exact
//   決済（TransferChecked）が口座一覧に載せるのは ATA だけで、本体は載らない（公開 RPC で実測:
//   本体の署名一覧に取引 0/3・ATA には 3/3、palmyr.ai の受取人1件の直近30日は本体 3 件／ATA 155 件）。
//   ATA の履歴は旧 scope（本体のカーソル）を引き継がず、新しい scope で最初から読む。
// ============================================================
import { sql } from "drizzle-orm";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@/lib/observatory/spl-token-lite";
import { getDb } from "@/lib/db/client";
import { getIndexerCheckpointWithCursor, setIndexerCheckpoint } from "@/lib/db/owner-index";
import { isMissingSchemaError } from "@/lib/db/pg-errors";
import { DISCOVERY_PAYEE_FRESH_DAYS } from "./discovery-payees";
import { payeeId as toPartyId } from "@/lib/ids/canonical";
import { SOLANA_MAINNET_CAIP2, SOLANA_USDC_MINT } from "@/lib/observatory/sol402-payer";
import { logServerError } from "@/lib/util/log";
import { resolveEndpointForSettlement } from "./ingest-payments";
import { loadWashClassifier, type WashClassifier } from "./context";
import { buildRow, rowsOf, upsertSettlement } from "./upsert";

export type SolanaIndexSummary = {
  chain: string;
  skipped?: string;
  payees: number;
  signatures: number;
  inserted: number;
  updated: number;
  errors: number;
  /** 締切で途中終了した（少なくとも 1 受取先のチェックポイントを進めていない）。 */
  budgetExhausted: boolean;
};

export const SOLANA_MAX_PAYEES_PER_RUN = 40;
export const SOLANA_MAX_SIGNATURES_PER_PAYEE = 25; // 1 ページの署名数
/** 1 受取先・1 走査で読むページ数の上限（25 × 40 = 1,000 署名）。超えた分は古い履歴として捨て、ログに出す。 */
export const SOLANA_MAX_PAGES_PER_PAYEE = 40;

type TokenBalance = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } };

export type SolanaSignatureInfo = { signature: string; slot: number; err: unknown | null };

/** @solana/web3.js Connection のうち索引が使う 2 メソッド。テストでは偽物を注入する。 */
export type SolanaRpc = {
  getSignaturesForAddress(
    address: string,
    opts: { limit: number; before?: string; until?: string },
  ): Promise<SolanaSignatureInfo[]>;
  getParsedTransaction(signature: string): Promise<{
    blockTime?: number | null;
    meta: { preTokenBalances?: readonly TokenBalance[] | null; postTokenBalances?: readonly TokenBalance[] | null } | null;
  } | null>;
};

export type SolanaCheckpoint = { lastSlot: bigint; lastSignature: string | null };

export type SolanaPayeeRow = { payTo: string; checkpointUpdatedAt: Date | null };

export type SolanaIndexDeps = {
  /** 受取人ごとに getSignaturesForAddress を掛ける口座。本番は USDC の ATA。導けなければ null。 */
  signatureAddressFor: (payee: string) => string | null;
  rpc: SolanaRpc;
  listPayees(): Promise<SolanaPayeeRow[]>;
  getCheckpoint(scope: string): Promise<SolanaCheckpoint | null>;
  setCheckpoint(scope: string, cp: SolanaCheckpoint): Promise<void>;
  persist(input: {
    signature: string;
    slot: number;
    payee: string;
    amount: string;
    payer: string | null;
    blockTime: Date | null;
  }): Promise<"inserted" | "updated">;
};

/** 残高差分から USDC の受取（payee owner）と支払元を取る。純関数。 */
export function extractUsdcTransfer(
  pre: readonly TokenBalance[],
  post: readonly TokenBalance[],
  payeeOwner: string,
  mint: string,
): { amount: string; payer: string | null } | null {
  const byIndex = (arr: readonly TokenBalance[]) => new Map(arr.filter((b) => b.mint === mint).map((b) => [b.accountIndex, b]));
  const preMap = byIndex(pre);
  const postMap = byIndex(post);
  let received = 0n;
  let payer: string | null = null;
  for (const [idx, p] of postMap) {
    const before = BigInt(preMap.get(idx)?.uiTokenAmount.amount ?? "0");
    const after = BigInt(p.uiTokenAmount.amount);
    const delta = after - before;
    if (delta > 0n && p.owner === payeeOwner) received += delta;
    if (delta < 0n && p.owner && p.owner !== payeeOwner) payer = p.owner;
  }
  if (received <= 0n) return null;
  return { amount: received.toString(), payer };
}

/** 未索引（チェックポイント無し）を先頭に、次にチェックポイントが古い順。同時刻は pay_to 順。純関数。 */
export function selectPayeesForRun(rows: readonly SolanaPayeeRow[], max = SOLANA_MAX_PAYEES_PER_RUN): string[] {
  return [...rows]
    .sort((a, b) => {
      const ta = a.checkpointUpdatedAt?.getTime() ?? -Infinity;
      const tb = b.checkpointUpdatedAt?.getTime() ?? -Infinity;
      if (ta !== tb) return ta < tb ? -1 : 1;
      return a.payTo < b.payTo ? -1 : a.payTo > b.payTo ? 1 : 0;
    })
    .slice(0, max)
    .map((r) => r.payTo);
}

/** 旧 scope: 受取人本体の署名一覧のカーソル（2026-09-15 まで）。ATA の履歴には流用しない。 */
export const SOLANA_LEGACY_OWNER_SCOPE_PREFIX = "settlements:solana:";
/** 現 scope: 受取人の USDC ATA の署名一覧のカーソル。 */
export const SOLANA_CHECKPOINT_SCOPE_PREFIX = "settlements:solana-usdc-ata:";
const scopeOf = (payee: string) => `${SOLANA_CHECKPOINT_SCOPE_PREFIX}${payee}`;

/** 受取人の USDC ATA（PDA の受取人も許す）。base58 の公開鍵でなければ null。純関数。 */
export function solanaUsdcTokenAccount(owner: string): string | null {
  try {
    return getAssociatedTokenAddressSync(new PublicKey(SOLANA_USDC_MINT), new PublicKey(owner), true).toBase58();
  } catch {
    return null;
  }
}

export async function runSolanaIndex(
  deps: SolanaIndexDeps,
  options: { budgetMs?: number; now?: () => number } = {},
): Promise<SolanaIndexSummary> {
  const summary: SolanaIndexSummary = {
    chain: SOLANA_MAINNET_CAIP2,
    payees: 0,
    signatures: 0,
    inserted: 0,
    updated: 0,
    errors: 0,
    budgetExhausted: false,
  };
  const { budgetMs = 90_000, now = Date.now } = options;
  const startedAt = now();
  const overBudget = () => now() - startedAt > budgetMs;

  const payees = selectPayeesForRun(await deps.listPayees());
  summary.payees = payees.length;
  if (payees.length === 0) return { ...summary, skipped: "no_known_payees" };

  for (const payee of payees) {
    if (overBudget()) {
      summary.budgetExhausted = true;
      break;
    }
    const scope = scopeOf(payee);
    try {
      const address = deps.signatureAddressFor(payee);
      if (!address) {
        // 導けない受取人は数えて後ろへ回す（先頭に居座って毎回の枠を食わない）
        summary.errors++;
        logServerError("settlements.index-solana.no_token_account", new Error(`payee ${payee}: cannot derive USDC token account`));
        await deps.setCheckpoint(scope, { lastSlot: 0n, lastSignature: null });
        continue;
      }
      const cp = (await deps.getCheckpoint(scope)) ?? { lastSlot: 0n, lastSignature: null };

      // 1) 署名を新しい順に集める。until = 保存済み署名（無ければ slot で止める）。
      const collected: SolanaSignatureInfo[] = [];
      let before: string | undefined;
      let pages = 0;
      let complete = false;
      let cut = false;
      while (pages < SOLANA_MAX_PAGES_PER_PAYEE) {
        if (overBudget()) {
          cut = true;
          break;
        }
        const page = await deps.rpc.getSignaturesForAddress(address, {
          limit: SOLANA_MAX_SIGNATURES_PER_PAYEE,
          before,
          until: cp.lastSignature ?? undefined,
        });
        pages++;
        let reachedOld = false;
        for (const s of page) {
          if (BigInt(s.slot) <= cp.lastSlot) {
            reachedOld = true;
            break;
          }
          collected.push(s);
        }
        if (reachedOld || page.length < SOLANA_MAX_SIGNATURES_PER_PAYEE) {
          complete = true;
          break;
        }
        before = page[page.length - 1].signature;
      }
      if (cut) {
        summary.budgetExhausted = true;
        break;
      }
      if (!complete) {
        logServerError(
          "settlements.index-solana.page_cap",
          new Error(`payee ${payee}: more than ${SOLANA_MAX_PAGES_PER_PAYEE * SOLANA_MAX_SIGNATURES_PER_PAYEE} new signatures; older history skipped`),
        );
      }

      // 2) 古い順に処理する。途中で締切なら何も進めない（upsert は冪等なので再実行で揃う）。
      let maxSlot = cp.lastSlot;
      for (let i = collected.length - 1; i >= 0; i--) {
        if (overBudget()) {
          cut = true;
          break;
        }
        const s = collected[i];
        if (BigInt(s.slot) > maxSlot) maxSlot = BigInt(s.slot);
        if (s.err) continue;
        summary.signatures++;
        const tx = await deps.rpc.getParsedTransaction(s.signature);
        if (!tx?.meta) continue;
        const moved = extractUsdcTransfer(tx.meta.preTokenBalances ?? [], tx.meta.postTokenBalances ?? [], payee, SOLANA_USDC_MINT);
        if (!moved) continue;
        const blockTime = tx.blockTime ? new Date(tx.blockTime * 1000) : null;
        const outcome = await deps.persist({ signature: s.signature, slot: s.slot, payee, amount: moved.amount, payer: moved.payer, blockTime });
        if (outcome === "inserted") summary.inserted++;
        else summary.updated++;
      }
      if (cut) {
        summary.budgetExhausted = true;
        break;
      }

      // 3) 完走した受取先だけ前進。署名 0 件でも触れて updated_at を進める（飢餓防止）。
      await deps.setCheckpoint(scope, {
        lastSlot: maxSlot,
        lastSignature: collected[0]?.signature ?? cp.lastSignature,
      });
    } catch (error) {
      summary.errors++;
      logServerError(`settlements.index-solana payee=${payee}`, error);
    }
  }
  return summary;
}

/**
 * 索引の受取人 = カタログの全 accept の Solana 受取人（先頭だけでなく）∪ カタログ外の discovery（14 日以内）。
 * x402_discovery_payees が未作成（DDL 前のデプロイ）ならカタログだけで返す。
 */
export async function listSolanaPayees(db: NonNullable<ReturnType<typeof getDb>>): Promise<SolanaPayeeRow[]> {
  // 受取人 = カタログの全 accept の Solana 受取人（先頭だけでなく）∪ カタログ外の discovery（14 日以内）。
  const toRows = (raw: unknown) =>
    rowsOf<{ pay_to: string; updated_at: string | Date | null }>(raw).map((r) => ({
      payTo: r.pay_to,
      checkpointUpdatedAt: r.updated_at ? new Date(r.updated_at) : null,
    }));
  const catalogPayees = sql`
    SELECT DISTINCT a->>'payTo' AS pay_to
    FROM x402_endpoints e
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(e.raw_accepts) = 'array' THEN e.raw_accepts ELSE '[]'::jsonb END
    ) a
    WHERE e.status = 'active'
      AND (a->>'network' = ${SOLANA_MAINNET_CAIP2} OR lower(a->>'network') IN ('solana', 'solana-mainnet'))
      AND a->>'payTo' IS NOT NULL AND a->>'payTo' !~ '^0x'
    UNION
    SELECT pay_to FROM x402_endpoints
    WHERE network = ${SOLANA_MAINNET_CAIP2} AND pay_to IS NOT NULL AND status = 'active'`;
  try {
    return toRows(
      await db.execute(sql`
        WITH p AS (
          ${catalogPayees}
          UNION
          SELECT pay_to FROM x402_discovery_payees
          WHERE chain = ${SOLANA_MAINNET_CAIP2}
            AND last_seen_at > now() - make_interval(days => ${DISCOVERY_PAYEE_FRESH_DAYS})
        )
        SELECT p.pay_to, c.updated_at
        FROM p
        LEFT JOIN indexer_checkpoints c ON c.scope = ${SOLANA_CHECKPOINT_SCOPE_PREFIX} || p.pay_to
      `),
    );
  } catch (error) {
    if (!isMissingSchemaError(error)) throw error;
    // x402_discovery_payees が未作成（DDL 前のデプロイ）: カタログだけで続ける
    return toRows(
      await db.execute(sql`
        WITH p AS (${catalogPayees})
        SELECT p.pay_to, c.updated_at
        FROM p
        LEFT JOIN indexer_checkpoints c ON c.scope = ${SOLANA_CHECKPOINT_SCOPE_PREFIX} || p.pay_to
      `),
    );
  }
}

/** 本番配線: DB と @solana/web3.js を runSolanaIndex へ差し込む。 */
export async function indexSolana(
  options: { budgetMs?: number; classifier?: WashClassifier; now?: () => number } = {},
): Promise<SolanaIndexSummary> {
  const base: SolanaIndexSummary = {
    chain: SOLANA_MAINNET_CAIP2,
    payees: 0,
    signatures: 0,
    inserted: 0,
    updated: 0,
    errors: 0,
    budgetExhausted: false,
  };
  if (process.env.OBSERVATORY_SOLANA_INDEX_ENABLED === "false") return { ...base, skipped: "disabled" };
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!rpcUrl) return { ...base, skipped: "solana_rpc_unset" };
  const db = getDb();
  if (!db) throw new Error("indexSolana: DATABASE_URL is not configured");

  const { Connection, PublicKey } = await import("@solana/web3.js");
  const conn = new Connection(rpcUrl, "confirmed");
  const classifier = options.classifier ?? (await loadWashClassifier());

  const deps: SolanaIndexDeps = {
    signatureAddressFor: solanaUsdcTokenAccount,
    rpc: {
      getSignaturesForAddress: (address, opts) => conn.getSignaturesForAddress(new PublicKey(address), opts, "confirmed"),
      getParsedTransaction: (signature) =>
        conn.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }) as ReturnType<
          SolanaRpc["getParsedTransaction"]
        >,
    },
    async listPayees() {
      return listSolanaPayees(db);
    },
    async getCheckpoint(scope) {
      const row = await getIndexerCheckpointWithCursor(scope);
      return row ? { lastSlot: row.lastBlock, lastSignature: row.lastCursor } : null;
    },
    async setCheckpoint(scope, cp) {
      await setIndexerCheckpoint(scope, cp.lastSlot, undefined, cp.lastSignature);
    },
    async persist(input) {
      const resolved = await resolveEndpointForSettlement(db, {
        chain: SOLANA_MAINNET_CAIP2,
        payee: input.payee,
        amount: input.amount,
        asset: SOLANA_USDC_MINT,
        blockTime: input.blockTime,
        resourceUrl: null,
      });
      const washFlag = await classifier.classify({
        payerId: input.payer ? toPartyId(SOLANA_MAINNET_CAIP2, input.payer) : null,
        payeeId: toPartyId(SOLANA_MAINNET_CAIP2, input.payee),
        blockTime: input.blockTime,
      });
      const row = buildRow(
        {
          chain: SOLANA_MAINNET_CAIP2,
          txHash: input.signature,
          asset: SOLANA_USDC_MINT,
          amount: input.amount,
          payer: input.payer,
          payee: input.payee,
          blockTime: input.blockTime,
          source: "chain_index",
          raw: { slot: input.slot },
        },
        { attribution: resolved.attribution, washFlag, resourceId: resolved.resourceId, endpointId: resolved.endpointId },
      );
      return upsertSettlement(row);
    },
  };
  return runSolanaIndex(deps, options);
}
