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
//
// 推定で貼らない（同日・独立レビュー C1）: EVM・Solana の索引には nonce が無いので、払い元・宛先・額・窓が合う
// 候補の購入が 2 行以上ある tx は、どちらのものか言えない。以前は「先に試行した行」へ貼っていたが、外れた行は
// 照合器が nonce_not_used で落とす。**候補が 1 行に決まる tx だけを貼る**（tx_candidates = 1）。
// それでも外れることはある（本当の持ち主が回収対象外の status にいる）。そのとき照合器は売り手の
// settle_claim_refuted にせず、行を lateSettlement.priorStatus / replacedTxHash へ戻し、その tx を
// lateSettlement.rejectedTxHashes（小文字）に残す（settlement-verifier.ts withdrawLateLink）。ここは
// その tx を二度と候補にしない——戻した行がまた同じ tx を拾って往復しないため。
//
// 2026-09-29（敵対的監査・penny402.fun）: 候補が 2 行以上ある tx は「貼らない」だけだったので、同じ payer から
// 同じ payTo へ同額の購入を数秒違いで 2 本出すと（tarot と koan・16 秒違い・2500 単位）、着金が 2 本とも実在しても
// どちらの行にも貼られず、頁は「決済を確認できず」と書いていた。本番では 20 行がこの形で止まっていた。
// 推定はしない。**EVM では tx のレシートの AuthorizationUsed(authorizer, nonce) を読み、行の auth_nonce（我々が
// 署名した nonce）と一致する行が 1 つだけのときに貼る**（linkAmbiguousByNonce）。nonce は我々が randomBytes(32)
// で作った値なので、一致すれば持ち主はその行に決まる。読み手（readNonces）は呼び手が渡す（cron は
// settlement-verify.ts の readAuthorizationNonces。テストは偽物）。渡さなければ従来どおり貼らない。
//
// 2026-09-29 第4巡（敵対的監査・fiatdock / agent-budget-guard / ai-agent-payment-safety-stack / wazir）: 逆方向の誤り
// （売り手に不利）を 3 つ塞ぐ。
//   1. 索引に無い着金（linkFromChain）。索引（index-evm）はその時点のカタログの payTo だけを前へ読むので、後から
//      カタログに載った payTo への、過去の着金は索引に入らない。2026-09-29 の実測で、Base の「レシート無しの 2xx・tx
//      なし」70 行のうち 43 行に、支払元（その行の payer・当時の 0x6777… を含む）から価格ちょうどの着金がチェーンに
//      あった（fiatdock の 08-14 10:10:17 の行は 2 秒後に 0x6777… から 0.01 USDC）。支払元の切り替え（0x6777… →
//      0xc9c7…）は原因ではなかった（行の payer と着金の from は全部一致）。索引に候補が無い行だけ、チェーンの
//      Transfer（from = 行の payer・to = 行の pay_to）を直接読む。読み手（readTransfers）は呼び手が渡す。
//   2. 入れ替え可能な組（chooseLinks の interchangeable_set）。同じ payer・payTo・額・窓の購入が n 行、着金が n 本で、
//      どの行の窓にもどの着金も入る（完全 2 部グラフ）なら、どれがどれかは言えないが「n 行とも課金された」は言える。
//      nonce の無い行（2026-09-04 より前）だけ、時刻順に対にして貼る（照合器は額・宛先で読み直す＝amount + payee）。
//      nonce のある行は従来どおり nonce で決める。agent-budget-guard と ai-agent-payment-safety-stack（3 秒違い・同じ
//      payTo・同額・着金 2 本）はこの形。
//   3. 売り手が名指した tx（promoteNamedTx）。PAYMENT-RESPONSE の success が false でも transaction を返した 2xx の行は
//      delivered_no_receipt のまま tx を持ち、照合器（settle_claimed と settled だけを読む）に回らなかった（wazir: 200 と
//      tx があるのに失敗の群）。売り手の申告として settle_claimed へ移し、照合器に読ませる（lateSettlement は付けない）。
// ============================================================
import { createPublicClient, http, parseAbiItem, type Address } from "viem";
import { base } from "viem/chains";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { getLogScanClient } from "@/lib/chain/client";
import { updateWithCorrection } from "@/lib/observatory/corrections";
import { logServerErrorSafe } from "@/lib/util/log-safe";

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

/** 1 回の実行で曖昧さの解消のために読むレシートの上限（RPC の呼び出し回数の上限）。 */
export const AMBIGUOUS_RECEIPTS_PER_RUN = 60;

/** tx の中で payer が消費した EIP-3009 nonce（小文字）。読めなければ null（＝貼らない）。 */
export type NonceReader = (input: { network: string; txHash: string; payer: string }) => Promise<string[] | null>;

/** チェーンから直接読んだ USDC の Transfer（blockTime は ISO8601 UTC）。 */
export type ChainTransfer = { txHash: string; from: string; to: string; value: string; blockTime: string };
/** from → to の USDC Transfer を時刻の窓で読む。対象外のチェーン・読めないときは null（＝貼らない・読んだ印も付けない）。 */
export type TransferReader = (q: {
  network: string;
  payer: string;
  payTo: string;
  from: Date;
  to: Date;
  /** この読みに使ってよい時間（ms）。読み手は RPC の timeout をこれ以下にし、再試行しない。 */
  timeoutMs?: number;
}) => Promise<ChainTransfer[] | null>;

/** 1 回の実行でチェーンを直接読む行の上限（RPC の呼び出し回数の上限）。 */
export const CHAIN_READ_ROWS_PER_RUN = 60;
/** チェーンを直接読む段の持ち時間（cron の 300 秒を他の段と分け合う）。過ぎたら残りは次回。 */
export const CHAIN_READ_BUDGET_MS = 45_000;
/** 残り時間がこれを切ったら次の組を読まない（1 回の読みに渡す timeout の下限）。 */
export const CHAIN_READ_MIN_REMAINING_MS = 3_000;
/** 着金はあったが貼れなかった行を読み直す上限の回数（読み続けて他の行を飢えさせない）。 */
export const CHAIN_READ_MAX_TRIES = 3;
/** 窓が閉じてから読む（試行の LATE_SETTLEMENT_WINDOW_MINUTES 分後 + 余裕）。 */
export const CHAIN_READ_AFTER_MINUTES = LATE_SETTLEMENT_WINDOW_MINUTES + 5;

