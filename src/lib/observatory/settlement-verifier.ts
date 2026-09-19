// ============================================================
// 決済主張の照合ジョブ（2026-08-23 監査 C-4 の本丸）。
//
// **`settled` を名乗らせる唯一の場所。** 購入時のランナーは `settle_claimed`
// までしか書かない。ここがチェーンを読み、確認できたものだけを `settled` に
// 昇格させ、確認できなかったものは `settle_claim_refuted` にする。
//
// なぜランナーと分けるか: 確定数を待つ必要がある。購入直後に読むと未確定の
// tx を「確認済み」と刻む事故になり、待てばバッチのデッドラインを食い潰す。
// 照合を日次 cron に置けば、実際の確定数は数千〜数万になり、確定数の要求は
// タダで買える（本番実測 2026-08-23: 約87,000）。
//
// スコア証拠（observed_purchases）を書くのもここだけ。以前はランナーが
// 購入直後に書いていたが、その時点の `settled` は売り手の自己申告だった。
// 「実購入がスコアに効く」という主張は、この照合が通って初めて成立する。
// ============================================================
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { x402L1Purchases } from "@/lib/db/schema";
import { recordObservedPurchase } from "@/lib/db/observed-purchases";
import { logAndSwallow, logServerError } from "@/lib/util/log";
import { invalidateDecisionCache } from "@/lib/decision/cache";
import { createDeadline } from "@/lib/util/deadline";
import { verifyL1Settlement } from "./settlement-verify";
import { isDeliveryVerified } from "./l1-runner";
import { ingestL1 } from "@/lib/settlements/ingest-l1";
import { LATE_RECOVERABLE_STATUSES } from "@/lib/settlements/recover-late";
import { recordCorrection } from "./corrections";
import { fireL1RegistryHook, fireL2RegistryHook } from "@/lib/chain/registry-hook";

/**
 * 一時的な失敗（RPCが答えない・確定数が足りない・まだ見つからない）は
 * 「否定」ではない。次回の cron で見直せるよう status を倒さず、理由だけ残す。
 * 恒久的な否定（レシートが revert・期待した Transfer が無い・別チェーン）は
 * 売り手についての所見なので settle_claim_refuted へ確定させる。
 */
export const TRANSIENT_REASONS = new Set([
  "rpc_unavailable",
  "tx_not_found",
  "insufficient_confirmations",
  "chain_not_yet_verifiable",
  // Solana（2026-09-04）: finalized 前は「まだ見えていない」であって否定ではない。
  // EVM の insufficient_confirmations と同じ扱い。
  "not_final",
  // 2026-09-04 監査 P1-3: **計器の故障**。下の INSTRUMENT_FAILURE_REASONS も参照。
  "wrong_chain",
  "malformed_tx",
]);

/**
 * 一時的な失敗のうち、**我々の側が壊れている**もの（2026-09-04 監査 P1-3）。
 *
 * `wrong_chain` は「BASE_RPC_URL が Base を指していない」「SOLANA_RPC_URL が別
 * クラスタ」——設定の事故であって売り手についての測定ではない。それが恒久の
 * `settle_claim_refuted` になっていたので、RPC を 1 つ差し替え間違えるだけで
 * その日の 200 件が全部「決済していない売り手」として公開台帳・公開バッジ・
 * スコアへ流れ、settlement_verified=false が立つので二度と見直されなかった。
 *
 * `malformed_tx` も同じ性質: ランナーは isWellFormedSettlementTx を通った行しか
 * settle_claimed にしないので、照合でこれが出るのは我々の側の不整合
 * （旧 `settled` 行・チェーン判定の取り違え）を意味する。
 *
 * 見つけたら黙って deferred を積まない——logServerError で鳴らし、
 * `wrong_chain` なら**そのチェーンの残りの行**を以後読みに行かない（同じ壊れた RPC で
 * 読んでも全部同じ結果になるだけで、デッドラインを食うだけ）。他のチェーンの行は
 * 歩き続ける（2026-09-17 レビュー: 以前はバッチごと中断していたので、Arc の RPC の
 * 誤設定で Base の照合まで毎日止まった）。
 */
export const INSTRUMENT_FAILURE_REASONS = new Set(["wrong_chain", "malformed_tx"]);

