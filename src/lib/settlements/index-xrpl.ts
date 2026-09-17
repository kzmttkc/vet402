// ============================================================
// 経路 3（XRPL）: 既知の payTo への RLUSD 受取を読む（2026-09-17）。
//
// 受取先ごとに `account_tx`（forward・ledger_index_min = チェックポイント + 1）でページを取り、
// validated な Payment / tesSUCCESS / Destination = 受取先 / delivered_amount が RLUSD の行だけを
// 決済として貯める。**XRP 建ての受取は記録しない**——settlements.amount は 1 チェーン 1 目盛り
// （USD 6 桁）でロールアップに合計され、drops を混ぜると XRPL の合計が壊れる（v1 の割り切り）。
//
// x402 の印: SourceTag が 804681468（xrpl:0 の x402 決済に実測で付いていた）か InvoiceID がある
// 行を x402 由来とみなす。印の無い受取（ダスト・手動送金）は unmatched。
//
// 走査の上限: 受取先 20 件・1 受取先 10 ページ（× 200 tx）・締切。締切で途中終了した受取先は
// チェックポイントを進めない（次回、同じ ledger から再開。upsert は冪等）。
// XRPL_RPC_URL 未設定は skipped（公開 RPC へ黙って倒れない）。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { getIndexerCheckpoint, setIndexerCheckpoint } from "@/lib/db/owner-index";
import { payeeId as toPartyId } from "@/lib/ids/canonical";
import { RLUSD_CURRENCY_HEX, RLUSD_ISSUER, XRPL_MAINNET_CAIP2, createXrplJsonRpc, isRlusdAsset, rlusdToUnitsFloor } from "@/lib/observatory/xrpl402-payer";
import { rippleTimeToDate } from "@/lib/observatory/settlement-verify-xrpl";
import { logServerError } from "@/lib/util/log";
import { resolveEndpointForSettlement } from "./ingest-payments";
import { selectPayeesForRun } from "./index-solana";
import { loadWashClassifier, type WashClassifier } from "./context";
import { buildRow, rowsOf, upsertSettlement } from "./upsert";
import type { Attribution } from "./types";

export type XrplIndexSummary = {
  chain: string;
  skipped?: string;
  payees: number;
  transactions: number;
  inserted: number;
  updated: number;
  errors: number;
  budgetExhausted: boolean;
};

export const XRPL_MAX_PAYEES_PER_RUN = 20;
export const XRPL_PAGE_LIMIT = 200;
export const XRPL_MAX_PAGES_PER_PAYEE = 10;
/** xrpl:0 の x402 決済に付く SourceTag（2026-09-17 実測・rMnHeut… への RLUSD Payment）。 */
export const XRPL_X402_SOURCE_TAG = 804681468;
export const XRPL_CHECKPOINT_SCOPE_PREFIX = "settlements:xrpl:";
const scopeOf = (payee: string) => `${XRPL_CHECKPOINT_SCOPE_PREFIX}${payee}`;

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec | null => (typeof v === "object" && v !== null ? (v as Rec) : null);

/** account_tx の 1 要素（API v1: tx / v2: tx_json）。 */
export type XrplAccountTxEntry = { tx?: Rec; tx_json?: Rec; meta?: Rec | string; validated?: boolean; ledger_index?: number; close_time_iso?: string; hash?: string };

export type XrplIndexRpc = {
  accountTx(
    account: string,
    opts: { ledgerIndexMin: number; limit: number; marker?: unknown },
  ): Promise<{ transactions: XrplAccountTxEntry[]; marker?: unknown }>;
};

export type XrplCheckpoint = { lastLedger: bigint };
export type XrplPayeeRow = { payTo: string; checkpointUpdatedAt: Date | null };

export type XrplDelivery = {
  hash: string;
  ledgerIndex: number;
  payer: string;
  payee: string;
  /** RLUSD を 6 桁 units に切り捨てた 10 進整数文字列。 */
  amountUnits: string;
  blockTime: Date | null;
  sourceTag: number | null;
  invoiceId: string | null;
};

export type XrplIndexDeps = {
  rpc: XrplIndexRpc;
  listPayees(): Promise<XrplPayeeRow[]>;
  getCheckpoint(scope: string): Promise<XrplCheckpoint | null>;
  setCheckpoint(scope: string, cp: XrplCheckpoint): Promise<void>;
  persist(delivery: XrplDelivery): Promise<"inserted" | "updated">;
};

/** x402 由来の印（SourceTag = 804681468 か InvoiceID あり）。純関数。 */
export function isX402Marked(d: { sourceTag: number | null; invoiceId: string | null }): boolean {
  return d.sourceTag === XRPL_X402_SOURCE_TAG || (typeof d.invoiceId === "string" && d.invoiceId.length > 0);
}

/**
 * account_tx の 1 要素から「payee に届いた RLUSD」を取る。純関数。
 * validated でない・Payment でない・失敗・宛先違い・RLUSD 以外は null。
 */