export type LateSettlementSummary = {
  recovered: number;
  /** recovered のうち、nonce で持ち主を 1 行に決めて貼った数。 */
  recoveredByNonce: number;
  /** recovered のうち、入れ替え可能な組（索引の候補）を時刻順に対にして貼った数（2026-09-29 第4巡）。 */
  recoveredBySet?: number;
  /** recovered のうち、索引に無い着金をチェーンから直接読んで貼った数（同）。 */
  recoveredFromChain?: number;
  /** 売り手が名指した tx を照合器へ回した行の数（settle_claimed へ移した・同）。 */
  promotedNamedTx?: number;
  /** チェーンを直接読んだ行の数（貼った行と印を付けた行・0 なら読み残しは無い）。 */
  chainRowsRead?: number;
  /** 1 本の貼り付けの文が落ちた数（その 1 本は台帳も訂正ログも書かれていない・次回に再試行）。 */
  linkErrors?: number;
  /** 結びつけた (purchase_id, tx_hash) の対。cron の応答に出る。 */
  links: { purchaseId: string; txHash: string }[];
};

export async function recoverLateSettlements(
  options: { readNonces?: NonceReader; readTransfers?: TransferReader; chainReadLimit?: number; chainReadBudgetMs?: number } = {},
): Promise<LateSettlementSummary> {
  const db = getDb();
  if (!db) throw new Error("recoverLateSettlements: DATABASE_URL is not configured");

  // 1 文で解決する。候補の列挙と UPDATE を分けると、その間に別の行が同じ tx を
  // 取れてしまう（部分一意 index が弾いてくれるが、そこで throw させるより
  // 最初から 1 つに決める方がよい）。
  //   match  … 条件を満たす (purchase, settlement) の全対。tx_candidates = その tx の候補になった購入の行数
  //   chosen … 購入ごとに 1 本。候補の購入が 1 行に決まる tx だけ残す（2 行以上なら誰にも貼らない）
  const raw = await updateWithCorrection(db, {
    ...LATE_LINK_CORRECTION,
    update: sql`
    WITH match AS (
      SELECT pu.id AS purchase_id,
             pu.status AS prior_status,
             pu.tx_hash AS prior_tx_hash,
             s.tx_hash AS tx_hash,
             s.block_time AS block_time,
             row_number() OVER (PARTITION BY pu.id ORDER BY s.block_time ASC, s.tx_hash ASC) AS rn_purchase,
             count(*) OVER (PARTITION BY s.chain, lower(s.tx_hash)) AS tx_candidates
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
       -- xrpl:0 に限らず xrpl で始まる network すべてに掛ける（将来の xrpl:* が束縛を素通りしない）。
       -- 候補の行数（tx_candidates）はこの束縛の後で数えるので、XRPL は hash の合う 1 行だけが候補になる。
       AND (lower(coalesce(pu.network, '')) NOT LIKE 'xrpl%'
            OR (pu.auth_nonce IS NOT NULL AND upper(s.tx_hash) = upper(btrim(pu.auth_nonce))))
       -- 照合器が「この購入のものではない」と取り消した tx は二度と候補にしない。
       AND NOT jsonb_exists(
             coalesce(pu.raw_response_meta->'lateSettlement'->'rejectedTxHashes', '[]'::jsonb),
             lower(s.tx_hash))
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
      SELECT purchase_id, prior_status, prior_tx_hash, tx_hash FROM match WHERE rn_purchase = 1 AND tx_candidates = 1
    )
    UPDATE x402_l1_purchases pu
    SET status = 'settle_claimed',
        tx_hash = chosen.tx_hash,
        -- 回収した行は照合前。以前の照合の跡が残っていると照合器（settlement_verified IS NULL）が拾わない。
        settlement_verified = NULL,
        settlement_verified_at = NULL,
        settlement_verify_reason = NULL,
        raw_response_meta = coalesce(pu.raw_response_meta, '{}'::jsonb) || jsonb_build_object(
          'lateSettlement', jsonb_strip_nulls(jsonb_build_object(
            'source', 'settlements_index',
            'note', 'the seller settled after we recorded ' || chosen.prior_status || '; the verifier decides whether it is ours',
            -- 照合器が取り消すときの戻し先（必ず書く）と、いま貼った tx。
            'priorStatus', chosen.prior_status,
            'replacedTxHash', chosen.prior_tx_hash,
            'txHash', chosen.tx_hash,
            -- 以前の取り消しの記録は貼り直しても持ち越す。
            'rejectedTxHashes', pu.raw_response_meta->'lateSettlement'->'rejectedTxHashes',
            'linkedAt', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
          ))
        )
    FROM chosen
    WHERE pu.id = chosen.purchase_id
    RETURNING pu.id::text AS purchase_id, pu.tx_hash AS tx_hash,
              chosen.prior_status AS prior_status, chosen.prior_tx_hash AS prior_tx_hash,
              pu.id::text AS correction_subject_id
  `,
  });

  const rows: LinkedRow[] = raw.map(toLinkedRow);

  // §10 / §6.2: 状態が変わったら訂正ログに残す（公開面が「いつ何が変わったか」を言える）。
  // 2026-09-29 監査4周目: 貼り付けの UPDATE と訂正ログは同じ文（updateWithCorrection）。以前は別の文で、
  // 訂正ログの失敗を握りつぶしていた——貼ったのに記録が無い行が作れた。cron の途中打ち切りでも、
  // 貼った行には必ず訂正がある（同じ文なので片方だけにはならない）。
  const byNonce = options.readNonces ? await linkAmbiguousByNonce(db, options.readNonces) : [];
  rows.push(...byNonce);
  // 2026-09-29 第4巡（独立レビュー BLOCK）: 下の 3 段も貼り付けと訂正ログを同じ文で書く（linkOne・promoteNamedTx が
  // updateWithCorrection を通る）。1 本の貼り付けが一意 index などで落ちても、その 1 本だけを飛ばして数える（linkErrors）。
  const errors = { count: 0 };
  const bySet = await linkInterchangeableSets(db, errors);
  rows.push(...bySet);
  const chain = options.readTransfers
    ? await linkFromChain(
        db,
        options.readTransfers,
        options.chainReadLimit ?? CHAIN_READ_ROWS_PER_RUN,
        options.chainReadBudgetMs ?? CHAIN_READ_BUDGET_MS,
        errors,
      )
    : { linked: [], read: 0 };
  const fromChain = chain.linked;
  rows.push(...fromChain);
  const promoted = await promoteNamedTx(db);

  return {
    recovered: rows.length,
    recoveredByNonce: byNonce.length,
    recoveredBySet: bySet.length,
    recoveredFromChain: fromChain.length,
    promotedNamedTx: promoted.length,
    chainRowsRead: chain.read,
    linkErrors: errors.count,
    links: rows.map((r) => ({ purchaseId: r.purchase_id, txHash: r.tx_hash })),
  };
}