/**
 * その行の tx は遅延回収（recover-late.ts）が貼ったものか。純関数。
 * 印は raw_response_meta.lateSettlement。2026-09-19 以降の回収は貼った tx を lateSettlement.txHash に残すので、
 * あればいまの tx_hash と一致することも要求する（旧い行には無い——印だけで判定する）。
 */
export function lateLinkOf(row: { tx_hash: string; late_settlement: unknown }): Record<string, unknown> | null {
  let late = row.late_settlement;
  if (typeof late === "string") {
    try {
      late = JSON.parse(late);
    } catch {
      return null;
    }
  }
  if (typeof late !== "object" || late === null || Array.isArray(late)) return null;
  const rec = late as Record<string, unknown>;
  if (typeof rec.txHash === "string" && rec.txHash.toLowerCase() !== row.tx_hash.toLowerCase()) return null;
  return rec;
}

export type VerifySettlementsSummary = {
  scanned: number;
  verified: number;
  refuted: number;
  /**
   * 遅延回収（recover-late.ts）で vet402 が貼った tx が nonce の束縛で落ち、行を回収前へ戻した件数
   * （2026-09-19 レビュー C1）。refuted には数えない——売り手の所見ではなく、我々の推定の取り消し。
   */
  lateLinksWithdrawn: number;
  /**
   * 1 行の処理が例外で落ちた件数（2026-09-19 レビュー 2 巡目）。落ちた行は触らずに次の行へ進む
   * ——1 件の DB エラーや RPC クライアントの故障で、残りの行の照合まで道連れにしない。
   * 0 が正常。理由はサーバログ（settlement-verifier.row）に出る。
   */
  rowErrors: number;
  deferred: number;
  evidenceWritten: number;
  deadlineHit: boolean;
  /**
   * 我々の計器が壊れていた理由（2026-09-04 監査 P1-3）。null が正常。
   * cron の応答に出るので、外から見て気づける。
   */
  instrumentFailure: string | null;
  /** `wrong_chain` を出して以後スキップしたチェーン（network）。空が正常。 */
  wrongChainNetworks: string[];
};

/**
 * 差し替え点（テスト用）。チェーン照合（viem）と Registry hook 本体を注入できる。
 * 本番は既定のまま。
 */
export type SettlementVerifierDeps = {
  verify?: typeof verifyL1Settlement;
  registryHooks?: {
    l1: typeof fireL1RegistryHook;
    l2: typeof fireL2RegistryHook;
  };
};