export function extractRlusdDelivery(entry: XrplAccountTxEntry, payee: string): XrplDelivery | null {
  if (entry.validated !== true) return null;
  const tx = asRec(entry.tx_json) ?? asRec(entry.tx);
  const meta = asRec(entry.meta);
  if (!tx || !meta) return null;
  if (tx.TransactionType !== "Payment") return null;
  if (meta.TransactionResult !== "tesSUCCESS") return null;
  if (tx.Destination !== payee) return null;
  if (typeof tx.Account !== "string") return null;
  const delivered = asRec(meta.delivered_amount ?? meta.DeliveredAmount);
  if (!delivered) return null; // XRP（drops の文字列）は v1 では記録しない
  if (typeof delivered.currency !== "string" || !isRlusdAsset(delivered.currency) || delivered.issuer !== RLUSD_ISSUER) return null;
  const units = typeof delivered.value === "string" ? rlusdToUnitsFloor(delivered.value) : null;
  if (units === null || units <= 0n) return null;
  const hash = typeof entry.hash === "string" ? entry.hash : typeof tx.hash === "string" ? tx.hash : null;
  if (!hash) return null;
  const ledgerIndex = typeof entry.ledger_index === "number" ? entry.ledger_index : typeof tx.ledger_index === "number" ? tx.ledger_index : null;
  if (ledgerIndex === null) return null;
  const blockTime =
    typeof entry.close_time_iso === "string" ? new Date(entry.close_time_iso) : rippleTimeToDate(tx.date);
  return {
    hash: hash.toUpperCase(),
    ledgerIndex,
    payer: tx.Account,
    payee,
    amountUnits: units.toString(),
    blockTime,
    sourceTag: typeof tx.SourceTag === "number" ? tx.SourceTag : null,
    invoiceId: typeof tx.InvoiceID === "string" && tx.InvoiceID.length > 0 ? tx.InvoiceID : null,
  };
}

/** 印のある受取は x402 由来（受取先が 1 つのカタログ endpoint に落ちなくても probable）、印が無ければ unmatched。 */
export function xrplAttribution(marked: boolean, resolved: Attribution): Attribution {
  if (!marked) return "unmatched";
  return resolved === "unmatched" ? "probable" : resolved;
}

export async function runXrplIndex(
  deps: XrplIndexDeps,
  options: { budgetMs?: number; now?: () => number } = {},
): Promise<XrplIndexSummary> {
  const summary: XrplIndexSummary = { chain: XRPL_MAINNET_CAIP2, payees: 0, transactions: 0, inserted: 0, updated: 0, errors: 0, budgetExhausted: false };
  const { budgetMs = 20_000, now = Date.now } = options;
  const startedAt = now();
  const overBudget = () => now() - startedAt > budgetMs;

  const payees = selectPayeesForRun(await deps.listPayees(), XRPL_MAX_PAYEES_PER_RUN);
  summary.payees = payees.length;
  if (payees.length === 0) return { ...summary, skipped: "no_known_payees" };

  for (const payee of payees) {
    if (overBudget()) {
      summary.budgetExhausted = true;
      break;
    }
    const scope = scopeOf(payee);
    try {
      const cp = (await deps.getCheckpoint(scope)) ?? { lastLedger: 0n };
      let maxLedger = cp.lastLedger;
      let marker: unknown = undefined;
      let pages = 0;
      let cut = false;
      let complete = false;
      while (pages < XRPL_MAX_PAGES_PER_PAYEE) {
        if (overBudget()) {
          cut = true;
          break;
        }
        const page = await deps.rpc.accountTx(payee, { ledgerIndexMin: Number(cp.lastLedger) + 1, limit: XRPL_PAGE_LIMIT, marker });
        pages++;
        for (const entry of page.transactions) {
          if (overBudget()) {
            cut = true;
            break;
          }
          const ledgerIndex = typeof entry.ledger_index === "number" ? entry.ledger_index : (asRec(entry.tx_json) ?? asRec(entry.tx))?.ledger_index;
          if (typeof ledgerIndex === "number" && BigInt(ledgerIndex) > maxLedger) maxLedger = BigInt(ledgerIndex);
          summary.transactions++;
          const delivery = extractRlusdDelivery(entry, payee);
          if (!delivery) continue;
          const outcome = await deps.persist(delivery);
          if (outcome === "inserted") summary.inserted++;
          else summary.updated++;
        }
        if (cut) break;
        if (page.marker === undefined || page.marker === null) {
          complete = true;
          break;
        }
        marker = page.marker;
      }
      if (cut) {
        summary.budgetExhausted = true;
        break;
      }
      if (!complete) {
        logServerError("settlements.index-xrpl.page_cap", new Error(`payee ${payee}: more than ${XRPL_MAX_PAGES_PER_PAYEE * XRPL_PAGE_LIMIT} transactions in one run; the rest continues next run`));
      }
      // 完走した受取先だけ前進。取引 0 件でも触れて updated_at を進める（飢餓防止）。
      await deps.setCheckpoint(scope, { lastLedger: maxLedger });
    } catch (error) {
      summary.errors++;
      logServerError(`settlements.index-xrpl payee=${payee}`, error);
    }
  }
  return summary;
}

