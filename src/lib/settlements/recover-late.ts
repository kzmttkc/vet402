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
//
// 2026-10-11（Celo レーン・本番で起きた取りこぼし）: チェーンの直読み（linkFromChain）を Celo（eip155:42220）にも通す。
//   何が起きたか: 10/11 02:30:53 UTC の agent402.tools/api/skill/ssl-audit（0.006 USDC）は、支払い付きの要求が 20 秒の
//   上限（L1_REQUEST_TIMEOUT_MS）で切れて応答なし＝ settle_failed・tx なしになった。売り手は 17 秒後（02:31:10 UTC・
//   Celo の tx 0x23421d63…2cd07a）に決済していた。お金は動いたのに、台帳は「決済に失敗」のまま直らなかった。
//   なぜ拾えなかったか: (a) 索引（index-evm）の受取先は「その chain を主ネットワークにする出品の pay_to」だけ。実際に
//   Celo で買うのは Base が先頭の出品の Celo の accept なので、その受取先への Celo の着金は索引に 1 本も入らない。
//   (b) 直読みは Base の行だけを選び（BASE_NETWORK_KEYS）、読み手（makeBaseTransferReader）も Base 以外に null を返す。
//   直し方: 直読みをレーンの表（CHAIN_READ_LANES）にし、Celo のレーンを足す。Base のレーンの選び方・貼り方・印は変えない。
//   Celo のレーンは **nonce で決める**: 対象は auth_nonce（我々が署名した EIP-3009 の nonce）が形の正しい行だけ。
//   購入元 → その行の pay_to への、額ちょうどの Celo USDC の Transfer を窓の内側で読み、候補の tx のレシートの
//   AuthorizationUsed(購入元, nonce) にその行の nonce があるときだけ貼る（額・宛先・時刻が合っても nonce が無ければ貼らない）。
//   Celo では索引の段（上の 1 文と linkAmbiguousByNonce）が働かないので、nonce の束縛をこの段が自分で持つ。貼った行は
//   Base と同じく settle_claimed（照合前）で、settled にするのは照合器（確定数・Transfer・nonce を読み直す）だけ。
//   Celo の RPC は CELO_RPC_URL 必須（無ければ読まない＝何も変えない。公開 RPC へ黙って倒れない）。Base の行
//   （2026-10-11 の公開台帳で tx の無い回収対象が 5,339 行・直読みは 1 回 20 行で新しい順）に Celo の行が埋もれない
//   よう、行の上限と持ち時間はレーンごとに持つ。
//   Arc（eip155:5042）は足していない: 同じ形の穴はあるが、Arc の Transfer の読み方（ブロック間隔・RPC の範囲の上限）を
//   実測していない。足すときは CHAIN_READ_LANES に 1 行と、その chain の読み手。
//
// 2026-10-19（BNB レーン）: 同じ形の直読みを eip155:56 にも通す。Celo のレーンの選び方・nonce の束縛・
// 行ごとの窓・応答なしを先に読む順は変えない。BNB は USD1（18 桁）なので、返す額は 6 桁（evmIndexLedgerAmount）。
// 10^12 で割り切れない額は候補にしない。RPC は BNB_RPC_URL 必須（公開 RPC へ黙って倒れない）。
// ブロック間隔は 2026-10-19 に測っていないので、窓の見積もりは Celo と同じ 1 秒を置き、ブロックの実時刻で直す。
//
// 2026-10-22（Arbitrum レーン）: 同じ形の直読みを eip155:42161 にも通す。Celo のレーンの選び方・nonce の束縛・
// 行ごとの窓・応答なしを先に読む順は変えない。トークンはネイティブ USDC。RPC は ARBITRUM_RPC_URL 必須
// （公開 RPC へ黙って倒れない）。ブロック間隔は 2026-10-22 実測 278.25 ms。窓の見積もりは 0.28 秒で、ブロックの実時刻で直す。
// 1 行の窓（≈ 6,900 ブロック）は 2,000 ブロックずつ読む（公開 RPC の eth_getLogs 上限）。
//
// 2026-10-26（Avalanche レーン）: 同じ形の直読みを eip155:43114 にも通す。Celo のレーンの選び方・nonce の束縛・
// 行ごとの窓・応答なしを先に読む順は変えない。トークンはネイティブ USDC。RPC は AVALANCHE_RPC_URL 必須
// （公開 RPC へ黙って倒れない）。ブロック間隔は 2026-10-26 実測 969.578 ms。窓の見積もりは 0.97 秒で、ブロックの実時刻で直す。
// 1 行の窓（≈ 1,980 ブロック）は 100 ブロックずつ読む（公開 RPC の eth_getLogs 上限。101 は断る）。
//
// 2026-11-03（数字の監査・結論 #1）: 台帳が settle_failed・confirmed_units 0 と書いた行のうち 15 行（$0.404）は、チェーン上で
// この購入の一回性の値つきで金が動いていた。Tempo 10（TransferWithMemo の memo = auth_nonce）・Arc 2（EIP-3009 の nonce）・
// Solana 1（spl-memo）は、有料の要求が transport で切れた（AbortError・http NULL）か 5xx で終わった行で、直読みのレーンが
// その 3 チェーンに無かった（Base の 2026-09 以外は一度も回っていなかった）。直し方:
//   - Tempo・Arc・Solana のレーンを足す。選び方・行ごとの窓・応答なしを先に読む順は Celo と同じ。貼るのは、その行の
//     一回性の値がその tx で消費されている（レシート・取引の中にある）ときだけ。
//   - Arc は EIP-3009 なので BNB と同じく **認可の状態で決める**（使われていない行だけ decided・使われた行は決めない）。
//     Celo も同じ形に変える（公開 RPC の forno はレシートを null で返すことがあり、ログの 0 件で決めると実在の着金を見落とす）。
//   - Tempo（TIP-20 の memo）と Solana（spl-memo）には「認可が使われたか」を問う関数が無い。ログ・署名一覧の 0 件を
//     1 回で「着金なし」と決めず、**別の回の 2 回の読みが両方 0 件のときだけ** decided にする（zeroReadsToDecide）。
//     読み手は chainId・先端・ブロックの実時刻を毎回確かめ、読めたと言えないときは null か例外（印を付けない）。
//   - 一回性の値の読み手（NonceReader）はチェーンで分ける: EVM は AuthorizationUsed の nonce、Tempo は TransferWithMemo の
//     memo（topics[3]）、Solana は spl-memo の文字列。どれも「我々が署名のときに作って行に残した値」と突き合わせる。
//   - 走らせる場所は cron /api/cron/recover-late-chains（index-settlements とは別の 300 秒）。index-settlements の中では
//     既存のレーンだけを走らせる（lanes オプション）。
//   Tempo の公開 RPC（rpc.tempo.xyz）の実測 2026-11-03T15:18Z: 0.561 秒/ブロック（直近 100,000 ブロック）・eth_getLogs は
//   10,000 ブロックに答えた。Arc（rpc.mainnet.arc.io）: 0.507 秒/ブロック・10,000 ブロックに答えた。どちらも 5,000 ずつ読む。
// ============================================================
import { createPublicClient, http, keccak256, parseAbiItem, toBytes, type Address } from "viem";
import { arbitrum, arc, avalanche, base, bsc, celo, tempo as tempoChain } from "viem/chains";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { getLogScanClient } from "@/lib/chain/client";
import { ARBITRUM_CAIP2, ARBITRUM_CHAIN_ID, ARBITRUM_USDC_ADDRESS } from "@/lib/chain/arbitrum";
import { ARC_CAIP2, ARC_CHAIN_ID, ARC_USDC_ADDRESS } from "@/lib/chain/arc";
import { AVALANCHE_CAIP2, AVALANCHE_CHAIN_ID, AVALANCHE_USDC_ADDRESS } from "@/lib/chain/avalanche";
import { BNB_CAIP2, BNB_CHAIN_ID, BNB_USD1_ADDRESS } from "@/lib/chain/bnb";
import { CELO_CAIP2, CELO_CHAIN_ID, CELO_USDC_ADDRESS } from "@/lib/chain/celo";
import { TEMPO_CHAIN_ID, TEMPO_MAINNET_CAIP2, TEMPO_USDC_E, tempoRpcUrl } from "@/lib/observatory/mpp-payer";
import { SOLANA_MAINNET_CAIP2, SOLANA_USDC_MINT } from "@/lib/observatory/sol402-payer";
import { usdcOwnerDelta, type SolanaTokenBalance } from "@/lib/observatory/settlement-verify-solana";
import { evmIndexLedgerAmount } from "@/lib/settlements/index-evm";
import { solanaUsdcTokenAccount } from "@/lib/settlements/index-solana";
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
 * （budget_denied・price_mismatch …・auth_nonce の無い request_error）は入れない。
 * auth_nonce のある request_error は LATE_RECOVERABLE_SIGNED_ERROR_STATUS（下）で別に足す。
 */
export const LATE_RECOVERABLE_STATUSES = ["settle_failed", "delivered_no_receipt", "settle_claimed_unverifiable"] as const;

/**
 * auth_nonce があるときだけ回収の対象にする status（2026-09-29 会計監査 7 周目・高）。
 *
 * 孤児掃除（l1-runner.ts sweepOrphanedInFlight）は、auth_nonce のある in_flight 行を今日から settle_failed へ倒す。
 * それより前に掃除された行は request_error のまま残り、上の 3 つに入っていないので回収されなかった。本番では
 * 3 行（09-06・09-17・09-18・reason = orphaned_in_flight）が、チェーン上では 3〜4 秒後に決済済み
 * （USDC の authorizationState が使用済み）なのに、公開台帳では「払っていない（export に出ない）」行のまま。
 * auth_nonce は有料の要求を出す直前に書く（l1-runner.ts purchaseOne）ので、nonce のある request_error は
 * 資格情報が売り手へ届いたかもしれない行——settle_failed と同じく生きた金。nonce の無い request_error は
 * 資格情報が外へ出ていないので従来どおり外す。照合条件・照合器の関門（nonce の束縛）は status によらず同じ。
 */
export const LATE_RECOVERABLE_SIGNED_ERROR_STATUS = "request_error" as const;

/** 照合器が遅延回収を取り消すとき（settlement-verifier.ts withdrawLateLink）に戻してよい status。 */
export const LATE_PRIOR_STATUSES = [...LATE_RECOVERABLE_STATUSES, LATE_RECOVERABLE_SIGNED_ERROR_STATUS] as const;

/** 回収の対象の行（別名 pu）。全段（索引・nonce・組・チェーン直読み・貼り付けの読み直し）で同じ条件を使う。 */
const RECOVERABLE_ROW = sql`((pu.status IN (${sql.join(LATE_RECOVERABLE_STATUSES.map((s) => sql`${s}`), sql`, `)})
  OR (pu.status = ${LATE_RECOVERABLE_SIGNED_ERROR_STATUS} AND pu.auth_nonce IS NOT NULL AND btrim(pu.auth_nonce) <> ''))
  AND coalesce(pu.raw_response_meta->>'circleGatewayRail', '') <> 'true')`;

/** 1 回の実行で曖昧さの解消のために読むレシートの上限（RPC の呼び出し回数の上限）。 */
export const AMBIGUOUS_RECEIPTS_PER_RUN = 60;

/** tx の中で payer が消費した EIP-3009 nonce（小文字）。読めなければ null（＝貼らない）。 */
export type NonceReader = (input: { network: string; txHash: string; payer: string }) => Promise<string[] | null>;

/** 認可がチェーンで使われたか。true＝使われた、false＝使われていない、null＝読めない（settlement-verify の readAuthorizationState）。 */
export type AuthorizationStateReader = (input: { network: string; payer: string; nonce: string }) => Promise<boolean | null>;

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
/**
 * Celo のレーンの持ち時間（2026-10-11）。Base の段（CHAIN_READ_BUDGET_MS）とは別に持つ——Base が持ち時間を使い切っても
 * Celo の行が読まれ、Celo の RPC が遅くても Base の段の時間を削らない。cron（index-settlements・300 秒）の中の最後の段。
 *
 * 2026-10-11 点検（中）: 15 秒では足りなかった。公開台帳のその日の Celo の未回収 6 行を forno 経由で読むと、5 行で
 * 12.8 秒かかり 6 行目に届かなかった。30 秒にする。cron の各段の持ち時間の合計は
 *   EVM の索引 120 + Solana の索引 60 + XRPL の索引 20 + Base の直読み 45 + Celo の直読み 30 = 275 秒（上限 300 秒）。
 * 持ち時間の無い段（取り込み・貼り付けの SQL・曖昧な tx のレシート読み）が先に時間を使った回でも 300 秒を越えないよう、
 * cron は締切（deadlineAt）を渡し、Celo の段はその手前で止まる（recoverLateSettlements の deadlineAt）。
 */
export const CELO_CHAIN_READ_BUDGET_MS = 30_000;
/**
 * BNB のレーンの持ち時間（2026-10-19）。Celo と同じ 30 秒を別枠で持つ。cron の締切（deadlineAt）で頭打ちにする
 * （名目の合計は 300 秒を超える。Celo のあとに走り、残りが無ければこの回は読まない）。
 */
