// ============================================================
// 遅れて決済された L1 購入の回収（2026-09-04 監査 P2）。
//
// 何が食い違っていたか: 署名した EIP-3009 は validBefore まで**生きた金**なので、
// 売り手が我々の有料リトライに応えなかった（`settle_failed`・tx_hash 無し）あとでも、
// 窓の内側ならいつでも決済できる。台帳には「払っていない」と書いてあるのに
// チェーンには我々のホットウォレット発の Transfer が残る——公開している成立率と
// オンチェーンの支出が食い違い、しかも tx_hash が無いので誰も突合できない。
//
// 材料は既に手元にある。決済索引（settlements）は「既知の payTo への USDC
// Transfer」をチェーンから読んで貯めている。そこから
//   我々の payer 発 / その endpoint の payTo 宛 / 期待額ちょうど /
//   試行時刻の窓の内側 / まだどの購入にも使われていない tx
// を拾って、tx_hash の無い settle_failed 行へ結びつける。
//
// **settled とは名乗らせない。** 結びつけた行は `settle_claimed`（主張はあるが
// 未照合）へ戻し、settlement-verifier がフル照合する——EIP-3009 nonce の束縛
// （auth_nonce と AuthorizationUsed）まで含めて。金額と宛先が合う tx を見つけた
// ことは「その tx がこの購入のもの」の証明にならないので、ここで結論は出さない。
//
// 実装メモ: `settled_late` という独立 status を作らなかったのは、status の語彙が
// src/lib/decision/seller-facts.ts と src/lib/observatory/decisions.ts に写って
// いるため（このブランチではその 2 つを触らない約束になっている）。
// settle_claimed へ戻す形は、公開面の語彙を増やさずに**より強い**保証を与える
// ——遅延決済も新規購入とまったく同じ関門を通る。
//
// 2026-09-19: 対象は settle_failed だけではない。署名したのに決済を名指せていない行は 3 種類ある
// （LATE_RECOVERABLE_STATUSES）。`delivered_no_receipt`（200 で品は来たがレシート無し）と
// `settle_claimed_unverifiable`（売り手の主張した識別子が形式不正）も署名は同じく生きていて、
// チェーンに決済が残っても tx_hash が無い（または読めない）ので突合できなかった。照合条件は
// status によらず同じ。settle_claimed_unverifiable の tx_hash（売り手の原文）は索引の tx に置き換え、
// 原文は raw_response_meta.lateSettlement.replacedTxHash に残す（raw_settlement にも元から残っている）。
//
// XRPL（同日）: 署名済み blob の hash が tx の hash そのもので、l1-runner が auth_nonce に残している。
// 索引の tx_hash と直接比べられるので、XRPL の行は **hash の一致も要求する**。払い元・宛先・額・窓だけ
// だと、同じ売り手への同額の支払いが 30 分の窓に 2 件あるとき先に試行した行へ貼ってしまい、照合器が
// それを nonce_not_used で否定する——我々の貼り間違いが売り手の settle_claim_refuted になる。
// auth_nonce の無い XRPL の行は貼らない（何に署名したか分からない行に、額と宛先だけで tx を結びつけない）。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { logAndSwallow } from "@/lib/util/log";
import { recordCorrection } from "@/lib/observatory/corrections";
import { XRPL_MAINNET_CAIP2 } from "@/lib/observatory/chains";

/**
 * 試行時刻からどれだけ後までを「この購入の決済」と見るか。
 *
 * 認可の有効期間の上限は 120 秒（x402-payer.MAX_AUTHORIZATION_WINDOW_SECONDS）
 * なので、それを過ぎた authorization は**チェーンが受け付けない**。窓を 30 分に
 * してあるのは、ブロック時刻の補間誤差（index-evm は窓の両端を実測して間を
 * 2 秒/ブロックで補間する）と、旧い 600 秒窓で署名された行の取りこぼしを
 * 拾うため。窓を広げても、金額・宛先・払い元の 3 つ一致と「未使用の tx」の
 * 条件が効いているので、他人の決済を拾うことはない。
 */
export const LATE_SETTLEMENT_WINDOW_MINUTES = 30;

/** ブロック時刻が試行より少し前に見えることがある（補間誤差）。 */
export const LATE_SETTLEMENT_BACKDATE_MINUTES = 2;

/**
 * 回収の対象にする status。どれも「署名した（spent_units が立っている）のに、決済の tx を名指せていない」行。
 * settled / settle_claimed / settle_claim_refuted（決済の主張を既に持つ・否定済み）と、署名していない行
 * （request_error・budget_denied・price_mismatch …）は入れない。
 */
export const LATE_RECOVERABLE_STATUSES = ["settle_failed", "delivered_no_receipt", "settle_claimed_unverifiable"] as const;

export type LateSettlementSummary = {
  recovered: number;
  /** 結びつけた (purchase_id, tx_hash) の対。cron の応答に出る。 */
  links: { purchaseId: string; txHash: string }[];
};

