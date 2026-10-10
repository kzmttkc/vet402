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
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { invalidateDecisionCache } from "@/lib/decision/cache";
import { createDeadline } from "@/lib/util/deadline";
import { readAuthorizationState, verifyL1Settlement } from "./settlement-verify";
import { evmChainFor } from "./x402-payer";
import { isDeliveryVerified } from "./l1-runner";
import { ingestL1 } from "@/lib/settlements/ingest-l1";
import { LATE_PRIOR_STATUSES } from "@/lib/settlements/recover-late";
import { updateWithCorrection } from "./corrections";
import { fireL1RegistryHook, fireL2RegistryHook } from "@/lib/chain/registry-hook";
import { SELLER_NAMED_TX_NOT_FOUND, SELLER_NAMED_TX_NOT_FOUND_AFTER_DAYS, SELLER_NAMED_TX_NOT_FOUND_MIN_DAYS } from "@/lib/sellers/fix-modes";

/**
 * 売り手が名指した tx の照合の期限（2026-09-29 敵対的監査 5 周目・値の正典は src/lib/sellers/fix-modes.ts）。
 *
 * tx_not_found は一時的な理由（まだ見えていないだけ）として status を倒さずに毎日読み直していたので、売り手が名指した
 * tx がチェーンに無いまま「照合待ち」が続いた（api.wines.bet: 2026-09-12 から 17 日）。購入から
 * SELLER_NAMED_TX_NOT_FOUND_AFTER_DAYS 日たっても見つからない行は、日付付きで「売り手の名指した tx が見つからない」
 * として確定する（settle_claim_refuted・理由は SELLER_NAMED_TX_NOT_FOUND で始まる）。受領証の tx がハッシュの形ですらない行
 * （settle_claimed_unverifiable・例 "first-can"）も、同じ日数の後、nonce の認可が未使用とチェーンで読めたときだけ同じ語で確定する。
 * 遅延回収で vet402 が貼った tx（売り手は名指していない）と、売り手が success:false のまま名指した tx には当てない
 * ——tx_not_found のまま deferred に置く（2026-09-29 独立レビュー HIGH: 期限で取り消し・申告の戻しへ進めると、RPC の
 * 失敗で実在する決済を rejectedTxHashes に永久に入れうる）。
 *
 * 2026-09-29 独立レビュー（CRITICAL）: RPC の失敗 1 回で確定しないよう、確定には次の全部を要る（sellerNamedTxExpiryReady）:
 *   - Base / Arc（x402-payer の EVM_PAY_CHAINS）の行。Solana（履歴を持たない RPC）・XRPL（searched_all を見ていない）・
 *     Tempo は当面対象外（tx_not_found のまま deferred）
 *   - 購入から SELLER_NAMED_TX_NOT_FOUND_AFTER_DAYS 日
 *   - 別々の UTC 日に SELLER_NAMED_TX_NOT_FOUND_MIN_DAYS 回以上「見つからない」（raw_response_meta.txNotFound に日付を記録）
 *   - auth_nonce のある行は USDC の authorizationState(payer, nonce) が false（チェーンで、お金が動いていない）
 *   - 確定の直前にもう一度読んで、また tx_not_found
 * 「見つからない」は RPC が「そのレシートは無い」と答えたときだけ（settlement-verify.ts の receiptMissing）。
 */
export const SELLER_NAMED_TX_EXPIRY_MS = SELLER_NAMED_TX_NOT_FOUND_AFTER_DAYS * 86_400_000;
export { SELLER_NAMED_TX_NOT_FOUND_MIN_DAYS };

/** 期限の対象になるチェーンの CAIP-2（SELECT で settle_claimed_unverifiable を拾う範囲）。 */
// Celo（eip155:42220・2026-10-10）: 下の sellerNamedTxExpiryChain は払い手の表（EVM_PAY_CHAINS）から決まるので、
// Celo の行は表に足した時点で期限の対象になる。この SELECT の範囲も同じ集合に揃える（Base / Arc と同じ条件:
// 別々の日に「無い」・nonce の認可が未使用・確定の直前の読み直し。Celo の USDC にも authorizationState がある）。
const EXPIRY_NETWORKS: readonly string[] = ["eip155:8453", "base", "eip155:5042", "eip155:42220"];