type Db = NonNullable<ReturnType<typeof getDb>>;
type LinkedRow = { purchase_id: string; tx_hash: string; prior_status: string; prior_tx_hash: string | null };

function rowsOfRaw<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as T[];
}

/**
 * 候補が 2 行以上ある EVM の tx を、レシートの nonce で 1 行に決めて貼る（2026-09-29）。
 *
 * 候補の条件は上の 1 文と同じ（払い元・宛先・額・窓・未使用の tx・取り消し済みでない）で、それに
 * 「EVM（eip155: か base）・auth_nonce がある」を足す。tx ごとにレシートを 1 回読み、payer が消費した nonce と
 * 一致する auth_nonce の候補が**ちょうど 1 行**なら、その行だけを貼る。0 行・2 行以上・読めないなら貼らない。
 * 貼る UPDATE は条件を読み直す（その間に別の経路が行や tx を動かしていれば何もしない）。部分一意 index
 * （同じ tx を 2 行が主張しない）も効いているので、競合しても二重には貼らない。
 */
async function linkAmbiguousByNonce(db: Db, readNonces: NonceReader): Promise<LinkedRow[]> {
  const raw = await db.execute(sql`
    WITH match AS (
      SELECT pu.id AS purchase_id,
             lower(btrim(pu.auth_nonce)) AS auth_nonce,
             pu.payer AS payer,
             pu.network AS network,
             s.chain AS chain,
             s.tx_hash AS tx_hash,
             s.block_time AS block_time,
             count(*) OVER (PARTITION BY s.chain, lower(s.tx_hash)) AS tx_candidates
      FROM x402_l1_purchases pu
      JOIN settlements s
        ON s.chain IS NOT DISTINCT FROM pu.network
       AND lower(s.payer) = lower(pu.payer)
       AND lower(s.payee) = lower(pu.pay_to)
       AND s.amount = pu.amount_units
       AND s.block_time >= pu.attempted_at - make_interval(mins => ${LATE_SETTLEMENT_BACKDATE_MINUTES}::int)
       AND s.block_time <= pu.attempted_at + make_interval(mins => ${LATE_SETTLEMENT_WINDOW_MINUTES}::int)
       AND NOT jsonb_exists(
             coalesce(pu.raw_response_meta->'lateSettlement'->'rejectedTxHashes', '[]'::jsonb),
             lower(s.tx_hash))
      WHERE pu.status IN (${sql.join(LATE_RECOVERABLE_STATUSES.map((s) => sql`${s}`), sql`, `)})
        AND (pu.tx_hash IS NULL OR pu.status = 'settle_claimed_unverifiable')
        AND pu.payer IS NOT NULL AND pu.pay_to IS NOT NULL AND pu.amount_units IS NOT NULL AND pu.attempted_at IS NOT NULL
        AND (pu.network LIKE 'eip155:%' OR pu.network = 'base')
        AND NOT EXISTS (
          SELECT 1 FROM x402_l1_purchases o
          WHERE o.tx_hash IS NOT NULL
            AND o.network IS NOT DISTINCT FROM pu.network
            AND lower(o.tx_hash) = lower(s.tx_hash)
        )
    )
    SELECT purchase_id::text AS purchase_id, auth_nonce, payer, network, tx_hash
    FROM match
    WHERE tx_candidates > 1
    ORDER BY block_time DESC, tx_hash, purchase_id`);
  const cands = rowsOfRaw<{ purchase_id: string; auth_nonce: string | null; payer: string; network: string; tx_hash: string }>(raw);

  // tx ごとに候補をまとめる（新しい tx から・上限つき）。
  const byTx = new Map<string, typeof cands>();
  for (const c of cands) {
    const k = `${c.network}|${c.tx_hash.toLowerCase()}`;
    const list = byTx.get(k) ?? [];
    list.push(c);
    byTx.set(k, list);
  }
  const chosen = new Map<string, { txHash: string }>();
  const usedPurchases = new Set<string>();
  let reads = 0;
  for (const list of byTx.values()) {
    if (reads >= AMBIGUOUS_RECEIPTS_PER_RUN) break;
    const withNonce = list.filter((c) => typeof c.auth_nonce === "string" && /^0x[0-9a-f]{64}$/.test(c.auth_nonce));
    if (withNonce.length === 0) continue;
    reads++;
    const nonces = await readNonces({ network: list[0].network, txHash: list[0].tx_hash, payer: list[0].payer }).catch(() => null);
    if (!nonces || nonces.length === 0) continue;
    const set = new Set(nonces.map((n) => n.toLowerCase()));
    const owners = withNonce.filter((c) => set.has(c.auth_nonce!));
    if (owners.length !== 1) continue;
    const owner = owners[0];
    // 1 行が 2 本の tx の持ち主になることは nonce の一意性から起きないが、起きたら両方とも貼らない。
    if (usedPurchases.has(owner.purchase_id)) {
      chosen.delete(owner.purchase_id);
      continue;
    }
    usedPurchases.add(owner.purchase_id);
    chosen.set(owner.purchase_id, { txHash: owner.tx_hash });
  }

  const linked: LinkedRow[] = [];
  for (const [purchaseId, { txHash }] of chosen) {
    const res = await updateWithCorrection(db, {
      ...LATE_LINK_CORRECTION,
      update: sql`
      WITH prior AS (
        SELECT pu.id, pu.status AS prior_status, pu.tx_hash AS prior_tx_hash
        FROM x402_l1_purchases pu
        WHERE pu.id = ${purchaseId}::uuid
          AND pu.status IN (${sql.join(LATE_RECOVERABLE_STATUSES.map((s) => sql`${s}`), sql`, `)})
          AND (pu.tx_hash IS NULL OR pu.status = 'settle_claimed_unverifiable')
          AND NOT EXISTS (
            SELECT 1 FROM x402_l1_purchases o
            WHERE o.tx_hash IS NOT NULL AND o.network IS NOT DISTINCT FROM pu.network AND lower(o.tx_hash) = lower(${txHash})
          )
        FOR UPDATE
      )
      UPDATE x402_l1_purchases pu
      SET status = 'settle_claimed',
          tx_hash = ${txHash},
          settlement_verified = NULL,
          settlement_verified_at = NULL,
          settlement_verify_reason = NULL,
          raw_response_meta = coalesce(pu.raw_response_meta, '{}'::jsonb) || jsonb_build_object(
            'lateSettlement', jsonb_strip_nulls(jsonb_build_object(
              'source', 'settlements_index',
              'note', 'the seller settled after we recorded ' || prior.prior_status || '; linked by the authorization nonce in the receipt; the verifier decides whether it is ours',
              'priorStatus', prior.prior_status,
              'replacedTxHash', prior.prior_tx_hash,
              'txHash', ${txHash}::text,
              'matchedBy', 'authorization_nonce',
              'rejectedTxHashes', pu.raw_response_meta->'lateSettlement'->'rejectedTxHashes',
              'linkedAt', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
            ))
          )
      FROM prior
      WHERE pu.id = prior.id
      RETURNING pu.id::text AS purchase_id, pu.tx_hash AS tx_hash, prior.prior_status AS prior_status, prior.prior_tx_hash AS prior_tx_hash,
                pu.id::text AS correction_subject_id`,
    });
    linked.push(...res.map(toLinkedRow));
  }
  return linked;
}