export async function runSettlementVerification(options?: {
  limit?: number;
  budgetMs?: number;
  deps?: SettlementVerifierDeps;
}): Promise<VerifySettlementsSummary> {
  const limit = options?.limit ?? 200;
  const deadline = createDeadline(options?.budgetMs ?? 240_000);
  const verify = options?.deps?.verify ?? verifyL1Settlement;
  const hooks = options?.deps?.registryHooks ?? { l1: fireL1RegistryHook, l2: fireL2RegistryHook };
  // 2026-09-02 監査 P1-7: ERC-8004 Validation Registry の発火点はここ——
  // オンチェーンで settled / refuted が**確定した後**だけ。以前は l1-runner が
  // 購入直後に売り手の自己申告（success:true）を verdict にして呼んでいた。
  // hook は絶対に投げない設計（registry-hook.ts）だが、注入された偽物が投げても
  // 照合の結果は変えない。
  //
  // 2026-09-04 監査 P1-4: **逐次に待つ（並列上限 1）。** 以前は Promise を配列へ
  // 積んで末尾で allSettled していた。hook 1 件は request → response の 2 本の
  // オンチェーン tx を出すので、並列に走らせると同じ operator 鍵から複数の tx が
  // 同時に飛び、nonce が衝突して片方が落ちる（本番 registry_writes は 14 行すべて
  // failed）。日次上限の判定も、飛んでいる最中の書き込みを数えられない。
  // 待ち時間は増えるが、この経路は既定 OFF で、ON でも日次 200 件が上限。
  const fireHook = (p: Promise<void>): Promise<void> =>
    p.catch((error) => logServerError("settlement-verifier.registry_hook", error));
  const summary: VerifySettlementsSummary = {
    scanned: 0,
    verified: 0,
    refuted: 0,
    lateLinksWithdrawn: 0,
    rowErrors: 0,
    deferred: 0,
    evidenceWritten: 0,
    deadlineHit: false,
    instrumentFailure: null,
    wrongChainNetworks: [],
  };
  // wrong_chain を出したチェーン。その行は読みに行かず wrong_chain として deferred に積む。
  const wrongChain = new Set<string>();
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL is not configured");

  // 対象: 決済を主張していて、まだ照合が確定していない行。
  // 既存の 'settled'（2026-08-23 より前に、照合前の意味で書かれたもの）も
  // settlement_verified IS NULL なので同じ経路で見に行く。
  const raw = await db.execute(sql`
    SELECT pu.id::text AS id, pu.tx_hash, pu.network, pu.pay_to, pu.payer,
           pu.amount_units, pu.http_status_paid, pu.payload_non_empty, pu.l2_schema,
           pu.status, pu.endpoint_id::text AS endpoint_id, pu.auth_nonce, e.resource_url,
           -- 遅延回収の印（recover-late.ts）。あれば tx を結び付けたのは売り手ではなく vet402 自身。
           pu.raw_response_meta->'lateSettlement' AS late_settlement,
           -- 2026-09-04 監査 P1-1: 同じ (network, lower(tx_hash)) を主張している
           -- 他の購入行が居るか。決済 tx は 1 購入にしか属せないので、2 行以上が
           -- 同じ tx を指していたら**どちらも** settled にできない（どちらが
           -- 本物か我々には言えない）。チェーンを読む前に落とす。
           (SELECT count(*) FROM x402_l1_purchases dup
              WHERE dup.tx_hash IS NOT NULL
                AND dup.network IS NOT DISTINCT FROM pu.network
                AND lower(dup.tx_hash) = lower(pu.tx_hash)) AS tx_claim_count
    FROM x402_l1_purchases pu
    LEFT JOIN x402_endpoints e ON e.id = pu.endpoint_id
    WHERE pu.settlement_verified IS NULL
      AND pu.tx_hash IS NOT NULL
      AND pu.status IN ('settle_claimed', 'settled')
    ORDER BY pu.attempted_at ASC
    LIMIT ${limit}
  `);
  const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as {
    id: string;
    tx_hash: string;
    network: string;
    pay_to: string | null;
    payer: string | null;
    amount_units: string | null;
    http_status_paid: number | null;
    payload_non_empty: boolean | null;
    l2_schema: string | null;
    status: string;
    endpoint_id: string;
    auth_nonce: string | null;
    resource_url: string | null;
    late_settlement: unknown;
    tx_claim_count: number | string | null;
  }[];

  type PurchaseRow = (typeof rows)[number];

  /**
   * 否定の確定（1 箇所に集約）。status を倒し、訂正ログに残し、Registry へ
   * fail を書く。呼ぶのは「見に行って一致しなかった」ときと、
   * 「同じ tx を別の購入が主張している」ときの 2 経路。
   */
  async function refute(row: PurchaseRow, reason: string, detail?: string): Promise<void> {
    await db!
      .update(x402L1Purchases)
      .set({
        status: "settle_claim_refuted",
        settlementVerified: false,
        settlementVerifiedAt: new Date(),
        settlementVerifyReason: `${reason}${detail ? `: ${detail}` : ""}`.slice(0, 500),
      })
      .where(eq(x402L1Purchases.id, row.id));
    summary.refuted++;
    invalidateDecisionCache(row.endpoint_id);
    await recordCorrection({
      subjectType: "purchase",
      subjectId: row.id,
      level: "l1",
      before: { status: row.status },
      after: { status: "settle_claim_refuted", reason },
      reason: "settlement_backfill",
    }).catch(logAndSwallow("settlement-verifier.record_correction.refuted"));
    // 否定もオンチェーンの事実（fail）。L2 は決済が確定していないので書かない。
    await fireHook(
      hooks.l1({ endpointId: row.endpoint_id, payTo: row.pay_to, settled: false, txHash: row.tx_hash, network: row.network }),
    );
  }

  /**
   * 遅延回収の取り消し（2026-09-19 レビュー C1）。`settle_claim_refuted` の公開定義（vocabulary.ts）は
   * 「**売り手が指した** tx を再読したら、その転送が無かった」。遅延回収の tx は売り手が名指したものではなく、
   * 払い元・宛先・額・窓の一致から vet402 が推定で貼ったものなので、否定の理由が何であれその定義は成り立たない
   * （2 巡目レビュー 1: `nonce_not_used` 限定から全理由へ広げた）。確定的な否定が出たら推定を取り消すだけにする:
   *   - status と tx_hash を回収前へ戻す（lateSettlement.priorStatus / replacedTxHash。priorStatus の無い
   *     旧い行は settle_failed——2026-09-19 より前の回収は settle_failed・tx なしだけが対象だった）
   *   - settlement_verified / reason は NULL のまま、Registry へは書かない
   *   - その tx を lateSettlement.rejectedTxHashes（小文字）に残す。recover-late はそれを候補から外すので、
   *     戻した行が同じ tx をまた拾って往復しない
   *   - 訂正ログに 1 行残す（公開面が「いつ何が変わったか」を言える）
   *
   * `nonce_not_used` 以外（`no_matching_transfer`・`amount_mismatch`・`tx_reverted`・`payee_mismatch` …）は
   * **鳴らす**。索引（settlements）と照合器は同じ 4 条件（chain・払い元・宛先・額）を見ているので、索引に
   * 載った tx がその 4 条件で落ちるのは計器の故障か reorg でしかありえない。黙って取り消すと、索引か照合器の
   * どちらかが壊れていることに誰も気づけない（2026-09-04 P1-3 と同じ規律・2 巡目レビュー 1）。
   */
  async function withdrawLateLink(row: PurchaseRow, late: Record<string, unknown>, reason: string, detail?: string): Promise<void> {
    const priorStatus =
      typeof late.priorStatus === "string" && (LATE_RECOVERABLE_STATUSES as readonly string[]).includes(late.priorStatus)
        ? late.priorStatus
        : "settle_failed";
    const priorTxHash = typeof late.replacedTxHash === "string" ? late.replacedTxHash : null;
    const rejected = row.tx_hash.toLowerCase();
    if (reason !== "nonce_not_used") {
      logServerError(
        "settlement-verifier.late_link_unexpected_refutation",
        `purchase ${row.id} (${row.network}) linked ${row.tx_hash} from the settlements index, but the verifier answered ` +
          `${reason}${detail ? `: ${detail}` : ""} — the index and the verifier read the same chain, payer, payee and amount, ` +
          `so this is an instrument failure or a reorg`,
      );
    }
    // raw_response_meta は SQL の中で継ぎ足す（読んでから書くと、その間の別の書き込みを潰す）。
    // tx_hash の戻し先は SQL の中で決める（2 巡目レビュー 2）。売り手の原文を別の行が既に持っていると
    // 部分一意 index（x402_l1_purchases_tx_unique）で throw し、このバッチの残りの行が照合されない。
    // 衝突するなら NULL で戻す——主張された原文は raw_settlement と lateSettlement.replacedTxHash に残る。
    await db!.execute(sql`
      UPDATE x402_l1_purchases pu
      SET status = ${priorStatus},
          tx_hash = CASE
            WHEN ${priorTxHash}::text IS NULL THEN NULL
            WHEN EXISTS (
              SELECT 1 FROM x402_l1_purchases o
              WHERE o.id <> pu.id
                AND o.tx_hash IS NOT NULL
                AND o.network IS NOT DISTINCT FROM pu.network
                AND lower(o.tx_hash) = lower(${priorTxHash}::text)
            ) THEN NULL
            ELSE ${priorTxHash}::text
          END,
          settlement_verified = NULL,
          settlement_verified_at = NULL,
          settlement_verify_reason = NULL,
          raw_response_meta = jsonb_set(
            raw_response_meta,
            '{lateSettlement,rejectedTxHashes}',
            coalesce(raw_response_meta->'lateSettlement'->'rejectedTxHashes', '[]'::jsonb) || to_jsonb(${rejected}::text)
          )
      WHERE pu.id = ${row.id}::uuid
    `);
    summary.lateLinksWithdrawn++;
    invalidateDecisionCache(row.endpoint_id);
    // 訂正ログは**実際に書き戻した値**を載せる（衝突で NULL になった場合も含めて、行と食い違わないように）。
    const [written] = await db!.select({ txHash: x402L1Purchases.txHash }).from(x402L1Purchases).where(eq(x402L1Purchases.id, row.id));
    await recordCorrection({
      subjectType: "purchase",
      subjectId: row.id,
      level: "l1",
      before: { status: row.status, txHash: row.tx_hash },
      after: { status: priorStatus, txHash: written?.txHash ?? null, lateLinkWithdrawn: reason },
      reason: "settlement_backfill",
    }).catch(logAndSwallow("settlement-verifier.record_correction.late_link_withdrawn"));
  }

  /**
   * 1 行ぶんの照合（2026-09-19 レビュー 2 巡目で関数へ切り出した）。呼び手が例外を受け止めて
   * 次の行へ進むので、1 件の DB エラー・RPC クライアントの故障が残りの行を道連れにしない。
   */
  async function verifyOneRow(row: PurchaseRow): Promise<void> {

    if (!row.pay_to || !row.payer || !row.amount_units) {
      // 期待値が台帳に無い＝我々が何を期待したか言えない。照合できないので
      // 触らず、理由だけ残す（推測で期待値を作らない）。
      await db!
        .update(x402L1Purchases)
        .set({ settlementVerifyReason: "expected_values_missing" })
        .where(eq(x402L1Purchases.id, row.id));
      summary.deferred++;
      return;
    }

    // 2026-09-04 監査 P1-1: 1 本の決済 tx は 1 つの購入にしか属せない。
    // 2 行以上が同じ tx を主張していたら、どちらが本物か我々には言えないので
    // **どちらも** settled にしない。チェーンを読む前に落とす（読んでも
    // 「その tx は実在する」としか分からず、区別できない）。
    if (Number(row.tx_claim_count ?? 1) > 1) {
      await refute(row, "tx_hash_reused", `${row.tx_claim_count} purchases claim ${row.tx_hash}`);
      return;
    }

    // このバッチで既に「RPC が別のチェーンを指している」と分かったチェーンの行は、
    // 読みに行かない（結果は同じ）。他のチェーンの行は続ける。
    if (wrongChain.has(row.network)) {
      await db!.update(x402L1Purchases).set({ settlementVerifyReason: "wrong_chain" }).where(eq(x402L1Purchases.id, row.id));
      summary.deferred++;
      return;
    }

    const result = await verify({
      txHash: row.tx_hash,
      network: row.network,
      expectedPayTo: row.pay_to,
      expectedPayer: row.payer,
      expectedAmountUnits: row.amount_units,
      expectedAuthNonce: row.auth_nonce,
    });

    if (result.ok) {
      await db!
        .update(x402L1Purchases)
        .set({
          status: "settled",
          settlementVerified: true,
          settlementVerifiedAt: new Date(),
          settlementVerifyReason: null,
          settlementBlockNumber: result.blockNumber,
        })
        .where(eq(x402L1Purchases.id, row.id));
      summary.verified++;
      invalidateDecisionCache(row.endpoint_id); // settled は判定材料（このインスタンスのみ・cache.ts 参照）
      // §10 / §6.2: バックフィルで確定した状態変化は訂正ログに残す。
      await recordCorrection({
        subjectType: "purchase",
        subjectId: row.id,
        level: "l1",
        before: { status: row.status },
        after: { status: "settled", blockNumber: String(result.blockNumber) },
        reason: "settlement_backfill",
      }).catch(logAndSwallow("settlement-verifier.record_correction.settled"));

      // §7.3（2026-09-02）: 確定した購入は決済索引へ即時に載せ、受取先→Endpoint の
      // 逆引きが cron を待たずに更新される（実装完了の定義「1 分以内」）。
      // 索引の失敗は照合の成否を変えない——次回の日次 ingestL1 が拾う。
      try {
        await ingestL1({ onlyPurchaseRowId: row.id });
      } catch (error) {
        logServerError("settlement-verifier.ingest-l1", error);
      }

      // ERC-8004 Validation Registry（フラグOFF既定・graceful）。書けるのはここで
      // 確定した settled だけ。L2 は conform / mismatch が確定しているときだけ
      // （未検査・宣言なしは書かない）。
      await fireHook(
        hooks.l1({ endpointId: row.endpoint_id, payTo: row.pay_to, settled: true, txHash: row.tx_hash, network: row.network }),
      );
      if (row.l2_schema === "match" || row.l2_schema === "mismatch") {
        await fireHook(
          hooks.l2({
            endpointId: row.endpoint_id,
            payTo: row.pay_to,
            l2: row.l2_schema === "match" ? "conform" : "mismatch",
            txHash: row.tx_hash,
            network: row.network,
          }),
        );
      }

      // スコア証拠はここでだけ書く。delivery_verified の規則はランナーと共有。
      try {
        const created = await recordObservedPurchase({
          wallet: row.payer,
          counterparty: row.pay_to,
          amount: row.amount_units,
          txHash: row.tx_hash,
          resource: row.resource_url,
          blockTimestamp: result.blockTimestamp,
          deliveryVerified: isDeliveryVerified({
            httpStatusPaid: row.http_status_paid,
            payloadNonEmpty: row.payload_non_empty === true,
            l2Schema: row.l2_schema ?? "no_declaration",
          }),
          observedBy: `observatory-l1-verified:${row.id}`,
        });
        if (created.created) summary.evidenceWritten++;
      } catch (error) {
        // 証拠が書けなくても照合の結果は正典（x402_l1_purchases）に残る。
        // 黙って消さない。
        logServerError("observatory.settlement_verify.evidence", error);
      }
      return;
    }

    if (TRANSIENT_REASONS.has(result.reason)) {
      // 見えなかっただけ。否定ではないので status は倒さない。
      await db!
        .update(x402L1Purchases)
        .set({ settlementVerifyReason: result.reason })
        .where(eq(x402L1Purchases.id, row.id));
      summary.deferred++;
      // 2026-09-04 監査 P1-3: 我々の側が壊れているときは鳴らす。
      if (INSTRUMENT_FAILURE_REASONS.has(result.reason)) {
        logServerError(
          "settlement-verifier.instrument_failure",
          `${result.reason} on purchase ${row.id} (${row.network})${result.detail ? `: ${result.detail}` : ""}`,
        );
        // wrong_chain は RPC そのものが別のチェーンを指している。そのチェーンの残りの
        // 行を読みに行っても全部同じ結果になるだけなので、以後はそのチェーンだけ飛ばす
        // （バッチは中断しない——他のチェーンの照合を道連れにしない）。
        if (result.reason === "wrong_chain") {
          summary.instrumentFailure = result.reason;
          if (!wrongChain.has(row.network)) {
            wrongChain.add(row.network);
            summary.wrongChainNetworks.push(row.network);
          }
        }
      }
      return;
    }

    // 遅延回収で vet402 が貼った tx が確定的に否定された。売り手は tx を名指していないので、否定の理由が
    // 何であれ refute しない（2 巡目レビュー 1）。nonce の束縛で落ちるのは正常な結果、それ以外は計器の
    // 故障か reorg——withdrawLateLink がその区別を鳴らす。
    const late = lateLinkOf(row);
    if (late) {
      await withdrawLateLink(row, late, result.reason, result.detail);
      return;
    }

    // 見に行って一致しなかった。売り手についての所見として確定させる。
    await refute(row, result.reason, result.detail);
  }

  for (const row of rows) {
    // 1件あたり最大 ~6s（RPC 3往復 + 予備）。残りが足りなければ次回へ回す。
    if (deadline.remaining() < 8_000) {
      summary.deadlineHit = true;
      break;
    }
    summary.scanned++;
    try {
      await verifyOneRow(row);
    } catch (error) {
      // 落ちた行は触らない（status は倒さず、次回のバッチがまた拾う）。黙って飲み込まず、
      // 件数を summary に出してログに理由を残す（2026-09-19 レビュー 2 巡目）。
      summary.rowErrors++;
      logServerError(`settlement-verifier.row ${row.id} (${row.network})`, error);
    }
  }

  return summary;
}

/** 未照合として残っている件数（公開面が「まだ見ていない」を言えるように）。 */
export async function countUnverifiedSettlementClaims(): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(x402L1Purchases)
    .where(
      and(
        isNull(x402L1Purchases.settlementVerified),
        or(
          eq(x402L1Purchases.status, "settle_claimed"),
          eq(x402L1Purchases.status, "settled"),
        ),
      ),
    );
  return Number(rows[0]?.n ?? 0);
}