/** 期限の対象になるチェーンか（Base / Arc / Celo＝払い手の表の EVM だけ・Tempo・Solana・XRPL は当面外す）。 */
export function sellerNamedTxExpiryChain(network: string | null): boolean {
  return typeof network === "string" && network.startsWith("eip155:") && evmChainFor(network) !== null;
}

/** raw_response_meta.txNotFound.days（UTC の日付の配列）から、別々の日の数。形が違えば 0。 */
export function notFoundDaysOf(v: unknown): string[] {
  let x = v;
  if (typeof x === "string") {
    try {
      x = JSON.parse(x);
    } catch {
      return [];
    }
  }
  const days = typeof x === "object" && x !== null && !Array.isArray(x) ? (x as { days?: unknown }).days : null;
  if (!Array.isArray(days)) return [];
  return [...new Set(days.filter((d): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)))];
}

/** 購入から期限の日数がたったか（純関数・読めない時刻は「たっていない」に倒す）。 */
export function sellerNamedTxExpired(attemptedAt: string | Date | null, now: number = Date.now()): boolean {
  const t = attemptedAt instanceof Date ? attemptedAt.getTime() : typeof attemptedAt === "string" ? Date.parse(attemptedAt) : NaN;
  return Number.isFinite(t) && now - t >= SELLER_NAMED_TX_EXPIRY_MS;
}

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
/** recover-late の promoteNamedTx の印（raw_response_meta.namedTxPromotion）。無ければ null。純関数。 */
export function namedTxPromotionOf(row: { named_tx_promotion: unknown }): Record<string, unknown> | null {
  let v = row.named_tx_promotion;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

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
   * 売り手が success:false と申告したまま名指した tx が照合で合わず、申告どおりの失敗へ戻した件数（2026-09-29 第4巡）。
   * refuted には数えない。
   */
  sellerDeclaredUnsettled: number;
  /**
   * 売り手が名指した tx が期限の日数たっても見つからない（または受領証の tx がハッシュの形でない）として確定した件数
   * （2026-09-29 第5巡）。refuted には数えない（チェーンで否定を読んだのではなく、期限までに見つからなかった）。
   */
  sellerNamedTxExpired: number;
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
  /** USDC の authorizationState(payer, nonce) を読む（2026-09-29・売り手の名指した tx の期限の条件）。 */
  authorizationState?: typeof readAuthorizationState;
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
  const authorizationState = options?.deps?.authorizationState ?? readAuthorizationState;
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
    p.catch((error) => logServerErrorSafe("settlement-verifier.registry_hook", error));
  const summary: VerifySettlementsSummary = {
    scanned: 0,
    verified: 0,
    refuted: 0,
    lateLinksWithdrawn: 0,
    sellerDeclaredUnsettled: 0,
    sellerNamedTxExpired: 0,
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
           to_char(pu.attempted_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS attempted_at,
           -- 遅延回収の印（recover-late.ts）。あれば tx を結び付けたのは売り手ではなく vet402 自身。
           pu.raw_response_meta->'lateSettlement' AS late_settlement,
           -- 2026-09-29 第4巡: 売り手が success:false のまま名指した tx を recover-late が照合へ回した印（promoteNamedTx）。
           pu.raw_response_meta->'namedTxPromotion' AS named_tx_promotion,
           -- 2026-09-29 独立レビュー: 「見つからない」だった UTC の日付（売り手の名指した tx の期限の条件）。
           pu.raw_response_meta->'txNotFound' AS tx_not_found_log,
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
      AND (pu.status IN ('settle_claimed', 'settled')
           -- 2026-09-29 第5巡: 受領証の tx がハッシュの形ですらない行は、期限の日数の後に確定する（チェーンは読まない）。
           OR (pu.status = 'settle_claimed_unverifiable'
               AND pu.network IN (${sql.join(EXPIRY_NETWORKS.map((n) => sql`${n}`), sql`, `)})
               AND pu.attempted_at < now() - (${SELLER_NAMED_TX_NOT_FOUND_AFTER_DAYS} * interval '1 day')))
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
    attempted_at: string | null;
    late_settlement: unknown;
    named_tx_promotion: unknown;
    tx_not_found_log: unknown;
    tx_claim_count: number | string | null;
  }[];

  type PurchaseRow = (typeof rows)[number];

  /**
   * 否定の確定（1 箇所に集約）。status を倒し、訂正ログに残し、Registry へ
   * fail を書く。呼ぶのは「見に行って一致しなかった」ときと、
   * 「同じ tx を別の購入が主張している」ときの 2 経路。
   */
  async function refute(row: PurchaseRow, reason: string, detail?: string): Promise<void> {
    // 2026-09-29 監査4周目: 台帳の UPDATE と訂正ログを 1 文で（updateWithCorrection の節）。
    // 訂正ログが書けないなら status も倒さない——例外は行単位の catch が rowErrors に数え、次回に再試行。
    await updateWithCorrection(db!, {
      update: sql`
        UPDATE x402_l1_purchases
        SET status = 'settle_claim_refuted',
            settlement_verified = false,
            settlement_verified_at = now(),
            settlement_verify_reason = ${`${reason}${detail ? `: ${detail}` : ""}`.slice(0, 500)}::text
        WHERE id = ${row.id}::uuid
        RETURNING id::text AS correction_subject_id`,
      subjectType: "purchase",
      level: "l1",
      before: { json: { status: row.status } },
      after: { json: { status: "settle_claim_refuted", reason } },
      reason: "settlement_backfill",
    });
    summary.refuted++;
    invalidateDecisionCache(row.endpoint_id);
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
      // 2026-09-29（会計監査 7 周目）: auth_nonce のある request_error（孤児掃除の旧い行）からの回収も戻し先に含める。
      typeof late.priorStatus === "string" && (LATE_PRIOR_STATUSES as readonly string[]).includes(late.priorStatus)
        ? late.priorStatus
        : "settle_failed";
    const priorTxHash = typeof late.replacedTxHash === "string" ? late.replacedTxHash : null;
    const rejected = row.tx_hash.toLowerCase();
    if (reason !== "nonce_not_used") {
      logServerErrorSafe(
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
    // 2026-09-29 監査4周目: 書き戻しと訂正ログを 1 文で。訂正ログの after.txHash は RETURNING の
    // 実際に書いた値（衝突で NULL になった場合も含めて行と食い違わない）。
    await updateWithCorrection(db!, {
      update: sql`
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
      RETURNING pu.id::text AS correction_subject_id, pu.tx_hash AS written_tx_hash`,
      subjectType: "purchase",
      level: "l1",
      before: { json: { status: row.status, txHash: row.tx_hash } },
      after: {
        expr: sql`jsonb_build_object('status', ${priorStatus}::text, 'txHash', changed.written_tx_hash, 'lateLinkWithdrawn', ${reason}::text)`,
      },
      reason: "settlement_backfill",
    });
    summary.lateLinksWithdrawn++;
    invalidateDecisionCache(row.endpoint_id);
  }

  /**
   * 売り手が PAYMENT-RESPONSE で success:false と申告したまま名指した tx が、照合で合わなかった（2026-09-29 第4巡・
   * 独立レビュー WARNING 3）。売り手は「決済していない」と正直に言っていたので、その tx の否定を売り手の申告の否定
   * （settle_claim_refuted）にしない。申告どおりの失敗として、recover-late が移す前の status（delivered_no_receipt /
   * settle_failed）へ戻し、照合の結果（settlement_verified = false と理由）を残す。tx はそのまま（売り手の原文）。
   * Registry へは書かない（元の status のときも書いていない）。台帳と訂正ログは同じ文。settlement_verified が
   * NULL でなくなるので recover-late は二度と移さない。
   */
  async function declineSellerNamedTx(row: PurchaseRow, promo: Record<string, unknown>, reason: string, detail?: string): Promise<void> {
    const priorStatus =
      promo.priorStatus === "delivered_no_receipt" || promo.priorStatus === "settle_failed" ? promo.priorStatus : "delivered_no_receipt";
    const verifyReason = `seller_declared_unsettled: ${reason}${detail ? `: ${detail}` : ""}`.slice(0, 500);
    await updateWithCorrection(db!, {
      update: sql`
        UPDATE x402_l1_purchases
        SET status = ${priorStatus},
            settlement_verified = false,
            settlement_verified_at = now(),
            settlement_verify_reason = ${verifyReason}::text
        WHERE id = ${row.id}::uuid
        RETURNING id::text AS correction_subject_id`,
      subjectType: "purchase",
      level: "l1",
      before: { json: { status: row.status, txHash: row.tx_hash } },
      after: { json: { status: priorStatus, txHash: row.tx_hash, sellerDeclaredUnsettled: reason } },
      reason: "settlement_backfill",
    });
    summary.sellerDeclaredUnsettled++;
    invalidateDecisionCache(row.endpoint_id);
  }

  /**
   * 売り手の名指した tx が見つからないとして確定する（2026-09-29 第5巡・SELLER_NAMED_TX_EXPIRY_MS）。売り手の申告
   * （「この tx で決済した」）の否定なので status を settle_claim_refuted に倒し、理由の先頭に SELLER_NAMED_TX_NOT_FOUND と
   * 日付を書く。台帳と訂正ログは同じ文（updateWithCorrection）。status が読んだ時から変わっていれば 0 行（訂正も 0 行）。
   * Registry へは書かない: チェーンで否定を読んだのではなく、期限までに見つからなかったという記録だから。
   */
  async function expireSellerNamedTx(row: PurchaseRow, what: string): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    const attempted = (row.attempted_at ?? "").slice(0, 10);
    const verifyReason = `${SELLER_NAMED_TX_NOT_FOUND}: ${what}, checked through ${today} (purchase ${attempted}, ${SELLER_NAMED_TX_NOT_FOUND_AFTER_DAYS}-day limit)`.slice(0, 500);
    const note = `The transaction the seller named was not found on-chain within ${SELLER_NAMED_TX_NOT_FOUND_AFTER_DAYS} days of the purchase on ${attempted}; recorded as seller-named tx not found on ${today}.`;
    const changed = await updateWithCorrection(db!, {
      update: sql`
        UPDATE x402_l1_purchases
        SET status = 'settle_claim_refuted',
            settlement_verified = false,
            settlement_verified_at = now(),
            settlement_verify_reason = ${verifyReason}::text
        WHERE id = ${row.id}::uuid AND status = ${row.status} AND settlement_verified IS NULL
        RETURNING id::text AS correction_subject_id`,
      subjectType: "purchase",
      level: "l1",
      before: { json: { status: row.status, txHash: row.tx_hash } },
      after: { json: { status: "settle_claim_refuted", reason: SELLER_NAMED_TX_NOT_FOUND, note } },
      reason: "settlement_backfill",
    });
    summary.sellerNamedTxExpired += changed.length;
    invalidateDecisionCache(row.endpoint_id);
  }

  /**
   * 「見つからない」だった UTC の日付を raw_response_meta.txNotFound に足し、別々の日付の一覧を返す（2026-09-29 独立レビュー）。
   * 読んでから書かず SQL の中で継ぎ足す（その間の別の書き込みを潰さない）。公開の状態ではないので訂正ログには載せない。
   */
  async function recordNotFoundDay(row: PurchaseRow): Promise<string[]> {
    const today = new Date().toISOString().slice(0, 10);
    const known = notFoundDaysOf(row.tx_not_found_log);
    if (known.includes(today)) return known;
    const raw = await db!.execute(sql`
      UPDATE x402_l1_purchases
      SET raw_response_meta = jsonb_set(
            CASE WHEN jsonb_typeof(raw_response_meta) = 'object' THEN raw_response_meta ELSE '{}'::jsonb END,
            '{txNotFound}',
            jsonb_build_object(
              'days', (SELECT coalesce(jsonb_agg(DISTINCT d ORDER BY d), '[]'::jsonb) FROM (
                        SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(raw_response_meta->'txNotFound'->'days') = 'array'
                                                              THEN raw_response_meta->'txNotFound'->'days' ELSE '[]'::jsonb END) AS d
                        UNION SELECT ${today}::text) x),
              'last', to_jsonb(now())))
      WHERE id = ${row.id}::uuid
      RETURNING raw_response_meta->'txNotFound' AS tx_not_found_log`);
    const rows = (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as { tx_not_found_log: unknown }[];
    return rows[0] ? notFoundDaysOf(rows[0].tx_not_found_log) : [...known, today];
  }

  /**
   * 売り手の名指した tx を「見つからない」と確定してよいか（2026-09-29 独立レビュー CRITICAL・条件は冒頭の
   * SELLER_NAMED_TX_EXPIRY_MS の注記）。認可の読み取り・読み直しが失敗したら確定しない（false）。
   */
  async function sellerNamedTxExpiryReady(row: PurchaseRow, days: readonly string[]): Promise<boolean> {
    if (!sellerNamedTxExpiryChain(row.network)) return false;
    if (!sellerNamedTxExpired(row.attempted_at)) return false;
    if (days.length < SELLER_NAMED_TX_NOT_FOUND_MIN_DAYS) return false;
    if (row.auth_nonce) {
      if (!row.payer) return false;
      const used = await authorizationState({ network: row.network, payer: row.payer, nonce: row.auth_nonce });
      if (used !== false) return false;
    }
    const again = await verify({
      txHash: row.tx_hash,
      network: row.network,
      expectedPayTo: row.pay_to!,
      expectedPayer: row.payer!,
      expectedAmountUnits: row.amount_units!,
      expectedAuthNonce: row.auth_nonce,
    });
    return !again.ok && again.reason === "tx_not_found";
  }

  /**
   * 照合の理由（settlement_verify_reason）だけを書く経路（status は変えない）。2026-09-29 監査4周目:
   * この列は売り手の頁（/sellers の reader.ts・verifyReason）に出る公開の状態なので、**値が変わったときだけ**
   * 同じ文で訂正ログに残す。同じ理由の書き直し（毎日の再試行）は UPDATE も訂正も 0 行。
   */
  // 2026-09-29 独立レビュー（WARNING）: 照合の理由だけの書き換え（status は変わらない）は公開の
  // 訂正ログに載せない。tx_not_found・rpc_unavailable 等の一時的な理由が入れ替わるたびに /corrections が
  // 1 行ずつ増え、本物の訂正が埋もれる。公開の状態（status・tx）が変わる書き込みだけを訂正として残す。
  async function setVerifyReason(row: PurchaseRow, verifyReason: string): Promise<void> {
    await db!.execute(sql`
      UPDATE x402_l1_purchases
      SET settlement_verify_reason = ${verifyReason}::text
      WHERE id = ${row.id}::uuid AND settlement_verify_reason IS DISTINCT FROM ${verifyReason}::text`);
  }

  /**
   * 1 行ぶんの照合（2026-09-19 レビュー 2 巡目で関数へ切り出した）。呼び手が例外を受け止めて
   * 次の行へ進むので、1 件の DB エラー・RPC クライアントの故障が残りの行を道連れにしない。
   */
  async function verifyOneRow(row: PurchaseRow): Promise<void> {
    // 2026-09-29 第5巡: 受領証の tx がハッシュの形ですらない行（SELECT が Base / Arc の、期限の日数の後の行だけを拾う）。
    // tx は読めないので、nonce のある行は認可が使われていない（お金が動いていない）とチェーンで確かめてから確定する。
    // 使われていた・読めなかったときは触らない（決済はどこかで起きている＝遅延回収の対象）。
    if (row.status === "settle_claimed_unverifiable") {
      // 2026-09-29 独立レビュー: nonce の無い行はチェーンで確かめられないので確定しない（照合待ちのまま）。
      if (!row.auth_nonce || !row.payer) {
        summary.deferred++;
        return;
      }
      const used = await authorizationState({ network: row.network, payer: row.payer, nonce: row.auth_nonce });
      if (used !== false) {
        summary.deferred++;
        return;
      }
      await expireSellerNamedTx(row, `the receipt's transaction id ${JSON.stringify(row.tx_hash.slice(0, 40))} is not a transaction hash`);
      return;
    }

    if (!row.pay_to || !row.payer || !row.amount_units) {
      // 期待値が台帳に無い＝我々が何を期待したか言えない。照合できないので
      // 触らず、理由だけ残す（推測で期待値を作らない）。
      await setVerifyReason(row, "expected_values_missing");
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
      await setVerifyReason(row, "wrong_chain");
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
      // §10 / §6.2: バックフィルで確定した状態変化は訂正ログに残す——2026-09-29 から同じ文で。
      await updateWithCorrection(db!, {
        update: sql`
          UPDATE x402_l1_purchases
          SET status = 'settled',
              settlement_verified = true,
              settlement_verified_at = now(),
              settlement_verify_reason = NULL,
              settlement_block_number = ${String(result.blockNumber)}::bigint
          WHERE id = ${row.id}::uuid
          RETURNING id::text AS correction_subject_id`,
        subjectType: "purchase",
        level: "l1",
        before: { json: { status: row.status } },
        after: { json: { status: "settled", blockNumber: String(result.blockNumber) } },
        reason: "settlement_backfill",
      });
      summary.verified++;
      invalidateDecisionCache(row.endpoint_id); // settled は判定材料（このインスタンスのみ・cache.ts 参照）

      // §7.3（2026-09-02）: 確定した購入は決済索引へ即時に載せ、受取先→Endpoint の
      // 逆引きが cron を待たずに更新される（実装完了の定義「1 分以内」）。
      // 索引の失敗は照合の成否を変えない——次回の日次 ingestL1 が拾う。
      try {
        await ingestL1({ onlyPurchaseRowId: row.id });
      } catch (error) {
        logServerErrorSafe("settlement-verifier.ingest-l1", error);
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
        logServerErrorSafe("observatory.settlement_verify.evidence", error);
      }
      return;
    }

    // 遅延回収の tx・success:false の申告は、ここで先に見分ける（下の確定の経路と、期限の確定の両方で使う）。
    const late = lateLinkOf(row);
    const promo = namedTxPromotionOf(row);

    // 2026-09-29 第5巡（独立レビューの修正込み）: 売り手が名指した tx の「見つからない」を日付で数え、条件が揃えば確定する。
    // 遅延回収の tx と success:false の申告は対象外（tx_not_found のまま下の deferred へ）。
    if (result.reason === "tx_not_found" && !late && !promo) {
      const days = await recordNotFoundDay(row);
      if (await sellerNamedTxExpiryReady(row, days)) {
        await expireSellerNamedTx(row, `transaction ${row.tx_hash.slice(0, 80)} not found on ${row.network} on ${days.length} different days`);
        return;
      }
    }

    if (TRANSIENT_REASONS.has(result.reason)) {
      // 見えなかっただけ。否定ではないので status は倒さない。
      await setVerifyReason(row, result.reason);
      summary.deferred++;
      // 2026-09-04 監査 P1-3: 我々の側が壊れているときは鳴らす。
      if (INSTRUMENT_FAILURE_REASONS.has(result.reason)) {
        logServerErrorSafe(
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
    if (late) {
      await withdrawLateLink(row, late, result.reason, result.detail);
      return;
    }

    // 売り手が success:false と申告したまま名指した tx（2026-09-29 第4巡）: 申告どおりの失敗に戻す。
    if (promo) {
      await declineSellerNamedTx(row, promo, result.reason, result.detail);
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
      logServerErrorSafe(`settlement-verifier.row ${row.id} (${row.network})`, error);
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