function toLinkedRow(r: Record<string, unknown>): LinkedRow {
  return {
    purchase_id: String(r.purchase_id),
    tx_hash: String(r.tx_hash),
    prior_status: String(r.prior_status),
    prior_tx_hash: r.prior_tx_hash == null ? null : String(r.prior_tx_hash),
  };
}

/**
 * 遅延回収の貼り付けの訂正（2 経路で同じ）。before / after は更新された行（changed）から組む。
 * 既存の語彙を使う（新しい reason は公開 enum・docs/openapi.yaml・src/app/docs/api/page.tsx へ波及する）。
 * 意味も合っている——「主張された決済が後からオンチェーンで確認/否定された」の入口がここ。
 */
const LATE_LINK_CORRECTION = {
  subjectType: "purchase" as const,
  level: "l1" as const,
  reason: "settlement_backfill" as const,
  before: { expr: sql`jsonb_build_object('status', changed.prior_status, 'txHash', changed.prior_tx_hash)` },
  after: { expr: sql`jsonb_build_object('status', 'settle_claimed', 'txHash', changed.tx_hash)` },
};
// ------------------------------------------------------------
// 2026-09-29 第4巡: 入れ替え可能な組・索引に無い着金・売り手が名指した tx。
// ------------------------------------------------------------

/** 購入の行と着金の候補の対（同じ payer・payTo・額で、着金が行の窓に入る）。 */
export type LinkCandidate = { purchaseId: string; attemptedAt: string; txHash: string; blockTime: string; hasNonce: boolean };
export type ChosenLink = { purchaseId: string; txHash: string; matchedBy: "unique" | "interchangeable_set" };

/**
 * 候補の対から、貼る (行, tx) を決める（純関数・推定で貼らない）。候補の対を連結成分に分け、成分ごとに:
 *   - 行が 1 つ: その行の最も早い着金（上の 1 文の rn_purchase = 1 と同じ・その着金の候補はこの行だけ）。
 *   - 行 n・着金 n で、全部の組が候補（完全 2 部グラフ）で、nonce のある行が無い: 時刻順に対にする。どの行も
 *     課金されたことは言え、どれがどれかは額・宛先の照合では区別がつかない（照合の強さは amount + payee）。
 *   - それ以外: 各行の最も早い着金が、その行だけの候補なら貼る（上の 1 文と同じ規則）。残りは貼らない。
 * 同じ tx を 2 行に貼らない・1 行に 2 本貼らない。
 */