/** 索引の受取先 = カタログの全 accept の XRPL 受取先（r アドレス）∪ 先頭 accept の pay_to。 */
export async function listXrplPayees(db: NonNullable<ReturnType<typeof getDb>>): Promise<XrplPayeeRow[]> {
  return rowsOf<{ pay_to: string; updated_at: string | Date | null }>(
    await db.execute(sql`
      WITH p AS (
        SELECT DISTINCT a->>'payTo' AS pay_to
        FROM x402_endpoints e
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(e.raw_accepts) = 'array' THEN e.raw_accepts ELSE '[]'::jsonb END
        ) a
        WHERE e.status = 'active'
          AND (a->>'network' = ${XRPL_MAINNET_CAIP2} OR lower(a->>'network') IN ('xrpl', 'xrpl:mainnet'))
          AND a->>'payTo' ~ '^r[1-9A-HJ-NP-Za-km-z]{24,34}$'
        UNION
        SELECT pay_to FROM x402_endpoints
        WHERE network = ${XRPL_MAINNET_CAIP2} AND status = 'active' AND pay_to ~ '^r[1-9A-HJ-NP-Za-km-z]{24,34}$'
      )
      SELECT p.pay_to, c.updated_at
      FROM p
      LEFT JOIN indexer_checkpoints c ON c.scope = ${XRPL_CHECKPOINT_SCOPE_PREFIX} || p.pay_to
    `),
  ).map((r) => ({ payTo: r.pay_to, checkpointUpdatedAt: r.updated_at ? new Date(r.updated_at) : null }));
}

/** 本番配線: DB と JSON-RPC を runXrplIndex へ差し込む。 */
export async function indexXrpl(
  options: { budgetMs?: number; classifier?: WashClassifier; now?: () => number } = {},
): Promise<XrplIndexSummary> {
  const base: XrplIndexSummary = { chain: XRPL_MAINNET_CAIP2, payees: 0, transactions: 0, inserted: 0, updated: 0, errors: 0, budgetExhausted: false };
  if (process.env.OBSERVATORY_XRPL_INDEX_ENABLED === "false") return { ...base, skipped: "disabled" };
  const rpcUrl = process.env.XRPL_RPC_URL?.trim();
  if (!rpcUrl) return { ...base, skipped: "xrpl_rpc_unset" };
  const db = getDb();
  if (!db) throw new Error("indexXrpl: DATABASE_URL is not configured");
  const rpc = createXrplJsonRpc({ url: rpcUrl, timeoutMs: 15_000 });
  const classifier = options.classifier ?? (await loadWashClassifier());

  const deps: XrplIndexDeps = {
    rpc: {
      async accountTx(account, opts) {
        const r = await rpc("account_tx", {
          account,
          ledger_index_min: opts.ledgerIndexMin,
          ledger_index_max: -1,
          forward: true,
          limit: opts.limit,
          ...(opts.marker !== undefined ? { marker: opts.marker } : {}),
        });
        return { transactions: Array.isArray(r.transactions) ? (r.transactions as XrplAccountTxEntry[]) : [], marker: r.marker };
      },
    },
    async listPayees() {
      return listXrplPayees(db);
    },
    async getCheckpoint(scope) {
      const last = await getIndexerCheckpoint(scope);
      return last === null ? null : { lastLedger: last };
    },
    async setCheckpoint(scope, cp) {
      await setIndexerCheckpoint(scope, cp.lastLedger);
    },
    async persist(d) {
      const resolved = await resolveEndpointForSettlement(db, {
        chain: XRPL_MAINNET_CAIP2,
        payee: d.payee,
        amount: d.amountUnits,
        asset: RLUSD_CURRENCY_HEX,
        blockTime: d.blockTime,
        resourceUrl: null,
      });
      const marked = isX402Marked(d);
      const washFlag = await classifier.classify({
        payerId: toPartyId(XRPL_MAINNET_CAIP2, d.payer),
        payeeId: toPartyId(XRPL_MAINNET_CAIP2, d.payee),
        blockTime: d.blockTime,
      });
      const row = buildRow(
        {
          chain: XRPL_MAINNET_CAIP2,
          txHash: d.hash,
          asset: RLUSD_CURRENCY_HEX,
          amount: d.amountUnits,
          payer: d.payer,
          payee: d.payee,
          blockTime: d.blockTime,
          source: "chain_index",
          raw: { ledgerIndex: d.ledgerIndex, sourceTag: d.sourceTag, invoiceId: d.invoiceId, x402Marked: marked },
        },
        { attribution: xrplAttribution(marked, resolved.attribution), washFlag, resourceId: resolved.resourceId, endpointId: resolved.endpointId },
      );
      return upsertSettlement(row);
    },
  };
  return runXrplIndex(deps, options);
}