export const BNB_CHAIN_READ_BUDGET_MS = 30_000;
/**
 * Arbitrum のレーンの持ち時間（2026-10-22）。Celo と同じ 30 秒を別枠で持つ。cron の締切（deadlineAt）で頭打ちにする
 * （名目の合計は 300 秒を超える。BNB のあとに走り、残りが無ければこの回は読まない）。
 */
export const ARBITRUM_CHAIN_READ_BUDGET_MS = 30_000;
/**
 * Avalanche のレーンの持ち時間（2026-10-26）。Celo と同じ 30 秒を別枠で持つ。cron の締切（deadlineAt）で頭打ちにする
 * （名目の合計は 300 秒を超える。Arbitrum のあとに走り、残りが無ければこの回は読まない）。
 */
export const AVALANCHE_CHAIN_READ_BUDGET_MS = 30_000;
/**
 * Tempo・Arc・Solana のレーンの持ち時間（2026-11-03）。Celo と同じ 30 秒を別枠で持つ。cron の締切（deadlineAt）で頭打ちに
 * する。本番では index-settlements ではなく /api/cron/recover-late-chains（別の 300 秒）が走らせる。
 */
export const TEMPO_CHAIN_READ_BUDGET_MS = 30_000;
export const ARC_CHAIN_READ_BUDGET_MS = 30_000;
export const SOLANA_CHAIN_READ_BUDGET_MS = 30_000;

/** 直読みのレーンの名前（lanes オプションと CHAIN_READ_LANES の key）。 */
export type ChainReadLaneKey = "base" | "celo" | "bnb" | "arbitrum" | "avalanche" | "tempo" | "arc" | "solana";

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
  /** recoveredFromChain のうち Celo のレーンで貼った数（2026-10-11・nonce で持ち主を決めた行だけ）。 */
  recoveredFromChainCelo?: number;
  /** chainRowsRead のうち Celo のレーンで読んだ行の数。 */
  chainRowsReadCelo?: number;
  /** Celo のレーンで、この回は読めなかった行の数（RPC の失敗・時間切れ。行は変えていない・次回また選ばれる）。 */
  chainRowsUnreadCelo?: number;
  /** recoveredFromChain のうち BNB のレーンで貼った数（2026-10-19・nonce で持ち主を決めた行だけ）。 */
  recoveredFromChainBnb?: number;
  /** chainRowsRead のうち BNB のレーンで読んだ行の数。 */
  chainRowsReadBnb?: number;
  /** BNB のレーンで、この回は読めなかった行の数（行は変えていない）。 */
  chainRowsUnreadBnb?: number;
  /** recoveredFromChain のうち Arbitrum のレーンで貼った数（2026-10-22・nonce で持ち主を決めた行だけ）。 */
  recoveredFromChainArbitrum?: number;
  /** chainRowsRead のうち Arbitrum のレーンで読んだ行の数。 */
  chainRowsReadArbitrum?: number;
  /** Arbitrum のレーンで、この回は読めなかった行の数（行は変えていない）。 */
  chainRowsUnreadArbitrum?: number;
  /** recoveredFromChain のうち Avalanche のレーンで貼った数（2026-10-26・nonce で持ち主を決めた行だけ）。 */
  recoveredFromChainAvalanche?: number;
  /** chainRowsRead のうち Avalanche のレーンで読んだ行の数。 */
  chainRowsReadAvalanche?: number;
  /** Avalanche のレーンで、この回は読めなかった行の数（行は変えていない）。 */
  chainRowsUnreadAvalanche?: number;
  /** recoveredFromChain のうち Tempo のレーンで貼った数（2026-11-03・memo で持ち主を決めた行だけ）。 */
  recoveredFromChainTempo?: number;
  /** chainRowsRead のうち Tempo のレーンで読んだ行の数。 */
  chainRowsReadTempo?: number;
  /** Tempo のレーンで、この回は読めなかった行の数（行は変えていない）。 */
  chainRowsUnreadTempo?: number;
  /** recoveredFromChain のうち Arc のレーンで貼った数（2026-11-03・nonce で持ち主を決めた行だけ）。 */
  recoveredFromChainArc?: number;
  /** chainRowsRead のうち Arc のレーンで読んだ行の数。 */
  chainRowsReadArc?: number;
  /** Arc のレーンで、この回は読めなかった行の数（行は変えていない）。 */
  chainRowsUnreadArc?: number;
  /** recoveredFromChain のうち Solana のレーンで貼った数（2026-11-03・memo で持ち主を決めた行だけ）。 */
  recoveredFromChainSolana?: number;
  /** chainRowsRead のうち Solana のレーンで読んだ行の数。 */
  chainRowsReadSolana?: number;
  /** Solana のレーンで、この回は読めなかった行の数（行は変えていない）。 */
  chainRowsUnreadSolana?: number;
  /** 1 本の貼り付けの文が落ちた数（その 1 本は台帳も訂正ログも書かれていない・次回に再試行）。 */
  linkErrors?: number;
  /** 結びつけた (purchase_id, tx_hash) の対。cron の応答に出る。 */
  links: { purchaseId: string; txHash: string }[];
};