export function chooseLinks(pairs: readonly LinkCandidate[]): ChosenLink[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  const node = (kind: "p" | "t", id: string) => {
    const k = `${kind}:${kind === "t" ? id.toLowerCase() : id}`;
    if (!parent.has(k)) parent.set(k, k);
    return k;
  };
  for (const p of pairs) {
    const a = find(node("p", p.purchaseId));
    const b = find(node("t", p.txHash));
    if (a !== b) parent.set(a, b);
  }
  const comps = new Map<string, LinkCandidate[]>();
  for (const p of pairs) {
    const root = find(node("p", p.purchaseId));
    const list = comps.get(root) ?? [];
    list.push(p);
    comps.set(root, list);
  }
  const byTime = (a: { t: string; id: string }, b: { t: string; id: string }) => a.t.localeCompare(b.t) || a.id.localeCompare(b.id);
  const out: ChosenLink[] = [];
  for (const list of comps.values()) {
    const rows = new Map<string, { t: string; id: string; nonce: boolean }>();
    const txs = new Map<string, { t: string; id: string; hash: string }>();
    const pairKeys = new Set<string>();
    for (const p of list) {
      rows.set(p.purchaseId, { t: p.attemptedAt, id: p.purchaseId, nonce: p.hasNonce });
      txs.set(p.txHash.toLowerCase(), { t: p.blockTime, id: p.txHash.toLowerCase(), hash: p.txHash });
      pairKeys.add(`${p.purchaseId}|${p.txHash.toLowerCase()}`);
    }
    const earliestTxOf = (pid: string) =>
      list
        .filter((p) => p.purchaseId === pid)
        .map((p) => ({ t: p.blockTime, id: p.txHash.toLowerCase(), hash: p.txHash }))
        .sort(byTime)[0];
    if (rows.size === 1) {
      const pid = [...rows.keys()][0];
      out.push({ purchaseId: pid, txHash: earliestTxOf(pid).hash, matchedBy: "unique" });
      continue;
    }
    const complete = rows.size === txs.size && pairKeys.size === rows.size * txs.size;
    if (complete && ![...rows.values()].some((r) => r.nonce)) {
      const rs = [...rows.values()].sort(byTime);
      const ts = [...txs.values()].sort(byTime);
      rs.forEach((r, i) => out.push({ purchaseId: r.id, txHash: ts[i].hash, matchedBy: "interchangeable_set" }));
      continue;
    }
    const candidatesOfTx = new Map<string, number>();
    for (const k of pairKeys) {
      const tx = k.split("|")[1];
      candidatesOfTx.set(tx, (candidatesOfTx.get(tx) ?? 0) + 1);
    }
    for (const pid of rows.keys()) {
      const t = earliestTxOf(pid);
      if (candidatesOfTx.get(t.id) === 1) out.push({ purchaseId: pid, txHash: t.hash, matchedBy: "unique" });
    }
  }
  return out;
}

/**
 * 1 行に 1 本を貼る（条件を読み直す・競合したら何もしない）。source と matchedBy は lateSettlement に残す。
 * 台帳の UPDATE と訂正ログは同じ文（updateWithCorrection）。文が落ちたら（一意 index など）どちらも書かれず、
 * その 1 本だけを errors に数えて空を返す（残りの貼り付けは続ける・次回に再試行）。
 */
async function linkOne(
  db: Db,
  link: { purchaseId: string; txHash: string; source: string; matchedBy: string; how: string },
  errors: { count: number },
): Promise<LinkedRow[]> {
  try {
    const res = await updateWithCorrection(db, {
      ...LATE_LINK_CORRECTION,
      update: sql`
    WITH prior AS (
      SELECT pu.id, pu.status AS prior_status, pu.tx_hash AS prior_tx_hash
      FROM x402_l1_purchases pu
      WHERE pu.id = ${link.purchaseId}::uuid
        AND pu.status IN (${sql.join(LATE_RECOVERABLE_STATUSES.map((s) => sql`${s}`), sql`, `)})
        AND (pu.tx_hash IS NULL OR pu.status = 'settle_claimed_unverifiable')
        AND NOT jsonb_exists(coalesce(pu.raw_response_meta->'lateSettlement'->'rejectedTxHashes', '[]'::jsonb), lower(${link.txHash}))
        AND NOT EXISTS (
          SELECT 1 FROM x402_l1_purchases o
          WHERE o.tx_hash IS NOT NULL AND o.network IS NOT DISTINCT FROM pu.network AND lower(o.tx_hash) = lower(${link.txHash})
        )
      FOR UPDATE
    )
    UPDATE x402_l1_purchases pu
    SET status = 'settle_claimed',
        tx_hash = ${link.txHash},
        settlement_verified = NULL,
        settlement_verified_at = NULL,
        settlement_verify_reason = NULL,
        raw_response_meta = coalesce(pu.raw_response_meta, '{}'::jsonb) || jsonb_build_object(
          'lateSettlement', jsonb_strip_nulls(jsonb_build_object(
            'source', ${link.source}::text,
            'note', 'the seller settled after we recorded ' || prior.prior_status || '; ' || ${link.how}::text || '; the verifier decides whether it is ours',
            'priorStatus', prior.prior_status,
            'replacedTxHash', prior.prior_tx_hash,
            'txHash', ${link.txHash}::text,
            'matchedBy', ${link.matchedBy}::text,
            'rejectedTxHashes', pu.raw_response_meta->'lateSettlement'->'rejectedTxHashes',
            'linkedAt', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
          ))
        )
    FROM prior
    WHERE pu.id = prior.id
    RETURNING pu.id::text AS purchase_id, pu.tx_hash AS tx_hash, prior.prior_status AS prior_status, prior.prior_tx_hash AS prior_tx_hash,
              pu.id::text AS correction_subject_id`,
    });
    return res.map(toLinkedRow);
  } catch (error) {
    errors.count++;
    logServerErrorSafe(`settlements.recover_late.link ${link.purchaseId}`, error);
    return [];
  }
}

/**
 * 索引の候補のうち、上の 1 文が「候補が 2 行以上」で貼らなかった tx を、入れ替え可能な組なら時刻順に貼る。
 * EVM・nonce の無い行だけ（nonce のある行は linkAmbiguousByNonce が決める）。
 */