export async function recoverLateSettlements(): Promise<LateSettlementSummary> {
  const db = getDb();
  if (!db) throw new Error("recoverLateSettlements: DATABASE_URL is not configured");

  // 1 文で解決する。候補の列挙と UPDATE を分けると、その間に別の行が同じ tx を
  // 取れてしまう（部分一意 index が弾いてくれるが、そこで throw させるより
  // 最初から 1 つに決める方がよい）。
  //   match  … 条件を満たす (purchase, settlement) の全対
  //   ranked … 購入ごとに 1 本、tx ごとに 1 購入だけ残す
  const raw = await db.execute(sql`
    WITH match AS (
      SELECT pu.id AS purchase_id,
             pu.status AS prior_status,
             pu.tx_hash AS prior_tx_hash,
             s.tx_hash AS tx_hash,
             s.block_time AS block_time,
             row_number() OVER (PARTITION BY pu.id ORDER BY s.block_time ASC, s.tx_hash ASC) AS rn_purchase,
             row_number() OVER (PARTITION BY lower(s.tx_hash) ORDER BY pu.attempted_at ASC, pu.id ASC) AS rn_tx
      FROM x402_l1_purchases pu
      JOIN x402_endpoints e ON e.id = pu.endpoint_id
      JOIN settlements s
        ON s.chain IS NOT DISTINCT FROM pu.network
       AND lower(s.payer) = lower(pu.payer)
       AND lower(s.payee) = lower(pu.pay_to)
       AND s.amount = pu.amount_units
       AND s.block_time >= pu.attempted_at - make_interval(mins => ${LATE_SETTLEMENT_BACKDATE_MINUTES}::int)
       AND s.block_time <= pu.attempted_at + make_interval(mins => ${LATE_SETTLEMENT_WINDOW_MINUTES}::int)
       -- XRPL: 索引の tx は我々が署名した blob そのものでなければならない（auth_nonce = 署名済み blob の hash）。
       AND (pu.network IS DISTINCT FROM ${XRPL_MAINNET_CAIP2}
            OR (pu.auth_nonce IS NOT NULL AND upper(s.tx_hash) = upper(btrim(pu.auth_nonce))))
      WHERE pu.status IN (${sql.join(LATE_RECOVERABLE_STATUSES.map((s) => sql`${s}`), sql`, `)})
        -- tx_hash を持ってよいのは settle_claimed_unverifiable だけ（売り手の形式不正な原文。索引の tx に置き換える）。
        AND (pu.tx_hash IS NULL OR pu.status = 'settle_claimed_unverifiable')
        AND pu.payer IS NOT NULL
        AND pu.pay_to IS NOT NULL
        AND pu.amount_units IS NOT NULL
        AND pu.attempted_at IS NOT NULL
        -- その tx を既に主張している購入があれば触らない（P1-1 の一意制約と同じ規律）。
        AND NOT EXISTS (
          SELECT 1 FROM x402_l1_purchases o
          WHERE o.tx_hash IS NOT NULL
            AND o.network IS NOT DISTINCT FROM pu.network
            AND lower(o.tx_hash) = lower(s.tx_hash)
        )
    ), chosen AS (
      SELECT purchase_id, prior_status, prior_tx_hash, tx_hash FROM match WHERE rn_purchase = 1 AND rn_tx = 1
    )
    UPDATE x402_l1_purchases pu
    SET status = 'settle_claimed',
        tx_hash = chosen.tx_hash,
        raw_response_meta = coalesce(pu.raw_response_meta, '{}'::jsonb) || jsonb_build_object(
          'lateSettlement', jsonb_strip_nulls(jsonb_build_object(
            'source', 'settlements_index',
            'note', 'the seller settled after we recorded ' || chosen.prior_status || '; the verifier decides whether it is ours',
            'priorStatus', chosen.prior_status,
            'replacedTxHash', chosen.prior_tx_hash,
            'linkedAt', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
          ))
        )
    FROM chosen
    WHERE pu.id = chosen.purchase_id
    RETURNING pu.id::text AS purchase_id, pu.tx_hash AS tx_hash,
              chosen.prior_status AS prior_status, chosen.prior_tx_hash AS prior_tx_hash
  `);

  const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as {
    purchase_id: string;
    tx_hash: string;
    prior_status: string;
    prior_tx_hash: string | null;
  }[];

  // §10 / §6.2: 状態が変わったら訂正ログに残す（公開面が「いつ何が変わったか」を言える）。
  for (const row of rows) {
    await recordCorrection({
      subjectType: "purchase",
      subjectId: row.purchase_id,
      level: "l1",
      before: { status: row.prior_status, txHash: row.prior_tx_hash },
      after: { status: "settle_claimed", txHash: row.tx_hash },
      // 既存の語彙を使う（新しい reason は公開 enum・docs/openapi.yaml・
      // src/app/docs/api/page.tsx へ波及し、このブランチでは触らない約束の
      // ファイルを含む）。意味も合っている——「主張された決済が後から
      // オンチェーンで確認/否定された」の入口がここ。
      reason: "settlement_backfill",
    }).catch(logAndSwallow("settlements.recover_late.record_correction"));
  }

  return {
    recovered: rows.length,
    links: rows.map((r) => ({ purchaseId: r.purchase_id, txHash: r.tx_hash })),
  };
}