export async function recoverLateSettlements(
  options: {
    readNonces?: NonceReader;
    readTransfers?: TransferReader;
    /** BNB のレーンが「着金なし」と決める根拠。無ければそのレーンは決めない（行を変えない）。 */
    readAuthorizationState?: AuthorizationStateReader;
    /** チェーンを直接読む行の上限。**レーンごと**（Base と Celo がそれぞれこの数まで）。 */
    chainReadLimit?: number;
    /** Base のレーンの持ち時間（ms）。 */
    chainReadBudgetMs?: number;
    /** Celo のレーンの持ち時間（ms）。 */
    celoChainReadBudgetMs?: number;
    /** BNB のレーンの持ち時間（ms）。 */
    bnbChainReadBudgetMs?: number;
    /** Arbitrum のレーンの持ち時間（ms）。 */
    arbitrumChainReadBudgetMs?: number;
    /** Avalanche のレーンの持ち時間（ms）。 */
    avalancheChainReadBudgetMs?: number;
    /** Tempo のレーンの持ち時間（ms）。 */
    tempoChainReadBudgetMs?: number;
    /** Arc のレーンの持ち時間（ms）。 */
    arcChainReadBudgetMs?: number;
    /** Solana のレーンの持ち時間（ms）。 */
    solanaChainReadBudgetMs?: number;
    /**
     * この回に走らせる直読みのレーン（2026-11-03）。省略は全部。index-settlements は従来の 5 本、
     * recover-late-chains は Tempo・Arc・Solana を渡す（同じレーンを 2 つの cron で二重に読まない）。
     * 索引の段（SQL だけ）と売り手の名指した tx の昇格は、lanes によらず毎回走る。
     */
    lanes?: readonly ChainReadLaneKey[];
    /**
     * 呼び手の締切（epoch ms）。Celo のレーンの持ち時間を「締切までの残り」で頭打ちにする（cron が 300 秒を越えない）。
     * Base のレーンには掛けない（従来どおり）。
     */
    deadlineAt?: number;
  } = {},
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
      WHERE ${RECOVERABLE_ROW}
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
  // チェーンの直読みのレーン（CHAIN_READ_LANES の順）。
  //   Base（2026-09-29）: Transfer の読み手だけで走る。持ち時間は chainReadBudgetMs（締切は掛けない・従来どおり）。
  //   それ以外（Celo 2026-10-11・BNB 10-19・Arbitrum 10-22・Avalanche 10-26・Tempo / Arc / Solana 11-03）: nonce で決めるので、
  //   Transfer の読み手と nonce の読み手の両方が渡されたときだけ走る（片方でも無ければその行は選びもしない＝印も付けない）。
  //   行の上限は Base と同じ数を**レーンごとに別枠で**持ち、持ち時間はレーンごとの既定（30 秒）を締切までの残りで頭打ちにする
  //   （前のレーンが先に使う。残りが無ければこの回は読まない）。
  //   lanes を渡した呼び手は、その表に無いレーンを走らせない（2026-11-03・2 つの cron で同じレーンを二重に読まない）。
  const laneBudgets: Record<ChainReadLaneKey, number> = {
    base: options.chainReadBudgetMs ?? CHAIN_READ_BUDGET_MS,
    celo: options.celoChainReadBudgetMs ?? CELO_CHAIN_READ_BUDGET_MS,
    bnb: options.bnbChainReadBudgetMs ?? BNB_CHAIN_READ_BUDGET_MS,
    arbitrum: options.arbitrumChainReadBudgetMs ?? ARBITRUM_CHAIN_READ_BUDGET_MS,
    avalanche: options.avalancheChainReadBudgetMs ?? AVALANCHE_CHAIN_READ_BUDGET_MS,
    tempo: options.tempoChainReadBudgetMs ?? TEMPO_CHAIN_READ_BUDGET_MS,
    arc: options.arcChainReadBudgetMs ?? ARC_CHAIN_READ_BUDGET_MS,
    solana: options.solanaChainReadBudgetMs ?? SOLANA_CHAIN_READ_BUDGET_MS,
  };
  const wanted = options.lanes ? new Set<ChainReadLaneKey>(options.lanes) : null;
  const none = { linked: [] as LinkedRow[], read: 0, unread: 0 };
  const byLane = {} as Record<ChainReadLaneKey, { linked: LinkedRow[]; read: number; unread: number }>;
  for (const lane of CHAIN_READ_LANES) {
    const runs = (wanted === null || wanted.has(lane.key)) && options.readTransfers && (!lane.nonceBound || options.readNonces);
    if (!runs) {
      byLane[lane.key] = none;
      continue;
    }
    const budgetMs =
      lane.key === "base"
        ? laneBudgets.base
        : Math.min(laneBudgets[lane.key], typeof options.deadlineAt === "number" ? options.deadlineAt - Date.now() : Infinity);
    byLane[lane.key] = await linkFromChain(
      db,
      lane,
      options.readTransfers!,
      options.chainReadLimit ?? CHAIN_READ_ROWS_PER_RUN,
      budgetMs,
      errors,
      lane.nonceBound ? options.readNonces : undefined,
      lane.decidesByAuthorizationState ? options.readAuthorizationState : undefined,
    );
  }
  const fromChain = CHAIN_READ_LANES.flatMap((l) => byLane[l.key].linked);
  rows.push(...fromChain);
  const promoted = await promoteNamedTx(db);

  return {
    recovered: rows.length,
    recoveredByNonce: byNonce.length,
    recoveredBySet: bySet.length,
    recoveredFromChain: fromChain.length,
    promotedNamedTx: promoted.length,
    chainRowsRead: CHAIN_READ_LANES.reduce((n, l) => n + byLane[l.key].read, 0),
    recoveredFromChainCelo: byLane.celo.linked.length,
    chainRowsReadCelo: byLane.celo.read,
    chainRowsUnreadCelo: byLane.celo.unread,
    recoveredFromChainBnb: byLane.bnb.linked.length,
    chainRowsReadBnb: byLane.bnb.read,
    chainRowsUnreadBnb: byLane.bnb.unread,
    recoveredFromChainArbitrum: byLane.arbitrum.linked.length,
    chainRowsReadArbitrum: byLane.arbitrum.read,
    chainRowsUnreadArbitrum: byLane.arbitrum.unread,
    recoveredFromChainAvalanche: byLane.avalanche.linked.length,
    chainRowsReadAvalanche: byLane.avalanche.read,
    chainRowsUnreadAvalanche: byLane.avalanche.unread,
    recoveredFromChainTempo: byLane.tempo.linked.length,
    chainRowsReadTempo: byLane.tempo.read,
    chainRowsUnreadTempo: byLane.tempo.unread,
    recoveredFromChainArc: byLane.arc.linked.length,
    chainRowsReadArc: byLane.arc.read,
    chainRowsUnreadArc: byLane.arc.unread,
    recoveredFromChainSolana: byLane.solana.linked.length,
    chainRowsReadSolana: byLane.solana.read,
    chainRowsUnreadSolana: byLane.solana.unread,
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
      WHERE ${RECOVERABLE_ROW}
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
          AND ${RECOVERABLE_ROW}
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
        AND ${RECOVERABLE_ROW}
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
      WHERE ${RECOVERABLE_ROW}
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

/** 我々が署名した EIP-3009 の nonce の形（0x + 64 桁の 16 進）。Celo のレーンはこの形の auth_nonce を持つ行だけを扱う。 */
const EVM_AUTH_NONCE_RE = /^0x[0-9a-f]{64}$/;

/**
 * チェーンを直接読む段のレーン（2026-10-11）。行の上限と持ち時間はレーンごと（呼び手が渡す）。
 *   networks   このレーンが選ぶ購入行の network。
 *   nonceBound true なら、形の正しい auth_nonce を持つ行だけを選び、候補の tx のレシートの AuthorizationUsed に
 *              その行の nonce があるときだけ貼る（chooseLinks の「候補が 1 本なら貼る」を使わない）。
 *   noAnswerFirst true なら、未読の行の中で「支払いを送って応答が無かった行」（http_status_paid が NULL）を先頭に、
 *              402 が返った行（売り手が受け取っていない見込みが高い）を最後に読む。
 *   rowWindows true なら、同じ払い元・宛先・額の行でも、窓（2 分前〜30 分後）が重ならない行は別の組として読む。
 *              読めなかった組はログに 1 行残す（Base は従来どおり 1 つの組として端から端まで読み、ログは出さない）。
 * 2026-10-11 点検（中 2 件）: noAnswerFirst と rowWindows は Celo だけ true。Base の並び・読む範囲・持ち時間は変えていない。
 * Base は従来どおり（nonceBound: false）: 2026-09-04 より前の nonce の無い行も対象で、nonce の束縛は照合器が見る。
 * Celo は nonceBound: true: レーンの開始（2026-10-10）から全行が nonce を持ち、索引の段（nonce で曖昧さを解く
 * linkAmbiguousByNonce）が Celo の受取先を持たないので、この段が nonce で決める。
 */
type ChainReadLane = {
  key: ChainReadLaneKey;
  networks: readonly string[];
  nonceBound: boolean;
  noAnswerFirst: boolean;
  rowWindows: boolean;
  /**
   * 行を、ログの結果ではなく認可の状態で決める（2026-11-02・BNB。2026-11-03 から Celo・Arc も）。ログを読む前に状態を読む。
   * 使われていない → decided: true でログを読まない。使われた → decided: false の印（tries は増やさない）で未読の後ろへ回し、
   * ログを読んで貼る。読めない → 行を変えず、ログだけ読む。ログの 0 件や失敗は根拠にしない。
   */
  decidesByAuthorizationState?: boolean;
  /**
   * 一回性の値（auth_nonce）の形（2026-11-03）。省略は EIP-3009 の nonce（0x + 64 桁の 16 進・Tempo の memo も同じ形）。
   * Solana の memo は 0x 無しの 32 桁（sol402-payer.ts の randomBytes(16).hex）。SQL（~）と JS（RegExp）の両方で使うので、
   * 両方で同じ意味になる書き方にする。
   */
  nonceShape?: string;
  /**
   * 認可の状態を問えないチェーン（Tempo・Solana）で、「着金なし」と決めるのに要る 0 件の読みの回数（2026-11-03）。
   * 省略は 1（1 回の読みで決める・Base / Arbitrum / Avalanche の従来どおり）。2 なら、別の回の 2 回の読みが両方 0 件で
   * 初めて decided: true（1 回目は decided: false・tries 1・zeroReads 1 で、次の回にまた読む）。
   */
  zeroReadsToDecide?: number;
};
const BASE_CHAIN_READ_LANE: ChainReadLane = { key: "base", networks: BASE_NETWORK_KEYS, nonceBound: false, noAnswerFirst: false, rowWindows: false };
// 2026-11-03: Celo も認可の状態で決める（BNB と同じ）。数字の監査で、公開 RPC の forno が settled の tx 12/30 のレシートを null で
// 返した。ログの 0 件で決めると実在の着金を見落とすので、EIP-3009 の authorizationState を根拠にする（CELO_RPC_URL 必須）。
const CELO_CHAIN_READ_LANE: ChainReadLane = { key: "celo", networks: [CELO_CAIP2], nonceBound: true, noAnswerFirst: true, rowWindows: true, decidesByAuthorizationState: true };
// 2026-11-02 実測: 本番の BNB_RPC_URL（PublicNode）は USD1 の eth_getLogs に、同じ範囲で 406 件と 0 件を返し分ける
// （約 7 日以内の 2,000 ブロック・24 回中 21 回が 0 件）。それより古い範囲は断る。ログの 0 件で決めると、実在の着金を
// 永久に見落とすので、このレーンは認可の状態で決める。認可は最長 120 秒で、行はこの段に来た時点で 35 分以上前なので、
// 使われていなければ、この先も使われない。
const BNB_CHAIN_READ_LANE: ChainReadLane = { key: "bnb", networks: [BNB_CAIP2], nonceBound: true, noAnswerFirst: true, rowWindows: true, decidesByAuthorizationState: true };
const ARBITRUM_CHAIN_READ_LANE: ChainReadLane = { key: "arbitrum", networks: [ARBITRUM_CAIP2], nonceBound: true, noAnswerFirst: true, rowWindows: true };
const AVALANCHE_CHAIN_READ_LANE: ChainReadLane = { key: "avalanche", networks: [AVALANCHE_CAIP2], nonceBound: true, noAnswerFirst: true, rowWindows: true };
// 2026-11-03（数字の監査・結論 #1）: Tempo の購入は TIP-20 の transferWithMemo で、memo（bytes32）を auth_nonce に残している。
// 貼るのは、候補の tx のレシートの TransferWithMemo（払い元 → 宛先）の memo が行の auth_nonce と一致するときだけ。
// 「memo が使われたか」を問う関数は無いので、0 件の読みは 2 回で決める。
const TEMPO_CHAIN_READ_LANE: ChainReadLane = { key: "tempo", networks: [TEMPO_MAINNET_CAIP2], nonceBound: true, noAnswerFirst: true, rowWindows: true, zeroReadsToDecide: 2 };
// 2026-11-03: Arc は EIP-3009（USDC 0x3600…0000）。Celo・BNB と同じく認可の状態で決める（ARC_RPC_URL 必須）。
const ARC_CHAIN_READ_LANE: ChainReadLane = { key: "arc", networks: [ARC_CAIP2], nonceBound: true, noAnswerFirst: true, rowWindows: true, decidesByAuthorizationState: true };
// 2026-11-03: Solana の購入は spl-memo に我々の memo（randomBytes(16).hex・32 桁）を載せ、auth_nonce に残している。
// 貼るのは、候補の取引の memo 命令に行の auth_nonce があるときだけ。認可の状態は無いので、0 件の読みは 2 回で決める。
const SOLANA_CHAIN_READ_LANE: ChainReadLane = {
  key: "solana",
  networks: [SOLANA_MAINNET_CAIP2],
  nonceBound: true,
  noAnswerFirst: true,
  rowWindows: true,
  nonceShape: "^[0-9a-f]{32}$",
  zeroReadsToDecide: 2,
};
/** 直読みのレーンの表（テストと点検が読む）。走る順もこの順。 */
export const CHAIN_READ_LANES: readonly ChainReadLane[] = [
  BASE_CHAIN_READ_LANE,
  CELO_CHAIN_READ_LANE,
  BNB_CHAIN_READ_LANE,
  ARBITRUM_CHAIN_READ_LANE,
  AVALANCHE_CHAIN_READ_LANE,
  TEMPO_CHAIN_READ_LANE,
  ARC_CHAIN_READ_LANE,
  SOLANA_CHAIN_READ_LANE,
];

/** レーンの一回性の値の形（SQL の ~ と JS の RegExp で同じ意味）。 */
function nonceShapeOf(lane: ChainReadLane): { sql: string; re: RegExp } {
  const source = lane.nonceShape ?? EVM_AUTH_NONCE_RE.source;
  return { sql: source, re: new RegExp(source) };
}

/**
 * 索引に候補の無い行について、チェーンの Transfer（from = 行の payer・to = 行の pay_to）を直接読んで貼る。
 * レーンの network の行・窓が閉じた行・まだ読んでいない行（raw_response_meta.lateChainRead が無い）だけ。2xx の行を先に、
 * 新しい順に limit 行。同じ payer・payTo・額の近くの行（窓が重なる行）も同じ組として読み、chooseLinks で決める
 * （nonceBound のレーンは chooseLinks ではなく nonce で決める・linksByNonce）。
 * 読めた行には lateChainRead（読んだ時刻と見つけた本数）を付け、次からは読まない。読めなければ印を付けない。
 */
async function linkFromChain(
  db: Db,
  lane: ChainReadLane,
  readTransfers: TransferReader,
  limit: number,
  budgetMs: number,
  errors: { count: number } = { count: 0 },
  readNonces?: NonceReader,
  readAuthorizationState?: AuthorizationStateReader,
): Promise<{ linked: LinkedRow[]; read: number; unread: number }> {
  // nonce で決めるレーンは、nonce の読み手が無ければ何もしない（行を選ばない＝印も付けない）。
  if (lane.nonceBound && !readNonces) return { linked: [], read: 0, unread: 0 };
  const startedAt = Date.now();
  const shape = nonceShapeOf(lane);
  const zeroReadsToDecide = Math.max(1, Math.trunc(lane.zeroReadsToDecide ?? 1));
  // 2026-10-11 点検（中 1）: Celo のレーンの並び。応答なしの行（支払いは送った・答えを受け取っていない＝売り手が後で
  // 決済していれば台帳だけが食い違う行）が、新しい 402 の行の後ろに並んで持ち時間の外へ押し出されていた。
  const laneOrder = lane.noAnswerFirst
    ? sql`(CASE WHEN pu.http_status_paid IS NULL THEN 0 WHEN pu.http_status_paid = 402 THEN 2 ELSE 1 END) ASC,`
    : sql``;
  const batchRaw = await db.execute(sql`
    SELECT pu.id::text AS purchase_id, pu.network, lower(pu.payer) AS payer, lower(pu.pay_to) AS pay_to, pu.amount_units,
           -- 2026-11-03: 読み手には行の表記のまま渡す（Solana の base58 は大文字小文字で別の鍵。小文字化した値から口座は導けない）。
           -- 組の鍵・突き合わせは従来どおり小文字で行う。
           btrim(pu.payer) AS payer_exact, btrim(pu.pay_to) AS pay_to_exact,
           lower(btrim(pu.auth_nonce)) AS auth_nonce,
           to_char(pu.attempted_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS attempted_at
    FROM x402_l1_purchases pu
    WHERE ${RECOVERABLE_ROW}
      AND (pu.tx_hash IS NULL OR pu.status = 'settle_claimed_unverifiable')
      AND pu.network IN (${sql.join(lane.networks.map((n) => sql`${n}`), sql`, `)})
      -- nonce で決めるレーン（Celo …）: 何に署名したかが行に残っている購入だけ（そのレーンの一回性の値の形・nonceShapeOf）。
      AND (${lane.nonceBound}::boolean IS NOT TRUE OR lower(btrim(coalesce(pu.auth_nonce, ''))) ~ ${shape.sql}::text)
      AND pu.payer IS NOT NULL AND pu.pay_to IS NOT NULL AND pu.amount_units ~ '^[0-9]{1,30}$' AND pu.attempted_at IS NOT NULL
      AND pu.attempted_at < now() - make_interval(mins => ${CHAIN_READ_AFTER_MINUTES}::int)
      -- 読んで決まった行（着金が窓に無かった）は二度と読まない。決まらなかった行（着金はあったが貼れなかった）は
      -- CHAIN_READ_MAX_TRIES 回まで読み直す（2026-09-29 独立レビュー WARNING 2）。まだ読んでいない行が先。
      AND NOT (coalesce(pu.raw_response_meta->'lateChainRead'->>'decided', 'false') = 'true')
      AND coalesce((pu.raw_response_meta->'lateChainRead'->>'tries')::int, 0) < ${CHAIN_READ_MAX_TRIES}::int
    -- 2026-09-29: 払った後に結果の書き込みが落ちた行（threw_after_reservation・outcomeWriteFailed・孤児掃除の orphaned_in_flight）を 2xx と同じ先頭の群に
    -- 置く。資格情報を送ったのに結果を失った行で、http_status_paid が NULL のまま残る——以前の DESC NULLS LAST は NULL を
    -- 「2xx でない」群のさらに後ろ（数千行の古い残りの後ろ）へ回し、索引に着金が無ければ一度も読まれなかった。
    -- http_status_paid が NULL の行は「2xx でない」群の中で時刻順に並ぶ（coalesce）。raw_response_meta が NULL の行も「未読」の群に入れる。
    ORDER BY coalesce(pu.raw_response_meta ? 'lateChainRead', false) ASC,
             ${laneOrder}
             (coalesce(pu.http_status_paid BETWEEN 200 AND 299, false)
               OR coalesce(pu.raw_response_meta->>'reason', '') IN ('threw_after_reservation', 'orphaned_in_flight')
               OR coalesce(pu.raw_response_meta ? 'outcomeWriteFailed', false)) DESC,
             pu.attempted_at DESC
    LIMIT ${Math.max(0, Math.trunc(limit))}`);
  type B = {
    purchase_id: string;
    network: string;
    payer: string;
    pay_to: string;
    payer_exact: string;
    pay_to_exact: string;
    amount_units: string;
    auth_nonce: string | null;
    attempted_at: string;
  };
  const batch = rowsOfRaw<B>(batchRaw);
  const winMs = LATE_SETTLEMENT_WINDOW_MINUTES * 60_000;
  const backMs = LATE_SETTLEMENT_BACKDATE_MINUTES * 60_000;
  const keyOf = (b: B) => `${b.network}|${b.payer}|${b.pay_to}|${b.amount_units}`;
  // 2026-10-11 点検（中 2）: 同じ払い元・宛先・額の未読の行が 1 日以上離れていると、1 つの組として端から端まで
  // （24 時間ぶんのブロック）を読みに行き、持ち時間で切れて、次回も同じ組から始まっていた。rowWindows のレーンでは、
  // 窓が重ならない行（試行の間隔が 窓 + 遡り より長い）を別の組に分ける——着金が両方の行の候補になることは無い。
  // 組を読むたびに印か貼り付けが残るので、途中で時間が切れても、読めた組のぶんは次回やり直さない。
  const windowIndex = new Map<string, number>();
  if (lane.rowWindows) {
    const byKey = new Map<string, B[]>();
    for (const b of batch) byKey.set(keyOf(b), [...(byKey.get(keyOf(b)) ?? []), b]);
    for (const rows of byKey.values()) {
      let idx = 0;
      let prev: number | null = null;
      for (const r of [...rows].sort((a, b) => Date.parse(a.attempted_at) - Date.parse(b.attempted_at))) {
        const t = Date.parse(r.attempted_at);
        if (prev !== null && t - prev > winMs + backMs) idx++;
        windowIndex.set(r.purchase_id, idx);
        prev = t;
      }
    }
  }
  const groups = new Map<string, B[]>();
  for (const b of batch) {
    const k = lane.rowWindows ? `${keyOf(b)}|${windowIndex.get(b.purchase_id) ?? 0}` : keyOf(b);
    const list = groups.get(k) ?? [];
    list.push(b);
    groups.set(k, list);
  }
  const linked: LinkedRow[] = [];
  let read = 0;
  // 読めなかった組（理由ごとに組と行を数える）。rowWindows のレーンだけ、最後に理由ごとに 1 行ログに出す。
  const unread = new Map<string, { groups: number; rows: number; error: unknown }>();
  const noteUnread = (reason: string, rows: number, error?: unknown) => {
    const u = unread.get(reason) ?? { groups: 0, rows: 0, error };
    unread.set(reason, { groups: u.groups + 1, rows: u.rows + rows, error: u.error ?? error });
  };
  for (const group of groups.values()) {
    let list = group;
    if (lane.decidesByAuthorizationState) {
      const unspent: string[] = [];
      const spent: string[] = [];
      const undecided: B[] = [];
      for (const b of group) {
        const left = budgetMs - (Date.now() - startedAt);
        const state =
          readAuthorizationState && b.auth_nonce && left >= CHAIN_READ_MIN_REMAINING_MS
            ? await withTimeout(readAuthorizationState({ network: b.network, payer: b.payer, nonce: b.auth_nonce }), left).catch(() => null)
            : null;
        if (state === false) {
          unspent.push(b.purchase_id);
          continue;
        }
        if (state === true) spent.push(b.purchase_id);
        undecided.push(b);
      }
      for (const [ids, decided] of [
        [unspent, true],
        [spent, false],
      ] as const) {
        if (ids.length === 0) continue;
        await db.execute(sql`
          UPDATE x402_l1_purchases
          SET raw_response_meta = coalesce(raw_response_meta, '{}'::jsonb) || jsonb_build_object('lateChainRead', jsonb_build_object(
                'at', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'decided', ${decided}::boolean,
                'by', 'authorization_state',
                'tries', coalesce((raw_response_meta->'lateChainRead'->>'tries')::int, 0)))
          WHERE id IN (SELECT (jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))::uuid)`);
      }
      read += unspent.length;
      if (undecided.length === 0) continue;
      list = undecided;
    }
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
             lower(btrim(pu.auth_nonce)) AS auth_nonce,
             coalesce(pu.raw_response_meta->'lateSettlement'->'rejectedTxHashes', '[]'::jsonb) AS rejected
      FROM x402_l1_purchases pu
      WHERE ${RECOVERABLE_ROW}
        AND (pu.tx_hash IS NULL OR pu.status = 'settle_claimed_unverifiable')
        AND pu.network = ${g.network} AND lower(pu.payer) = ${g.payer} AND lower(pu.pay_to) = ${g.pay_to}
        AND pu.amount_units = ${g.amount_units}
        AND pu.attempted_at BETWEEN ${lo.toISOString()}::timestamptz AND ${hi.toISOString()}::timestamptz`);
    const near = rowsOfRaw<{ purchase_id: string; attempted_at: string; has_nonce: boolean; auth_nonce: string | null; rejected: unknown }>(nearRaw);
    const nearTimes = near.map((r) => Date.parse(r.attempted_at));
    const from = new Date(Math.min(...times, ...nearTimes) - backMs);
    const to = new Date(Math.max(...times, ...nearTimes) + winMs);
    let readFailure: unknown = null;
    const transfers = await withTimeout(
      readTransfers({ network: g.network, payer: g.payer_exact, payTo: g.pay_to_exact, from, to, timeoutMs: remaining }),
      remaining,
    ).catch((error: unknown) => {
      readFailure = error ?? new Error("the transfer read failed");
      return null;
    });
    if (transfers === null) {
      if (readFailure === null) noteUnread("the transfer reader could not read (no RPC url set, an RPC on another chain id, or a node behind the window)", list.length);
      else if (isTimeout(readFailure)) noteUnread("the transfer read ran out of time", list.length);
      else noteUnread("the transfer read failed", list.length, readFailure);
      continue;
    }
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
    // 貼る (行, tx) を決める。nonce で決めるレーン（Celo）は、候補の tx のレシートを読めなければこの組を丸ごと
    // 次回へ回す（貼らない・印も付けない＝何も変えない）。
    let links: { purchaseId: string; txHash: string; matchedBy: string; how: string }[];
    if (lane.nonceBound) {
      const byNonce = await linksByNonce(
        pairs,
        new Map(near.map((r) => [r.purchase_id, r.auth_nonce])),
        { network: g.network, payer: g.payer },
        readNonces!,
        () => budgetMs - (Date.now() - startedAt),
        shape.re,
      );
      if ("unreadable" in byNonce) {
        noteUnread(byNonce.unreadable, list.length);
        continue;
      }
      links = byNonce.links.map((l) => ({
        ...l,
        matchedBy: "authorization_nonce",
        how: "read from the chain (the transfer was not in our index); linked by the authorization nonce in the receipt",
      }));
    } else {
      links = chooseLinks(pairs).map((c) => ({
        purchaseId: c.purchaseId,
        txHash: c.txHash,
        matchedBy: c.matchedBy,
        how:
          c.matchedBy === "interchangeable_set"
            ? "read from the chain (the transfer was not in our index); one of an equal number of purchases and transfers with the same payer, payee and amount, paired in time order"
            : "read from the chain (the transfer was not in our index)",
      }));
    }
    read += list.length;
    const linkedIds = new Set<string>();
    for (const c of links) {
      const done = await linkOne(db, { purchaseId: c.purchaseId, txHash: c.txHash, source: "chain_read", matchedBy: c.matchedBy, how: c.how }, errors);
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
    if (lane.decidesByAuthorizationState) {
      if (unlinked.length > 0) {
        read -= unlinked.length;
        noteUnread("the authorization was used or unreadable and no transfer was linked", unlinked.length);
      }
      continue;
    }
    // 2026-11-03: 認可の状態を問えないレーン（Tempo・Solana）は、0 件の読みを zeroReadsToDecide 回（別の回）重ねて初めて
    // 「決まった」にする。1 回目は decided: false・zeroReads 1 で次の回にまた読む（tries の上限の内側）。
    for (const noTransfer of [true, false]) {
      const ids = unlinked.filter((b) => !inWindow(b) === noTransfer).map((b) => b.purchase_id);
      if (ids.length === 0) continue;
      await db.execute(sql`
        UPDATE x402_l1_purchases
        SET raw_response_meta = coalesce(raw_response_meta, '{}'::jsonb) || jsonb_build_object('lateChainRead', jsonb_build_object(
              'at', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
              'exactTransfers', ${exact.length}::int,
              'decided', (${noTransfer}::boolean
                          AND coalesce((raw_response_meta->'lateChainRead'->>'zeroReads')::int, 0) + 1 >= ${zeroReadsToDecide}::int),
              'zeroReads', coalesce((raw_response_meta->'lateChainRead'->>'zeroReads')::int, 0) + (CASE WHEN ${noTransfer}::boolean THEN 1 ELSE 0 END),
              'tries', coalesce((raw_response_meta->'lateChainRead'->>'tries')::int, 0) + 1))
        WHERE id IN (SELECT (jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))::uuid)`);
    }
  }
  // 読めなかった組は何も変えていない（次回また選ばれる）。黙って持ち越さず、理由ごとに 1 行残す。URL は
  // logServerErrorSafe が伏せる（RPC の誤りの本文には鍵入りの URL が入る）。
  let unreadRows = 0;
  for (const [reason, u] of unread) {
    unreadRows += u.rows;
    if (!lane.rowWindows) continue;
    const cause = u.error instanceof Error ? `: ${u.error.message}` : u.error != null ? `: ${String(u.error)}` : "";
    logServerErrorSafe(
      `settlements.recover_late.chain_read_unread ${lane.key}`,
      new Error(`${u.groups} group(s), ${u.rows} row(s) left unchanged for the next run — ${reason}${cause}`),
    );
  }
  return { linked, read, unread: unreadRows };
}

/** withTimeout が切った読みか（理由をログで「時間切れ」と分ける）。 */
function isTimeout(error: unknown): boolean {
  return error instanceof Error && /^timed out after /.test(error.message);
}

/**
 * nonce で決めるレーン（Celo）の貼り先（2026-10-11）。候補の対（払い元・宛先・額・窓が合い、まだ誰も主張していない tx）の
 * それぞれの tx について、レシートの AuthorizationUsed(払い元, nonce) を読み、**その行の auth_nonce がその tx で
 * 消費されているときだけ**貼る。額・宛先・時刻が合うだけの tx（nonce が別・未使用）は貼らない。
 *   - 読めない tx が 1 本でもあれば unreadable（呼び手はこの組を次回へ回す。貼らない・印も付けない）。持ち時間切れも同じ。
 *   - nonce は 1 回しか消費できないので、1 行の持ち主の tx は高々 1 本。2 本以上に見えたら（RPC の誤り）貼らない。
 *   - 同じ tx を 2 行が持ち主だと言うなら（auth_nonce の重複）どちらにも貼らない。
 */
async function linksByNonce(
  pairs: readonly LinkCandidate[],
  nonceOf: ReadonlyMap<string, string | null>,
  group: { network: string; payer: string },
  readNonces: NonceReader,
  remainingMs: () => number,
  nonceShape: RegExp = EVM_AUTH_NONCE_RE,
): Promise<{ links: { purchaseId: string; txHash: string }[] } | { unreadable: string }> {
  const consumed = new Map<string, Set<string>>();
  for (const p of pairs) {
    const tx = p.txHash.toLowerCase();
    if (consumed.has(tx)) continue;
    const remaining = remainingMs();
    if (remaining < CHAIN_READ_MIN_REMAINING_MS) return { unreadable: "out of time before the receipts were read" };
    const nonces = await withTimeout(readNonces({ network: group.network, txHash: p.txHash, payer: group.payer }), remaining).catch(() => null);
    if (nonces === null) return { unreadable: "a candidate transaction's receipt could not be read" };
    consumed.set(tx, new Set(nonces.map((n) => n.toLowerCase())));
  }
  const ownersOfTx = new Map<string, Set<string>>();
  const txsOfRow = new Map<string, Map<string, string>>();
  for (const p of pairs) {
    const nonce = nonceOf.get(p.purchaseId);
    if (typeof nonce !== "string" || !nonceShape.test(nonce)) continue;
    const tx = p.txHash.toLowerCase();
    if (!consumed.get(tx)?.has(nonce)) continue;
    ownersOfTx.set(tx, (ownersOfTx.get(tx) ?? new Set<string>()).add(p.purchaseId));
    txsOfRow.set(p.purchaseId, (txsOfRow.get(p.purchaseId) ?? new Map<string, string>()).set(tx, p.txHash));
  }
  const out: { purchaseId: string; txHash: string }[] = [];
  for (const [purchaseId, txs] of txsOfRow) {
    if (txs.size !== 1) continue;
    const [tx, txHash] = [...txs.entries()][0];
    if (ownersOfTx.get(tx)?.size !== 1) continue;
    out.push({ purchaseId, txHash });
  }
  return { links: out };
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

/** Celo のブロック間隔（秒）。2026-10-10 実測（chain/celo.ts）: forno の直近 86,400 ブロックの時刻差がちょうど 86,400 秒。 */
const CELO_BLOCK_SECONDS = 1;
/**
 * Celo の eth_getLogs を 1 回で問うブロック数。索引の既定（GET_LOGS_CHUNK_BLOCKS 2,000）と同じ。2026-10-11 実測: forno は
 * 5,000 ブロックまで答え、10,000 は断る（max block range 5000）。1 行の窓（2 分前〜30 分後 ≈ 1,920 ブロック + 余裕）は 1 回で読める。
 */
export const CELO_TRANSFER_READ_CHUNK_BLOCKS = 2_000n;
/** 時刻からブロック番号を見積もったあと、そのブロックの実際の時刻とのずれをここまで許す（秒）。超えたら見積もり直す。 */
const CELO_BLOCK_LOCATE_TOLERANCE_SECONDS = 30;
/**
 * 窓の両端に足す余裕（ブロック）。CELO_BLOCK_LOCATE_TOLERANCE_SECONDS（30）より広く取る。35 にしてあるのは、1 行の窓
 * （2 分前〜30 分後 = 1,920 ブロック）+ 両端の余裕 70 + 1 = 1,991 ブロックが 1 回の問い（2,000）に収まるから（60 だと 2 回）。
 */
const CELO_TRANSFER_READ_MARGIN_BLOCKS = 35n;

type CeloTransferClient = Pick<ReturnType<typeof getLogScanClient>, "getBlock" | "getLogs" | "getChainId">;

/**
 * Celo の USDC（0xcebA…118C）の Transfer（from → to）を時刻の窓で読む読み手（2026-10-11・linkFromChain の Celo のレーン）。
 * Celo 以外の network は null。**読めたと言えないときは必ず null か例外**（呼び手は貼らず、印も付けない）:
 *   - CELO_RPC_URL が無い（公開 RPC へ黙って倒れない。決済の再読・索引と同じ規律）
 *   - RPC が chainId 42220 を名乗らない（別のチェーンの空の結果を「着金なし」と読まない）
 *   - RPC の先端が窓の終わりに届いていない（遅れているノードの空の結果を「着金なし」と読まない）
 *   - 時刻 → ブロック番号の見積もりが、ブロックの実際の時刻と合わない（読む範囲が窓を外している）
 * 空の配列（[]）を返すのは、窓を読み切って Transfer が無かったときだけ——呼び手はそれを「決まった」と印す。
 * トークンは固定（CELO_USDC_ADDRESS）。別のトークンの同名のイベントは読まない。
 */
export function makeCeloTransferReader(client?: CeloTransferClient): TransferReader {
  return async ({ network, payer, payTo, from, to, timeoutMs }) => {
    if (network !== CELO_CAIP2) return null;
    const c = client ?? boundedCeloClient(timeoutMs);
    if (!c) return null;
    const deadline = typeof timeoutMs === "number" ? Date.now() + timeoutMs : Infinity;
    const expired = () => {
      if (Date.now() > deadline) throw new Error("transfer read ran past its time limit");
    };
    // chainId と先端は同時に問う（1 行あたりの往復を減らす。2026-10-11 点検: 1 行 2.5 秒かかっていた）。
    const [chainId, head] = await Promise.all([c.getChainId(), c.getBlock({ blockTag: "latest" })]);
    if (chainId !== CELO_CHAIN_ID) return null;
    const headMs = Number(head.timestamp) * 1000;
    if (headMs < to.getTime()) return null;
    // 時刻 → ブロック番号。1 秒/ブロックで見積もり、そのブロックの実際の時刻で確かめて直す（最大 3 回）。
    const locate = async (t: Date): Promise<bigint> => {
      let n = head.number - BigInt(Math.max(0, Math.ceil((headMs - t.getTime()) / (CELO_BLOCK_SECONDS * 1000))));
      for (let i = 0; i < 3; i++) {
        expired();
        if (n < 0n) n = 0n;
        if (n > head.number) n = head.number;
        const block = await c.getBlock({ blockNumber: n });
        const driftSeconds = Math.round((Number(block.timestamp) * 1000 - t.getTime()) / 1000);
        if (Math.abs(driftSeconds) <= CELO_BLOCK_LOCATE_TOLERANCE_SECONDS) return n;
        // 先端・起点に張り付いたまま合わないなら、これ以上は直せない。
        if ((n === 0n && driftSeconds > 0) || (n === head.number && driftSeconds < 0)) break;
        n -= BigInt(Math.trunc(driftSeconds / CELO_BLOCK_SECONDS));
      }
      throw new Error("could not locate the Celo block for the window");
    };
    const [fromAt, toAt] = await Promise.all([locate(from), locate(to)]);
    const first = fromAt - CELO_TRANSFER_READ_MARGIN_BLOCKS;
    const last = toAt + CELO_TRANSFER_READ_MARGIN_BLOCKS;
    const fromBlock = first < 0n ? 0n : first;
    const toBlock = last > head.number ? head.number : last;
    if (fromBlock > toBlock) throw new Error("empty Celo block range for the window");
    const times = new Map<bigint, number>();
    const out: ChainTransfer[] = [];
    for (let lo = fromBlock; lo <= toBlock; lo += CELO_TRANSFER_READ_CHUNK_BLOCKS) {
      expired();
      const hi = lo + CELO_TRANSFER_READ_CHUNK_BLOCKS - 1n < toBlock ? lo + CELO_TRANSFER_READ_CHUNK_BLOCKS - 1n : toBlock;
      const logs = await c.getLogs({
        address: CELO_USDC_ADDRESS,
        event: TRANSFER_LOG,
        args: { from: payer as Address, to: payTo as Address },
        fromBlock: lo,
        toBlock: hi,
      });
      for (const l of logs) {
        // 形の欠けた log を黙って捨てると「着金なし」と読める。読めなかったことにする。
        if (l.blockNumber === null || !l.transactionHash || typeof l.args.value !== "bigint") {
          throw new Error("a Celo transfer log came back without a block, a hash or a value");
        }
        expired();
        if (!times.has(l.blockNumber)) times.set(l.blockNumber, Number((await c.getBlock({ blockNumber: l.blockNumber })).timestamp) * 1000);
        out.push({
          txHash: l.transactionHash,
          from: String(l.args.from),
          to: String(l.args.to),
          value: l.args.value.toString(),
          blockTime: new Date(times.get(l.blockNumber)!).toISOString(),
        });
      }
    }
    return out;
  };
}

/** CELO_RPC_URL を、呼び手の時間で切り・再試行しないクライアント。CELO_RPC_URL が無ければ null（公開 RPC を使わない）。 */
function boundedCeloClient(timeoutMs: number | undefined): CeloTransferClient | null {
  const url = process.env.CELO_RPC_URL?.trim();
  if (!url) return null;
  return createPublicClient({
    chain: celo as unknown as typeof base,
    transport: http(url, { timeout: Math.max(1_000, Math.trunc(timeoutMs ?? 20_000)), retryCount: 0 }),
  }) as unknown as CeloTransferClient;
}

/**
 * BNB のブロック間隔（秒）。2026-11-02 実測: 直近 1,000,000 ブロックの時刻差から 0.4502 秒。
 * それまでの 1 秒は 3 回の補正で許容 30 秒に届かず、窓のブロックを特定できなかった。補正は読んだブロックと先端の実の間隔で
 * 行う。窓と先端の間で間隔が変わると特定できないことがあり、そのときは例外になる（行は変えない）。
 */
const BNB_BLOCK_SECONDS = 0.45;
/** Celo の読み手と同じ幅。BSC の eth_getLogs の上限は 2026-10-19 に測っていないので、それより広い範囲は問わない。 */
export const BNB_TRANSFER_READ_CHUNK_BLOCKS = 2_000n;
const BNB_BLOCK_LOCATE_TOLERANCE_SECONDS = 30;
// 余裕は許容 30 秒より広く取る。0.45 秒間隔で 200 ブロックは 90 秒。
const BNB_TRANSFER_READ_MARGIN_BLOCKS = 200n;

type BnbTransferClient = Pick<ReturnType<typeof getLogScanClient>, "getBlock" | "getLogs" | "getChainId">;

/**
 * BNB の USD1 の Transfer（from → to）を時刻の窓で読む読み手（2026-10-19・linkFromChain の BNB のレーン）。
 * 規則は makeCeloTransferReader と同じ。違いはトークンと額だけ: チェーン上の額は 18 桁で、返す value は
 * 6 桁（evmIndexLedgerAmount）。10^12 で割り切れない額は配列に入れない（記録しない）。
 * BNB 以外の network は null。BNB_RPC_URL が無い・chainId が 56 でない・先端が窓に届いていない・
 * 時刻からブロックを特定できないときは null か例外。空配列は「RPC が 0 件と答えた」だけで、着金が無いことを意味しない
 * （BNB_CHAIN_READ_LANE の注記）。
 */
export function makeBnbTransferReader(client?: BnbTransferClient): TransferReader {
  return async ({ network, payer, payTo, from, to, timeoutMs }) => {
    if (network !== BNB_CAIP2) return null;
    const c = client ?? boundedBnbClient(timeoutMs);
    if (!c) return null;
    const deadline = typeof timeoutMs === "number" ? Date.now() + timeoutMs : Infinity;
    const expired = () => {
      if (Date.now() > deadline) throw new Error("transfer read ran past its time limit");
    };
    const [chainId, head] = await Promise.all([c.getChainId(), c.getBlock({ blockTag: "latest" })]);
    if (chainId !== BNB_CHAIN_ID) return null;
    const headMs = Number(head.timestamp) * 1000;
    if (headMs < to.getTime()) return null;
    const locate = async (t: Date): Promise<bigint> => {
      let n = head.number - BigInt(Math.max(0, Math.ceil((headMs - t.getTime()) / (BNB_BLOCK_SECONDS * 1000))));
      for (let i = 0; i < 3; i++) {
        expired();
        if (n < 0n) n = 0n;
        if (n > head.number) n = head.number;
        const block = await c.getBlock({ blockNumber: n });
        const driftSeconds = Math.round((Number(block.timestamp) * 1000 - t.getTime()) / 1000);
        if (Math.abs(driftSeconds) <= BNB_BLOCK_LOCATE_TOLERANCE_SECONDS) return n;
        if ((n === 0n && driftSeconds > 0) || (n === head.number && driftSeconds < 0)) break;
        const blocksBack = Number(head.number - n);
        const observed = blocksBack > 0 ? (Number(head.timestamp) - Number(block.timestamp)) / blocksBack : 0;
        n -= BigInt(Math.trunc(driftSeconds / (observed > 0 ? observed : BNB_BLOCK_SECONDS)));
      }
      throw new Error("could not locate the BNB block for the window");
    };
    const [fromAt, toAt] = await Promise.all([locate(from), locate(to)]);
    const first = fromAt - BNB_TRANSFER_READ_MARGIN_BLOCKS;
    const last = toAt + BNB_TRANSFER_READ_MARGIN_BLOCKS;
    const fromBlock = first < 0n ? 0n : first;
    const toBlock = last > head.number ? head.number : last;
    if (fromBlock > toBlock) throw new Error("empty BNB block range for the window");
    const times = new Map<bigint, number>();
    const out: ChainTransfer[] = [];
    for (let lo = fromBlock; lo <= toBlock; lo += BNB_TRANSFER_READ_CHUNK_BLOCKS) {
      expired();
      const hi = lo + BNB_TRANSFER_READ_CHUNK_BLOCKS - 1n < toBlock ? lo + BNB_TRANSFER_READ_CHUNK_BLOCKS - 1n : toBlock;
      const logs = await c.getLogs({
        address: BNB_USD1_ADDRESS,
        event: TRANSFER_LOG,
        args: { from: payer as Address, to: payTo as Address },
        fromBlock: lo,
        toBlock: hi,
      });
      for (const l of logs) {
        if (l.blockNumber === null || !l.transactionHash || typeof l.args.value !== "bigint") {
          throw new Error("a BNB transfer log came back without a block, a hash or a value");
        }
        const booked = evmIndexLedgerAmount(BNB_CHAIN_ID, l.args.value);
        if (booked === null) continue;
        expired();
        if (!times.has(l.blockNumber)) times.set(l.blockNumber, Number((await c.getBlock({ blockNumber: l.blockNumber })).timestamp) * 1000);
        out.push({
          txHash: l.transactionHash,
          from: String(l.args.from),
          to: String(l.args.to),
          value: booked.toString(),
          blockTime: new Date(times.get(l.blockNumber)!).toISOString(),
        });
      }
    }
    return out;
  };
}

/** BNB_RPC_URL を、呼び手の時間で切り・再試行しないクライアント。BNB_RPC_URL が無ければ null（公開 RPC を使わない）。 */
function boundedBnbClient(timeoutMs: number | undefined): BnbTransferClient | null {
  const url = process.env.BNB_RPC_URL?.trim();
  if (!url) return null;
  return createPublicClient({
    chain: bsc as unknown as typeof base,
    transport: http(url, { timeout: Math.max(1_000, Math.trunc(timeoutMs ?? 20_000)), retryCount: 0 }),
  }) as unknown as BnbTransferClient;
}

/**
 * Arbitrum のブロック間隔（秒）。2026-10-22T11:16:31Z 実測（https://arb1.arbitrum.io/rpc）:
 * 直近 345,600 ブロックの時刻差 96,162 秒 → 278.25 ms。0.28 で見積もり、ブロックの実時刻で直す。
 */
const ARBITRUM_BLOCK_SECONDS = 0.28;
/**
 * Arbitrum の eth_getLogs を 1 回で問うブロック数。2026-10-22 実測: 公開 RPC はネイティブ USDC の Transfer を
 * 2,000 ブロックで答え（7,313 件）、5,000 ブロックは "Missing or invalid parameters"（10,000 件のログ上限）で断る。
 * 1 行の窓（2 分前〜30 分後 ≈ 1,920 秒 / 0.28 ≈ 6,900 ブロック + 余裕）は 4 回に割る。
 */
export const ARBITRUM_TRANSFER_READ_CHUNK_BLOCKS = 2_000n;
const ARBITRUM_BLOCK_LOCATE_TOLERANCE_SECONDS = 30;
// 余裕は見積もりの許容（30 秒 ≈ 108 ブロック）より広く取る。Celo の「余裕は許容より広く」と同じ規則（2026-10-22 審査）。
const ARBITRUM_TRANSFER_READ_MARGIN_BLOCKS = 120n;

type ArbitrumTransferClient = Pick<ReturnType<typeof getLogScanClient>, "getBlock" | "getLogs" | "getChainId">;

/**
 * Arbitrum のネイティブ USDC（0xaf88…5831）の Transfer（from → to）を時刻の窓で読む読み手（2026-10-22・linkFromChain の Arbitrum のレーン）。
 * 規則は makeCeloTransferReader と同じ。トークンはネイティブ USDC だけ（USDC.e は読まない）。
 * Arbitrum 以外の network は null。**読めたと言えないときは必ず null か例外**（呼び手は貼らず、印も付けない）:
 *   - ARBITRUM_RPC_URL が無い（公開 RPC へ黙って倒れない。決済の再読・索引と同じ規律）
 *   - RPC が chainId 42161 を名乗らない（別のチェーンの空の結果を「着金なし」と読まない）
 *   - RPC の先端が窓の終わりに届いていない（遅れているノードの空の結果を「着金なし」と読まない）
 *   - 時刻 → ブロック番号の見積もりが、ブロックの実際の時刻と合わない（読む範囲が窓を外している）
 * 空の配列（[]）を返すのは、窓を読み切って Transfer が無かったときだけ——呼び手はそれを「決まった」と印す。
 */
export function makeArbitrumTransferReader(client?: ArbitrumTransferClient): TransferReader {
  return async ({ network, payer, payTo, from, to, timeoutMs }) => {
    if (network !== ARBITRUM_CAIP2) return null;
    const c = client ?? boundedArbitrumClient(timeoutMs);
    if (!c) return null;
    const deadline = typeof timeoutMs === "number" ? Date.now() + timeoutMs : Infinity;
    const expired = () => {
      if (Date.now() > deadline) throw new Error("transfer read ran past its time limit");
    };
    const [chainId, head] = await Promise.all([c.getChainId(), c.getBlock({ blockTag: "latest" })]);
    if (chainId !== ARBITRUM_CHAIN_ID) return null;
    const headMs = Number(head.timestamp) * 1000;
    if (headMs < to.getTime()) return null;
    const locate = async (t: Date): Promise<bigint> => {
      let n = head.number - BigInt(Math.max(0, Math.ceil((headMs - t.getTime()) / (ARBITRUM_BLOCK_SECONDS * 1000))));
      for (let i = 0; i < 3; i++) {
        expired();
        if (n < 0n) n = 0n;
        if (n > head.number) n = head.number;
        const block = await c.getBlock({ blockNumber: n });
        const driftSeconds = Math.round((Number(block.timestamp) * 1000 - t.getTime()) / 1000);
        if (Math.abs(driftSeconds) <= ARBITRUM_BLOCK_LOCATE_TOLERANCE_SECONDS) return n;
        if ((n === 0n && driftSeconds > 0) || (n === head.number && driftSeconds < 0)) break;
        n -= BigInt(Math.trunc(driftSeconds / ARBITRUM_BLOCK_SECONDS));
      }
      throw new Error("could not locate the Arbitrum block for the window");
    };
    const [fromAt, toAt] = await Promise.all([locate(from), locate(to)]);
    const first = fromAt - ARBITRUM_TRANSFER_READ_MARGIN_BLOCKS;
    const last = toAt + ARBITRUM_TRANSFER_READ_MARGIN_BLOCKS;
    const fromBlock = first < 0n ? 0n : first;
    const toBlock = last > head.number ? head.number : last;
    if (fromBlock > toBlock) throw new Error("empty Arbitrum block range for the window");
    const times = new Map<bigint, number>();
    const out: ChainTransfer[] = [];
    for (let lo = fromBlock; lo <= toBlock; lo += ARBITRUM_TRANSFER_READ_CHUNK_BLOCKS) {
      expired();
      const hi = lo + ARBITRUM_TRANSFER_READ_CHUNK_BLOCKS - 1n < toBlock ? lo + ARBITRUM_TRANSFER_READ_CHUNK_BLOCKS - 1n : toBlock;
      const logs = await c.getLogs({
        address: ARBITRUM_USDC_ADDRESS,
        event: TRANSFER_LOG,
        args: { from: payer as Address, to: payTo as Address },
        fromBlock: lo,
        toBlock: hi,
      });
      for (const l of logs) {
        if (l.blockNumber === null || !l.transactionHash || typeof l.args.value !== "bigint") {
          throw new Error("an Arbitrum transfer log came back without a block, a hash or a value");
        }
        expired();
        if (!times.has(l.blockNumber)) times.set(l.blockNumber, Number((await c.getBlock({ blockNumber: l.blockNumber })).timestamp) * 1000);
        out.push({
          txHash: l.transactionHash,
          from: String(l.args.from),
          to: String(l.args.to),
          value: l.args.value.toString(),
          blockTime: new Date(times.get(l.blockNumber)!).toISOString(),
        });
      }
    }
    return out;
  };
}

/** ARBITRUM_RPC_URL を、呼び手の時間で切り・再試行しないクライアント。ARBITRUM_RPC_URL が無ければ null（公開 RPC を使わない）。 */
function boundedArbitrumClient(timeoutMs: number | undefined): ArbitrumTransferClient | null {
  const url = process.env.ARBITRUM_RPC_URL?.trim();
  if (!url) return null;
  return createPublicClient({
    chain: arbitrum as unknown as typeof base,
    transport: http(url, { timeout: Math.max(1_000, Math.trunc(timeoutMs ?? 20_000)), retryCount: 0 }),
  }) as unknown as ArbitrumTransferClient;
}

/**
 * Avalanche のブロック間隔（秒）。2026-10-26T10:42:23.389Z 実測（https://api.avax.network/ext/bc/C/rpc）:
 * ヘッド 98596954 と 172,800 ブロック前の時刻差 167,543 秒 → 969.578 ms。0.97 で見積もり、ブロックの実時刻で直す。
 */
const AVALANCHE_BLOCK_SECONDS = 0.97;
/**
 * Avalanche の eth_getLogs を 1 回で問う包含ブロック数。2026-10-26T10:43:41.960Z 実測（ヘッド 98597030）:
 * 包含 100 ブロックは答え、101 ブロックは -32602「maximum of 100 blocks」で断る。絞り込みでも上限は上がらない。
 * 1 行の窓（2 分前〜30 分後 ≈ 1,920 秒 / 0.97 ≈ 1,980 ブロック + 余裕）は 100 ブロックずつに割る。
 */
export const AVALANCHE_TRANSFER_READ_CHUNK_BLOCKS = 100n;
const AVALANCHE_BLOCK_LOCATE_TOLERANCE_SECONDS = 30;
// 余裕は許容 30 秒より広く取る。2026-10-26 の実測でブロック間隔は 0.75〜1.43 秒。
// 40 ブロックは 0.75 秒間隔だと 30 秒ちょうどで、見積もりが速い側にずれると窓を外す。
// 80 ブロックは 0.75 秒でも 60 秒、1.43 秒でも 30 秒を超える。Arbitrum の「余裕は許容より広く」と同じ規則。
const AVALANCHE_TRANSFER_READ_MARGIN_BLOCKS = 80n;

type AvalancheTransferClient = Pick<ReturnType<typeof getLogScanClient>, "getBlock" | "getLogs" | "getChainId">;

/**
 * Avalanche のネイティブ USDC（0xB97E…8a6E）の Transfer（from → to）を時刻の窓で読む読み手（2026-10-26・linkFromChain の Avalanche のレーン）。
 * 規則は makeArbitrumTransferReader と同じ。トークンはネイティブ USDC だけ（USDC.e は読まない）。
 * Avalanche 以外の network は null。**読めたと言えないときは必ず null か例外**（呼び手は貼らず、印も付けない）:
 *   - AVALANCHE_RPC_URL が無い（公開 RPC へ黙って倒れない。決済の再読・索引と同じ規律）
 *   - RPC が chainId 43114 を名乗らない（別のチェーンの空の結果を「着金なし」と読まない）
 *   - RPC の先端が窓の終わりに届いていない（遅れているノードの空の結果を「着金なし」と読まない）
 *   - 時刻 → ブロック番号の見積もりが、ブロックの実際の時刻と合わない（読む範囲が窓を外している）
 * 空の配列（[]）を返すのは、窓を読み切って Transfer が無かったときだけ——呼び手はそれを「決まった」と印す。
 */
export function makeAvalancheTransferReader(client?: AvalancheTransferClient): TransferReader {
  return async ({ network, payer, payTo, from, to, timeoutMs }) => {
    if (network !== AVALANCHE_CAIP2) return null;
    const c = client ?? boundedAvalancheClient(timeoutMs);
    if (!c) return null;
    const deadline = typeof timeoutMs === "number" ? Date.now() + timeoutMs : Infinity;
    const expired = () => {
      if (Date.now() > deadline) throw new Error("transfer read ran past its time limit");
    };
    const [chainId, head] = await Promise.all([c.getChainId(), c.getBlock({ blockTag: "latest" })]);
    if (chainId !== AVALANCHE_CHAIN_ID) return null;
    const headMs = Number(head.timestamp) * 1000;
    if (headMs < to.getTime()) return null;
    const locate = async (t: Date): Promise<bigint> => {
      let n = head.number - BigInt(Math.max(0, Math.ceil((headMs - t.getTime()) / (AVALANCHE_BLOCK_SECONDS * 1000))));
      for (let i = 0; i < 3; i++) {
        expired();
        if (n < 0n) n = 0n;
        if (n > head.number) n = head.number;
        const block = await c.getBlock({ blockNumber: n });
        const driftSeconds = Math.round((Number(block.timestamp) * 1000 - t.getTime()) / 1000);
        if (Math.abs(driftSeconds) <= AVALANCHE_BLOCK_LOCATE_TOLERANCE_SECONDS) return n;
        if ((n === 0n && driftSeconds > 0) || (n === head.number && driftSeconds < 0)) break;
        n -= BigInt(Math.trunc(driftSeconds / AVALANCHE_BLOCK_SECONDS));
      }
      throw new Error("could not locate the Avalanche block for the window");
    };
    const [fromAt, toAt] = await Promise.all([locate(from), locate(to)]);
    const first = fromAt - AVALANCHE_TRANSFER_READ_MARGIN_BLOCKS;
    const last = toAt + AVALANCHE_TRANSFER_READ_MARGIN_BLOCKS;
    const fromBlock = first < 0n ? 0n : first;
    const toBlock = last > head.number ? head.number : last;
    if (fromBlock > toBlock) throw new Error("empty Avalanche block range for the window");
    const times = new Map<bigint, number>();
    const out: ChainTransfer[] = [];
    for (let lo = fromBlock; lo <= toBlock; lo += AVALANCHE_TRANSFER_READ_CHUNK_BLOCKS) {
      expired();
      const hi = lo + AVALANCHE_TRANSFER_READ_CHUNK_BLOCKS - 1n < toBlock ? lo + AVALANCHE_TRANSFER_READ_CHUNK_BLOCKS - 1n : toBlock;
      const logs = await c.getLogs({
        address: AVALANCHE_USDC_ADDRESS,
        event: TRANSFER_LOG,
        args: { from: payer as Address, to: payTo as Address },
        fromBlock: lo,
        toBlock: hi,
      });
      for (const l of logs) {
        if (l.blockNumber === null || !l.transactionHash || typeof l.args.value !== "bigint") {
          throw new Error("an Avalanche transfer log came back without a block, a hash or a value");
        }
        expired();
        if (!times.has(l.blockNumber)) times.set(l.blockNumber, Number((await c.getBlock({ blockNumber: l.blockNumber })).timestamp) * 1000);
        out.push({
          txHash: l.transactionHash,
          from: String(l.args.from),
          to: String(l.args.to),
          value: l.args.value.toString(),
          blockTime: new Date(times.get(l.blockNumber)!).toISOString(),
        });
      }
    }
    return out;
  };
}

/** AVALANCHE_RPC_URL を、呼び手の時間で切り・再試行しないクライアント。AVALANCHE_RPC_URL が無ければ null（公開 RPC を使わない）。 */
function boundedAvalancheClient(timeoutMs: number | undefined): AvalancheTransferClient | null {
  const url = process.env.AVALANCHE_RPC_URL?.trim();
  if (!url) return null;
  return createPublicClient({
    chain: avalanche as unknown as typeof base,
    transport: http(url, { timeout: Math.max(1_000, Math.trunc(timeoutMs ?? 20_000)), retryCount: 0 }),
  }) as unknown as AvalancheTransferClient;
}

/**
 * 一回性の値の読み手を network で分ける（2026-11-03）。EVM（Base / Arc / Celo / BNB / Arbitrum / Avalanche）はレシートの
 * AuthorizationUsed の nonce（呼び手が settlement-verify.ts の readAuthorizationNonces を渡す）、Tempo はレシートの
 * TransferWithMemo の memo、Solana は取引の spl-memo。渡されなかった種類の network は null（＝読めない・貼らない）。
 */
export function makeChainNonceReader(readers: { evm?: NonceReader; tempo?: NonceReader; solana?: NonceReader } = {}): NonceReader {
  const tempoReader = readers.tempo ?? makeTempoMemoReader();
  const solanaReader = readers.solana ?? makeSolanaMemoReader();
  return (q) =>
    q.network === TEMPO_MAINNET_CAIP2
      ? tempoReader(q)
      : q.network === SOLANA_MAINNET_CAIP2
        ? solanaReader(q)
        : readers.evm
          ? readers.evm(q)
          : Promise.resolve(null);
}

/**
 * cron が linkFromChain に渡す読み手（2026-10-11、BNB は 2026-10-19、Arbitrum は 2026-10-22、Avalanche は 2026-10-26、
 * Tempo / Arc / Solana は 2026-11-03）: network ごとの読み手へ振り分け、それ以外は Base
 * （Base の読み手は Base 以外の network に null を返す＝従来どおり読まない）。
 */
export function makeChainTransferReader(
  readers: {
    base?: TransferReader;
    celo?: TransferReader;
    bnb?: TransferReader;
    arbitrum?: TransferReader;
    avalanche?: TransferReader;
    tempo?: TransferReader;
    arc?: TransferReader;
    solana?: TransferReader;
  } = {},
): TransferReader {
  const baseReader = readers.base ?? makeBaseTransferReader();
  const byNetwork: Record<string, TransferReader> = {
    [CELO_CAIP2]: readers.celo ?? makeCeloTransferReader(),
    [BNB_CAIP2]: readers.bnb ?? makeBnbTransferReader(),
    [ARBITRUM_CAIP2]: readers.arbitrum ?? makeArbitrumTransferReader(),
    [AVALANCHE_CAIP2]: readers.avalanche ?? makeAvalancheTransferReader(),
    [TEMPO_MAINNET_CAIP2]: readers.tempo ?? makeTempoTransferReader(),
    [ARC_CAIP2]: readers.arc ?? makeArcTransferReader(),
    [SOLANA_MAINNET_CAIP2]: readers.solana ?? makeSolanaTransferReader(),
  };
  return (q) => (byNetwork[q.network] ?? baseReader)(q);
}

// ------------------------------------------------------------
// 2026-11-03: Tempo・Arc・Solana の読み手（数字の監査・結論 #1）。
// ------------------------------------------------------------

/** TIP-20 TransferWithMemo（settlement-verify-tempo.ts と同じ宣言。memo は indexed・topics[3]）。 */
const TEMPO_TRANSFER_WITH_MEMO_LOG = parseAbiItem("event TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 indexed memo)");
/**
 * Tempo のブロック間隔（秒）。2026-11-03T15:18Z 実測（https://rpc.tempo.xyz）: ヘッド 47,252,884 と 100,000 ブロック前の時刻差から
 * 0.561 秒。0.56 で見積もり、読んだブロックと先端の実の間隔で直す（BNB の読み手と同じ）。
 */
const TEMPO_BLOCK_SECONDS = 0.56;
/** 2026-11-03 実測: rpc.tempo.xyz は USDC.e のログを 10,000 ブロックで答えた（5,000 は 3.4 秒）。1 行の窓（≈ 3,430 ブロック）は 1 回で読む。 */
export const TEMPO_TRANSFER_READ_CHUNK_BLOCKS = 5_000n;
const TEMPO_BLOCK_LOCATE_TOLERANCE_SECONDS = 30;
// 余裕は許容 30 秒より広く取る。0.56 秒間隔で 120 ブロックは 67 秒。
const TEMPO_TRANSFER_READ_MARGIN_BLOCKS = 120n;

type TempoTransferClient = Pick<ReturnType<typeof getLogScanClient>, "getBlock" | "getLogs" | "getChainId">;

/**
 * Tempo の USDC.e（0x20C0…8b50）の TransferWithMemo（from → to）を時刻の窓で読む読み手（2026-11-03・linkFromChain の Tempo のレーン）。
 * 規則は makeCeloTransferReader と同じ: Tempo 以外の network は null、TEMPO_RPC_URL が無ければ null（公開 RPC へ黙って倒れない）、
 * chainId が 4217 でない・先端が窓に届いていない・ブロックを特定できないときは null か例外。空配列は「窓を読み切って無かった」。
 * 読むのは TransferWithMemo だけ: 我々の購入は MPP の transferWithMemo で、memo（auth_nonce）の無い Transfer は持ち主を決められない。
 */
export function makeTempoTransferReader(client?: TempoTransferClient): TransferReader {
  return async ({ network, payer, payTo, from, to, timeoutMs }) => {
    if (network !== TEMPO_MAINNET_CAIP2) return null;
    const c = client ?? boundedTempoClient(timeoutMs);
    if (!c) return null;
    const deadline = typeof timeoutMs === "number" ? Date.now() + timeoutMs : Infinity;
    const expired = () => {
      if (Date.now() > deadline) throw new Error("transfer read ran past its time limit");
    };
    const [chainId, head] = await Promise.all([c.getChainId(), c.getBlock({ blockTag: "latest" })]);
    if (chainId !== TEMPO_CHAIN_ID) return null;
    const headMs = Number(head.timestamp) * 1000;
    if (headMs < to.getTime()) return null;
    const [fromAt, toAt] = await Promise.all([
      locateEvmBlock(c, head, from, TEMPO_BLOCK_SECONDS, TEMPO_BLOCK_LOCATE_TOLERANCE_SECONDS, expired, "Tempo"),
      locateEvmBlock(c, head, to, TEMPO_BLOCK_SECONDS, TEMPO_BLOCK_LOCATE_TOLERANCE_SECONDS, expired, "Tempo"),
    ]);
    const first = fromAt - TEMPO_TRANSFER_READ_MARGIN_BLOCKS;
    const last = toAt + TEMPO_TRANSFER_READ_MARGIN_BLOCKS;
    const fromBlock = first < 0n ? 0n : first;
    const toBlock = last > head.number ? head.number : last;
    if (fromBlock > toBlock) throw new Error("empty Tempo block range for the window");
    const times = new Map<bigint, number>();
    const out: ChainTransfer[] = [];
    for (let lo = fromBlock; lo <= toBlock; lo += TEMPO_TRANSFER_READ_CHUNK_BLOCKS) {
      expired();
      const hi = lo + TEMPO_TRANSFER_READ_CHUNK_BLOCKS - 1n < toBlock ? lo + TEMPO_TRANSFER_READ_CHUNK_BLOCKS - 1n : toBlock;
      const logs = await c.getLogs({
        address: TEMPO_USDC_E as Address,
        event: TEMPO_TRANSFER_WITH_MEMO_LOG,
        args: { from: payer as Address, to: payTo as Address },
        fromBlock: lo,
        toBlock: hi,
      });
      for (const l of logs) {
        const args = l.args as { from?: unknown; to?: unknown; amount?: unknown; memo?: unknown };
        if (l.blockNumber === null || !l.transactionHash || typeof args.amount !== "bigint") {
          throw new Error("a Tempo transfer log came back without a block, a hash or a value");
        }
        expired();
        if (!times.has(l.blockNumber)) times.set(l.blockNumber, Number((await c.getBlock({ blockNumber: l.blockNumber })).timestamp) * 1000);
        out.push({
          txHash: l.transactionHash,
          from: String(args.from),
          to: String(args.to),
          value: args.amount.toString(),
          blockTime: new Date(times.get(l.blockNumber)!).toISOString(),
        });
      }
    }
    return out;
  };
}

/** TEMPO_RPC_URL を、呼び手の時間で切り・再試行しないクライアント。無ければ null（公開 RPC を使わない）。 */
function boundedTempoClient(timeoutMs: number | undefined): TempoTransferClient | null {
  const url = tempoRpcUrl();
  if (!url) return null;
  return createPublicClient({
    chain: tempoChain as unknown as typeof base,
    transport: http(url, { timeout: Math.max(1_000, Math.trunc(timeoutMs ?? 20_000)), retryCount: 0 }),
  }) as unknown as TempoTransferClient;
}

/** レシートを読む面（Tempo の memo の読み手）。 */
type TempoReceiptClient = Pick<ReturnType<typeof getLogScanClient>, "getChainId" | "getTransactionReceipt">;

/**
 * Tempo の tx の中で、payer が送った TransferWithMemo の memo（小文字 0x + 64 桁）の一覧（2026-11-03・NonceReader）。
 * settlement-verify-tempo.ts と同じ読み方: USDC.e のログで topic0 が TransferWithMemo、topics[1] が payer、memo は topics[3]。
 * 読めない（TEMPO_RPC_URL なし・chainId 違い・レシート無し・revert・RPC の失敗）なら null。
 */
export function makeTempoMemoReader(client?: TempoReceiptClient): NonceReader {
  return async ({ network, txHash, payer }) => {
    if (network !== TEMPO_MAINNET_CAIP2) return null;
    if (!EVM_TX_HASH_RE.test(txHash)) return null;
    const c = client ?? (boundedTempoClient(10_000) as unknown as TempoReceiptClient | null);
    if (!c) return null;
    try {
      if ((await c.getChainId()) !== TEMPO_CHAIN_ID) return null;
      const receipt = await c.getTransactionReceipt({ hash: txHash as `0x${string}` });
      if (!receipt || receipt.status !== "success") return null;
      const usdcLower = TEMPO_USDC_E.toLowerCase();
      const payerLower = payer.toLowerCase();
      const memoTopic = TEMPO_TRANSFER_WITH_MEMO_TOPIC0;
      const out: string[] = [];
      for (const log of receipt.logs) {
        if (log.address?.toLowerCase() !== usdcLower) continue;
        if (log.topics[0]?.toLowerCase() !== memoTopic) continue;
        const from = log.topics[1];
        const memo = log.topics[3];
        if (!from || typeof memo !== "string" || memo.length !== 66) continue;
        if (`0x${from.slice(-40)}`.toLowerCase() !== payerLower) continue;
        out.push(memo.toLowerCase());
      }
      return out;
    } catch {
      return null;
    }
  };
}

/** TransferWithMemo(address,address,uint256,bytes32) の topic0（indexed の有無で変わらない。settlement-verify-tempo.ts と同じ値）。 */
const TEMPO_TRANSFER_WITH_MEMO_TOPIC0 = keccak256(toBytes("TransferWithMemo(address,address,uint256,bytes32)")).toLowerCase();

/** EVM の tx hash の形。 */
const EVM_TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Arc のブロック間隔（秒）。2026-11-03T15:18Z 実測（https://rpc.mainnet.arc.io）: ヘッド 29,347,957 と 100,000 ブロック前の時刻差から
 * 0.507 秒。0.51 で見積もり、読んだブロックと先端の実の間隔で直す。
 */
const ARC_BLOCK_SECONDS = 0.51;
/** 2026-11-03 実測: rpc.mainnet.arc.io は USDC のログを 10,000 ブロックで答えた（1.8 秒）。1 行の窓（≈ 3,770 ブロック）は 1 回で読む。 */
export const ARC_TRANSFER_READ_CHUNK_BLOCKS = 5_000n;
const ARC_BLOCK_LOCATE_TOLERANCE_SECONDS = 30;
// 余裕は許容 30 秒より広く取る。0.51 秒間隔で 120 ブロックは 61 秒。
const ARC_TRANSFER_READ_MARGIN_BLOCKS = 120n;

type ArcTransferClient = Pick<ReturnType<typeof getLogScanClient>, "getBlock" | "getLogs" | "getChainId">;

/**
 * Arc の USDC（0x3600…0000）の Transfer（from → to）を時刻の窓で読む読み手（2026-11-03・linkFromChain の Arc のレーン）。
 * 規則は makeCeloTransferReader と同じ。ARC_RPC_URL が無ければ null——chain/arc.ts の arcRpcUrl は公開 RPC へ倒れるが、
 * このレーンの決め手（nonce・認可の状態の読み手）は ARC_RPC_URL 必須なので、ここも同じ関門にする。
 */
export function makeArcTransferReader(client?: ArcTransferClient): TransferReader {
  return async ({ network, payer, payTo, from, to, timeoutMs }) => {
    if (network !== ARC_CAIP2) return null;
    const c = client ?? boundedArcClient(timeoutMs);
    if (!c) return null;
    const deadline = typeof timeoutMs === "number" ? Date.now() + timeoutMs : Infinity;
    const expired = () => {
      if (Date.now() > deadline) throw new Error("transfer read ran past its time limit");
    };
    const [chainId, head] = await Promise.all([c.getChainId(), c.getBlock({ blockTag: "latest" })]);
    if (chainId !== ARC_CHAIN_ID) return null;
    const headMs = Number(head.timestamp) * 1000;
    if (headMs < to.getTime()) return null;
    const [fromAt, toAt] = await Promise.all([
      locateEvmBlock(c, head, from, ARC_BLOCK_SECONDS, ARC_BLOCK_LOCATE_TOLERANCE_SECONDS, expired, "Arc"),
      locateEvmBlock(c, head, to, ARC_BLOCK_SECONDS, ARC_BLOCK_LOCATE_TOLERANCE_SECONDS, expired, "Arc"),
    ]);
    const first = fromAt - ARC_TRANSFER_READ_MARGIN_BLOCKS;
    const last = toAt + ARC_TRANSFER_READ_MARGIN_BLOCKS;
    const fromBlock = first < 0n ? 0n : first;
    const toBlock = last > head.number ? head.number : last;
    if (fromBlock > toBlock) throw new Error("empty Arc block range for the window");
    const times = new Map<bigint, number>();
    const out: ChainTransfer[] = [];
    for (let lo = fromBlock; lo <= toBlock; lo += ARC_TRANSFER_READ_CHUNK_BLOCKS) {
      expired();
      const hi = lo + ARC_TRANSFER_READ_CHUNK_BLOCKS - 1n < toBlock ? lo + ARC_TRANSFER_READ_CHUNK_BLOCKS - 1n : toBlock;
      const logs = await c.getLogs({
        address: ARC_USDC_ADDRESS,
        event: TRANSFER_LOG,
        args: { from: payer as Address, to: payTo as Address },
        fromBlock: lo,
        toBlock: hi,
      });
      for (const l of logs) {
        if (l.blockNumber === null || !l.transactionHash || typeof l.args.value !== "bigint") {
          throw new Error("an Arc transfer log came back without a block, a hash or a value");
        }
        expired();
        if (!times.has(l.blockNumber)) times.set(l.blockNumber, Number((await c.getBlock({ blockNumber: l.blockNumber })).timestamp) * 1000);
        out.push({
          txHash: l.transactionHash,
          from: String(l.args.from),
          to: String(l.args.to),
          value: l.args.value.toString(),
          blockTime: new Date(times.get(l.blockNumber)!).toISOString(),
        });
      }
    }
    return out;
  };
}

/** ARC_RPC_URL を、呼び手の時間で切り・再試行しないクライアント。ARC_RPC_URL が無ければ null（公開 RPC を使わない）。 */
function boundedArcClient(timeoutMs: number | undefined): ArcTransferClient | null {
  const url = process.env.ARC_RPC_URL?.trim();
  if (!url) return null;
  return createPublicClient({
    chain: arc as unknown as typeof base,
    transport: http(url, { timeout: Math.max(1_000, Math.trunc(timeoutMs ?? 20_000)), retryCount: 0 }),
  }) as unknown as ArcTransferClient;
}

/**
 * 時刻 → ブロック番号（Tempo・Arc の読み手が共有・2026-11-03）。秒/ブロックで見積もり、そのブロックの実際の時刻で確かめて直す
 * （最大 3 回）。直すときの間隔は、読んだブロックと先端の実の間隔（BNB の読み手と同じ）。先端・起点に張り付いたまま合わないなら例外。
 */
async function locateEvmBlock(
  c: Pick<ReturnType<typeof getLogScanClient>, "getBlock">,
  head: { number: bigint; timestamp: bigint },
  t: Date,
  secondsPerBlock: number,
  toleranceSeconds: number,
  expired: () => void,
  chainName: string,
): Promise<bigint> {
  const headMs = Number(head.timestamp) * 1000;
  let n = head.number - BigInt(Math.max(0, Math.ceil((headMs - t.getTime()) / (secondsPerBlock * 1000))));
  for (let i = 0; i < 3; i++) {
    expired();
    if (n < 0n) n = 0n;
    if (n > head.number) n = head.number;
    const block = await c.getBlock({ blockNumber: n });
    const driftSeconds = Math.round((Number(block.timestamp) * 1000 - t.getTime()) / 1000);
    if (Math.abs(driftSeconds) <= toleranceSeconds) return n;
    if ((n === 0n && driftSeconds > 0) || (n === head.number && driftSeconds < 0)) break;
    const blocksBack = Number(head.number - n);
    const observed = blocksBack > 0 ? (Number(head.timestamp) - Number(block.timestamp)) / blocksBack : 0;
    n -= BigInt(Math.trunc(driftSeconds / (observed > 0 ? observed : secondsPerBlock)));
  }
  throw new Error(`could not locate the ${chainName} block for the window`);
}

/**
 * Solana の直読みが使う RPC の面（2026-11-03・テストでは偽物を注入する）。本番は @solana/web3.js の Connection（SOLANA_RPC_URL）。
 * 署名一覧は購入元の USDC の ATA に問う（index-solana.ts と同じ理由: x402 の SVM の決済が口座一覧に載せるのは ATA）。
 */
export type SolanaLateReadRpc = {
  getGenesisHash(): Promise<string>;
  /** 先端のスロットとその時刻（秒）。先端が窓の終わりに届いていなければ読まない。 */
  getHeadTime(): Promise<number | null>;
  getSignaturesForAddress(address: string, opts: { limit: number; before?: string }): Promise<{ signature: string; blockTime?: number | null; err: unknown | null }[]>;
  getParsedTransaction(signature: string): Promise<{
    blockTime?: number | null;
    meta: { err: unknown | null; preTokenBalances?: readonly SolanaTokenBalance[] | null; postTokenBalances?: readonly SolanaTokenBalance[] | null } | null;
    /** spl-memo 命令の文字列。読めなければ null。 */
    memos: readonly string[] | null;
  } | null>;
};

/** 1 回の署名の頁（getSignaturesForAddress の上限）。 */
export const SOLANA_LATE_READ_SIGNATURES_PER_PAGE = 1_000;
/** 1 つの組で遡る頁の上限。購入元の ATA の履歴は我々の Solana の購入だけなので、30 日ぶんでも数頁。 */
export const SOLANA_LATE_READ_MAX_PAGES = 10;
/** CAIP-2 の solana 名前空間は genesis hash の先頭 32 文字を参照に使う（settlement-verify-solana.ts と同じ）。 */
const CAIP2_SOLANA_REFERENCE_LENGTH = 32;

/**
 * Solana の USDC の着金（購入元 → 宛先）を時刻の窓で読む読み手（2026-11-03・linkFromChain の Solana のレーン）。
 *   - Solana 以外の network は null。SOLANA_RPC_URL が無ければ null（公開 RPC へ黙って倒れない）。
 *   - クラスタを毎回読む（genesis hash が network の参照と合わなければ null）。先端の時刻が窓の終わりに届いていなければ null。
 *   - 購入元の USDC の ATA の署名一覧を新しい順に遡り、窓の中の署名だけ取引を読む。窓より古い署名に届く前に頁の上限に
 *     当たったら例外（読み切れていない窓を「着金なし」と言わない）。
 *   - 取引ごとに、宛先（owner）の USDC の受領額を残高差分で取り（usdcOwnerDelta・照合器と同じ読み方）、購入元の USDC が
 *     減っているものだけを着金にする。value は宛先の受領額。失敗した取引（meta.err）は数えない。
 *   - from / to は呼び手が渡した表記のまま返す（base58 は大文字小文字で別の鍵）。
 */
export function makeSolanaTransferReader(rpc?: SolanaLateReadRpc | null): TransferReader {
  return async ({ network, payer, payTo, from, to, timeoutMs }) => {
    if (network !== SOLANA_MAINNET_CAIP2) return null;
    const c = rpc === undefined ? await createSolanaLateReadRpc() : rpc;
    if (!c) return null;
    const deadline = typeof timeoutMs === "number" ? Date.now() + timeoutMs : Infinity;
    const expired = () => {
      if (Date.now() > deadline) throw new Error("transfer read ran past its time limit");
    };
    const reference = network.slice("solana:".length);
    const genesis = await c.getGenesisHash();
    if (typeof genesis !== "string" || genesis.slice(0, CAIP2_SOLANA_REFERENCE_LENGTH) !== reference) return null;
    const headSeconds = await c.getHeadTime();
    if (headSeconds === null || !Number.isFinite(headSeconds) || headSeconds * 1000 < to.getTime()) return null;
    const account = solanaUsdcTokenAccount(payer);
    if (!account) return null;
    const fromSeconds = Math.floor(from.getTime() / 1000);
    const toSeconds = Math.ceil(to.getTime() / 1000);
    const inWindow: string[] = [];
    let before: string | undefined;
    let reachedPast = false;
    for (let page = 0; page < SOLANA_LATE_READ_MAX_PAGES; page++) {
      expired();
      const sigs = await c.getSignaturesForAddress(account, { limit: SOLANA_LATE_READ_SIGNATURES_PER_PAGE, ...(before ? { before } : {}) });
      if (sigs.length === 0) {
        reachedPast = true;
        break;
      }
      for (const s of sigs) {
        const bt = typeof s.blockTime === "number" ? s.blockTime : null;
        if (bt === null) throw new Error("a Solana signature came back without a block time");
        if (s.err !== null && s.err !== undefined) continue;
        if (bt >= fromSeconds && bt <= toSeconds) inWindow.push(s.signature);
      }
      const last = sigs[sigs.length - 1];
      if (typeof last.blockTime === "number" && last.blockTime < fromSeconds) {
        reachedPast = true;
        break;
      }
      if (sigs.length < SOLANA_LATE_READ_SIGNATURES_PER_PAGE) {
        reachedPast = true;
        break;
      }
      before = last.signature;
    }
    if (!reachedPast) throw new Error("the Solana signature list did not reach the start of the window within the page limit");
    const out: ChainTransfer[] = [];
    for (const signature of inWindow) {
      expired();
      const tx = await c.getParsedTransaction(signature);
      if (!tx || !tx.meta) throw new Error(`the Solana transaction ${signature.slice(0, 16)}… could not be read`);
      if (tx.meta.err !== null && tx.meta.err !== undefined) continue;
      const pre = tx.meta.preTokenBalances ?? [];
      const post = tx.meta.postTokenBalances ?? [];
      const payee = usdcOwnerDelta(pre, post, payTo, SOLANA_USDC_MINT);
      const source = usdcOwnerDelta(pre, post, payer, SOLANA_USDC_MINT);
      if (!payee.attributable || !source.attributable) throw new Error(`the Solana transaction ${signature.slice(0, 16)}… has token balances without owners`);
      if (payee.received <= 0n || source.sent <= 0n) continue;
      const bt = typeof tx.blockTime === "number" ? tx.blockTime : null;
      if (bt === null) throw new Error(`the Solana transaction ${signature.slice(0, 16)}… has no block time`);
      out.push({ txHash: signature, from: payer, to: payTo, value: payee.received.toString(), blockTime: new Date(bt * 1000).toISOString() });
    }
    return out;
  };
}

/**
 * Solana の取引の spl-memo の文字列（小文字・前後の空白を除く）の一覧（2026-11-03・NonceReader）。
 * 読めない（SOLANA_RPC_URL なし・クラスタ違い・取引無し・失敗した取引・memo が読めない応答）なら null。
 */
export function makeSolanaMemoReader(rpc?: SolanaLateReadRpc | null): NonceReader {
  return async ({ network, txHash }) => {
    if (network !== SOLANA_MAINNET_CAIP2) return null;
    const c = rpc === undefined ? await createSolanaLateReadRpc() : rpc;
    if (!c) return null;
    try {
      const genesis = await c.getGenesisHash();
      if (typeof genesis !== "string" || genesis.slice(0, CAIP2_SOLANA_REFERENCE_LENGTH) !== network.slice("solana:".length)) return null;
      const tx = await c.getParsedTransaction(txHash.trim());
      if (!tx || !tx.meta || (tx.meta.err !== null && tx.meta.err !== undefined)) return null;
      if (tx.memos === null || tx.memos === undefined) return null;
      return tx.memos.map((m) => m.trim().toLowerCase());
    } catch {
      return null;
    }
  };
}

/** 本番の RPC の面（@solana/web3.js）。SOLANA_RPC_URL 未設定なら null。 */
async function createSolanaLateReadRpc(): Promise<SolanaLateReadRpc | null> {
  const url = process.env.SOLANA_RPC_URL?.trim();
  if (!url) return null;
  const { Connection, PublicKey } = await import("@solana/web3.js");
  const conn = new Connection(url, "confirmed");
  const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
  return {
    getGenesisHash: () => conn.getGenesisHash(),
    getHeadTime: async () => {
      const slot = await conn.getSlot("confirmed");
      const t = await conn.getBlockTime(slot);
      return typeof t === "number" ? t : null;
    },
    getSignaturesForAddress: async (address, opts) => {
      const list = await conn.getSignaturesForAddress(new PublicKey(address), opts, "confirmed");
      return list.map((s) => ({ signature: s.signature, blockTime: s.blockTime ?? null, err: s.err }));
    },
    getParsedTransaction: async (signature) => {
      const tx = await conn.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
      if (!tx) return null;
      const memos: string[] = [];
      const walk = (instructions: readonly unknown[]) => {
        for (const raw of instructions) {
          const ix = raw as { program?: string; programId?: { toBase58(): string }; parsed?: unknown };
          const programId = ix.programId?.toBase58?.() ?? "";
          if ((ix.program === "spl-memo" || programId === MEMO_PROGRAM_ID) && typeof ix.parsed === "string") memos.push(ix.parsed);
        }
      };
      walk(tx.transaction.message.instructions);
      for (const inner of tx.meta?.innerInstructions ?? []) walk(inner.instructions);
      return {
        blockTime: tx.blockTime,
        meta: tx.meta
          ? {
              err: tx.meta.err,
              preTokenBalances: tx.meta.preTokenBalances as readonly SolanaTokenBalance[] | null | undefined,
              postTokenBalances: tx.meta.postTokenBalances as readonly SolanaTokenBalance[] | null | undefined,
            }
          : null,
        memos,
      };
    },
  };
}