async function linkInterchangeableSets(db: Db, errors: { count: number }): Promise<LinkedRow[]> {
  const raw = await db.execute(sql`
    WITH match AS (
      SELECT pu.id::text AS purchase_id,
             to_char(pu.attempted_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS attempted_at,
             (pu.auth_nonce IS NOT NULL) AS has_nonce,
             s.tx_hash AS tx_hash,
             to_char(s.block_time AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS block_time,
             count(*) OVER (PARTITION BY s.chain, lower(s.tx_hash)) AS tx_candidates
      FROM x402_l1_purchases pu
      JOIN settlements s
        ON s.chain IS NOT DISTINCT FROM pu.network
       AND lower(s.payer) = lower(pu.payer)
       AND lower(s.payee) = lower(pu.pay_to)
       AND s.amount = pu.amount_units
       AND s.block_time >= pu.attempted_at - make_interval(mins => ${LATE_SETTLEMENT_BACKDATE_MINUTES}::int)
       AND s.block_time <= pu.attempted_at + make_interval(mins => ${LATE_SETTLEMENT_WINDOW_MINUTES}::int)
       AND NOT jsonb_exists(
             coalesce(pu.raw_response_meta->'lateSettlement'->'rejectedTxHashes', '[]'::jsonb),
             lower(s.tx_hash))
      WHERE pu.status IN (${sql.join(LATE_RECOVERABLE_STATUSES.map((s) => sql`${s}`), sql`, `)})
        AND (pu.tx_hash IS NULL OR pu.status = 'settle_claimed_unverifiable')
        AND pu.payer IS NOT NULL AND pu.pay_to IS NOT NULL AND pu.amount_units IS NOT NULL AND pu.attempted_at IS NOT NULL
        AND (pu.network LIKE 'eip155:%' OR pu.network = 'base')
        AND NOT EXISTS (
          SELECT 1 FROM x402_l1_purchases o
          WHERE o.tx_hash IS NOT NULL
            AND o.network IS NOT DISTINCT FROM pu.network
            AND lower(o.tx_hash) = lower(s.tx_hash)
        )
    ), ambiguous AS (
      SELECT DISTINCT purchase_id FROM match WHERE tx_candidates > 1
    )
    SELECT m.purchase_id, m.attempted_at, m.has_nonce, m.tx_hash, m.block_time
    FROM match m
    WHERE m.purchase_id IN (SELECT purchase_id FROM ambiguous)
       OR lower(m.tx_hash) IN (SELECT lower(m2.tx_hash) FROM match m2 WHERE m2.purchase_id IN (SELECT purchase_id FROM ambiguous))`);
  const pairs: LinkCandidate[] = rowsOfRaw<{ purchase_id: string; attempted_at: string; has_nonce: boolean; tx_hash: string; block_time: string }>(raw).map(
    (r) => ({ purchaseId: r.purchase_id, attemptedAt: r.attempted_at, txHash: r.tx_hash, blockTime: r.block_time, hasNonce: r.has_nonce === true }),
  );
  const linked: LinkedRow[] = [];
  for (const c of chooseLinks(pairs)) {
    if (c.matchedBy !== "interchangeable_set") continue;
    linked.push(
      ...(await linkOne(db, {
        purchaseId: c.purchaseId,
        txHash: c.txHash,
        source: "settlements_index",
        matchedBy: "interchangeable_set",
        how: "one of an equal number of purchases and transfers with the same payer, payee and amount, paired in time order",
      }, errors)),
    );
  }
  return linked;
}

const BASE_NETWORK_KEYS = ["eip155:8453", "base"];

/**
 * 索引に候補の無い行について、チェーンの Transfer（from = 行の payer・to = 行の pay_to）を直接読んで貼る。
 * Base の行・窓が閉じた行・まだ読んでいない行（raw_response_meta.lateChainRead が無い）だけ。2xx の行を先に、
 * 新しい順に limit 行。同じ payer・payTo・額の近くの行（窓が重なる行）も同じ組として読み、chooseLinks で決める。
 * 読めた行には lateChainRead（読んだ時刻と見つけた本数）を付け、次からは読まない。読めなければ印を付けない。
 */
