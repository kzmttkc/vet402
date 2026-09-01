// ============================================================
// 経路 3（Solana）: 既知の payTo への USDC 受取を読む（§7.2 P0「Base + 1 非EVM」）。
//
// 受取先ごとに getSignaturesForAddress → getParsedTransaction で、USDC mint の
// トークン残高差分から (payer, payee, amount) を取る。RPC 実費が掛かるので
// 1 回の走査は payee 数・署名数・締切で止め、slot をチェックポイントに持つ
// （indexer_checkpoints.scope = settlements:solana:<payee>）。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { getIndexerCheckpoint, setIndexerCheckpoint } from "@/lib/db/owner-index";
import { payeeId as toPartyId } from "@/lib/ids/canonical";
import { SOLANA_MAINNET_CAIP2, SOLANA_USDC_MINT } from "@/lib/observatory/sol402-payer";
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
};

export const SOLANA_MAX_PAYEES_PER_RUN = 40;
export const SOLANA_MAX_SIGNATURES_PER_PAYEE = 25;

type TokenBalance = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } };

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

export async function indexSolana(
  options: { budgetMs?: number; classifier?: WashClassifier; now?: () => number } = {},
): Promise<SolanaIndexSummary> {
  const db = getDb();
  if (!db) throw new Error("indexSolana: DATABASE_URL is not configured");
  const summary: SolanaIndexSummary = { chain: SOLANA_MAINNET_CAIP2, payees: 0, signatures: 0, inserted: 0, updated: 0, errors: 0 };
  if (process.env.OBSERVATORY_SOLANA_INDEX_ENABLED === "false") return { ...summary, skipped: "disabled" };
  const { budgetMs = 90_000, now = Date.now } = options;
  const startedAt = now();

  const payees = rowsOf<{ pay_to: string }>(
    await db.execute(sql`
      SELECT DISTINCT pay_to FROM x402_endpoints
      WHERE network = ${SOLANA_MAINNET_CAIP2} AND pay_to IS NOT NULL AND status = 'active'
      ORDER BY pay_to LIMIT ${SOLANA_MAX_PAYEES_PER_RUN}
    `),
  ).map((r) => r.pay_to);
  summary.payees = payees.length;
  if (payees.length === 0) return { ...summary, skipped: "no_known_payees" };

  const { Connection, PublicKey } = await import("@solana/web3.js");
  const rpc = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const conn = new Connection(rpc, "confirmed");
  const classifier = options.classifier ?? (await loadWashClassifier());

  for (const payee of payees) {
    if (now() - startedAt > budgetMs) break;
    const scope = `settlements:solana:${payee}`;
    try {
      const lastSlot = (await getIndexerCheckpoint(scope)) ?? 0n;
      const sigs = await conn.getSignaturesForAddress(new PublicKey(payee), { limit: SOLANA_MAX_SIGNATURES_PER_PAYEE }, "confirmed");
      let maxSlot = lastSlot;
      for (const s of sigs) {
        if (now() - startedAt > budgetMs) break;
        if (BigInt(s.slot) <= lastSlot || s.err) continue;
        summary.signatures++;
        const tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
        if (!tx?.meta) continue;
        const moved = extractUsdcTransfer(
          (tx.meta.preTokenBalances ?? []) as TokenBalance[],
          (tx.meta.postTokenBalances ?? []) as TokenBalance[],
          payee,
          SOLANA_USDC_MINT,
        );
        if (!moved) continue;
        const blockTime = tx.blockTime ? new Date(tx.blockTime * 1000) : null;
        const resolved = await resolveEndpointForSettlement(db, {
          chain: SOLANA_MAINNET_CAIP2,
          payee,
          amount: moved.amount,
          asset: SOLANA_USDC_MINT,
          blockTime,
          resourceUrl: null,
        });
        const washFlag = await classifier.classify({
          payerId: moved.payer ? toPartyId(SOLANA_MAINNET_CAIP2, moved.payer) : null,
          payeeId: toPartyId(SOLANA_MAINNET_CAIP2, payee),
          blockTime,
        });
        const row = buildRow(
          {
            chain: SOLANA_MAINNET_CAIP2,
            txHash: s.signature,
            asset: SOLANA_USDC_MINT,
            amount: moved.amount,
            payer: moved.payer,
            payee,
            blockTime,
            source: "chain_index",
            raw: { slot: s.slot },
          },
          { attribution: resolved.attribution, washFlag, resourceId: resolved.resourceId, endpointId: resolved.endpointId },
        );
        const outcome = await upsertSettlement(row);
        if (outcome === "inserted") summary.inserted++;
        else summary.updated++;
        if (BigInt(s.slot) > maxSlot) maxSlot = BigInt(s.slot);
      }
      if (maxSlot > lastSlot) await setIndexerCheckpoint(scope, maxSlot);
    } catch {
      summary.errors++;
    }
  }
  return summary;
}
