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
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { updateWithCorrection } from "@/lib/observatory/corrections";

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

export type LateSettlementSummary = {
  recovered: number;
  /** recovered のうち、nonce で持ち主を 1 行に決めて貼った数。 */
  recoveredByNonce: number;
  /** 結びつけた (purchase_id, tx_hash) の対。cron の応答に出る。 */
  links: { purchaseId: string; txHash: string }[];
};

export async function recoverLateSettlements(options: { readNonces?: NonceReader } = {}): Promise<LateSettlementSummary> {
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

  return {
    recovered: rows.length,
    recoveredByNonce: byNonce.length,
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