async function linkFromChain(
  db: Db,
  readTransfers: TransferReader,
  limit: number,
  budgetMs: number,
  errors: { count: number } = { count: 0 },
): Promise<{ linked: LinkedRow[]; read: number }> {
  const startedAt = Date.now();
  const RECOVERABLE = sql.join(LATE_RECOVERABLE_STATUSES.map((s) => sql`${s}`), sql`, `);
  const batchRaw = await db.execute(sql`
    SELECT pu.id::text AS purchase_id, pu.network, lower(pu.payer) AS payer, lower(pu.pay_to) AS pay_to, pu.amount_units,
           to_char(pu.attempted_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS attempted_at
    FROM x402_l1_purchases pu
    WHERE pu.status IN (${RECOVERABLE})
      AND (pu.tx_hash IS NULL OR pu.status = 'settle_claimed_unverifiable')
      AND pu.network IN (${sql.join(BASE_NETWORK_KEYS.map((n) => sql`${n}`), sql`, `)})
      AND pu.payer IS NOT NULL AND pu.pay_to IS NOT NULL AND pu.amount_units ~ '^[0-9]{1,30}$' AND pu.attempted_at IS NOT NULL
      AND pu.attempted_at < now() - make_interval(mins => ${CHAIN_READ_AFTER_MINUTES}::int)
      -- 読んで決まった行（着金が窓に無かった）は二度と読まない。決まらなかった行（着金はあったが貼れなかった）は
      -- CHAIN_READ_MAX_TRIES 回まで読み直す（2026-09-29 独立レビュー WARNING 2）。まだ読んでいない行が先。
      AND NOT (coalesce(pu.raw_response_meta->'lateChainRead'->>'decided', 'false') = 'true')
      AND coalesce((pu.raw_response_meta->'lateChainRead'->>'tries')::int, 0) < ${CHAIN_READ_MAX_TRIES}::int
    ORDER BY (pu.raw_response_meta ? 'lateChainRead') ASC, (pu.http_status_paid BETWEEN 200 AND 299) DESC NULLS LAST, pu.attempted_at DESC
    LIMIT ${Math.max(0, Math.trunc(limit))}`);
  type B = { purchase_id: string; network: string; payer: string; pay_to: string; amount_units: string; attempted_at: string };
  const batch = rowsOfRaw<B>(batchRaw);
  const groups = new Map<string, B[]>();
  for (const b of batch) {
    const k = `${b.network}|${b.payer}|${b.pay_to}|${b.amount_units}`;
    const list = groups.get(k) ?? [];
    list.push(b);
    groups.set(k, list);
  }
  const linked: LinkedRow[] = [];
  let read = 0;
  const winMs = LATE_SETTLEMENT_WINDOW_MINUTES * 60_000;
  const backMs = LATE_SETTLEMENT_BACKDATE_MINUTES * 60_000;
  for (const list of groups.values()) {
    // 持ち時間を過ぎたら残りは次回（読んでいない行には印を付けないので、次の実行でまた選ばれる）。
    // RPC の読みには残り時間を timeout として渡す（2026-09-29 独立レビュー WARNING 1: 以前は組と組の間でしか
    // 確かめておらず、1 回の読みが 20 秒 × 再試行 3 回まで延びうた）。
    const remaining = budgetMs - (Date.now() - startedAt);
    if (remaining < CHAIN_READ_MIN_REMAINING_MS) break;
    const g = list[0];
    const times = list.map((b) => Date.parse(b.attempted_at));
    const lo = new Date(Math.min(...times) - winMs - backMs);
    const hi = new Date(Math.max(...times) + winMs + backMs);
    // 同じ組の近くの行（窓が重なる行・読んだ印の有無を問わない）。
    const nearRaw = await db.execute(sql`
      SELECT pu.id::text AS purchase_id,
             to_char(pu.attempted_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS attempted_at,
             (pu.auth_nonce IS NOT NULL) AS has_nonce,
             coalesce(pu.raw_response_meta->'lateSettlement'->'rejectedTxHashes', '[]'::jsonb) AS rejected
      FROM x402_l1_purchases pu
      WHERE pu.status IN (${RECOVERABLE})
        AND (pu.tx_hash IS NULL OR pu.status = 'settle_claimed_unverifiable')
        AND pu.network = ${g.network} AND lower(pu.payer) = ${g.payer} AND lower(pu.pay_to) = ${g.pay_to}
        AND pu.amount_units = ${g.amount_units}
        AND pu.attempted_at BETWEEN ${lo.toISOString()}::timestamptz AND ${hi.toISOString()}::timestamptz`);
    const near = rowsOfRaw<{ purchase_id: string; attempted_at: string; has_nonce: boolean; rejected: unknown }>(nearRaw);
    const nearTimes = near.map((r) => Date.parse(r.attempted_at));
    const from = new Date(Math.min(...times, ...nearTimes) - backMs);
    const to = new Date(Math.max(...times, ...nearTimes) + winMs);
    const transfers = await withTimeout(
      readTransfers({ network: g.network, payer: g.payer, payTo: g.pay_to, from, to, timeoutMs: remaining }),
      remaining,
    ).catch(() => null);
    if (transfers === null) continue;
    read += list.length;
    const exact = transfers.filter(
      (t) => t.from.toLowerCase() === g.payer && t.to.toLowerCase() === g.pay_to && t.value === g.amount_units && Number.isFinite(Date.parse(t.blockTime)),
    );
    // 既にどれかの購入が主張している tx は候補にしない。
    let claimed = new Set<string>();
    if (exact.length > 0) {
      const hashes = JSON.stringify(exact.map((t) => t.txHash.toLowerCase()));
      const claimedRaw = await db.execute(sql`
        SELECT lower(tx_hash) AS tx FROM x402_l1_purchases
        WHERE tx_hash IS NOT NULL AND network = ${g.network}
          AND lower(tx_hash) IN (SELECT jsonb_array_elements_text(${hashes}::jsonb))`);
      claimed = new Set(rowsOfRaw<{ tx: string }>(claimedRaw).map((r) => r.tx));
    }
    const pairs: LinkCandidate[] = [];
    for (const r of near) {
      const at = Date.parse(r.attempted_at);
      const rejected = new Set(Array.isArray(r.rejected) ? (r.rejected as unknown[]).map((x) => String(x).toLowerCase()) : []);
      for (const t of exact) {
        const bt = Date.parse(t.blockTime);
        const tx = t.txHash.toLowerCase();
        if (claimed.has(tx) || rejected.has(tx)) continue;
        if (bt < at - backMs || bt > at + winMs) continue;
        pairs.push({ purchaseId: r.purchase_id, attemptedAt: r.attempted_at, txHash: t.txHash, blockTime: t.blockTime, hasNonce: r.has_nonce === true });
      }
    }
    const linkedIds = new Set<string>();
    for (const c of chooseLinks(pairs)) {
      const done = await linkOne(db, {
        purchaseId: c.purchaseId,
        txHash: c.txHash,
        source: "chain_read",
        matchedBy: c.matchedBy,
        how:
          c.matchedBy === "interchangeable_set"
            ? "read from the chain (the transfer was not in our index); one of an equal number of purchases and transfers with the same payer, payee and amount, paired in time order"
            : "read from the chain (the transfer was not in our index)",
      }, errors);
      for (const d of done) linkedIds.add(d.purchase_id);
      linked.push(...done);
    }
    // 読んだ印（貼らなかった行だけ）。2026-09-29 独立レビュー WARNING 2: 「決まった」のは、価格ちょうどの着金が
    // その行の窓に 1 本も無かった行だけ（decided: true・二度と読まない）。窓に着金はあったが貼れなかった行
    // （同じ回に隣の行が先に貼った・推定できない組・文が落ちた）は decided: false で tries を増やし、次の回で読み直す。
    const inWindow = (b: { attempted_at: string }) => {
      const at = Date.parse(b.attempted_at);
      return exact.some((t) => {
        const bt = Date.parse(t.blockTime);
        return bt >= at - backMs && bt <= at + winMs;
      });
    };
    const unlinked = list.filter((b) => !linkedIds.has(b.purchase_id));
    for (const decided of [true, false]) {
      const ids = unlinked.filter((b) => !inWindow(b) === decided).map((b) => b.purchase_id);
      if (ids.length === 0) continue;
      await db.execute(sql`
        UPDATE x402_l1_purchases
        SET raw_response_meta = coalesce(raw_response_meta, '{}'::jsonb) || jsonb_build_object('lateChainRead', jsonb_build_object(
              'at', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
              'exactTransfers', ${exact.length}::int,
              'decided', ${decided}::boolean,
              'tries', coalesce((raw_response_meta->'lateChainRead'->>'tries')::int, 0) + 1))
        WHERE id IN (SELECT (jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))::uuid)`);
    }
  }
  return { linked, read };
}

/** Promise に上限時間を付ける（読み手が timeout を守らなくても、この段の持ち時間を超えない）。 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), Math.max(0, ms));
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * 売り手が PAYMENT-RESPONSE で tx を名指したのに、success が true でなかったので delivered_no_receipt /
 * settle_failed のまま照合器（settle_claimed と settled だけを読む）に回っていない行を settle_claimed へ移す。
 * 支払い付き要求が 2xx だった行だけ（品が届いていて、決済だけが確かめられていない形・wazir 型）。
 *
 * tx は売り手の原文のまま・lateSettlement は付けない: tx を名指したのは売り手で、vet402 の索引ではない
 * （lateSettlement を付けると settlement-source.ts が「tx from our index」と書く）。照合器は普通の売り手の申告として
 * 読み直す。移した事実と元の status は raw_response_meta.namedTxPromotion に残す。
 */
async function promoteNamedTx(db: Db): Promise<LinkedRow[]> {
  const res = await updateWithCorrection(db, {
    ...LATE_LINK_CORRECTION,
    update: sql`
    WITH prior AS (
      SELECT pu.id, pu.status AS prior_status, pu.tx_hash AS prior_tx_hash
      FROM x402_l1_purchases pu
      WHERE pu.status IN ('delivered_no_receipt', 'settle_failed')
        AND pu.http_status_paid BETWEEN 200 AND 299
        AND pu.tx_hash IS NOT NULL AND pu.tx_hash <> ''
        AND pu.settlement_verified IS NULL
        AND NOT (coalesce(pu.raw_response_meta, '{}'::jsonb) ? 'namedTxPromotion')
        AND NOT EXISTS (
          SELECT 1 FROM x402_l1_purchases o
          WHERE o.id <> pu.id AND o.tx_hash IS NOT NULL AND o.network IS NOT DISTINCT FROM pu.network AND lower(o.tx_hash) = lower(pu.tx_hash)
        )
      FOR UPDATE
    )
    UPDATE x402_l1_purchases pu
    SET status = 'settle_claimed',
        settlement_verified = NULL,
        settlement_verified_at = NULL,
        settlement_verify_reason = NULL,
        raw_response_meta = coalesce(pu.raw_response_meta, '{}'::jsonb) || jsonb_build_object(
          'namedTxPromotion', jsonb_build_object(
            'priorStatus', prior.prior_status,
            'note', 'the seller named this transaction although its receipt did not say success; sent to the verifier as the seller''s claim',
            'at', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
          )
        )
    FROM prior
    WHERE pu.id = prior.id
    RETURNING pu.id::text AS purchase_id, pu.tx_hash AS tx_hash, prior.prior_status AS prior_status, prior.prior_tx_hash AS prior_tx_hash,
              pu.id::text AS correction_subject_id`,
  });
  return res.map(toLinkedRow);
}

const TRANSFER_LOG = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const BASE_USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** Base のブロック間隔（秒）。窓の端はブロック番号で広めに取り、着金の時刻はブロックを読んで決める。 */
const BASE_BLOCK_SECONDS = 2;

type TransferClient = Pick<ReturnType<typeof getLogScanClient>, "getBlock" | "getLogs">;

/**
 * Base の USDC Transfer（from → to）を時刻の窓で読む読み手（cron と一度きりの再照合が linkFromChain に渡す）。
 * Base 以外は null。時刻からブロック番号を 2 秒/ブロックで見積もり、両端に 60 ブロックの余裕を足す。
 */
export function makeBaseTransferReader(client?: TransferClient): TransferReader {
  return async ({ network, payer, payTo, from, to, timeoutMs }) => {
    if (!BASE_NETWORK_KEYS.includes(network)) return null;
    // 2026-09-29 独立レビュー WARNING 1: 時間の上限が渡されたら、その時間を timeout にして再試行しない専用の
    // クライアントで読む（既定の索引用クライアントは 1 回 20 秒・再試行 3 回）。
    const c = client ?? (typeof timeoutMs === "number" ? boundedBaseClient(timeoutMs) : getLogScanClient(8453));
    const deadline = typeof timeoutMs === "number" ? Date.now() + timeoutMs : Infinity;
    const head = await c.getBlock({ blockTag: "latest" });
    const headMs = Number(head.timestamp) * 1000;
    const blockAt = (t: Date) => head.number - BigInt(Math.ceil((headMs - t.getTime()) / (BASE_BLOCK_SECONDS * 1000)));
    const fromBlock = blockAt(from) - 60n;
    const toBlock = blockAt(to) + 60n > head.number ? head.number : blockAt(to) + 60n;
    if (fromBlock < 0n || fromBlock > toBlock) return [];
    const logs = await c.getLogs({
      address: BASE_USDC,
      event: TRANSFER_LOG,
      args: { from: payer as Address, to: payTo as Address },
      fromBlock,
      toBlock,
    });
    const times = new Map<bigint, number>();
    const out: ChainTransfer[] = [];
    for (const l of logs) {
      if (l.blockNumber === null || !l.transactionHash || typeof l.args.value !== "bigint") continue;
      if (Date.now() > deadline) throw new Error("transfer read ran past its time limit");
      if (!times.has(l.blockNumber)) times.set(l.blockNumber, Number((await c.getBlock({ blockNumber: l.blockNumber })).timestamp) * 1000);
      out.push({
        txHash: l.transactionHash,
        from: String(l.args.from),
        to: String(l.args.to),
        value: l.args.value.toString(),
        blockTime: new Date(times.get(l.blockNumber)!).toISOString(),
      });
    }
    return out;
  };
}

/** 索引と同じ RPC（INDEXER_RPC_URL → BASE_RPC_URL → 公開 RPC）を、呼び手の時間で切り・再試行しないクライアント。 */
function boundedBaseClient(timeoutMs: number): TransferClient {
  const indexer = process.env.INDEXER_RPC_URL?.trim();
  const baseRpc = process.env.BASE_RPC_URL?.trim();
  const url = (indexer && indexer.length > 0 ? indexer : null) ?? (baseRpc && baseRpc.length > 0 ? baseRpc : null) ?? "https://mainnet.base.org";
  return createPublicClient({
    chain: base,
    transport: http(url, { timeout: Math.max(1_000, Math.trunc(timeoutMs)), retryCount: 0 }),
  }) as unknown as TransferClient;
}
