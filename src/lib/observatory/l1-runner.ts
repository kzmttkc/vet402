// ============================================================
// vet402 Observatory L1 — purchase runner (design §1 L1/L2, §5 W3).
//
// One batch = walk the real-demand target list and, per endpoint, do ONE
// paid purchase (made under our own User-Agent): request → 402 → sign (x402-payer's funnel of refusals) →
// paid retry → record what actually happened, with the settlement tx hash
// as the receipt. Everything is recorded, including the refusals — a seller
// over-charging vs its own catalog listing is a published fact, not a
// payment.
//
// Money discipline (in order of the checks in code):
//  1. Master switches: OBSERVATORY_L1_ENABLED must be "true" AND the wallet
//     key present — otherwise zero requests are made at all.
//  2. Budget: today's spend is summed FROM THE DATABASE (x402_l1_purchases.
//     spent_units, UTC day) — restarts and concurrent invocations read the
//     same ledger. checkL1Budget gates each purchase BEFORE signing.
//  3. spent_units is RESERVED (row written, status `in_flight`) BEFORE the
//     signature exists, and the reservation itself re-checks the day's total
//     inside a single SQL statement (reserveSpend). Two reasons, both found
//     live-fire in the 2026-08-15 audit: (a) a signed EIP-3009 authorization
//     is live money until validBefore, so a kill between signing and the
//     write (maxDuration, DB blip) must not lose the spend; (b) reading the
//     day's total once per batch let two overlapping invocations each spend a
//     full daily budget ($49 measured against a $25 cap).
//  4. One purchase per endpoint per sweep window (default 6 days) — the
//     weekly-sweep cadence emerges from the daily budget, not from a queue.
// ============================================================
import { L1_CELO_PAID_TIMEOUT_MS, L1_REQUEST_TIMEOUT_MS, l1PaidTimeoutMs } from "./l1-timing";
import { answerShapeOf } from "./answer-shape";
import { sortAnswerShapeCaught, sortAnswerShapeFromRun } from "./answer-shape-sort";
import { privateKeyToAccount } from "viem/accounts";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { isMissingSchemaError } from "@/lib/db/pg-errors";
import { utcDayStart } from "@/lib/db/utc-day";
import { x402L1Purchases } from "@/lib/db/schema";
import { invalidateDecisionCache } from "@/lib/decision/cache";
import { readBodyCapped, readBodyCappedDetailed } from "@/lib/net/read-capped";
import { UnsafeTargetError, createSafeFetchImpl, type SafeFetchCallOptions } from "@/lib/net/safe-fetch";
import { redactForLog, redactedError } from "./redact";
import { createDeadline } from "@/lib/util/deadline";
import { CENSUS_PER_RUN, CHAIN_DAILY_CAPS, LANE_FLOOR_FETCH_MAX, LANE_FLOOR_MAX_PER_HOST, LANE_FLOOR_OVERSAMPLE, cappedChainFor, chainDailyCapUnits, checkL1Budget, domainDailyCapUnits, isCensusEnabled, isL1Enabled, laneFloorPerRun, sellerDailyCapUnits, DAILY_BUDGET_USD, type CappedChain } from "./budget";
// census の枠（2026-09-29）。別の import 行に分けてある（同じ行を触る並行ブランチとの衝突を避ける）。
import { censusFirstPurchaseQuota, censusMinPerRun, laneTimeShare } from "./budget";
import { isSpendingHalted, type HaltVerdict } from "./kill-switch";
import { addDerivedOperatorAddresses, isOperatorPayTo, operatorPayToDenylist } from "./operator";
import { operatorExclusionPredicate } from "./operator-sql";
import {
  ARC_CAIP2,
  ARC_CHAIN,
  ARBITRUM_CAIP2,
  ARBITRUM_CHAIN,
  AVALANCHE_CAIP2,
  AVALANCHE_CHAIN,
  BASE_CAIP2,
  BASE_USDC,
  BNB_CAIP2,
  BNB_CHAIN,
  CELO_CAIP2,
  CELO_CHAIN,
  MAX_PER_PURCHASE_UNITS,
  buildAuthorization,
  declaredPayTosFor,
  encodePaymentHeader,
  type ChallengeAccept,
  evmChainFor,
  isArcL1Enabled,
  isArbitrumL1Enabled,
  isAvalancheL1Enabled,
  isBnbL1Enabled,
  isCeloL1Enabled,
  parseChallenge,
  parseSettlementResponse,
  selectAccept,
  signX402Payment,
} from "./x402-payer";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { isWellFormedSettlementTx } from "@/lib/validation/settlement-tx";
import { Keypair } from "@solana/web3.js";
import {
  SOLANA_MAINNET_CAIP2,
  buildSolanaPaymentTransaction,
  encodeSolanaPaymentHeader,
  isSolanaL1Enabled,
  selectSolanaAccept,
} from "./sol402-payer";
import type { Wallet as XrplWallet } from "xrpl";
import { XRPL_MAINNET_CAIP2 } from "./chains";
import { RLUSD_CURRENCY_HEX, RLUSD_ISSUER } from "./xrpl-constants";
import { withDailyFallback } from "@/lib/settlements/rollup";
import { l1TierWhere } from "./coverage";
import { censusHostSql, RETEST_LISTINGS_SQL, RETEST_SELLERS_SQL } from "./retest-sellers-sql";
import { registeredDomainOf, registeredDomainSql } from "./registered-domain";
import { isPathTemplate, notPathTemplateSql } from "./path-template";
import { declaredRequestBody, declaredRequestUrl, type RequestBodySource, type RequestQuerySource } from "./declared-input";
import { requestBodyRecord } from "./request-body";
import { isDeliveryHttp } from "./delivery";
import { createPayerFunds, defaultPayerUsdcBalance, type PayerChain, type PayerFunds, type PayerUsdcBalanceReader } from "./payer-funds";
import {
  arcGatewayCapOpen,
  arcGatewayFundsOk,
  chainCapNetworkSql,
  gatewayAuthWindowOk,
  gatewayCandidateInclusionSql,
  gatewayCandidateRequestShapeSql,
  gatewayDeclaredPayTosFor,
  gatewayLeafFacts,
  gatewayPostBodyUnknownExcludedCountSql,
  gatewayPrimaryExclusionSql,
  gatewaySignedStatus,
  hasSignableNativeArcAccept,
  hasSignableOtherRailAccept,
  isArcGatewayL1Enabled,
  readArcGatewayAvailable as readArcGatewayAvailableProd,
  gatewaySellerResource,
  selectArcGatewayAccept,
  signArcGatewayPayment,
  type ArcGatewaySigned,
  type ArcGatewaySigner,
} from "./arc-gateway";
import { createHash } from "node:crypto";
import { PURCHASE_EVIDENCE_VERSION, challengeEvidenceForRow, mppChallengeEvidence, paymentPayloadEvidence, x402ChallengeEvidence } from "./purchase-evidence";
// Tempo の MPP 方言（2026-09-17・mpp-payer.ts）。x402 ではなく WWW-Authenticate: Payment の壁。
// フラグ OBSERVATORY_TEMPO_L1_ENABLED（既定 off）が無ければ Tempo は lanes で候補外（行 0）。
import {
  TEMPO_MAINNET_CAIP2,
  createMppCredential,
  isTempoL1Enabled,
  parseMppChallengesFromHeaders,
  parseMppReceipt,
  selectMppChallenge,
  type MppxCharge,
} from "./mpp-payer";
// L2（宣言との一致）の判定と、支払い付き応答の本文の読み取り上限（2026-09-29・l2-check.ts）。
import { L1_BODY_OVER_CAP_REASON, L1_PAID_BODY_CAP_BYTES, checkL2Detailed as checkL2DetailedImpl, liveOutputExampleHash, liveOutputExampleOf, paidBodyReadOf, type L2Detail, type LiveOutputExampleShadow } from "./l2-check";

export type L1BatchSummary = {
  attempted: number;
  settled: number;
  /**
   * 署名して支払ったが決済レシートが返らなかった件数。2026-08-22 まで
   * `delivered_no_receipt`（品は来たがレシート無し）を吸収していて、DBの
   * status は区別しているのに cron 応答からは判別できなかった。
   */
  settleFailed: number;
  /** 品は返ってきたが PAYMENT-RESPONSE が無かった件数（DBの status と1:1）。 */
  deliveredNoReceipt: number;
  skipped: number;
  budgetDenied: number;
  spentUnitsTotal: string;
  /** True when the batch stopped early to stay inside maxDuration (see L1_BATCH_BUDGET_MS). */
  stoppedForDeadline: boolean;
  /** Candidates left untouched by that stop — zero on a normal full walk. */
  notAttempted: number;
  /** Stale `in_flight` rows resolved at the top of this batch (see sweepOrphanedInFlight). */
  orphansResolved: number;
  /**
   * 実行時の停止スイッチが効いた（2026-09-05 監査 P0・kill-switch.ts）。
   * バッチ開始時に立っていれば 1 リクエストも出さず、途中で立てば
   * そこで打ち切る（飛行中の 1 件は最後まで記帳する）。
   */
  halted: boolean;
  haltReason: string | null;
  disabledReason: "l1_disabled" | "wallet_key_missing" | "spending_halted" | null;
  /**
   * 購入元の USDC 残高が足りない（または読めない）ために署名しなかった候補の数
   * （2026-09-17 Issue #29・payer-funds.ts）。台帳には行を書かないので、ここと
   * サーバログ（observatory.l1.payer_unfunded）だけが資金切れを知らせる。
   */
  payerUnfunded: number;
  /**
   * 売り手ごとの日次上限（budget.ts SELLER_DAILY_CAP_USD・2026-09-29 監査 5 周目）で署名しなかった候補の数。
   * 予約が断った件と、同じバッチで同じ受取先・ホストの残りを飛ばした件の合計（skipped にも含まれる）。行は書かない。
   */
  sellerCapped: number;
  /**
   * 上の payerUnfunded のうち、残高を**読めなかった**チェーンの名前（2026-09-20・Issue #29 レビューの宿題 ⓒ）。
   * 読み取りはチェーンごとに 1 バッチ 1 回で、失敗もそのバッチの間は使い回すので、1 回の RPC 障害で
   * そのチェーンは全件署名しない。payerUnfunded は「足りない」と「読めない」を足した数で、cron は 200 の
   * まま返す——監視が障害を資金切れと分けて拾えるよう、鍵を分ける。誤りの本文（RPC の文言）は出さない。
   */
  payerFundsUnreadable: string[];
  /**
   * チェーンごとの候補の最低枠（2026-09-17・budget.ts laneFloorPerRun）で主候補の先頭に置いた
   * 件数。別枠を持つレーン（CHAIN_DAILY_CAPS）だけが鍵になる。旗が off・別枠が尽きた・候補が
   * 無い日は 0。購入の可否は従来の経路（デッドライン・別枠・残高・原子的予約）がそのまま決める。
   */
  laneFloor: Partial<Record<CappedChain, number>>;
  /**
   * レーン枠を埋める途中で、同一ホストの上限（budget.ts LANE_FLOOR_MAX_PER_HOST）のために
   * 飛ばした候補の件数（レーン別・2026-09-18）。0 でない日は、1 つのホストが枠を埋めかけていた。
   */
  laneFloorHostCapped: Partial<Record<CappedChain, number>>;
  /**
   * XRPL の open_ledger_fee が上限（1,000 drops）を超えていて署名しなかった候補の数（2026-09-17）。
   * 台帳には行を書かない（payer_unfunded と同じ作法）。1 件出たらそのバッチの XRPL は閉じる。
   */
  xrplFeeOverCap: number;
  /**
   * このバッチで XRPL のレーンを **我々の側の理由** で閉じたときの理由（2026-09-18 レビュー W1）。
   *   "signing_inputs_unavailable" 署名の材料（Sequence・validated ledger）を XRPL_RPC_URL から読めなかった
   *   "fee_over_cap"               網の open_ledger_fee が上限超（xrplFeeOverCap と同じ出来事）
   *   "payer_unfunded"             XRPL の購入元の RLUSD（または手数料ぶんの XRP）が足りない／読めない
   *                                （2026-09-19・payerUnfunded に数えた出来事。以降のレーン候補は Base へ戻す）
   * 1 件署名して閉じる通常の 1 バッチ 1 件は null のまま（それは障害ではない）。
   * 同じバッチで 2 つ目の理由が出ても、最初に閉じた理由を残す（上書きしない）。
   */
  xrplLaneClosed: "signing_inputs_unavailable" | "fee_over_cap" | "payer_unfunded" | null;
  /**
   * 売り手の census（2026-09-28・budget.ts CENSUS_PER_RUN）から、このバッチの候補に入れた件数。
   * 旗（OBSERVATORY_L1_CENSUS=on）が無い・playground の 1 件指定・候補が無い日は 0。
   * 購入の可否は主候補と同じ経路（デッドライン・上限・別枠・初回枠・残高・原子的予約）が決める。
   */
  censusCandidates: number;
  /**
   * 公平な買い直し（retest・2026-09-28）から、このバッチの候補に入れた件数。census と同じ旗・同じ上限
   * （CENSUS_PER_RUN を census と分け合う）。旗が無い・playground の 1 件指定・候補が無い日は 0。
   */
  retestCandidates: number;
  /**
   * バッチ開始時点の、未購入の Base ホスト数: active で Base の accept を持つ行のホスト名（ポート無視）のうち、
   * L1 の購入行がまだ 1 件も無いもの。$1 超の出品しか無い・L0 不合格・price_amount が無いなど、census が
   * 選べないホストも含む（＝census の残り件数ではなく、まだ 1 行も無い売り手の数）。
   * 旗が無い日と、読めなかった日は null（0 と混ぜない）。
   */
  censusRemaining: number | null;
  /**
   * 使った時間が持ち時間の L1_LANE_TIME_SHARE（budget.ts laneTimeShare・既定 0.5）を超えたあとで、
   * 買わずに飛ばしたレーン候補（candidate.laneChain !== null・Gateway の pinned を含む）の数（2026-10-27）。
   * 402 も取りに行かず、行も書かない。skipped にも含まれる。主ネットワークがそのチェーンの主候補は数えない。
   */
  laneSkippedForTime: number;
  /**
   * 目録全体の active 行のうち、Gateway 専用で POST・目録本文不明の件数（2026-10-28）。
   * その回の候補母数ではない。問い合わせが失敗した回は null（0 と混ぜない）。
   */
  gatewayPostBodyUnknownActive: number | null;
  /**
   * 402 を読んだあと、Gateway + POST で live 402 が本文を宣言していないため署名前に見送った件数（2026-10-29）。
   * gatewayPostBodyUnknownActive とは別（目録と 402 の食い違い）。
   */
  gatewayPostBodyUnknownSignSkipped: number;
  /**
   * 実行の開始から候補ループに入るまでのミリ秒（2026-10-27）。鍵・停止スイッチ・台帳・レーンの別枠・
   * 候補 SQL（主・レーン枠・census / retest）の合計。ループに入る前に返った実行（旗 off・停止など）は null。
   * 10/26 12:35Z のデプロイ後に最初の購入まで 19〜20 秒から 60 秒へ延びた原因を切り分けるための計器。
   */
  setupMs: number | null;
  /** このバッチで試行（kind === "attempted"）した件数を、署名した accept の network（CAIP-2）ごとに（2026-10-27）。 */
  attemptsByNetwork: Record<string, number>;
  /**
   * 主候補の SQL（targetsSql の主の取得）のミリ秒（2026-10-27）。ループに入る前に返った実行は null。
   * setupMs の内訳: 準備のどの問い合わせが重いかを本番の summary から切り分ける。
   */
  primaryFetchMs: number | null;
  /** レーン枠の取得のミリ秒をレーンごとに（2026-10-27・並べて走らせる）。問い合わせなかったレーンは載せない。 */
  laneFetchMs: Record<string, number>;
};

/**
 * 鍵の要らない公開口（POST /api/v1/demo/verify）へ返してよい summary（2026-09-19 横断監査 W3）。
 *
 * 落とすのは haltReason ひとつ。中身は kill-switch.ts の
 * `halted_by_operator: <運用者が書いた理由>` か `halt_flag_unreadable: <DB ドライバの error.message>`
 * で、前者は内部の事情、後者は上流の素の文言——同じルートの 503 の枝が
 * 「どの上流が不調かは admin 限定」としてわざと伏せている種類のものである。
 * 「止まっている」という事実（halted / disabledReason）は隠さない: 503 の枝も
 * `spending_halted` と名乗るし、隠すと呼び手からは動いて見えてしまう。
 *
 * 白名簿を Omit の型で書いているのは関門にするため——L1BatchSummary に列を足すと
 * ここが型不足で落ち、「公開してよいか」を決めない限り typecheck が通らない。
 */
// census の 2 つ（2026-09-28）は公開口へ出さない: 公開口は 1 件指定の playground で census を使わないし、
// 「まだ試していない売り手の数」は内部の進み具合であって、その 1 件の計測の事実ではない。
// sellerCapped（2026-09-29 監査 5 周目）も出さない: 売り手ごとの上限で見送った件数は運用の内訳で、その 1 件の計測の事実ではない。
// laneSkippedForTime・setupMs・attemptsByNetwork（2026-10-27）も出さない: 持ち時間の配分と準備の所要時間は運用の計器で、
// その 1 件の計測の事実ではない（公開口は 1 件指定なのでレーン枠も census も使わない）。
// gatewayPostBodyUnknownActive・gatewayPostBodyUnknownSignSkipped（2026-10-28/29）も出さない: Gateway 形の関門の内訳。
// primaryFetchMs・laneFetchMs（2026-10-27）も同じ理由で出さない（準備の内訳の計器）。
export type PublicL1BatchSummary = Omit<
  L1BatchSummary,
  | "haltReason"
  | "censusCandidates"
  | "censusRemaining"
  | "retestCandidates"
  | "sellerCapped"
  | "laneSkippedForTime"
  | "gatewayPostBodyUnknownActive"
  | "gatewayPostBodyUnknownSignSkipped"
  | "setupMs"
  | "attemptsByNetwork"
  | "primaryFetchMs"
  | "laneFetchMs"
>;

export function publicL1Summary(summary: L1BatchSummary): PublicL1BatchSummary {
  return {
    attempted: summary.attempted,
    settled: summary.settled,
    settleFailed: summary.settleFailed,
    deliveredNoReceipt: summary.deliveredNoReceipt,
    skipped: summary.skipped,
    budgetDenied: summary.budgetDenied,
    spentUnitsTotal: summary.spentUnitsTotal,
    stoppedForDeadline: summary.stoppedForDeadline,
    notAttempted: summary.notAttempted,
    orphansResolved: summary.orphansResolved,
    halted: summary.halted,
    disabledReason: summary.disabledReason,
    payerUnfunded: summary.payerUnfunded,
    payerFundsUnreadable: summary.payerFundsUnreadable,
    laneFloor: summary.laneFloor,
    laneFloorHostCapped: summary.laneFloorHostCapped,
    xrplFeeOverCap: summary.xrplFeeOverCap,
    xrplLaneClosed: summary.xrplLaneClosed,
  };
}

type Candidate = {
  id: string;
  resourceUrl: string;
  method: string | null;
  priceAmount: string | null;
  payTo: string | null;
  network: string | null;
  declaredSchema: unknown;
  isPriority: boolean;
  /** 成立が MATURE_SETTLED_MIN 件以上＝証拠が足りている（買い直しは 30 日間隔）。 */
  isMature: boolean;
  /** このエンドポイントで settled / settle_claimed の行がある network（CAIP-2）。レーンの accept 優先の材料（2026-09-17）。 */
  settledNetworks: string[];
  /** このエンドポイントで非決済（settle_failed / delivered_no_receipt / settle_claim_refuted）が 1 度でも出た network。 */
  failedNetworks: string[];
  /** レーン枠（laneFloorCandidates）から来た候補なら、そのレーン。主候補は null。 */
  laneChain: CappedChain | null;
  /**
   * 売り手の census（censusCandidates・2026-09-28）から来た候補なら "census"、公平な買い直し（retest）から
   * 来た候補なら "retest"。主候補・レーン枠は null。台帳の行の raw_response_meta.selection に残す
   * （export の列は増やさない）。
   */
  selection: CensusSelection | null;
  /**
   * カタログの raw_accepts が宣言した XRPL（xrpl:0・RLUSD・固定発行者）accept の payTo（2026-09-18）。
   * Base が先頭の行を XRPL の accept で買うとき、壁の payTo はこの宣言と完全一致でなければ払わない
   * （カタログの pay_to は 0x アドレスで、r アドレスとは比べられない）。
   */
  xrplDeclaredPayTos: string[];
  /**
   * カタログの raw_accepts が宣言した Arc の accept のうち、**署名の関門と同じ述語**（x402-payer declaredPayTosFor:
   * scheme exact・固定 USDC・eip3009 か未指定・正規の EIP-712 ドメイン・署名できる形）を通ったものの payTo（2026-09-19）。
   * 本番の実測: api.exa.ai は Arc の accept を先頭（Base legacy）と**別の payTo** で宣言している。先頭の pay_to と
   * 比べると Arc の accept は必ず payto_mismatch で落ち、Base で買われていた。レーンとして優先された Arc の
   * accept の payTo は、この宣言の集合と照合する（selectAccept の declaredPayTosByNetwork）。
   */
  arcDeclaredPayTos: string[];
  /**
   * Celo（2026-10-10）で同じもの: カタログの raw_accepts が宣言した Celo の accept のうち、署名の関門と同じ述語
   * （declaredPayTosFor(CELO_CHAIN, …)）を通ったものの payTo。10/10 の実測: api.blockscout.com は Celo の accept と
   * Base の accept を**別の payTo** で出している。レーンとして優先された Celo の accept の payTo は、この集合と照合する。
   */
  celoDeclaredPayTos: string[];
  /**
   * カタログの raw_accepts が宣言した stellar:pubnet の USDC（classic か SAC）accept の payTo（2026-10-18・段4）。
   * Base が先頭の行を Stellar で買うとき、壁の payTo はこの集合と完全一致でなければ払わない
   * （カタログの pay_to は 0x アドレスで、G/C アドレスとは比べられない）。
   */
  stellarDeclaredPayTos: string[];
  /**
   * BNB（2026-10-19・段B2）で同じもの: カタログの raw_accepts が宣言した eip155:56 の accept のうち、
   * 署名の関門と同じ述語（declaredPayTosFor(BNB_CHAIN, …)）を通ったものの payTo。USD1 の eip3009 だけ。
   * レーンとして優先された BNB の accept の payTo は、この集合と照合する。先頭（Base）の pay_to とは比べない。
   */
  bnbDeclaredPayTos: string[];
  /**
   * Arbitrum（2026-10-22）で同じもの: カタログの raw_accepts が宣言した eip155:42161 の accept のうち、
   * 署名の関門と同じ述語（declaredPayTosFor(ARBITRUM_CHAIN, …)）を通ったものの payTo。ネイティブ USDC だけ。
   * レーンとして優先された Arbitrum の accept の payTo は、この集合と照合する。先頭（Base）の pay_to とは比べない。
   */
  arbitrumDeclaredPayTos: string[];
  /**
   * Avalanche（2026-10-26）で同じもの: カタログの raw_accepts が宣言した eip155:43114 の accept のうち、
   * 署名の関門と同じ述語（declaredPayTosFor(AVALANCHE_CHAIN, …)）を通ったものの payTo。ネイティブ USDC だけ。
   * extra.name が GatewayWalletBatched の accept は通らない。レーンとして優先された Avalanche の accept の
   * payTo は、この集合と照合する。先頭（Base）の pay_to とは比べない。
   */
  avalancheDeclaredPayTos: string[];
  /**
   * カタログの Arc accept のうち、GatewayWalletBatched（ピンしたウォレット）の payTo。
   * Gateway レーンはこの集合と照合する。ネイティブ USDC の宣言は arcDeclaredPayTos のまま。
   */
  gatewayDeclaredPayTos: string[];
};

/**
 * レーンが選ぶ accept の network（2026-09-17）。別枠を持つレーン（budget.ts CHAIN_DAILY_CAPS）が
 * selectable なとき、purchaseOne は「そのエンドポイントにそのチェーンでの settled 行がまだ無い」
 * レーンの network を selectAccept の preferNetworks に渡す。一度そのチェーンで settled したら
 * 従来の並び（Base 先頭）に戻す＝レーンの実績は 1 エンドポイント 1 回でよい。
 *
 * 2026-09-17 レビュー C2/C4: 優先は**レーン枠から来た候補（candidate.laneChain）にだけ**渡す。
 * 主候補（Base の需要順）には掛けない。バッチ内でそのレーンの支出を加算し、別枠を使い切ったら
 * 以後は渡さない。そのチェーンで settle_claimed 以上の行があるか、非決済（settle_failed 等）が
 * 1 度でも出た endpoint にも渡さない。
 */
/**
 * Stellar pubnet の定数。stellar402-payer.ts と同じ文字列。ここから static import しない
 * （旗 OFF のとき `@x402/stellar` を読まない。署名器は loadStellarPayerModule だけが読む）。
 */
const STELLAR_PUBNET_CAIP2 = "stellar:pubnet";

/**
 * 行に書く network。Stellar は壁の文字列を使わない（完全一致で選んでも、表記は定数に固定する）。
 * 壁の値をそのまま書く変異は、壁が定数と違う文字列でも定数を返すことで落ちる。
 */
export function purchaseLedgerNetwork(input: { isXrpl: boolean; isStellar: boolean; acceptNetwork: string }): string {
  if (input.isXrpl) return XRPL_MAINNET_CAIP2;
  if (input.isStellar) return STELLAR_PUBNET_CAIP2;
  return input.acceptNetwork;
}
const STELLAR_USDC_CLASSIC = "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const STELLAR_USDC_SAC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

const LANE_NETWORK: Partial<Record<CappedChain, string>> = {
  solana: SOLANA_MAINNET_CAIP2,
  arc: ARC_CAIP2,
  // Celo（2026-10-10）: Arc と同じ EVM の署名経路（selectAccept の preferNetworks）。
  celo: CELO_CAIP2,
  // BNB（2026-10-19・段B2）: 同じ EVM の署名経路・同じ EOA。USD1 の eip3009 だけ。
  bnb: BNB_CAIP2,
  // Arbitrum（2026-10-22）: 同じ EVM の署名経路・同じ EOA。ネイティブ USDC の eip3009 だけ。
  arbitrum: ARBITRUM_CAIP2,
  // Avalanche（2026-10-26）: 同じ EVM の署名経路・同じ EOA。ネイティブ USDC の eip3009 だけ。
  avalanche: AVALANCHE_CAIP2,
  // Stellar（2026-10-18・段4）: 主ネットワークが pubnet の行は isStellar が先に selectStellarAccept へ入る。
  // preferNetworks はその選択より前には届かない。2 番目以降（Base 先頭）は XRPL と同じく
  // stellarLanePreferred のときだけ、壁の stellar:pubnet を selectStellarAccept で選ぶ。
  stellar: STELLAR_PUBNET_CAIP2,
  // tempo は入れない（2026-09-17）: Tempo は MPP 方言で accept 選択の経路（mpp-payer）が別。
  // x402 の challenge に Tempo の accept が混ざることも無いので、preferNetworks の対象外。
  // xrpl も入れない（2026-09-17）: 署名器が別（xrpl402-payer・selectXrplAccept）で、EVM の
  // selectAccept は xrpl:0 の accept を eligible にしない。
};

/**
 * raw_accepts の 2 番目以降の accept まで見てレーン候補にするか。Arc（EVM）は同じ EOA・同じ
 * EVM の署名経路なので、Base が先頭の exa.ai の行も Arc の accept で買える。Solana は
 * purchaseOne の経路が主ネットワーク（e.network）で分かれるため、先頭が Base の行を Solana の
 * 枠に入れても Base で買われてしまう——e.network が Solana の行だけを従来どおり枠に入れる。
 */
// XRPL（2026-09-18）: 本番の実測で、XRPL を主ネットワークにする稼働中の行は 1 件（x402.greenhead.io・unbuildable）。
// 約 1,600 件は Base が先頭で、XRPL の RLUSD accept は 2 番目以降。purchaseOne がレーン由来の候補に限って
// XRPL レールを選べるようにした（selectXrplSecondaryAccept）ので、Arc と同じく secondary を枠に入れる。
// Celo（2026-10-10）: Arc と同じ EVM の署名経路・同じ EOA。10/10 の実測で、Celo を 2 番目以降の accept に置く売り手
// （agent402.tools は 9 番目・api.describe.net は 6 番目・どちらも先頭は Base）と、先頭に置く売り手（api.blockscout.com）の
// 両方が居る。Arc と同じく secondary を枠に入れる。
// Stellar（2026-10-18・段4）: 本番の実測では主ネットワークが stellar:pubnet の行は 0 件。
// 692 件は Base（eip155:8453）が先頭で、stellar:pubnet の USDC accept は 2 番目以降。
// レーン由来の候補に限って selectStellarAccept で選ぶ（stellarLanePreferred。宣言した payTo と
// 完全一致のときだけ）。選べなければ Base の通常経路へ落とす。XRPL と同じく secondary を枠に入れる。
// BNB（2026-10-19・段B2）: 実測で eip155:56 の accept は 1,106 件。BNB が先頭なのは 1 件だけで、
// 1,105 件は Base が主ネットワーク。Celo と同じく secondary を枠に入れる。署名するのは USD1 の eip3009 だけ
// （下の LANE_SECONDARY_ACCEPT_FILTER）。permit2・USDT だけの行は枠に載せない。
// Arbitrum（2026-10-22）: 実測で eip155:42161 の accept は CDP Bazaar 28,000 件中 5,890 件・331 ホスト（2026-10-21）。
// Celo と同じく secondary を枠に入れる。署名するのはネイティブ USDC だけ。USDC.e だけの行は selectAccept が断る。
// Avalanche（2026-10-26）: 実測で eip155:43114 のネイティブ USDC（name "USD Coin"）は 902 件・23 ホスト。
// 先頭が Avalanche の行は 0 件。全部 2 番目以降なので secondary を枠に入れる。
// extra.name が GatewayWalletBatched の accept（1,670 件・9 ホスト）は Circle Gateway の別経路なので外す。
const LANE_SECONDARY_ACCEPTS: Record<CappedChain, boolean> = { solana: false, arc: true, tempo: false, xrpl: true, celo: true, stellar: true, bnb: true, arbitrum: true, avalanche: true, arc_gateway: false };

/**
 * secondary の枝で raw_accepts の accept（SQL の別名 `a`）に足す条件。XRPL は RLUSD（hex か literal）かつ
 * 固定発行者の accept を持つ行だけを枠に入れる——XRP 建て・USDC IOU しか無い行を枠に載せても
 * selectXrplSecondaryAccept が断って Base で買われるだけで、枠（1 回 5 件）を無駄にする。
 */
const LANE_SECONDARY_ACCEPT_FILTER: Partial<Record<CappedChain, SQL>> = {
  xrpl: sql`AND (upper(a->>'asset') = ${RLUSD_CURRENCY_HEX} OR a->>'asset' = 'RLUSD') AND a->'extra'->>'issuer' = ${RLUSD_ISSUER}`,
  // Stellar: classic USDC か SAC だけ。XLM だけの行を枠に載せても selectStellarAccept が断って Base で買われる。
  stellar: sql`AND (a->>'asset' = ${STELLAR_USDC_CLASSIC} OR a->>'asset' = ${STELLAR_USDC_SAC})`,
  // BNB: USD1 の eip3009 だけ。permit2・permit2-exact・USDC(BSC)・USDT・United Stables は枠に載せない
  // （載せても selectAccept が断って Base で買われるだけで、枠を埋める）。asset は大小を無視する。
  bnb: sql`AND lower(a->>'asset') = ${BNB_CHAIN.usdc.toLowerCase()} AND a->'extra'->>'assetTransferMethod' = 'eip3009'`,
  // Arbitrum（2026-10-22 審査）: ネイティブ USDC で、eip3009（または方式の記載なし）だけ。USDC.e・permit2 だけの行を
  // 枠に載せても selectAccept が断って Base で買われるだけで、枠を埋める（BNB で直した型と同じ）。
  arbitrum: sql`AND lower(a->>'asset') = ${ARBITRUM_CHAIN.usdc.toLowerCase()} AND coalesce(a->'extra'->>'assetTransferMethod', 'eip3009') = 'eip3009'`,
  // Avalanche（2026-10-26）: ネイティブ USDC で、eip3009（または方式の記載なし）だけ。USDC.e・EURC・permit2 だけの行は
  // 枠に載せない。extra.name が GatewayWalletBatched の accept は Circle Gateway の別経路なので、同じ資産アドレスでも外す
  // （載せると枠を埋め、署名の関門 hasCanonicalUsdcDomain が断って Base で買われるだけになる）。
  avalanche: sql`AND lower(a->>'asset') = ${AVALANCHE_CHAIN.usdc.toLowerCase()} AND coalesce(a->'extra'->>'assetTransferMethod', 'eip3009') = 'eip3009' AND coalesce(a->'extra'->>'name','') <> 'GatewayWalletBatched'`,
  // Arc: GatewayWalletBatched はネイティブ枠に入れない（BNB と同じ型）。旗 off のとき
  // Gateway だけの行が no_eligible_accept で枠を埋め、旗 on のとき Base で買える行が
  // Arc の枠に入って「Arc の購入がまだ無い」のまま戻ってくるのを止める。
  arc: sql`AND coalesce(a->'extra'->>'name','') <> 'GatewayWalletBatched'`,
};

/**
 * レーン枠の取得に足す前置きの絞り込み（2026-10-27）。
 *
 * 本番の読み取り（EXPLAIN ANALYZE・2026-10-27）: secondary の枝を持つレーン（Arc・XRPL・Celo・BNB・Arbitrum・
 * Avalanche・Stellar）と Gateway の取得は、active の約 7.7 万行すべてで raw_accepts を jsonb_array_elements に
 * 展開してから捨てていた（1 本 0.5〜1.2 秒。secondary の無い Solana・Tempo は同じ走査で 0.07 秒）。
 *
 * ここで足すのは、下のレーンの条件（主ネットワークの一致、または raw_accepts のいずれかの要素の network の一致）から
 * そのまま導ける**弱い**条件だけ: 「主ネットワークが一致する、または raw_accepts がその network の要素を含む（@>）」。
 * レーンの条件は 1 文字も変えずに残すので、選ぶ行と並びは変わらない（tests/l1-lane-prefilter.pg.test.ts）。
 * 包含（@>）は展開せずに比べるので、ほとんどの行はここで安く落ちる。
 *
 * networkLike にワイルドカード（% _ \\）がある取得（Solana の `solana:%`）は、LIKE と @> の完全一致が同じ意味に
 * ならないので足さない（secondary の枝も持たない）。Gateway（`%`）だけは出品の条件の側から導く（下）。
 */
export function laneNetworkPrefilterSql(lane: { chain: CappedChain; networkLike: string }): SQL {
  // Gateway の取得（networkLike は "%"）: 出品の条件は gatewayCandidateInclusionSql の existsGateway（scheme exact・
  // network eip155:5042・extra.name GatewayWalletBatched ほか）と POST 本文の目録宣言（gatewayCandidateRequestShapeSql）。
  // そのうち文字列の完全一致の 3 つだけを包含で前に置く（version は数でも '1' になるので入れない）。existsGateway が真なら必ず真。
  if (lane.chain === "arc_gateway") {
    return sql`AND e.raw_accepts @> ${JSON.stringify([{ scheme: "exact", network: ARC_CAIP2, extra: { name: "GatewayWalletBatched" } }])}::jsonb ${gatewayCandidateRequestShapeSql()}`;
  }
  if (!LANE_SECONDARY_ACCEPTS[lane.chain] || /[%_\\]/.test(lane.networkLike)) return sql``;
  return sql`AND (e.network LIKE ${lane.networkLike} OR e.raw_accepts @> ${JSON.stringify([{ network: lane.networkLike }])}::jsonb)`;
}

/**
 * Celo レーンで、1 回の取得が同じホストから取る出品の上限。
 * JS の LANE_FLOOR_MAX_PER_HOST は LIMIT の後なので、出品の多い 1 ホストが
 * 取得窓（枠 × LANE_FLOOR_OVERSAMPLE、上限 LANE_FLOOR_FETCH_MAX）を埋めると
 * 他のホストは窓に入らない。Celo だけ、LIMIT の前に同じ上限を掛ける。
 */
export const CELO_LANE_MAX_LISTINGS_PER_HOST = 2;

/**
 * ホストの Celo 試行数。reader.ts の PAID_ATTEMPT_STATUSES と同じ並び。
 * l1-runner は reader を import しない（購入の実行側から読み取り側を引かない）。
 * 署名前の skip（budget_denied など）は試行に数えない。
 */
export const CELO_HOST_ATTEMPT_STATUSES = [
  "settled",
  "settle_failed",
  "delivered_no_receipt",
  "settle_claimed_unverifiable",
  "settle_claimed",
  "settle_claim_refuted",
] as const;

/**
 * Celo・Avalanche の候補の並びの最初のキー（2026-10-28・Prezenti M3 と Team1 の数え方）。「試した売り手」は
 * ホストではなく運営者（payTo）で数える。10/27 の Celo の SiteCheck は 9 ホストが同じ payTo
 * 0xb8491f…（/.well-known/x402 の name もどれも SiteCheck）なので、1 ホストを試したら、ほかの 8 ホストは後ろへ回す。
 *
 * 段（小さいほど先）:
 *   0  その network で資格情報を出した行（auth_nonce IS NOT NULL）が、その payTo にまだ無い
 *   1  資格情報は出したが、Celo では証拠の列（payment_payload IS NOT NULL）のある行がまだ無い（M3 の証拠のため 1 回買い直す）
 *   2  Celo で証拠の列つきの行がある（組み立て失敗の印 {error: "evidence_build_failed"} だけの行は 1 のまま）
 * Avalanche は段 0 と 1 だけ（資格情報を出したら 1）。
 *
 * payTo は小文字で比べる。購入の側は x402_l1_purchases.pay_to、出品の側はその network の accept の payTo
 * （SELECT の celo_declared_accepts / avalanche_declared_accepts）と、主ネットワークがその network の行の e.pay_to。
 *
 * 共有の payTo（集約型の仲介）: active の出品で、その network の accept が同じ payTo を LANE_SHARED_PAYTO_MIN_HOSTS
 * 以上のホストに出しているとき、その payTo は運営者の印にしない。その payTo の「試した」は同じホストの行だけで見る
 * （1 つの売り手を試しても、同じ受取先を使うほかの売り手を後ろへ回さない）。10/28 の公開カタログ（CDP Bazaar）では、
 * Celo・Avalanche で最も多いのは SiteCheck の 9 ホストで、10 以上の payTo は無い。
 *
 * 並びだけを変える。上限（日次・チェーン別・売り手別）・予約・署名の順・金の条件・候補に入る行は変えない。
 */
export const LANE_SHARED_PAYTO_MIN_HOSTS = 10;

function lanePayToTierCtes(network: string, threeTier: boolean): SQL {
  return sql`
    lane_tried_payto AS MATERIALIZED (
      SELECT lower(tp.pay_to) AS pay_to,
             ${censusHostSql(sql`te.resource_key`)} AS host,
             -- 証拠の組み立てに失敗した印（buildPurchaseEvidence の {error: "evidence_build_failed"}）は証拠に数えない。
             max(CASE WHEN ${threeTier ? sql`tp.payment_payload IS NOT NULL AND tp.payment_payload->'error' IS NULL` : sql`false`} THEN 2 ELSE 1 END)::int AS tier
      FROM x402_l1_purchases tp
      JOIN x402_endpoints te ON te.id = tp.endpoint_id
      WHERE tp.network = ${network}
        AND tp.auth_nonce IS NOT NULL
        AND tp.pay_to IS NOT NULL AND tp.pay_to <> ''
      GROUP BY 1, 2
    ),
    lane_shared_payto AS MATERIALIZED (
      SELECT lower(sa->>'payTo') AS pay_to
      FROM x402_endpoints se
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(se.raw_accepts) = 'array' THEN se.raw_accepts ELSE '[]'::jsonb END) sa
      WHERE se.status = 'active'
        AND se.raw_accepts @> ${JSON.stringify([{ network }])}::jsonb
        AND sa->>'network' = ${network}
        AND sa->>'payTo' IS NOT NULL AND sa->>'payTo' <> ''
      GROUP BY 1
      HAVING count(DISTINCT ${censusHostSql(sql`se.resource_key`)}) >= ${LANE_SHARED_PAYTO_MIN_HOSTS}
    )`;
}

function lanePayToTierSql(network: string, declaredAccepts: SQL): SQL {
  return sql`coalesce((
          SELECT max(lt.tier)
          FROM lane_tried_payto lt
          WHERE lt.pay_to IN (
                  SELECT lower(da->>'payTo')
                  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${declaredAccepts}) = 'array' THEN ${declaredAccepts} ELSE '[]'::jsonb END) da
                  WHERE da->>'network' = ${network} AND da->>'payTo' IS NOT NULL
                  UNION ALL
                  SELECT lower(base.pay_to) WHERE base.network = ${network} AND base.pay_to IS NOT NULL
                )
            AND (lt.pay_to NOT IN (SELECT ls.pay_to FROM lane_shared_payto ls)
                 OR lt.host = ${censusHostSql(sql`base.resource_key`)})
        ), 0)::int`;
}

/** Celo レーンの取得だけ、ホストの幅を広げる包みを掛ける。census と他レーンは掛けない。 */
export function celoLaneUsesHostSpread(lane: { chain: string } | undefined, census: boolean): boolean {
  return lane?.chain === "celo" && !census;
}

/**
 * Celo レーンの候補を、ホストあたり CELO_LANE_MAX_LISTINGS_PER_HOST 件に絞ってから
 * payTo の段（lanePayToTierSql・2026-10-28）の小さい順、次にホストの Celo 試行数の少ない順に並べる。同点は内側の並び（需要・未購入・優先・
 * 品質・最終試行・first_seen・id）のまま。試行は network が eip155:42220 の
 * CELO_HOST_ATTEMPT_STATUSES だけ。
 */
function celoDiversifiedCandidatesSql(inner: SQL, limit: number): SQL {
  const statuses = sql.join(
    CELO_HOST_ATTEMPT_STATUSES.map((st) => sql`${st}`),
    sql`, `,
  );
  return sql`
    WITH ${lanePayToTierCtes(CELO_CAIP2, true)}
    SELECT ranked.* FROM (
      SELECT c.*, row_number() OVER (
        PARTITION BY c.celo_host
        ORDER BY c.celo_ord_tier DESC,
                 c.celo_ord_unbought DESC,
                 c.celo_ord_priority DESC,
                 c.celo_ord_payers DESC NULLS LAST,
                 c.celo_ord_calls DESC NULLS LAST,
                 c.celo_ord_last ASC NULLS FIRST,
                 c.celo_ord_seen ASC NULLS LAST,
                 c.id ASC
      ) AS celo_host_rn
      FROM (
        SELECT base.*,
               ${censusHostSql(sql`base.resource_key`)} AS celo_host,
               ${lanePayToTierSql(CELO_CAIP2, sql`base.celo_declared_accepts`)} AS celo_payto_tier,
               coalesce(tries.n, 0)::int AS celo_host_attempts,
               coalesce(unpaid.n, 0)::int AS celo_host_unpaid_7d
        FROM (${inner}) base
        LEFT JOIN (
          SELECT ${censusHostSql(sql`he.resource_key`)} AS host, count(*)::int AS n
          FROM x402_l1_purchases att
          JOIN x402_endpoints he ON he.id = att.endpoint_id
          WHERE att.network = ${CELO_CAIP2}
            AND att.status IN (${statuses})
          GROUP BY 1
        ) tries ON tries.host = ${censusHostSql(sql`base.resource_key`)}
        -- A host that ends before payment every time (no 402, no eligible accept, request error) keeps 0 paid
        -- attempts. Its rows of the last 7 days that never reached a payment push it back, so it does not take
        -- the Celo slots run after run (review of 34dfea05).
        LEFT JOIN (
          SELECT ${censusHostSql(sql`ue.resource_key`)} AS host, count(*)::int AS n
          FROM x402_l1_purchases un
          JOIN x402_endpoints ue ON ue.id = un.endpoint_id
          WHERE un.attempted_at >= now() - interval '7 days'
            AND un.status NOT IN (${statuses})
          GROUP BY 1
        ) unpaid ON unpaid.host = ${censusHostSql(sql`base.resource_key`)}
      ) c
    ) ranked
    WHERE ranked.celo_host_rn <= ${CELO_LANE_MAX_LISTINGS_PER_HOST}
    ORDER BY ranked.celo_payto_tier ASC,
             ranked.celo_host_attempts ASC,
             ranked.celo_host_unpaid_7d ASC,
             ranked.celo_ord_tier DESC,
             ranked.celo_ord_unbought DESC,
             ranked.celo_ord_priority DESC,
             ranked.celo_ord_payers DESC NULLS LAST,
             ranked.celo_ord_calls DESC NULLS LAST,
             ranked.celo_ord_last ASC NULLS FIRST,
             ranked.celo_ord_seen ASC NULLS LAST,
             ranked.id ASC
    LIMIT ${limit}
  `;
}

/**
 * Avalanche レーンで、1 回の取得が同じホストから取る出品の上限。
 * Celo と同じ理由（JS の LANE_FLOOR_MAX_PER_HOST は LIMIT の後なので、出品の多い 1 ホストが窓を埋める）。
 * Avalanche だけ、LIMIT の前に同じ上限を掛ける。Celo の SQL 文は変えない。
 */
export const AVALANCHE_LANE_MAX_LISTINGS_PER_HOST = 2;

/** Avalanche レーンの取得だけ、ホストの幅を広げる包みを掛ける。census と他レーンは掛けない。 */
export function avalancheLaneUsesHostSpread(lane: { chain: string } | undefined, census: boolean): boolean {
  return lane?.chain === "avalanche" && !census;
}

/**
 * Avalanche レーンの候補を、ホストあたり AVALANCHE_LANE_MAX_LISTINGS_PER_HOST 件に絞ってから
 * payTo の段（lanePayToTierSql・2026-10-28。Avalanche は 0 と 1 だけ）の小さい順、次に
 * ホストの Avalanche 試行数の少ない順、次に直近 7 日の未入金試行の少ない順に並べる。
 * 試行（paid）は network が eip155:43114 の CELO_HOST_ATTEMPT_STATUSES だけ。
 * 未入金の数えはネットワークで絞らない（Celo と同じ。支払いの前に終わった試行はどの network でも後ろへ回す）。
 * まだ試していないホストが先。同点は内側の並びのまま。
 */
function avalancheDiversifiedCandidatesSql(inner: SQL, limit: number): SQL {
  const statuses = sql.join(
    CELO_HOST_ATTEMPT_STATUSES.map((st) => sql`${st}`),
    sql`, `,
  );
  return sql`
    WITH ${lanePayToTierCtes(AVALANCHE_CAIP2, false)}
    SELECT ranked.* FROM (
      SELECT c.*, row_number() OVER (
        PARTITION BY c.avax_host
        ORDER BY c.avax_ord_tier DESC,
                 c.avax_ord_unbought DESC,
                 c.avax_ord_priority DESC,
                 c.avax_ord_payers DESC NULLS LAST,
                 c.avax_ord_calls DESC NULLS LAST,
                 c.avax_ord_last ASC NULLS FIRST,
                 c.avax_ord_seen ASC NULLS LAST,
                 c.id ASC
      ) AS avax_host_rn
      FROM (
        SELECT base.*,
               ${censusHostSql(sql`base.resource_key`)} AS avax_host,
               ${lanePayToTierSql(AVALANCHE_CAIP2, sql`base.avalanche_declared_accepts`)} AS avax_payto_tier,
               coalesce(tries.n, 0)::int AS avax_host_attempts,
               coalesce(unpaid.n, 0)::int AS avax_host_unpaid_7d
        FROM (${inner}) base
        LEFT JOIN (
          SELECT ${censusHostSql(sql`he.resource_key`)} AS host, count(*)::int AS n
          FROM x402_l1_purchases att
          JOIN x402_endpoints he ON he.id = att.endpoint_id
          WHERE att.network = ${AVALANCHE_CAIP2}
            AND att.status IN (${statuses})
          GROUP BY 1
        ) tries ON tries.host = ${censusHostSql(sql`base.resource_key`)}
        LEFT JOIN (
          SELECT ${censusHostSql(sql`ue.resource_key`)} AS host, count(*)::int AS n
          FROM x402_l1_purchases un
          JOIN x402_endpoints ue ON ue.id = un.endpoint_id
          WHERE un.attempted_at >= now() - interval '7 days'
            AND un.status NOT IN (${statuses})
          GROUP BY 1
        ) unpaid ON unpaid.host = ${censusHostSql(sql`base.resource_key`)}
      ) c
    ) ranked
    WHERE ranked.avax_host_rn <= ${AVALANCHE_LANE_MAX_LISTINGS_PER_HOST}
    ORDER BY ranked.avax_payto_tier ASC,
             ranked.avax_host_attempts ASC,
             ranked.avax_host_unpaid_7d ASC,
             ranked.avax_ord_tier DESC,
             ranked.avax_ord_unbought DESC,
             ranked.avax_ord_priority DESC,
             ranked.avax_ord_payers DESC NULLS LAST,
             ranked.avax_ord_calls DESC NULLS LAST,
             ranked.avax_ord_last ASC NULLS FIRST,
             ranked.avax_ord_seen ASC NULLS LAST,
             ranked.id ASC
    LIMIT ${limit}
  `;
}

/**
 * 主候補から外す。network が Arc で、Arc の accept が GatewayWalletBatched だけの行。
 * 旗 off の gatewayPrimaryExclusionSql は空なので、ここが無いと主ネットワークを Arc にした
 * Gateway だけの行がネイティブ Arc の主掃引に戻り、no_eligible_accept を書き続ける。
 * レーン枠の primary 枝と同じ条件。Gateway レーンの inclusion には掛けない。
 */
function nativeArcGatewayOnlyExclusionSql(): SQL {
  const arc = "eip155:5042";
  // Gateway だけの行だけを外す。Base の exact も持つ行（主ネットワークが Arc でも）は
  // 主掃引に残し、Base で買う。レーン枠の primary 枝とは違い、他チェーンの accept は残す。
  return sql`AND NOT (
    e.network LIKE ${arc}
    AND jsonb_typeof(e.raw_accepts) = 'array'
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.raw_accepts) g WHERE g->>'network' LIKE ${arc} AND coalesce(g->'extra'->>'name','') = 'GatewayWalletBatched')
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(e.raw_accepts) n
      WHERE coalesce(n->'extra'->>'name','') <> 'GatewayWalletBatched'
        AND coalesce(n->>'scheme', 'exact') = 'exact'
    )
  )`;
}

/**
 * OBSERVATORY_SOLANA_SECRET_KEY: JSON配列（solana-keygenの出力）または
 * base64。どちらも64バイトのsecret keyへ落ちる。壊れていれば null
 * （fail-closed: 鍵が読めない状態でSolana候補は選ばれない）。
 */
export function loadSolanaKeypair(): Keypair | null {
  const raw = process.env.OBSERVATORY_SOLANA_SECRET_KEY?.trim() ?? "";
  if (!raw) return null;
  try {
    if (raw.startsWith("[")) {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[]));
    }
    return Keypair.fromSecretKey(Uint8Array.from(Buffer.from(raw, "base64")));
  } catch {
    return null;
  }
}

const USDC_PER_USD = 1_000_000;

/** 本物の blockhash 取得（テストは options.getSolanaBlockhash で差し替える）。 */
async function defaultSolanaBlockhash(): Promise<string> {
  const { Connection } = await import("@solana/web3.js");
  // 2026-09-02 監査是正: 決済索引と同じく、RPC 未設定は公開 RPC へ無言で落ちず fail-loud。
  const rpc = process.env.SOLANA_RPC_URL;
  if (!rpc) throw new Error("solana_rpc_unset: set SOLANA_RPC_URL before enabling Solana L1 purchases");
  const conn = new Connection(rpc, "confirmed");
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  return blockhash;
}

/**
 * XRPL の署名器（xrpl402-payer.ts）。**フラグが立っているときだけ動的に読む**——OFF の本番バンドルに
 * `xrpl` を入れない（payer-funds と同じ作法・2026-09-17 レビュー #7e）。
 */
type XrplPayerModule = typeof import("./xrpl402-payer");
async function loadXrplPayerModule(): Promise<XrplPayerModule | null> {
  if (process.env.OBSERVATORY_XRPL_L1_ENABLED !== "true") return null;
  return await import("./xrpl402-payer");
}

/**
 * XRPL の署名に要る Sequence・validated ledger・手数料（テストは options.getXrplSigningInputs で差し替える）。
 * `feeDrops: null` は「網の open_ledger_fee が上限 1,000 drops を超えている」——そのバッチの XRPL は署名しない。
 */
export type XrplSigningInputs = { sequence: number; validatedLedgerIndex: number; feeDrops?: string | null };
/** XRPL_RPC_URL 未設定は createXrplJsonRpc が throw（公開 RPC へ無言で倒れない）。手数料は `fee` を 1 回読み、上限 1,000 drops。 */
async function defaultXrplSigningInputs(address: string): Promise<XrplSigningInputs> {
  const { createXrplJsonRpc, getAccountSequence, getNetworkFeeDrops, getValidatedLedgerIndex } = await import("./xrpl402-payer");
  const rpc = createXrplJsonRpc();
  const [sequence, validatedLedgerIndex, feeDrops] = await Promise.all([getAccountSequence(address, rpc), getValidatedLedgerIndex(rpc), getNetworkFeeDrops(rpc)]);
  return { sequence, validatedLedgerIndex, feeDrops };
}

/**
 * Stellar の署名器（stellar402-payer.ts）。**フラグが立っているときだけ動的に読む**——OFF の本番バンドルに
 * `@x402/stellar` を入れない（XRPL の loadXrplPayerModule と同じ作法）。
 */
type StellarPayerModule = typeof import("./stellar402-payer");
async function loadStellarPayerModule(): Promise<StellarPayerModule | null> {
  if (process.env.OBSERVATORY_STELLAR_L1_ENABLED !== "true") return null;
  return await import("./stellar402-payer");
}

/**
 * createStellarPaymentPayload が付けた印。auth entry に署名する前だけ true。
 * 署名後（`stellar_sign_failed_post:`）と、印の無い誤りは false（予約を残し、Base では買わない）。
 */
function stellarSignFailedPre(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("stellar_sign_failed_pre:");
}

/** テストが差し替える署名口。既定は createStellarPaymentPayload（Soroban RPC へ出る）。 */
export type StellarPaymentInput = { accept: ChallengeAccept; signingAsset: string; stellarUnits: bigint };
async function defaultCreateStellarPayment(input: StellarPaymentInput): Promise<{ transaction: string }> {
  const { createStellarPaymentPayload } = await import("./stellar402-payer");
  return createStellarPaymentPayload(input);
}

const guardedFetch = createSafeFetchImpl();

/** The daily cap in USDC base units — the same $25 checkL1Budget judges in USD. */
const DAILY_BUDGET_UNITS = BigInt(DAILY_BUDGET_USD) * BigInt(USDC_PER_USD);

/**
 * バッチ全体の壁時計予算（2026-08-22 監査・Critical の後半）。
 *
 * /api/cron/l1-purchase は maxDuration=300s。runL1Batch は limit=100 件を
 * 逐次処理するのに全体のデッドラインを持っておらず、300s を越えた瞬間に
 * **署名済み・予約済みの購入が記帳される前に殺される**——in_flight の行だけ
 * が残り「金が動いたかもしれないのにレシートが無い」最悪の落ち方をする。
 *
 * 対策は「走っている購入を殺す」ではなく「**新しい購入を始めない**」。
 * 1件の最悪ケースは HTTP 2本（各 timeoutMs・本文読み取り込み）＋ 署名・
 * 予約・記帳・Solana の blockhash RPC で、後者を L1_PURCHASE_SLACK_MS で
 * 見積もる。既定では 210s + (20s + 20s + 20s) = 270s < 300s なので、
 * デッドライン直前に始めた1件が最悪でも maxDuration の内側で終わる。
 * Celo の候補は支払い付きだけ 45s（無払いは 20s のまま）なので
 * 210s + (20s + 45s + 20s) = 295s。ルートの maxDuration 300s の内側。
 * 45s を 2 本分見込むと 210s + 110s で 300s を超えるので、見込まない。
 */
export const L1_BATCH_BUDGET_MS = 210_000;

/** 1購入あたり、2本の HTTP 以外（署名・DB・blockhash RPC）に見込む余裕。 */
export const L1_PURCHASE_SLACK_MS = 20_000;

/**
 * 1件の購入の最悪所要時間。無払いは timeoutMs、支払い付きは paidTimeoutMs。
 * paidTimeoutMs を省くと両方 timeoutMs（従来の timeoutMs * 2 + slack と同じ）。
 */
export function worstCasePurchaseMs(timeoutMs: number, paidTimeoutMs: number = timeoutMs): number {
  return timeoutMs + paidTimeoutMs + L1_PURCHASE_SLACK_MS;
}

/**
 * 残り時間で「もう1件」始めてよいか。純関数（DB なしでテストするため公開）。
 * 判定は最悪ケース基準——平均で判断すると、遅い1件が maxDuration を跨ぐ。
 * paidTimeoutMs は Celo の候補だけ大きい方を渡す（paidTimeoutForBudget）。
 */
export function canStartAnotherPurchase(remainingMs: number, timeoutMs: number, paidTimeoutMs: number = timeoutMs): boolean {
  return remainingMs >= worstCasePurchaseMs(timeoutMs, paidTimeoutMs);
}

/**
 * 予算が見込む支払い付きの待ち。候補が Celo レーン（laneChain か主ネットワーク）なら、
 * 無払いの timeoutMs と Celo の支払い付きの待ちの大きい方。ほかの候補は timeoutMs のまま。
 */
export function paidTimeoutForBudget(
  candidate: { network: string | null; laneChain: string | null },
  timeoutMs: number,
  celoPaidTimeoutMs: number = L1_CELO_PAID_TIMEOUT_MS,
): number {
  const celoLane = candidate.laneChain === "celo" || candidate.network === CELO_CAIP2;
  if (!celoLane) return timeoutMs;
  return Math.max(timeoutMs, l1PaidTimeoutMs(CELO_CAIP2, { timeoutMs, celoPaidTimeoutMs }));
}

/** Endpoints purchased within this window are not re-purchased (1判定1購買). */
export const SWEEP_WINDOW_DAYS = 6;

/**
 * Sellers with independently verified organic demand (要件定義v2 2026-08-14
 * §0.5): the rikocr8orh8 Bazaar survey (data 2026-07-28, methodology
 * reproducible, verified against the primary source) names these four as
 * carrying 73% of ALL organic Bazaar calls. The moat is the receipt
 * TIME-SERIES — a settle-through record with 3+ points on an endpoint buyers
 * actually depend on is worth more than 3 one-shot rows on the long tail —
 * so these hosts are pinned to the head of candidate selection and swept on
 * the shorter window below.
 */
export const PRIORITY_SELLER_HOSTS = [
  "x402.twit.sh",
  "x402.tavily.com",
  "stableenrich.dev",
  "api.exa.ai",
];

/** Priority sellers may be re-purchased daily — repeats build the series. */
export const PRIORITY_SWEEP_WINDOW_DAYS = 1;

/**
 * 証拠が溜まったエンドポイントの買い直し間隔（2026-09-16）。
 *
 * 公開台帳 export.csv?days=30 の実測（2026-09-16）: 30 日で $83.81・成立 2,639 件・
 * エンドポイント 1,743。うち **初回購入 55.5%（$46.54）／買い直し 44%（$37.27）**。
 * カタログは増え続けるので、全件を 6 日間隔で回し続けると、買い直しの側だけが
 * 単調に積み上がる（この形のまま年 $3,400 に向かう）。
 *
 * 判断は「何件あれば、その売り手について言えることが変わらなくなるか」。成立を
 * 3 件積んだ相手に 4 件目を足しても、公開する所見（決済する／届く）は動かない。
 * だから成熟したエンドポイントは 30 日間隔へ落とし、空いた枠を**まだ何も測って
 * いない相手**へ回す。分母（掃引の対象）は減らさない——間隔が延びるだけで、
 * L0 の生存観測も公開台帳の行もそのまま残る。
 */
export const MATURE_SWEEP_WINDOW_DAYS = 30;

/** 「成熟」の線。status='settled' だけを数える（下の settledCountSql を見よ）。 */
export const MATURE_SETTLED_MIN = 3;

/**
 * その UTC 日に許す**初回購入**の件数（2026-09-16）。
 *
 * 9/02 週に $47.66 と跳ねたのは、カタログへ 1,059 件が一度に入って初回購入が
 * 一斉に走ったから。日次 $25 の上限はそれ自体は正しく働いたが、上限に張り付いた
 * 日は買い直し（＝時系列の密度＝堀）が押し出される。枠は上限の代わりではなく、
 * **上限の内側で初回購入と買い直しの取り分を決める**ためのもの。
 *
 * 枠に達した日は「購入行がまだ 1 件も無いエンドポイント」だけを候補から外す。
 * 行は書かない——書けばスイープ窓のあいだ再選択されず、翌日の枠にも戻らない。
 */
export const FIRST_PURCHASE_DAILY_QUOTA = 120;

/**
 * resource_key is host+path; a priority host matches itself and any path under
 * it — but NOTHING else. The old `${h}%` matched any prefix, so a look-alike
 * host an attacker can register (`api.exa.aique.com/paid` under `api.exa.ai%`,
 * `x402.twit.shady.io/x` under `x402.twit.sh%`) would be pinned to the head of
 * candidate selection and re-purchased daily, siphoning the $25/day budget off
 * the real priority sellers. Anchoring each host on an exact match OR a `/`
 * path boundary closes that. SQL patterns and the JS predicate below are both
 * derived from the same host list so they cannot drift.
 */
const PRIORITY_PATTERNS = PRIORITY_SELLER_HOSTS.flatMap((h) => [h, `${h}/%`]);

/**
 * True iff a catalog resource_key belongs to a priority host: exactly the host,
 * or the host followed by a `/` path. Case-insensitive to mirror SQL ILIKE.
 * Exported for direct testing without a database.
 */
export function isPriorityResourceKey(resourceKey: string): boolean {
  const key = resourceKey.toLowerCase();
  return PRIORITY_SELLER_HOSTS.some((h) => {
    const host = h.toLowerCase();
    return key === host || key.startsWith(`${host}/`);
  });
}

// Operator (self) payTo denylist — the addresses L1 must never buy from — lives
// in the dependency-light ./operator module so the public read path can share
// it. Re-exported here for existing callers.
export { operatorPayToDenylist };

/**
 * `ILIKE ANY(ARRAY[$1, $2, …]::text[])` with each pattern as its own bound
 * parameter — a bare JS array binds as a single scalar on postgres-js and
 * fails with 42809 (wrong object type).
 */
const prioritySqlArray = () =>
  sql`ARRAY[${sql.join(PRIORITY_PATTERNS.map((p) => sql`${p}`), sql`, `)}]::text[]`;

/**
 * 成熟の判定に数える行は **status='settled' だけ**。
 *
 * ここを「有料試行の件数」にすると、決済しない売り手ほど速く成熟して測られなく
 * なる——検証者としては逆向きの誘因になる。settle_claimed（主張はあるが未照合）も
 * 数えない: 照合が済んでいない主張は、まだ我々の証拠ではない。
 */
const settledCountSql = (endpointRef: SQL) => sql`(
    SELECT count(*) FROM x402_l1_purchases s
    WHERE s.endpoint_id = ${endpointRef} AND s.status = 'settled'
  )`;

/**
 * 候補 SQL のスイープ窓。**優先売り手を最初に判定する**——成熟の条件（成立 3 件）
 * は優先売り手ほど先に満たすので、順番を逆にすると堀そのものが 30 日間隔へ落ちる。
 * JS 側の sweepWindowDaysFor が同じ順番を持つ（予約もこの窓で締める）。
 */
const sweepWindowDaysSql = (endpointRef: SQL, resourceKeyRef: SQL) => sql`(CASE
            WHEN ${resourceKeyRef} ILIKE ANY(${prioritySqlArray()}) THEN ${PRIORITY_SWEEP_WINDOW_DAYS}::int
            WHEN ${settledCountSql(endpointRef)} >= ${MATURE_SETTLED_MIN} THEN ${MATURE_SWEEP_WINDOW_DAYS}::int
            ELSE ${SWEEP_WINDOW_DAYS}::int
          END)`;

/**
 * 予約が締めるスイープ窓。sweepWindowDaysSql と同じ順番（優先売り手が先）。
 * DB 無しで固定できるよう純関数で出す。
 */
export function sweepWindowDaysFor(input: { isPriority: boolean; isMature: boolean }): number {
  if (input.isPriority) return PRIORITY_SWEEP_WINDOW_DAYS;
  return input.isMature ? MATURE_SWEEP_WINDOW_DAYS : SWEEP_WINDOW_DAYS;
}

/**
 * その UTC 日に「それまで購入行の無かったエンドポイント」を買った件数。
 *
 * 数え方は endpoint ごとの min(attempted_at) が今日の 0 時 UTC 以降か——status は
 * 見ない。budget_denied や request_error でも、その endpoint は「今日もう手を
 * 付けた」ので枠を 1 つ使っている（候補 SQL の「未購入」判定＝行の有無とも揃う）。
 */
const firstPurchasesTodayCountSql = () => sql`(
    SELECT count(*) FROM (
      SELECT pu.endpoint_id FROM x402_l1_purchases pu
      GROUP BY pu.endpoint_id
      HAVING min(pu.attempted_at) >= ${utcDayStart()}
    ) f
  )`;

const CENSUS_HOST_SQL = censusHostSql(sql`e.resource_key`);

/** L1 の購入行が 1 件でもあるホスト名（status を問わない・ポート違いも同じ売り手）。NOT IN の相手。resource_key は NOT NULL。 */
const CENSUS_TRIED_HOSTS_SQL = sql`
  SELECT ${censusHostSql(sql`te.resource_key`)}
  FROM x402_l1_purchases tp JOIN x402_endpoints te ON te.id = tp.endpoint_id`;

/**
 * 台帳の受取先の正規化（2026-09-29 監査 5 周目）。0x（EVM）は小文字、base58（Solana）と r アドレス（XRPL）は
 * 原文（小文字化すると別のアドレスになる）。予約は `accept.payTo` を同じ規則で書くので、同じ売り手の行はこの形で揃う。
 */
export function normalizedPayTo(payTo: string): string {
  return /^0x/i.test(payTo) ? payTo.toLowerCase() : payTo;
}

/** normalizedPayTo の SQL 版。 */
const payToNormSql = (col: SQL) => sql`(CASE WHEN ${col} ILIKE '0x%' THEN lower(${col}) ELSE ${col} END)`;

/**
 * L1 で買ってよい出品か（2026-09-29 監査 5 周目・中・お金）: https であり、カタログが受取先（pay_to）を宣言している。
 * 候補 SQL の同じ条件（`e.pay_to IS NOT NULL` と `resource_url LIKE 'https://%'`）の JS 側。
 */
export function isL1PurchasableListing(candidate: { resourceUrl: string; payTo: string | null }): boolean {
  if (candidate.payTo === null || candidate.payTo.trim() === "") return false;
  try {
    return new URL(candidate.resourceUrl).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * 候補 SQL の売り手ごとの日次上限（x402_endpoints e に対する AND 句・2026-09-29 監査 5 周目）。当日の支出が
 * 上限に届いた受取先・ホストの出品を外す。**上限を締めるのは reserveSpend**（ここはバッチ開始時点の値で、
 * 402 を取りに行く無駄を省くだけ）。サブクエリは相関しないので 1 回だけ評価される。NOT IN の相手に NULL を入れない。
 */
function sellerCapExclusionSql(): SQL {
  const cap = String(sellerDailyCapUnits());
  const domainCap = String(domainDailyCapUnits());
  const day = utcDayStart();
  return sql`AND ${payToNormSql(sql`e.pay_to`)} NOT IN (
        SELECT ${payToNormSql(sql`cp_pu.pay_to`)} FROM x402_l1_purchases cp_pu
        WHERE cp_pu.attempted_at >= ${day} AND cp_pu.pay_to IS NOT NULL
        GROUP BY 1 HAVING coalesce(sum(cp_pu.spent_units::numeric), 0) >= ${cap}::numeric)
      AND ${censusHostSql(sql`e.resource_key`)} NOT IN (
        SELECT ${censusHostSql(sql`cp_e.resource_key`)} FROM x402_l1_purchases cp_hu JOIN x402_endpoints cp_e ON cp_e.id = cp_hu.endpoint_id
        WHERE cp_hu.attempted_at >= ${day}
        GROUP BY 1 HAVING coalesce(sum(cp_hu.spent_units::numeric), 0) >= ${cap}::numeric)
      AND ${registeredDomainSql(censusHostSql(sql`e.resource_key`))} NOT IN (
        SELECT ${registeredDomainSql(censusHostSql(sql`cp_d.resource_key`))} FROM x402_l1_purchases cp_du JOIN x402_endpoints cp_d ON cp_d.id = cp_du.endpoint_id
        WHERE cp_du.attempted_at >= ${day}
        GROUP BY 1 HAVING coalesce(sum(cp_du.spent_units::numeric), 0) >= ${domainCap}::numeric)`;
}

/** census の売り手の単位（SQL の censusHostSql と同じ規則: 小文字・末尾の `:ポート` を落とす）。 */
export function censusHostOf(host: string): string {
  return host.toLowerCase().replace(/:[0-9]+$/, "");
}

/** 売り手の登録ドメイン（registered-domain.ts・SQL の registeredDomainSql(censusHostSql(...)) と同じ規則）。 */
export function sellerDomainOf(resourceUrl: string): string {
  return registeredDomainOf(censusHostOf(laneHostOf(resourceUrl)));
}

/** census 系の候補の出どころ（raw_response_meta.selection の値）。 */
export type CensusSelection = "census" | "retest";

/** 宣言本文を送り始めた時刻（正典は request-body.ts・既存の呼び手のための再公開）。 */
export { DECLARED_BODY_SENT_SINCE } from "./request-body";

export { RETEST_SELLERS_SQL };

function unitsToUsd(units: bigint): number {
  return Number(units) / USDC_PER_USD;
}

function rowsOf(raw: unknown): Record<string, unknown>[] {
  return (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Record<
    string,
    unknown
  >[];
}

type Reservation =
  | { ok: true; rowId: string }
  | {
      ok: false;
      reason:
        | "daily_budget_exceeded"
        | "already_purchased"
        /** その network の日次別枠（budget.ts CHAIN_DAILY_CAPS: Solana・Arc）に届かなかった。 */
        | "chain_daily_cap"
        | "first_purchase_quota"
        /**
         * 売り手ごとの日次上限（budget.ts SELLER_DAILY_CAP_USD・2026-09-29 監査 5 周目）に届かなかった。
         * `scope` はどの単位で届いたか（複数なら payto → host → domain の順で先のもの）。
         * domain は登録ドメイン（eTLD+1）ごとの上限（DOMAIN_DAILY_CAP_USD・2026-09-29 監査 6 周目）。
         */
        | "seller_daily_cap";
      scope?: "payto" | "host" | "domain";
    };

/**
 * Claim the spend before it can happen. ONE statement, so the day's total and
 * the sweep-window check are evaluated and the ledger row written without the
 * caller ever holding a stale number: whoever commits first is the one whose
 * money is counted, and the loser is refused.
 *
 * Written as a single statement on purpose — production runs on neon-http,
 * where every query is its own connection and implicit transaction, so
 * multi-statement locking (advisory locks, SELECT ... FOR UPDATE) cannot span
 * a check and its write. What is left uncovered is only the sub-millisecond
 * overlap of two INSERTs whose snapshots predate each other's commit, and its
 * cost is bounded by one purchase (≤ $1), not by a second daily budget.
 */
async function reserveSpend(input: {
  db: NonNullable<ReturnType<typeof getDb>>;
  endpointId: string;
  payer: string;
  network: string;
  asset: string;
  payTo: string;
  amountUnits: string;
  /** Per-candidate: PRIORITY_SWEEP_WINDOW_DAYS for pinned sellers, SWEEP_WINDOW_DAYS otherwise. */
  windowDays: number;
  /**
   * 予約行の raw_response_meta（2026-09-28・census の `{ selection: "census" }`）。null / 省略なら列を
   * 書かない（従来と同じ文）。予約の後に落ちた行（resolveReservationAsFailed・孤児掃除）は
   * raw_response_meta へ継ぎ足すので、ここで置いた印は消えない。金の条件には関わらない。
   */
  meta?: Record<string, unknown> | null;
  /** 初回購入の日次枠（既定 FIRST_PURCHASE_DAILY_QUOTA）。census の候補だけ censusFirstPurchaseQuota（2026-09-29）。 */
  firstPurchaseQuota?: number;
  /**
   * 別枠の名前を明示する（Circle Gateway）。eip155:5042 は cappedChainFor が "arc" を返すので、
   * Gateway の支出はここが "arc_gateway" のときだけ Gateway の別枠に入る。省略時は従来どおり。
   */
  capChain?: CappedChain;
  /**
   * 2026-10-27: その購入で受け取った 402 の記録（purchase-evidence.ts・内部専用の列 challenge_402）。
   * 上限に収めた JSON。null / 省略なら列を書かない。金の条件（WHERE）には関わらない。
   */
  challenge402?: Record<string, unknown> | null;
}): Promise<Reservation> {
  const { db, endpointId, payer, network, asset, payTo, amountUnits, windowDays } = input;
  const metaJson = input.meta ? JSON.stringify(input.meta) : null;
  // 予約と同じ 1 文で書く。この INSERT が落ちれば予約も無い＝署名しない（auth_nonce の UPDATE が落ちたら
  // 有料の要求を出さないのと同じ側に倒す: 記録の無い支払いを出さない）。
  const challengeJson = input.challenge402 ? JSON.stringify(input.challenge402) : null;
  // チェーン別の別枠（budget.ts CHAIN_DAILY_CAPS）。2026-09-15 の Solana の別枠を 2026-09-17 に
  // Arc と共通の表にした。Base は別枠を持たないので CTE も条件も入らない（従来と同じ 1 文）。
  const capChain = cappedChainFor(network);
  const spendCap = input.capChain ?? capChain;
  const capLike = spendCap ? CHAIN_DAILY_CAPS[spendCap].networkLike : null;
  const capUnits = spendCap ? String(chainDailyCapUnits(spendCap)) : null;
  // 初回購入の日次枠は、別枠を持つチェーンには掛けない（2026-09-17 本番: 枠 120 が当日ぶん
  // 使い切られ、Tempo 265 件・XRPL 1 件の候補が「購入行が無い」だけで除外され、レーン枠が
  // 0 だった）。新しいチェーンの掃引は初回購入しか無いので、この枠に当たると永久に始まらない。
  // 支出はそのチェーンの別枠で既に縛られている（既定は $2。Stellar だけ既定 $0.5）。Base の初回購入の枠は従来どおり。
  const firstQuotaApplies = capChain === null;
  const firstQuota = input.firstPurchaseQuota ?? FIRST_PURCHASE_DAILY_QUOTA;
  // 売り手ごとの日次上限（2026-09-29 監査 5 周目・高）。受取先は台帳と同じ正規化（0x は小文字・base58 / r は原文）、
  // ホストは census と同じ単位（resource_key の最初の `/` の前・ポート無視・小文字）。status は見ない
  // （day CTE と同じ——予約した瞬間に数える。署名前に戻した予約は spent_units が 0 なので数に入らない）。
  const sellerCap = String(sellerDailyCapUnits());
  // 登録ドメイン（eTLD+1）ごとの上限（2026-09-29 監査 6 周目・高）: サブドメインと payTo を分けて受取先・ホストの
  // 上限を回避する形を、持ち主の単位で締める。単位は registered-domain.ts（候補 SQL と同じ式）。
  const domainCap = String(domainDailyCapUnits());
  const payToKey = normalizedPayTo(payTo);
  const raw = await db.execute(sql`
    WITH day AS (
      SELECT coalesce(sum(spent_units::numeric), 0) AS spent
      FROM x402_l1_purchases
      WHERE attempted_at >= ${utcDayStart()}
    ), chain_day AS (
      -- その network の別枠の当日支出。Base の定期購入を押し出さない。別枠の無い network は
      -- 何にも一致しないパターンで 0 を返す（条件も付かない）。
      SELECT coalesce(sum(spent_units::numeric), 0) AS spent
      FROM x402_l1_purchases
      WHERE attempted_at >= ${utcDayStart()} AND ${chainCapNetworkSql(spendCap, capLike)}
    ), dup AS (
      SELECT EXISTS (
        SELECT 1 FROM x402_l1_purchases pu
        WHERE pu.endpoint_id = ${endpointId}::uuid
          AND pu.attempted_at > now() - make_interval(days => ${windowDays})
      ) AS taken
    ), first_day AS (
      -- 初回購入の日次枠（FIRST_PURCHASE_DAILY_QUOTA）。候補 SQL がバッチ開始時に
      -- 一度外すが、1 バッチの途中で枠を跨ぐぶんはそこでは止まらない。Solana の
      -- 別枠と同じで、締めるのは予約の側（同じ 1 文の中で数える）。
      SELECT ${firstPurchasesTodayCountSql()} AS n,
             NOT EXISTS (
               SELECT 1 FROM x402_l1_purchases pu WHERE pu.endpoint_id = ${endpointId}::uuid
             ) AS is_first
    ), seller_day AS (
      -- 同じ受取先・同じホストへの当日の支出。同じ 1 文の中で数えるので、読んでから書くまでの間に
      -- 別のバッチの予約が挟まる窓は day CTE と同じ（互いの INSERT が見えないほぼ同時の 2 文だけ・1 件 ≤ $1 まで）。
      SELECT
        coalesce(sum(sp.spent_units::numeric) FILTER (WHERE ${payToNormSql(sql`sp.pay_to`)} = ${payToKey}), 0) AS payto_spent,
        coalesce(sum(sp.spent_units::numeric) FILTER (
          WHERE ${censusHostSql(sql`se.resource_key`)} = (
            SELECT ${censusHostSql(sql`xe.resource_key`)} FROM x402_endpoints xe WHERE xe.id = ${endpointId}::uuid)
        ), 0) AS host_spent,
        coalesce(sum(sp.spent_units::numeric) FILTER (
          WHERE ${registeredDomainSql(censusHostSql(sql`se.resource_key`))} = (
            SELECT ${registeredDomainSql(censusHostSql(sql`xd.resource_key`))} FROM x402_endpoints xd WHERE xd.id = ${endpointId}::uuid)
        ), 0) AS domain_spent
      FROM x402_l1_purchases sp JOIN x402_endpoints se ON se.id = sp.endpoint_id
      WHERE sp.attempted_at >= ${utcDayStart()}
    ), ins AS (
      INSERT INTO x402_l1_purchases
        (endpoint_id, status, payer, network, asset, pay_to, amount_units, spent_units${metaJson === null ? sql`` : sql`, raw_response_meta`}${challengeJson === null ? sql`` : sql`, challenge_402`})
      SELECT ${endpointId}::uuid, 'in_flight', ${payer}, ${network}, ${asset},
             ${payTo}, ${amountUnits}, ${amountUnits}${metaJson === null ? sql`` : sql`, ${metaJson}::jsonb`}${challengeJson === null ? sql`` : sql`, ${challengeJson}::jsonb`}
      FROM day, chain_day, dup, first_day, seller_day
      WHERE NOT dup.taken
        AND day.spent + ${amountUnits}::numeric <= ${String(DAILY_BUDGET_UNITS)}::numeric
        AND seller_day.payto_spent + ${amountUnits}::numeric <= ${sellerCap}::numeric
        AND seller_day.host_spent + ${amountUnits}::numeric <= ${sellerCap}::numeric
        AND seller_day.domain_spent + ${amountUnits}::numeric <= ${domainCap}::numeric
        ${capUnits === null ? sql`` : sql`AND chain_day.spent + ${amountUnits}::numeric <= ${capUnits}::numeric`}
        ${firstQuotaApplies ? sql`AND (NOT first_day.is_first OR first_day.n < ${firstQuota})` : sql``}
      RETURNING id
    )
    SELECT (SELECT id FROM ins)::text AS row_id, (SELECT taken FROM dup) AS taken,
           (SELECT spent FROM chain_day)::text AS chain_spent,
           (SELECT is_first FROM first_day) AS is_first,
           (SELECT n FROM first_day)::text AS first_day_count,
           (SELECT payto_spent FROM seller_day)::text AS payto_spent,
           (SELECT host_spent FROM seller_day)::text AS host_spent,
           (SELECT domain_spent FROM seller_day)::text AS domain_spent
  `);
  const row = rowsOf(raw)[0];
  // No row back at all means the statement did not run as written — refuse to
  // spend on a gate whose verdict we cannot read.
  if (!row) throw new Error("l1 spend reservation returned no verdict row");
  const rowId = typeof row.row_id === "string" && row.row_id !== "" ? row.row_id : null;
  if (rowId) return { ok: true, rowId };
  if (row.taken === true) return { ok: false, reason: "already_purchased" };
  if (firstQuotaApplies && row.is_first === true) {
    const firstCount =
      typeof row.first_day_count === "string" ? Number(row.first_day_count.split(".")[0]) : null;
    // 読めなければ枠が尽きた側へ倒す（行を書かない——書くと掃引の窓ぶん締め出す）。
    if (firstCount === null || !Number.isFinite(firstCount) || firstCount >= firstQuota) {
      return { ok: false, reason: "first_purchase_quota" };
    }
  }
  // 売り手ごとの上限。読めなければ上限に届いた側へ倒す（行を書かない——書くと掃引の窓ぶん締め出す）。
  {
    const cap = BigInt(sellerCap);
    const amount = BigInt(amountUnits);
    const read = (v: unknown): bigint | null => {
      if (typeof v !== "string" || !/^[0-9]+(\.[0-9]+)?$/.test(v)) return null;
      return BigInt(v.split(".")[0]);
    };
    const paytoSpent = read(row.payto_spent);
    const hostSpent = read(row.host_spent);
    if (paytoSpent === null || paytoSpent + amount > cap) return { ok: false, reason: "seller_daily_cap", scope: "payto" };
    if (hostSpent === null || hostSpent + amount > cap) return { ok: false, reason: "seller_daily_cap", scope: "host" };
    const domainSpent = read(row.domain_spent);
    if (domainSpent === null || domainSpent + amount > BigInt(domainCap)) {
      return { ok: false, reason: "seller_daily_cap", scope: "domain" };
    }
  }
  if (spendCap !== null) {
    const chainSpent = typeof row.chain_spent === "string" ? BigInt(row.chain_spent.split(".")[0]) : null;
    // 読めなければ別枠の判定とみなす（行を書かない側へ倒す——書くと 6 日締め出す）
    if (chainSpent === null || chainSpent + BigInt(amountUnits) > chainDailyCapUnits(spendCap)) {
      return { ok: false, reason: "chain_daily_cap" };
    }
  }
  return { ok: false, reason: "daily_budget_exceeded" };
}

/**
 * observed_purchases.delivery_verified の判定（2026-08-22 監査・項目1）。
 *
 * この列は**書き手側の保証**で、読み手（observed-purchases.ts）は導出できず
 * フラグを信じるしかない。だから true にする条件は「品が実際に届いたと
 * 我々が観測した」ことに限る:
 *   - 有料リトライが HTTP 2xx（202 Accepted を除く・delivery.ts isDeliveryHttp）を返し、
 *   - 本文が空でなく（空ボディの200は「届いた」と言えない）、
 *   - 宣言スキーマに対して mismatch でない（宣言があるのに違う形の応答は、
 *     配送の確認になっていない。宣言が無い no_declaration は減点しない）。
 * どれか欠ければ false で**記録する**——行ごと捨てるのではなく、x402 相当の
 * 「決済はした」事実として残す（scoreEconomicActivity はこの差を見ている）。
 *
 * 純関数。DB なしでテストするため公開。
 */
export function isDeliveryVerified(input: {
  httpStatusPaid: number | null;
  payloadNonEmpty: boolean;
  l2Schema: string;
}): boolean {
  return isDeliveryHttp(input.httpStatusPaid) && input.payloadNonEmpty && input.l2Schema !== "mismatch";
}

/**
 * 孤児 `in_flight` の回収しきい値（2026-08-22 監査）。
 *
 * reserveSpend は署名の**前**に in_flight 行を書く（正しい——署名済み
 * EIP-3009 は validBefore まで生きた金なので、記帳より先に予約する）。
 * だが署名後・結果の記帳前に落ちた行を後から解決する仕組みが無く、
 * スイープ窓（既定6日・優先1日）の重複判定は status を見ないので、
 * 孤児が1件でもあるとそのエンドポイントは窓の間ずっと購入対象から
 * 外れ続ける（本番実測 2026-08-22 時点では 0 件）。
 *
 * 30分の根拠: 1件の最悪ケースは worstCasePurchaseMs = 60s、バッチ全体でも
 * cron の maxDuration = 300s が上限。30分はその6倍あるので、**実行中の
 * 別インボケーションの行を誤って回収することはあり得ない**。
 */
/**
 * 署名後失敗が何回続いたら冷却へ入れるか（2026-08-24 監査）。
 *
 * 1回では外さない——正直な売り手も一時的に落ちるし、ネットワークの都合でも
 * 決済は失敗する。3回連続で「署名させたが決済に至らない」なら、それは
 * その壁についての所見であり、予算を投じ続ける理由がない。
 *
 * 冷却は永久ではない: スイープ窓（既定6日・優先1日）を過ぎれば、上の
 * NOT EXISTS が古い試行を見なくなるので自然に対象へ戻る。回復の道を
 * 残さない排除にはしない。
 */
export const NON_SETTLING_COOLDOWN_STREAK = 3;

export const ORPHAN_IN_FLIGHT_MINUTES = 30;

/**
 * 孤児 in_flight を解決する。変えるのは status と raw_response_meta だけで、
 * **spent_units には触らない**——「署名したら計上する」は予算の不変条件で、
 * ここで金額を戻すと、実際に動いたかもしれない金の分だけ当日の予算が
 * 二重に空く。だから day 集計（runL1Batch の日次合計・reserveSpend の day
 * CTE。どちらも status を見ずに spent_units を合計する）は回収の前後で
 * 完全に同じ値を返す。
 *
 * 解決先を `request_error` にする理由: 我々のランナーが死んだという**我々側
 * の事実**であり、売り手についての測定ではない。`settle_failed` に落とすと
 * 測っていない失敗を売り手の決済率の分母（PAID_ATTEMPT_STATUSES）に入れて
 * しまう。request_error は公開面（decisions / export.csv / backtest /
 * reader）のどの分母からも既に外れている。
 *
 * 2026-09-29 監査4周目（例外）: **auth_nonce が NULL の行だけは spent_units を 0 に戻す。**
 * purchaseOne は署名の直後、有料の要求を出す**前**に auth_nonce を書く（4 チェーンとも。
 * それより前に外へ出るのは Tempo の読み取り RPC だけで、資格情報は載らない）。だから
 * auth_nonce が NULL の行の資格情報は、このプロセスの外へ一度も出ていない——動きうる金が無い。
 * 署名直前の停止判定のあと DB 不通で予約を戻せなかった行（:2153 付近）がこれに当たり、
 * 従来はここで spent_units を残したため、日次予算がその日のうちに戻らなかった。
 * auth_nonce が入っている行は従来どおり 1 単位も動かさない。
 *
 * 2026-09-29 独立レビュー（提案2）: **auth_nonce が入っている行の解決先は `settle_failed`**（以前は request_error）。
 * nonce は有料の要求を出す直前に書くので、その行の資格情報は売り手へ届いたかもしれない——売り手は後から決済できる。
 * request_error のままだと遅延回収（recover-late.ts は request_error を「署名していない行」として外す）の対象から外れ、
 * チェーンに着金があっても台帳に結び付かなかった。上の「測っていない失敗を売り手の分母に入れる」懸念は残るが、
 * 払ったかもしれない金を台帳から見失う方を重く見た。行は reason = orphaned_in_flight・credentialSent = true で区別できる。
 * auth_nonce が NULL の行は従来どおり request_error（予約を解放）。
 */
export async function sweepOrphanedInFlight(
  db: NonNullable<ReturnType<typeof getDb>>,
  olderThanMinutes: number = ORPHAN_IN_FLIGHT_MINUTES,
): Promise<number> {
  const raw = await db.execute(sql`
    UPDATE x402_l1_purchases
    SET status = CASE WHEN auth_nonce IS NULL THEN 'request_error' ELSE 'settle_failed' END,
        spent_units = CASE WHEN auth_nonce IS NULL THEN '0' ELSE spent_units END,
        raw_response_meta = coalesce(raw_response_meta, '{}'::jsonb) || jsonb_build_object(
          'phase', 'sweep',
          'reason', 'orphaned_in_flight',
          'note', CASE WHEN auth_nonce IS NULL
            THEN 'reserved; no payment credential left vet402 (auth_nonce never written), so the reservation was released'
            ELSE 'reserved and possibly signed; the runner died before the outcome was written' END,
          'credentialSent', auth_nonce IS NOT NULL,
          'sweptAt', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        )
    WHERE status = 'in_flight'
      AND attempted_at < now() - make_interval(mins => ${olderThanMinutes}::int)
    RETURNING id
  `);
  return rowsOf(raw).length;
}

/**
 * 予約したのに結果を書けなかった行を、その場で `settle_failed` へ倒す
 * （2026-09-04 監査 P1-2）。
 *
 * sweepOrphanedInFlight（30 分後の掃除）との違いは「誰が落ちたか分かっているか」。
 * こちらは**同じ実行の中で例外を掴んでいる**ので、理由まで書ける。
 * 解決先を settle_failed にするのは、我々が署名して払える状態にした試行だから
 * ——公開面の分母（PAID_ATTEMPT_STATUSES）に入り、冷却の対象にもなる。
 * spent_units は触らない（「署名したら計上する」は予算の不変条件）。
 *
 * 2026-09-19（横断監査 W4）: `error` は redactForLog を通す（RPC の URL に鍵が入る形がある）。
 * 同時に `$1::text` の明示キャストを足した——付けないと postgres は
 * `jsonb_build_object('error', $1)` の型を決められず（could not determine data type of
 * parameter $1）、この UPDATE は**毎回落ちていた**。行は in_flight のまま残り、30 分後の
 * 孤児掃除が request_error として拾っていたので、誰も気づかなかった。
 *
 * 2026-09-29 監査4周目: auth_nonce が NULL の行（資格情報を有料の要求に載せる前に落ちた——
 * nonce の書き込みは有料の要求より前）は `settle_failed` にしない。settle_failed は公開の定義で
 * 「署名して**送った**のに決済が確認できない」で、売り手の分母に入る。送っていない失敗は
 * 我々側の事実なので `request_error`、動きうる金が無いので spent_units も 0 に戻す。
 * auth_nonce が入っている行は従来どおり（settle_failed・spent_units は残す）。
 * 戻り値は実際に書いた status（書けなかったら従来の想定どおり settle_failed）。
 */
export async function resolveReservationAsFailed(
  db: NonNullable<ReturnType<typeof getDb>>,
  rowId: string,
  error: unknown,
): Promise<"settle_failed" | "request_error"> {
  try {
    const raw = await db.execute(sql`
      UPDATE x402_l1_purchases
      SET status = CASE WHEN auth_nonce IS NULL THEN 'request_error' ELSE 'settle_failed' END,
          spent_units = CASE WHEN auth_nonce IS NULL THEN '0' ELSE spent_units END,
          raw_response_meta = coalesce(raw_response_meta, '{}'::jsonb) || jsonb_build_object(
            'phase', 'post_reservation',
            'reason', 'threw_after_reservation',
            'credentialSent', auth_nonce IS NOT NULL,
            'error', ${pgSafeText(redactForLog(error))}::text,
            -- 原因（SQLSTATE と本文・2026-09-29）。error は drizzle の包みの先頭 300 文字で、原因は途中で切れていた。
            'cause', ${JSON.stringify(dbErrorCause(error))}::jsonb
          )
      -- 2026-09-29 独立レビュー（提案1）: 既に決着した行（結果の書き込みが済んだ後に落ちた等）を上書きしない。
      WHERE id = ${rowId}::uuid AND status = 'in_flight'
      RETURNING status
    `);
    const written = rowsOf(raw)[0]?.status;
    // 0 行（既に決着していた）なら、その行の status は書いた側が決めたもの。呼び手の集計は従来どおり settle_failed に数える。
    return written === "request_error" ? "request_error" : "settle_failed";
  } catch (writeError) {
    // ここまで失敗したら 30 分後の孤児掃除が拾う。黙って消さない。
    logServerErrorSafe("observatory.l1.resolve_reservation_failed", redactedError(writeError));
    return "settle_failed";
  }
}

/**
 * 署名していない予約を戻す（spent_units を 0 に）。2026-09-29 監査4周目。
 *
 * 署名直前の停止判定（haltGate）は DB が読めないと fail-closed で「止める」を返す——つまり
 * 「DB 不通で止めた」直後に、同じ DB へ予約を戻す UPDATE を打つことになる。従来はこの UPDATE が
 * 投げて purchaseOne ごと落ち、未署名の予約が in_flight のまま日次予算を占有した。
 * ここでは短く数回だけ試し、それでも書けなければ fail-loud のログを残して**投げない**。
 * 残った行は auth_nonce が NULL なので、孤児掃除（sweepOrphanedInFlight）が spent_units を戻す。
 * `WHERE status = 'in_flight'` で、既に決着した行を上書きしない。
 */
export async function releaseUnsignedReservation(
  db: NonNullable<ReturnType<typeof getDb>>,
  rowId: string,
  outcome: { status: "halted" | "request_error"; rawResponseMeta: unknown },
  retryDelaysMs: readonly number[] = [0, 200, 1_000],
): Promise<boolean> {
  let lastError: unknown = null;
  for (const delay of retryDelaysMs) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    try {
      await db
        .update(x402L1Purchases)
        .set({ status: outcome.status, spentUnits: "0", rawResponseMeta: outcome.rawResponseMeta })
        .where(and(eq(x402L1Purchases.id, rowId), eq(x402L1Purchases.status, "in_flight"), isNull(x402L1Purchases.authNonce)));
      return true;
    } catch (error) {
      lastError = error;
    }
  }
  logServerErrorSafe(
    "observatory.l1.unsigned_reservation_not_released",
    new Error(`row ${rowId} stays in_flight until the orphan sweep releases it: ${redactForLog(lastError)}`),
  );
  return false;
}

/**
 * 停止スイッチを 1 回読む。**fail-closed の「DB が読めないので止めた」を
 * 黙って「運用者が止めた」に見せない**ための薄い包み: 前者は障害なので
 * fail-loud にする（cron の応答からは haltReason の文言で区別できるが、
 * 障害はログにも出ていなければ誰も気づかない）。
 */
async function haltGate(db: NonNullable<ReturnType<typeof getDb>>): Promise<HaltVerdict> {
  const verdict = await isSpendingHalted(db);
  if (verdict.halted && verdict.source === "unreachable") {
    logServerErrorSafe("observatory.l1.halt_flag_unreadable", new Error(verdict.reason));
  }
  return verdict;
}

/**
 * 主候補の文（2026-10-27）。選ぶ行と並びは 1 文の形（下の targetsSql の query・旗 primaryLazyWalk=false）と同じ。
 *
 * 本番の読み取り（EXPLAIN ANALYZE・2026-10-27）: 1 文の形は、安い条件を通る約 4.2 万行のすべてで L0 の最新判定
 * （x402_l0_probes を 1 行ずつ）・Gateway の除外（raw_accepts の展開・TOAST）・並びの先頭の C2 判定（settlements を
 * 1 行ずつ。決済のあるエンドポイントでは表の行を 1 回読む）を評価してから LIMIT していた。温まって 2 秒、冷えると
 * 10 秒（10/27 08:32 JST の本番の回は 50 秒）。
 *
 * ここでは、
 *  1. 安い条件（coreWhere: x402_endpoints の列と、相関しない売り手の上限）と購入表の条件（purchaseWhere）を通る行を、
 *     C2 以外の並びの鍵で 1 回だけ並べる（l1_primary_cand）。購入表は 1 回だけ endpoint ごとに畳み（l1_primary_bought）、
 *     購入行の無い行（約 6.5 万行）では purchaseWhere を評価しない。その行での答えは決まっている: スイープ窓と冷却の
 *     NOT EXISTS は真、初回購入の EXISTS は偽（＝ firstPurchasesSelectable のときだけ通る）。未購入の鍵は「畳んだ行が無い」、
 *     最後の試行は畳んだ max(attempted_at)（元の副問い合わせと同じ値。行が無ければ NULL）。
 *  2. その並びを上から歩き、C2 の行（A）と C2 でない行（B）を別々に、L0 の判定と extraWhere を通るものだけ最大 limit 件ずつ取る。
 *     重い判定は歩いた行にしか走らない（並びが CTE から伝わり、Limit が止める）。
 *  3. A と B の和を、元と同じ鍵（C2 → 未購入 → 優先 → 需要 → 最後の試行 → 初出 → id）で並べ直して limit 件。
 *
 * 同じ結果になる理由: 元の答え（F を (C2, k) で並べた先頭 limit 件）の各行は、C2 の行なら「C2 の行を k で並べた先頭
 * limit 件」に、C2 でない行なら「C2 でない行を k で並べた先頭 limit 件」に必ず入る。k は id で終わる全順序なので同点は無い。
 * C2 の値は NULL にならない（l1_primary_cand の行は status = 'active'・resource_url が https で始まる非 NULL、残りは EXISTS だけ）。
 * B を IS NOT TRUE で取るのは、仮に NULL が出ても行を落とさないため（並びはその場合だけ元と違いうる）。
 */
function lazyPrimaryTargetsSql(input: {
  daily: boolean;
  baseColumns: SQL;
  coreWhere: SQL;
  purchaseWhere: SQL;
  extraWhere: SQL;
  limit: number;
  firstPurchasesSelectable: boolean;
}): SQL {
  const { daily, baseColumns, coreWhere, purchaseWhere, extraWhere, limit, firstPurchasesSelectable } = input;
  const ordKeys = (a: string) => {
    const t = sql.raw(a);
    return sql`${t}.ord_unbought DESC, ${t}.ord_priority DESC, ${t}.ord_payers DESC NULLS LAST, ${t}.ord_calls DESC NULLS LAST,
             ${t}.ord_last ASC NULLS FIRST, ${t}.ord_seen ASC NULLS LAST, ${t}.id ASC`;
  };
  const walk = (c2: boolean) => sql`
      SELECT w.id, ${c2 ? sql`true` : sql`false`} AS ord_tier,
             w.ord_unbought, w.ord_priority, w.ord_payers, w.ord_calls, w.ord_last, w.ord_seen
      FROM (
        SELECT e.id, e.ord_unbought, e.ord_priority, e.ord_payers, e.ord_calls, e.ord_last, e.ord_seen
        FROM l1_primary_cand e
        WHERE (${l1TierWhere(daily)}) ${c2 ? sql`IS TRUE` : sql`IS NOT TRUE`}
        ORDER BY ${ordKeys("e")}
      ) w
      JOIN x402_endpoints e ON e.id = w.id
      JOIN LATERAL (
        SELECT verdict FROM x402_l0_probes p
        WHERE p.endpoint_id = e.id
        ORDER BY probed_at DESC LIMIT 1
      ) lp ON lp.verdict = 'pass'
      WHERE true
        ${extraWhere}
      ORDER BY ${ordKeys("w")}
      LIMIT ${limit}`;
  return sql`
    WITH l1_primary_bought AS (
      SELECT pb.endpoint_id, max(pb.attempted_at) AS last_at
      FROM x402_l1_purchases pb
      GROUP BY pb.endpoint_id
    ),
    l1_primary_cand AS MATERIALIZED (
      SELECT e.id, e.status, e.resource_url,
             (bought.endpoint_id IS NULL) AS ord_unbought,
             (e.resource_key ILIKE ANY(${prioritySqlArray()})) AS ord_priority,
             e.quality_payers_30d AS ord_payers,
             e.quality_calls_30d AS ord_calls,
             bought.last_at AS ord_last,
             e.first_seen_at AS ord_seen
      FROM x402_endpoints e
      LEFT JOIN l1_primary_bought bought ON bought.endpoint_id = e.id
      WHERE ${coreWhere}
        AND CASE WHEN bought.endpoint_id IS NULL THEN ${firstPurchasesSelectable ? sql`true` : sql`false`}
                 ELSE (true ${purchaseWhere}) END
      ORDER BY ord_unbought DESC, ord_priority DESC, ord_payers DESC NULLS LAST, ord_calls DESC NULLS LAST,
               ord_last ASC NULLS FIRST, ord_seen ASC NULLS LAST, e.id ASC
    )
    SELECT ${baseColumns}
    FROM ((${walk(true)}) UNION ALL (${walk(false)})) pick
    JOIN x402_endpoints e ON e.id = pick.id
    ORDER BY pick.ord_tier DESC, ${ordKeys("pick")}
    LIMIT ${limit}
  `;
}

/**
 * 候補 SQL の組み立て（2026-10-27・runL1Batch の中から外へ出した）。レーン枠と census の文は従来のまま。
 * 主候補（lane も census も無い文）だけ、同じ答えを返す lazyPrimaryTargetsSql の形にした（同日・tests/l1-primary-lazy.pg.test.ts）。
 * 準備の各問い合わせを本番の読み取りで同じ関数のまま測り、DB 試験で選ぶ候補を固定するため。
 * 値は runL1Batch が準備の途中で決めたもの（初回購入の枠・レーンの除外・自己除外）をそのまま受け取る。
 */
export type L1TargetsSqlContext = {
  limit: number;
  onlyEndpointId?: string;
  laneExclusions: SQL[];
  firstPurchasesSelectable: boolean;
  censusFirstSelectable: boolean;
  /**
   * Test seam（2026-10-27）: false でレーン枠の前置きの絞り込み（laneNetworkPrefilterSql）を外す。DB 試験が
   * 「足しても選ぶ行と並びが同じ」を、足す前の文と並べて確かめるためだけに使う。本番の呼び手は渡さない（既定 true）。
   */
  lanePrefilter?: boolean;
  /**
   * Test seam（2026-10-27）: false で主候補を 1 文の並び（重い判定を通る行の全部で評価してから LIMIT）に戻す。
   * DB 試験が lazyPrimaryTargetsSql と同じ id を同じ順に返すことを確かめるためだけに使う。本番の呼び手は渡さない（既定 true）。
   */
  primaryLazyWalk?: boolean;
};

export function l1TargetsSqlBuilders(ctx: L1TargetsSqlContext) {
  const { limit, onlyEndpointId, laneExclusions, firstPurchasesSelectable, censusFirstSelectable } = ctx;
  const lanePrefilter = ctx.lanePrefilter !== false;
  const primaryLazyWalk = ctx.primaryLazyWalk !== false;
  const selfExclusion = sql`AND ${operatorExclusionPredicate("e")}`;
  // 候補 SQL は settlement_daily を読む（C2 の 30 日窓が生行の保持期間へ縮まないため）。
  // 表がまだ無い環境では生行だけの式へ落とす（withDailyFallback）。
  // census（2026-09-28）: 同じ SELECT・同じ WHERE に census の条件だけを足し、並びと LIMIT は
  // censusTargetsSql（下）が包んで決める（1 ホスト 1 件・最安）。ここでは並びも LIMIT も付けない。
  const targetsSql = (
    daily: boolean,
    lane?: { chain: CappedChain; networkLike: string; limit: number },
    census?: CensusSelection,
    retest?: RetestParams,
    extraWhere: SQL = gatewayPrimaryExclusionSql(),
    exclusions: SQL[] = laneExclusions,
  ) => {
    // Celo と Avalanche だけ、ORDER BY / LIMIT を外してホスト幅の包みに渡す。他レーンの並びの文は下のまま。
    const celoLane = celoLaneUsesHostSpread(lane, census !== undefined);
    const avalancheLane = avalancheLaneUsesHostSpread(lane, census !== undefined);
    // 主候補（レーン枠でも census でもない文）だけ、重い判定を並びの順に必要な行まで遅らせる（lazyPrimaryTargetsSql）。
    const lazyPrimary = primaryLazyWalk && lane === undefined && census === undefined;
    const baseColumns = sql`e.id, e.resource_url, e.method, e.price_amount, e.pay_to, e.network, e.declared_schema,
           (e.resource_key ILIKE ANY(${prioritySqlArray()})) AS is_priority,
           (${settledCountSql(sql`e.id`)} >= ${MATURE_SETTLED_MIN}) AS is_mature,
           -- レーンの accept 優先（2026-09-17）: このエンドポイントで決済済み／決済主張のある network と、
           -- 非決済が 1 度でも出た network（レビュー C4: どちらも優先の対象から外す）。
           (SELECT coalesce(array_agg(DISTINCT s.network), '{}'::text[])
              FROM x402_l1_purchases s
              WHERE s.endpoint_id = e.id AND s.status IN ('settled', 'settle_claimed') AND s.network IS NOT NULL) AS settled_networks,
           (SELECT coalesce(array_agg(DISTINCT s.network), '{}'::text[])
              FROM x402_l1_purchases s
              WHERE s.endpoint_id = e.id AND s.status IN ('settle_failed', 'delivered_no_receipt', 'settle_claim_refuted')
                AND s.network IS NOT NULL) AS failed_networks,
           -- XRPL の secondary accept（2026-09-18）: カタログが宣言した XRPL の RLUSD accept の payTo。
           (SELECT coalesce(array_agg(DISTINCT xa->>'payTo'), '{}'::text[])
              FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.raw_accepts) = 'array' THEN e.raw_accepts ELSE '[]'::jsonb END) xa
              WHERE xa->>'network' = ${XRPL_MAINNET_CAIP2}
                AND (upper(xa->>'asset') = ${RLUSD_CURRENCY_HEX} OR xa->>'asset' = 'RLUSD')
                AND xa->'extra'->>'issuer' = ${RLUSD_ISSUER}
                AND xa->>'payTo' IS NOT NULL) AS xrpl_declared_pay_tos,
           -- Arc の lane accept（2026-09-19）: カタログが宣言した Arc の accept を**生の JSON のまま**取る。どの accept の
           -- payTo を「宣言された受取先」と数えるかは TS の declaredPayTosFor が署名の関門と同じ述語で決める
           -- （レビュー W1: SQL に別の述語を置かない）。network は実行時（normalizeNetwork）と同じ完全一致。
           -- SELECT リストの相関サブクエリ＝Sort/Limit 後の行だけで走る。
           (SELECT coalesce(jsonb_agg(aa), '[]'::jsonb)
              FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.raw_accepts) = 'array' THEN e.raw_accepts ELSE '[]'::jsonb END) aa
              WHERE aa->>'network' = ${ARC_CAIP2}) AS arc_declared_accepts,
           -- Celo の lane accept（2026-10-10）: Arc と同じ取り方（生の JSON・network は完全一致・述語は TS の declaredPayTosFor）。
           (SELECT coalesce(jsonb_agg(ca), '[]'::jsonb)
              FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.raw_accepts) = 'array' THEN e.raw_accepts ELSE '[]'::jsonb END) ca
              WHERE ca->>'network' = ${CELO_CAIP2}) AS celo_declared_accepts,
           -- BNB の lane accept（2026-10-19・段B2）: Celo と同じ取り方。どの payTo を宣言と数えるかは declaredPayTosFor。
           (SELECT coalesce(jsonb_agg(ba), '[]'::jsonb)
              FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.raw_accepts) = 'array' THEN e.raw_accepts ELSE '[]'::jsonb END) ba
              WHERE ba->>'network' = ${BNB_CAIP2}) AS bnb_declared_accepts,
           -- Arbitrum の lane accept（2026-10-22）: Celo と同じ取り方。どの payTo を宣言と数えるかは declaredPayTosFor。
           (SELECT coalesce(jsonb_agg(aa), '[]'::jsonb)
              FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.raw_accepts) = 'array' THEN e.raw_accepts ELSE '[]'::jsonb END) aa
              WHERE aa->>'network' = ${ARBITRUM_CAIP2}) AS arbitrum_declared_accepts,
           -- Avalanche の lane accept（2026-10-26）: Arbitrum と同じ取り方。どの payTo を宣言と数えるかは declaredPayTosFor。
           (SELECT coalesce(jsonb_agg(ava), '[]'::jsonb)
              FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.raw_accepts) = 'array' THEN e.raw_accepts ELSE '[]'::jsonb END) ava
              WHERE ava->>'network' = ${AVALANCHE_CAIP2}) AS avalanche_declared_accepts,
           -- Stellar の secondary accept（2026-10-18・段4）: カタログが宣言した stellar:pubnet の USDC accept の payTo。
           -- asset は枠の LANE_SECONDARY_ACCEPT_FILTER と同じ完全一致。照合の述語は selectStellarAccept。
           (SELECT coalesce(array_agg(DISTINCT sa->>'payTo'), '{}'::text[])
              FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.raw_accepts) = 'array' THEN e.raw_accepts ELSE '[]'::jsonb END) sa
              WHERE sa->>'network' = ${STELLAR_PUBNET_CAIP2}
                AND (sa->>'asset' = ${STELLAR_USDC_CLASSIC} OR sa->>'asset' = ${STELLAR_USDC_SAC})
                AND sa->>'payTo' IS NOT NULL) AS stellar_declared_pay_tos`;
    const coreWhere = sql`e.status = 'active'
      -- 2026-08-26 緊急修正（外部レビュー F-1）: resource_url に ':siren' のような
      -- **未置換のパスパラメータ**が残るエンドポイントを対象から外す。パラメータの
      -- 実値を知らない我々には正しいリクエストを作れず、実測で settle_failed の
      -- 82%（724/885 が HTTP 400）がこの形だった——「我々が不正な URL で叩いて
      -- 断られた」を「売り手が決済しない」として記録し、日次予算を燃やし
      -- （認可$35.28分・オンチェーン移動はゼロ）、冤罪の BLOCK を4件出していた。
      -- active 15,251 件中 709 件が該当。これらは L0（生存観測）には残る——
      -- 測れないものを買いに行かない、というだけ。
      -- 2026-09-02 監査 A1: ':name' 以外の形（'{name}' '<name>' '[name]' '*'・
      -- URL 符号化済み）も同じ。判定は path-template.ts が正典（JS 側と同じ正規表現・
      -- 下の候補ループにも isPathTemplate のガードを置く二重防御）。
      AND ${notPathTemplateSql()}
      ${onlyEndpointId ? sql`AND e.id = ${onlyEndpointId}::uuid` : sql``}
      ${sql.join(exclusions, sql` `)}
      ${lane && lanePrefilter ? laneNetworkPrefilterSql(lane) : sql``}
      ${
        // レーン枠（2026-09-17・laneFloorCandidates）。主ネットワークが一致する行（従来どおり・
        // 全レーン）に加え、LANE_SECONDARY_ACCEPTS のレーン（Arc・XRPL・Celo・Stellar・BNB・Arbitrum・Avalanche）だけは raw_accepts のいずれかの
        // accept が一致する行（exa.ai: Base 先頭・Arc 2 番目）も入れる。この secondary の枝にだけ
        // 「そのチェーンで settled / settle_claimed の行がまだ無い・非決済が 1 度も出ていない」を
        // 掛ける（レビュー W1・C4: Solana/Tempo/XRPL の枠の意味は従来のまま）。
        // raw_accepts の network は実行時（x402-payer normalizeNetwork）と同じ**完全一致**で見る
        // （レビュー W5）: 実行時は `arc` スラグを Arc に寄せない（署名の経路に推測を入れない）ので、
        // SQL でも寄せない。`arc` とだけ書く行は枠にも署名にも載らない——同じ集合。
        lane
          ? sql`AND ((e.network LIKE ${lane.networkLike}${
              lane.chain === "arc"
                ? sql` AND NOT (
                      jsonb_typeof(e.raw_accepts) = 'array'
                      AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.raw_accepts) g WHERE g->>'network' LIKE ${lane.networkLike} AND coalesce(g->'extra'->>'name','') = 'GatewayWalletBatched')
                      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(e.raw_accepts) n WHERE n->>'network' LIKE ${lane.networkLike} AND coalesce(n->'extra'->>'name','') <> 'GatewayWalletBatched')
                    )`
                : sql``
            })${
              LANE_SECONDARY_ACCEPTS[lane.chain]
                ? sql` OR (jsonb_typeof(e.raw_accepts) = 'array'
                      AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.raw_accepts) a WHERE a->>'network' LIKE ${lane.networkLike} ${LANE_SECONDARY_ACCEPT_FILTER[lane.chain] ?? sql``})
                      AND NOT EXISTS (
                        SELECT 1 FROM x402_l1_purchases ls
                        WHERE ls.endpoint_id = e.id AND ls.network LIKE ${lane.networkLike}
                          AND ls.status IN ('settled', 'settle_claimed', 'settle_failed', 'delivered_no_receipt', 'settle_claim_refuted')))`
                : sql``
            })`
          : sql``
      }
      ${
        // census / retest（2026-09-28）: (1) Base の USDC accept の宣言があり、払う額（price_amount）が $1 以下、
        // (2) 主ネットワーク（カタログの accepts[0]）が Base——price_amount はその accept の額なので、Base 以外が
        // 先頭の行（eip155:84532・algorand: など）を Base で買うと、売り手に落ち度が無いのに price_mismatch が
        // 公開台帳に載る（レビュー 2026-09-28）、(3) census: そのホスト名（ポート無視）に L1 の購入行が 1 件も
        // 無い（status を問わない）／ retest: その売り手の最新の行がこちらの側の理由で失敗（RETEST_SELLERS_SQL を先に
        // 1 回流し、ホストの一覧を JSON のパラメータで受け取る）。
        census
          ? sql`AND cp.has_base
      AND cp.census_price IS NOT NULL
      AND cp.census_price <= ${String(MAX_PER_PURCHASE_UNITS)}::numeric
      AND e.network IN (${BASE_CAIP2}, 'base')
      AND ${
        census === "retest"
          ? retest?.sellerHostsJson !== undefined
            ? // 出品単位（旗 on）: 売り手単位のホストは従来どおり全出品から、出品単位でだけ入ったホストは失敗した出品だけ。
              sql`(${CENSUS_HOST_SQL} IN (SELECT jsonb_array_elements_text(${retest.sellerHostsJson}::jsonb))
                   OR e.id::text IN (SELECT jsonb_array_elements_text(${retest.preferredIdsJson}::jsonb)))`
            : sql`${CENSUS_HOST_SQL} IN (SELECT jsonb_array_elements_text(${retest?.hostsJson ?? "[]"}::jsonb))`
          : sql`${CENSUS_HOST_SQL} NOT IN (${CENSUS_TRIED_HOSTS_SQL})`
      }`
          : sql``
      }
      ${selfExclusion}
      -- Tempo（MPP・2026-09-17 レビュー #4）: directory は受取先を載せない。L0 が生きた challenge から
      -- 学習した pay_to を持つ行だけを L1 候補にする（受取先を知らない相手に署名しない）。
      AND (e.source <> 'mpp_directory' OR e.pay_to IS NOT NULL)
      -- 2026-09-29 監査 5 周目（中）: 全チェーンで、カタログが pay_to を宣言した https の出品だけを買う
      -- （purchaseOne の isL1PurchasableListing と同じ条件）。平文 http の 402 は経路上で payTo を差し替えられる。
      AND e.pay_to IS NOT NULL AND e.pay_to <> ''
      AND lower(e.resource_url) LIKE 'https://%'
      -- 売り手ごとの日次上限（budget.ts SELLER_DAILY_CAP_USD）に当日もう届いた受取先・ホストは候補にしない。
      -- 締めるのは reserveSpend の同じ 1 文（ここは 402 を取りに行く無駄を省くだけ・バッチ開始時点の値）。
      ${sellerCapExclusionSql()}`;
    // 購入表を 1 行ずつ引く条件（初回購入の枠・スイープ窓・冷却）。主候補の文（lazyPrimaryTargetsSql）は、購入行の無い
    // エンドポイントではこの 3 つを評価しない（答えが決まっているので）ため、coreWhere と分けて渡す。
    const purchaseWhere = sql`
      ${
        // 初回購入の枠を使い切った日は、購入行がまだ無いエンドポイントを外す
        // （買い直しは続く）。行を書かないので、翌 UTC 日にまた候補へ戻る。
        // レーン枠（lane 付き）の問い合わせには掛けない（2026-09-17）: 別枠を持つチェーンの
        // 掃引は初回購入しか無く、この枠で除外すると新しいチェーンが永久に始まらない。
        // 支出はそのチェーンの別枠で縛られる（reserveSpend の firstQuotaApplies と同じ判断）。
        // census の候補（census === "census"）は census の枠（censusFirstSelectable・2026-09-29）で判定する。
        (census === "census" ? censusFirstSelectable : firstPurchasesSelectable) || lane
          ? sql``
          : sql`AND EXISTS (SELECT 1 FROM x402_l1_purchases fp WHERE fp.endpoint_id = e.id)`
      }
      AND NOT EXISTS (
        SELECT 1 FROM x402_l1_purchases pu
        WHERE pu.endpoint_id = e.id
          AND pu.attempted_at > now() - make_interval(days => ${sweepWindowDaysSql(sql`e.id`, sql`e.resource_key`)})
      )
      -- 2026-08-24 監査: 署名後失敗による予算 Griefing への耐性。
      -- reserveSpend は署名の前に計上する（正しい——署名済み EIP-3009 は
      -- validBefore まで生きた金）。だが売り手が決済しなければ、我々は金を
      -- 一円も渡していないのに日次$25の観測予算だけが減る。敵対的な売り手が
      -- 「署名だけさせて決済しない」を繰り返すと、**スコアを偽造しなくても
      -- 検証者の観測能力を枯らせる**。スコアの穴ではなく可用性への攻撃。
      --
      -- 守り方は「疑わしきを罰する」ではなく「無駄撃ちを止める」。直近の
      -- 有料試行が連続で決済に至っていないエンドポイントは、冷却期間のあいだ
      -- 対象から外す。1回の失敗では外さない（正直な売り手も一時的に落ちる）。
      -- 外れている間もL0の観測は続くので、公開台帳から消えるわけではない。
      AND NOT EXISTS (
        SELECT 1
        FROM (
          SELECT pu.status
          FROM x402_l1_purchases pu
          WHERE pu.endpoint_id = e.id
            AND pu.status IN (
              'settled', 'settle_claimed', 'settle_claim_refuted',
              'settle_claimed_unverifiable', 'delivered_no_receipt', 'settle_failed',
              -- 2026-09-04 監査 P1-2: sweepOrphanedInFlight の解決先。
              -- 予約後・記帳前に落ちた行は request_error になるが、この status は
              -- 冷却のどの条件にも当たらなかった。つまり「署名させて我々を
              -- 落とす」を繰り返す売り手は、何度でも予算を焼けた。
              -- request_error は無償リクエストの失敗（到達不能・SSRF 拒否）も
              -- 含むが、3 回続けて何も測れていない相手に予算を投じ続ける理由も
              -- 同じく無い。公開面の分母（PAID_ATTEMPT_STATUSES）には
              -- 従来どおり入らない。
              'request_error'
            )
          ORDER BY pu.attempted_at DESC
          LIMIT ${NON_SETTLING_COOLDOWN_STREAK}
        ) recent
        HAVING count(*) = ${NON_SETTLING_COOLDOWN_STREAK}
           AND count(*) FILTER (
                 WHERE recent.status IN ('settled', 'settle_claimed')
               ) = 0
      )`;
    if (lazyPrimary) {
      return lazyPrimaryTargetsSql({ daily, baseColumns, coreWhere, purchaseWhere, extraWhere, limit, firstPurchasesSelectable });
    }
    const query = sql`
    SELECT ${baseColumns}
           ${
             census
               ? sql`, cp.census_price::text AS census_price, ${CENSUS_HOST_SQL} AS census_host,
           ${
             census === "retest" && retest
               ? sql`(e.id::text IN (SELECT jsonb_array_elements_text(${retest.preferredIdsJson}::jsonb)))`
               : sql`false`
           } AS census_preferred`
               : sql``
           }
           ${
             celoLane
               ? sql`, e.resource_key,
           (${l1TierWhere(daily)}) AS celo_ord_tier,
           (NOT EXISTS (SELECT 1 FROM x402_l1_purchases np WHERE np.endpoint_id = e.id)) AS celo_ord_unbought,
           (e.resource_key ILIKE ANY(${prioritySqlArray()})) AS celo_ord_priority,
           e.quality_payers_30d AS celo_ord_payers,
           e.quality_calls_30d AS celo_ord_calls,
           (SELECT max(lt.attempted_at) FROM x402_l1_purchases lt WHERE lt.endpoint_id = e.id) AS celo_ord_last,
           e.first_seen_at AS celo_ord_seen`
               : avalancheLane
                 ? sql`, e.resource_key,
           (${l1TierWhere(daily)}) AS avax_ord_tier,
           (NOT EXISTS (SELECT 1 FROM x402_l1_purchases np WHERE np.endpoint_id = e.id)) AS avax_ord_unbought,
           (e.resource_key ILIKE ANY(${prioritySqlArray()})) AS avax_ord_priority,
           e.quality_payers_30d AS avax_ord_payers,
           e.quality_calls_30d AS avax_ord_calls,
           (SELECT max(lt.attempted_at) FROM x402_l1_purchases lt WHERE lt.endpoint_id = e.id) AS avax_ord_last,
           e.first_seen_at AS avax_ord_seen`
                 : sql``
           }
    FROM x402_endpoints e
    JOIN LATERAL (
      SELECT verdict FROM x402_l0_probes p
      WHERE p.endpoint_id = e.id
      ORDER BY probed_at DESC LIMIT 1
    ) lp ON lp.verdict = 'pass'
    ${
      // census の値段（2026-09-28・独立レビュー W2 で改訂）: **実際に払う額**＝e.price_amount（カタログの
      // accepts[0].amount）。selectAccept が壁の accept と照合するのはこの宣言額なので、raw_accepts の別の
      // accept の方が安くても、その額では払わない（本番 437 件中 18 件で食い違っていた: 並べた 24 units・
      // 払う 200 units）。price_amount が null の行（v1 の maxAmountRequired だけの行）は census に入れない。
      // 数字として読めない額・0 は数えない（CASE の中でだけ numeric へ落とす——WHERE の AND は評価順を
      // 保証しないので、壊れた額で文全体を落とさない）。has_base は Base の USDC accept の宣言があるか。
      census
        ? sql`CROSS JOIN LATERAL (
      SELECT CASE WHEN e.price_amount ~ '^[0-9]{1,30}$' THEN nullif(e.price_amount::numeric, 0) END AS census_price,
             EXISTS (
               SELECT 1
               FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.raw_accepts) = 'array' THEN e.raw_accepts ELSE '[]'::jsonb END) x
               WHERE x->>'network' IN (${BASE_CAIP2}, 'base') AND lower(x->>'asset') = ${BASE_USDC.toLowerCase()}
             ) AS has_base
    ) cp`
        : sql``
    }
    WHERE ${coreWhere}
      ${purchaseWhere}
      ${extraWhere}
    -- §7.4（2026-09-02）: C2（決済帰属あり ∨ 問い合わせ多）を最初に買う。日次予算が
    -- 尽きれば残りは未実施のまま（facts では l1_not_attempted = 未検証。pass とは書かない）。
    -- C2 だけに絞らないのは、決済索引が空の初日に L1 が完全に止まるのを避けるため——
    -- 仕様の「C2 は 24 時間ごと L1」は順序で満たし、他階層は従来の掃引で薄く測る。
    -- 2026-09-02 グラント側の指摘: 日次 $25 の枠に対し実支出 $1〜3・購入実績のある endpoint は
    -- 8.1%。C2 の次は「一度も買っていない in-cap endpoint」を優先し、証拠の裾野を広げる
    -- （上限は全て据え置き: 1 件 $1・日次 $25・原子的予約・cooldown）。
    ${
      census || celoLane || avalancheLane
        ? sql``
        : sql`ORDER BY (${l1TierWhere(daily)}) DESC,
             (NOT EXISTS (SELECT 1 FROM x402_l1_purchases np WHERE np.endpoint_id = e.id)) DESC,
             (e.resource_key ILIKE ANY(${prioritySqlArray()})) DESC,
             e.quality_payers_30d DESC NULLS LAST, e.quality_calls_30d DESC NULLS LAST,
             -- 2026-10-17: 需要の値が同じ行の決め手。ここで並びのキーが尽きていたので、同点のどれを買うかは実行計画
             -- しだいだった（本番 10/17: 18〜53 位が同点 36 件・1 回の実行の通常候補は中央値 33 件）。待った時間が長い
             -- 順に買う: 買い直しは最後に試した日時が古い順（未購入は上のキーで別の組なので全部 NULL）、未購入は
             -- カタログに最初に載った日時が古い順、最後に id。索引 x402_l1_purchases_endpoint_idx (endpoint_id, attempted_at)。
             (SELECT max(lt.attempted_at) FROM x402_l1_purchases lt WHERE lt.endpoint_id = e.id) ASC NULLS FIRST,
             e.first_seen_at ASC NULLS LAST,
             e.id ASC
    LIMIT ${lane?.limit ?? limit}`
    }
  `;
    if (avalancheLane && lane) return avalancheDiversifiedCandidatesSql(query, lane.limit);
    return celoLane && lane ? celoDiversifiedCandidatesSql(query, lane.limit) : query;
  };
  /**
   * census の候補（2026-09-28）: 上の WHERE を通った行から 1 ホスト 1 件（そのホストでいちばん安い行・
   * 同額なら id の小さい方）を選び、安い順（同額ならホスト名順）に censusLimit 件。決定的な並び。
   */
  // retest の (b) では、失敗した出品そのもの（census_preferred）がまだ買えるならそれを先に取る（レビュー W2）。
  const censusTargetsSql = (daily: boolean, censusLimit: number, selection: CensusSelection = "census", retest?: RetestParams) => sql`
    SELECT d.* FROM (
      SELECT DISTINCT ON (c.census_host) c.*
      FROM (${targetsSql(daily, undefined, selection, retest)}) c
      ORDER BY c.census_host, c.census_preferred DESC, c.census_price::numeric ASC, c.id ASC
    ) d
    ORDER BY d.census_price::numeric ASC, d.census_host ASC
    LIMIT ${censusLimit}
  `;
  const primaryExtra = sql`${gatewayPrimaryExclusionSql()} ${nativeArcGatewayOnlyExclusionSql()}`;
  return { targetsSql, censusTargetsSql, primaryExtra };
}

/** Gateway 専用・POST・目録本文不明の active 行数。DB 障害時は null。 */
export async function queryGatewayPostBodyUnknownActive(
  db: NonNullable<ReturnType<typeof getDb>>,
): Promise<number | null> {
  try {
    const excludedRaw = await db.execute(gatewayPostBodyUnknownExcludedCountSql());
    const excludedRows = (Array.isArray(excludedRaw)
      ? excludedRaw
      : (excludedRaw as { rows?: { n?: number }[] }).rows ?? []) as { n?: number }[];
    return Number(excludedRows[0]?.n ?? 0);
  } catch (error) {
    logServerErrorSafe("observatory.l1.gateway_post_body_count", redactedError(error));
    return null;
  }
}

export async function runL1Batch(
  options: {
    limit?: number;
    fetchImpl?: (url: string, init?: RequestInit, call?: SafeFetchCallOptions) => Promise<Response>;
    timeoutMs?: number;
    /**
     * Test seam: Celo の支払い付き要求の待ち。既定は L1_CELO_PAID_TIMEOUT_MS。
     * 無払いの要求と、Celo 以外の支払い付き要求は timeoutMs のまま。
     */
    celoPaidTimeoutMs?: number;
    /**
     * Playground demo path: narrow candidate selection to this one endpoint.
     * Everything else — L0-pass requirement, self-exclusion, sweep-window
     * dedup, the atomic budget reservation — applies unchanged, so a demo
     * trigger can never spend past what the daily batch itself could.
     */
    onlyEndpointId?: string;
    /** Test seam: Solana recent blockhash. Default hits SOLANA_RPC_URL. */
    getSolanaBlockhash?: () => Promise<string>;
    /** Whole-batch wall-clock budget; default L1_BATCH_BUDGET_MS (test seam). */
    batchBudgetMs?: number;
    /** Test seam: 購入元の USDC 残高（基本単位）。既定は BASE_RPC_URL / SOLANA_RPC_URL を読む。 */
    getPayerUsdcBalance?: PayerUsdcBalanceReader;
    /** Test seam: Circle Gateway の available。既定は GatewayClient.getBalances。テストはここを差し替え、ネットへ出ない。 */
    readArcGatewayAvailable?: () => Promise<bigint | null>;
    /** Test seam: Gateway の署名。既定は BatchEvmScheme（ローカル署名、ブロードキャストしない）。 */
    signArcGateway?: ArcGatewaySigner;
    /** Test seam: Tempo（MPP）の署名器。既定は mppx/client（Tempo RPC へ出る）。 */
    mppxCharge?: MppxCharge;
    /** Test seam: XRPL の Sequence と validated ledger。既定は XRPL_RPC_URL（JSON-RPC）を読む。 */
    getXrplSigningInputs?: (address: string) => Promise<XrplSigningInputs>;
    /** Test seam: Stellar の支払い XDR。既定は STELLAR_RPC_URL へ出る。テストはここを差し替え、ネットへ出ない。 */
    createStellarPayment?: (input: StellarPaymentInput) => Promise<{ transaction: string }>;
    /**
     * Test seam: レーン枠の時間の上限（L1_LANE_TIME_SHARE）と setupMs が読む時計。既定は Date.now。
     * デッドライン（createDeadline）は差し替えない——maxDuration を守る判定は従来どおり壁時計で決める。
     */
    now?: () => number;
  } = {},
): Promise<L1BatchSummary> {
  const now = options.now ?? Date.now;
  const runStartedAt = now();
  // SSRF (2026-08-15 audit): resourceUrl is a seller-declared string from the
  // public Bazaar catalog. The production default refuses any target that is —
  // or redirects to — a non-public address, so this runner cannot be pointed
  // at the platform's own internal surfaces (nor made to carry a signed
  // payment authorization there). See src/lib/net/safe-fetch.ts.
  const {
    limit = 100,
    fetchImpl = guardedFetch,
    timeoutMs = L1_REQUEST_TIMEOUT_MS,
    celoPaidTimeoutMs = L1_CELO_PAID_TIMEOUT_MS,
    onlyEndpointId,
    batchBudgetMs = L1_BATCH_BUDGET_MS,
  } = options;
  const deadline = createDeadline(batchBudgetMs);
  const getSolanaBlockhash = options.getSolanaBlockhash ?? defaultSolanaBlockhash;
  const getXrplSigningInputs = options.getXrplSigningInputs ?? defaultXrplSigningInputs;
  const createStellarPayment = options.createStellarPayment ?? defaultCreateStellarPayment;
  const summary: L1BatchSummary = {
    attempted: 0,
    settled: 0,
    settleFailed: 0,
    deliveredNoReceipt: 0,
    skipped: 0,
    budgetDenied: 0,
    spentUnitsTotal: "0",
    stoppedForDeadline: false,
    notAttempted: 0,
    orphansResolved: 0,
    halted: false,
    haltReason: null,
    disabledReason: null,
    payerUnfunded: 0,
    sellerCapped: 0,
    payerFundsUnreadable: [],
    laneFloor: {},
    laneFloorHostCapped: {},
    xrplFeeOverCap: 0,
    xrplLaneClosed: null,
    censusCandidates: 0,
    retestCandidates: 0,
    censusRemaining: null,
    laneSkippedForTime: 0,
    gatewayPostBodyUnknownActive: null,
    gatewayPostBodyUnknownSignSkipped: 0,
    setupMs: null,
    attemptsByNetwork: {},
    primaryFetchMs: null,
    laneFetchMs: {},
  };

  // 1. Master switches — fail-closed before any network traffic.
  if (!isL1Enabled()) {
    summary.disabledReason = "l1_disabled";
    return summary;
  }
  // MetaMask exports the key WITHOUT the 0x prefix; Coinbase Wallet WITH it.
  // Accept both, normalize to the 0x form viem requires.
  const rawPk = process.env.OBSERVATORY_WALLET_PRIVATE_KEY?.trim() ?? "";
  const pk = rawPk.startsWith("0x") ? rawPk : rawPk ? `0x${rawPk}` : "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    summary.disabledReason = "wallet_key_missing";
    return summary;
  }
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL is not configured");

  // 1.2 実行時の停止スイッチ（2026-09-05 監査 P0）。env のフラグ（上）は
  //     再デプロイしないと変わらないので、支出を今すぐ止める手段になれない。
  //     DB の 1 行を、ネットワークへ 1 本も出す前に読む。
  const batchHalt = await haltGate(db);
  if (batchHalt.halted) {
    summary.halted = true;
    summary.haltReason = batchHalt.reason;
    summary.disabledReason = "spending_halted";
    return summary;
  }

  const account = privateKeyToAccount(pk as `0x${string}`);
  // Solana は独立フラグ + 独立鍵。どちらか欠ければ candidates から除外される
  // （試行すらしない）。予算・台帳は Base と共有（USDC 基本単位が共通）。
  const solanaKeypair = isSolanaL1Enabled() ? loadSolanaKeypair() : null;
  const solanaReady = solanaKeypair !== null;
  // XRPL（2026-09-17）も同じ形: 独立フラグ + 独立 seed。RLUSD は 1 単位 = $1 なので台帳の目盛りは共有。
  const xrplPayer = await loadXrplPayerModule();
  const xrplWallet = xrplPayer ? xrplPayer.loadXrplWallet() : null;
  // ready = フラグ + seed + XRPL_RPC_URL。RPC が無ければ SQL の段階で候補外にする——署名の材料（Sequence・
  // validated ledger）を読めない失敗を、売り手の request_error 行にしない（2026-09-17 出荷前レビュー #2）。
  const xrplReady = xrplWallet !== null && !!process.env.XRPL_RPC_URL?.trim();
  // Stellar（2026-10-18）: 旗 + 秘密 + Horizon（残高）+ Soroban RPC（署名）。RPC が無いと予約の後に
  // createPaymentPayload が落ちるので、SQL の段階で候補外にする（XRPL の RPC と同じ理由）。
  const stellarPayer = await loadStellarPayerModule();
  const stellarAccount = stellarPayer ? stellarPayer.loadStellarPayer() : null;
  const stellarReady =
    stellarAccount !== null && !!process.env.STELLAR_HORIZON_URL?.trim() && !!process.env.STELLAR_RPC_URL?.trim();

  // 2026-08-23 監査: 自己除外が VET402_OPERATOR_PAYTO の手入力だけに依存していて、
  // **本番では未設定＝完全な no-op** だった。中立性は堀そのものなので、忘れられる
  // 場所に置かない。いま鍵を読んだアドレス（＝我々が署名できる＝定義上そこへの
  // 支払いは自己取引）を実行時に注入し、環境変数のリストと合併する。
  addDerivedOperatorAddresses([
    account.address,
    solanaKeypair?.publicKey.toBase58() ?? null,
    xrplWallet?.classicAddress ?? null,
    stellarAccount?.address ?? null,
  ]);

  // 1.5 Resolve orphaned reservations from earlier runs BEFORE anything else
  //     reads the ledger. Ordering is safe by construction: the sweep never
  //     touches spent_units, so the day total below is identical either way.
  //     A failure here must not stop the batch — it is housekeeping, not a
  //     money gate — but it is never swallowed silently.
  try {
    summary.orphansResolved = await sweepOrphanedInFlight(db);
  } catch (error) {
    if (!isMissingSchemaError(error)) logServerErrorSafe("observatory.l1.orphan_sweep", redactedError(error));
  }

  // 2. Today's spend from the ledger (UTC day).
  let spentToday = 0n;
  try {
    const raw = await db.execute(sql`
      SELECT coalesce(sum(spent_units::numeric), 0)::text AS spent
      FROM x402_l1_purchases
      WHERE attempted_at >= ${utcDayStart()}
    `);
    const list = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as {
      spent: string;
    }[];
    // Fail-closed: an unreadable ledger must never read as "nothing spent
    // today" — that is the one wrong answer that opens a fresh daily budget.
    const spentRaw = list[0]?.spent;
    if (typeof spentRaw !== "string") throw new Error("l1 daily spend query returned no total");
    spentToday = BigInt(spentRaw.split(".")[0]);
  } catch (error) {
    if (!isMissingSchemaError(error)) throw error;
    return summary; // table missing → cold start, nothing to do safely
  }

  // 2.5 別枠を持つレーン（Solana・Arc）ごとに、(a) レーンが有効か、(b) その日の別枠が
  //     もう尽きていないかを見て、どちらかが否なら候補から外す（試行して断られた行を
  //     書くと、その売り手はスイープ窓のあいだ再選択されない）。読めなければ外す側へ倒す。
  //     Arc（2026-09-17）は Base と同じ鍵で署名するので、有効条件はフラグだけ。
  const lanes: { chain: CappedChain; ready: boolean }[] = [
    { chain: "solana", ready: solanaReady },
    { chain: "arc", ready: isArcL1Enabled() },
    // Circle Gateway（2026-10-25）: 旗が正確に "true" かつ ARC_RPC_URL。ネイティブ Arc のフラグとは独立。
    { chain: "arc_gateway", ready: isArcGatewayL1Enabled() && !!process.env.ARC_RPC_URL?.trim() },
    // Tempo（MPP・2026-09-17）: Base と同じ EOA・USDC.e。有効条件はフラグだけ。
    { chain: "tempo", ready: isTempoL1Enabled() },
    // XRPL（2026-09-17）: 独立フラグ + 独立 seed。どちらか欠ければ候補から外れる。
    { chain: "xrpl", ready: xrplReady },
    // Celo（2026-10-10）: Base と同じ鍵で署名する EVM レーン。有効条件はフラグだけ（Arc と同じ）。
    // フラグが無ければ候補 SQL が Celo を主ネットワークにする行を外し、レーン枠も問い合わせない。
    { chain: "celo", ready: isCeloL1Enabled() },
    // BNB（2026-10-19・段B2）: 同じ EOA。レーン枠の有効条件は旗 + BNB_RPC_URL。どちらか欠ければレーン枠を問い合わせない。
    // 旗が on でも BNB_RPC_URL が空なら署名しない（x402-payer の requiredEnv）。Base 先頭で Base の accept が外れても BNB には署名しない。
    { chain: "bnb", ready: isBnbL1Enabled() && !!process.env.BNB_RPC_URL?.trim() },
    // Arbitrum（2026-10-22）: Base と同じ鍵で署名する EVM レーン。有効条件は旗 + ARBITRUM_RPC_URL（BNB と同じ。
    // RPC が無いまま買うと照合も遅延回収もできない行が積み上がる。2026-10-22 審査）。
    { chain: "arbitrum", ready: isArbitrumL1Enabled() && !!process.env.ARBITRUM_RPC_URL?.trim() },
    // Avalanche（2026-10-26）: Base と同じ鍵で署名する EVM レーン。有効条件は旗 + AVALANCHE_RPC_URL（Arbitrum と同じ。
    // RPC が無いまま買うと照合も遅延回収もできない行が積み上がる）。
    { chain: "avalanche", ready: isAvalancheL1Enabled() && !!process.env.AVALANCHE_RPC_URL?.trim() },
    // Stellar（2026-10-18）: 旗 + 秘密 + Horizon + RPC。どれか欠ければ主ネットワークが pubnet の行を外す。
    { chain: "stellar", ready: stellarReady },
  ];
  const laneExclusionChains: { chain: CappedChain; clause: SQL }[] = [];
  const laneSelectable = new Map<CappedChain, boolean>();
  /** そのレーンの当日支出（バッチ開始時の台帳 + このバッチで署名した額）。別枠を使い切ったら優先を止める（レビュー C2）。 */
  const laneSpent = new Map<CappedChain, bigint>();
  for (const lane of lanes) {
    let selectable = lane.ready;
    if (selectable) {
      try {
        const capPredicate =
          lane.chain === "arc" || lane.chain === "arc_gateway"
            ? chainCapNetworkSql(lane.chain, CHAIN_DAILY_CAPS[lane.chain].networkLike)
            : sql`network LIKE ${CHAIN_DAILY_CAPS[lane.chain].networkLike}`;
        const rawLane = await db.execute(sql`
          SELECT coalesce(sum(spent_units::numeric), 0)::text AS spent
          FROM x402_l1_purchases
          WHERE attempted_at >= ${utcDayStart()} AND ${capPredicate}
        `);
        const laneRows = (Array.isArray(rawLane) ? rawLane : (rawLane as { rows?: unknown[] }).rows ?? []) as { spent: string }[];
        const spentRaw = laneRows[0]?.spent;
        if (typeof spentRaw !== "string") {
          selectable = false;
        } else {
          const spentNow = BigInt(spentRaw.split(".")[0]);
          const open = lane.chain === "arc_gateway" ? arcGatewayCapOpen(spentNow) : spentNow < chainDailyCapUnits(lane.chain);
          if (!open) selectable = false;
          else laneSpent.set(lane.chain, spentNow);
        }
      } catch (error) {
        logServerErrorSafe(`observatory.l1.${lane.chain}_cap_read`, redactedError(error));
        selectable = false;
      }
    }
    // レーンが無効（フラグ無し or 鍵が読めない）か別枠が尽きた間は、候補から SQL の段階で
    // 外す——「試行して skip」の雑音でなく、最初から対象外。行も書かない。
    laneSelectable.set(lane.chain, selectable);
    // 旗 OFF の stellar:pubnet は origin/main と同じく候補 SQL から外さない。未知の network として主候補に残り、
    // purchaseOne は EVM の selectAccept に落とす。旗 ON で準備が足りないときだけ外す。
    // 旗 OFF の eip155:56 も同じ（2026-10-19・段B2）。旗 ON で BNB_RPC_URL が無いときだけ外す。
    const flagOffKeepsCandidates =
      (lane.chain === "stellar" && process.env.OBSERVATORY_STELLAR_L1_ENABLED !== "true") ||
      (lane.chain === "bnb" && process.env.OBSERVATORY_BNB_L1_ENABLED !== "true");
    if (!selectable && !flagOffKeepsCandidates) {
      laneExclusionChains.push({
        chain: lane.chain,
        clause: sql`AND (e.network IS NULL OR e.network NOT LIKE ${CHAIN_DAILY_CAPS[lane.chain].networkLike})`,
      });
    }
  }
  // 主候補は従来どおり。Gateway の専用取得だけは、ネイティブ Arc が止まっていても eip155:5042 を隠さない
  // （Gateway だけの出品は network が eip155:5042。arc の NOT LIKE を掛けると旗が on でも 0 件になる）。
  const laneExclusions: SQL[] = laneExclusionChains.map((x) => x.clause);
  const gatewayExclusions: SQL[] = laneExclusionChains.filter((x) => x.chain !== "arc").map((x) => x.clause);
  /** レーンの優先がまだ開いているか: selectable で、バッチ内の加算込みの支出が別枠未満。 */
  const laneOpen = (chain: CappedChain): boolean =>
    laneSelectable.get(chain) === true && (laneSpent.get(chain) ?? chainDailyCapUnits(chain)) < chainDailyCapUnits(chain);

  // 2.6 初回購入の日次枠（FIRST_PURCHASE_DAILY_QUOTA）。枠に達した日は「購入行が
  //     まだ 1 件も無いエンドポイント」を候補から外す（買い直しは続く）。読めなければ
  //     外す側へ倒す——初回購入を 1 日見送っても翌日また候補になるが、枠を数えられない
  //     まま走ると、カタログが跳ねた日に初回購入だけで日次予算を使い切る。
  let firstPurchasesSelectable = true;
  // census の候補（selection = "census"）だけは censusFirstPurchaseQuota（2026-09-29・既定は同じ 120）まで。
  // 数え方は同じ（当日の初回購入の総数）。読めなければ census も外す側へ倒す。
  const censusFirstQuota = censusFirstPurchaseQuota(FIRST_PURCHASE_DAILY_QUOTA);
  let censusFirstSelectable = true;
  try {
    const rawFirst = await db.execute(sql`SELECT ${firstPurchasesTodayCountSql()}::text AS n`);
    const firstRows = (Array.isArray(rawFirst)
      ? rawFirst
      : ((rawFirst as { rows?: unknown[] }).rows ?? [])) as { n: string }[];
    const firstRaw = firstRows[0]?.n;
    if (typeof firstRaw !== "string" || Number(firstRaw) >= FIRST_PURCHASE_DAILY_QUOTA) {
      firstPurchasesSelectable = false;
    }
    if (typeof firstRaw !== "string" || !Number.isFinite(Number(firstRaw)) || Number(firstRaw) >= censusFirstQuota) {
      censusFirstSelectable = false;
    }
  } catch (error) {
    logServerErrorSafe("observatory.l1.first_purchase_quota_read", redactedError(error));
    firstPurchasesSelectable = false;
    censusFirstSelectable = false;
  }

  // 3. Targets: L0-passing active endpoints. Priority sellers (verified
  //    organic demand, PRIORITY_SELLER_HOSTS) are pinned to the head and
  //    re-enter daily so their receipt series accumulates; the long tail
  //    follows by observed demand and is swept once per SWEEP_WINDOW_DAYS.
  //    (要件定義v2 2026-08-14 §2.1-2: concentrate the daily budget on repeat
  //    purchases of the endpoints buyers depend on, not one-shot coverage.)
  // 2026-09-19 最終確認 Note: 読み取り経路の逐語コピーは operator-sql.ts へ寄せた。
  // 買い手側に残っていたこの 1 箇所も同じ述語を通す（denylist が空なら `AND true` で、
  // 以前の「句ごと空」と結果は同じ。違いは、空なら 1 回鳴ること）。
  const { targetsSql, censusTargetsSql, primaryExtra } = l1TargetsSqlBuilders({
    limit,
    onlyEndpointId,
    laneExclusions,
    firstPurchasesSelectable,
    censusFirstSelectable,
  });
  const primaryStartedAt = now();
  const rawTargets = await withDailyFallback(
    async () => await db.execute(targetsSql(true, undefined, undefined, undefined, primaryExtra)),
    async () => await db.execute(targetsSql(false, undefined, undefined, undefined, primaryExtra)),
  );
  summary.primaryFetchMs = now() - primaryStartedAt;
  const targetList = (Array.isArray(rawTargets)
    ? rawTargets
    : (rawTargets as { rows?: unknown[] }).rows ?? []) as Record<string, unknown>[];
  let candidates: Candidate[] = targetList.map(rowToCandidate);

  // 旗 on で 1 件を名指ししたときだけ、Gateway 以外に署名できる accept が無い出品をレーンに戻す。
  // 旗 off ではこの問い合わせを出さない。主候補の SQL は origin/main のまま。
  if (onlyEndpointId && isArcGatewayL1Enabled() && laneSelectable.get("arc_gateway") === true) {
    const pinnedRaw = await withDailyFallback(
      async () => await db.execute(targetsSql(true, undefined, undefined, undefined, gatewayCandidateInclusionSql(), gatewayExclusions)),
      async () => await db.execute(targetsSql(false, undefined, undefined, undefined, gatewayCandidateInclusionSql(), gatewayExclusions)),
    );
    const pinnedRows = (Array.isArray(pinnedRaw) ? pinnedRaw : (pinnedRaw as { rows?: unknown[] }).rows ?? []) as Record<string, unknown>[];
    const pinnedOne = pinnedRows[0];
    if (pinnedOne && String(pinnedOne.id) === onlyEndpointId) {
      const pinned = { ...rowToCandidate(pinnedOne), laneChain: "arc_gateway" as const };
      candidates = [pinned, ...candidates.filter((c) => c.id !== pinned.id)];
    }
  }

  // 3.5 チェーンごとの候補の最低枠（2026-09-17・budget.ts laneFloorPerRun）。需要順の主候補は
  //     EVM の未購入の裾野に埋まり、Solana（候補 204・未購入 192）は別枠 $2 を一度も使い切れずに
  //     1 件/日だった。別枠を持つレーンごとに、同じ WHERE で network を絞った候補を先頭に置く。
  //     主候補の LIMIT は減らさない（Base の候補は毎回 20 件以上残す）。旗が off・別枠が尽きた
  //     レーンは laneExclusions が同じ WHERE で外すので、ここでも 0 行。playground の 1 件指定
  //     （onlyEndpointId）では枠を使わない。
  const laneHead = await laneFloorCandidates({
    lanes,
    now,
    floor: onlyEndpointId ? 0 : laneFloorPerRun(),
    fetchLane: async (chain, laneLimit) => {
      // Gateway は共有の枠 SQL を使わない。networkLike を "%" にするのは、初回購入の EXISTS を
      // レーン付きの問い合わせとして飛ばすため（その三項は固定）。出品の条件は inclusion が掛ける。
      // 別枠 0・残高で閉じたあとはここで問い合わせない。
      if (chain === "arc_gateway") {
        if (!laneOpen("arc_gateway")) return [];
        const lane = { chain, networkLike: "%", limit: laneLimit };
        return await withDailyFallback(
          async () => await db.execute(targetsSql(true, lane, undefined, undefined, gatewayCandidateInclusionSql(), gatewayExclusions)),
          async () => await db.execute(targetsSql(false, lane, undefined, undefined, gatewayCandidateInclusionSql(), gatewayExclusions)),
        );
      }
      const lane = { chain, networkLike: CHAIN_DAILY_CAPS[chain].networkLike, limit: laneLimit };
      return await withDailyFallback(
        async () => await db.execute(targetsSql(true, lane)),
        async () => await db.execute(targetsSql(false, lane)),
      );
    },
  });
  summary.laneFloor = laneHead.counts;
  summary.laneFloorHostCapped = laneHead.hostCapped;
  summary.laneFetchMs = laneHead.fetchMs;
  if (!onlyEndpointId && laneSelectable.get("arc_gateway") === true && isArcGatewayL1Enabled()) {
    summary.gatewayPostBodyUnknownActive = await queryGatewayPostBodyUnknownActive(db);
  }
  // 3.6 売り手の census（2026-09-28・budget.ts CENSUS_PER_RUN）。L1 の購入行がまだ無い Base のホストを、
  //     そのホストで払う額（price_amount）がいちばん安い出品（$1 以下）で 1 件ずつ、レーン枠と優先ホストの
  //     **後ろ**・主候補の残りの**前**に置く
  //     （レーン枠は削らない）。旗 OBSERVATORY_L1_CENSUS=on が無い日・playground の 1 件指定では
  //     1 本も問い合わせない。WHERE は主候補と同じ（L0 合格・自己除外・初回購入の日次枠・冷却・窓）で、
  //     購入の可否もその後の同じ経路（上限・別枠・残高・原子的予約・停止スイッチ）が決める。
  //     公平な買い直し（retest・2026-09-28）も同じ旗・同じ上限（CENSUS_PER_RUN を分け合う・retest が先）で、
  //     最新の行がこちらの側の理由で失敗している Base の売り手を、同じ規則（1 売り手 1 件・払う額の最安・
  //     $1 以下・主ネットワーク Base）で 1 件ずつ選ぶ。retest は購入行のある売り手、census は無い売り手なので
  //     本来重ならないが、ホスト名でも重複を外す（同じ売り手を 1 回のバッチで 2 度買わない）。
  const censusOn = isCensusEnabled() && !onlyEndpointId;
  const laneIds = new Set(laneHead.head.map((c) => c.id));
  const fetchCensusRows = async (censusLimit: number) =>
    await withDailyFallback(
      async () => await db.execute(censusTargetsSql(true, censusLimit)),
      async () => await db.execute(censusTargetsSql(false, censusLimit)),
    );
  // 2026-09-29 独立レビュー W2: 日次 $25 がバッチ開始時点で尽きている日は census / retest の候補を取りに行かない。
  // 両者は予算の否認で行を書かない（下の purchaseOne）ので、取りに行くと実行のたびに同じホストへ支払いなしの要求を
  // 出し直すだけになる。残りの予算より高い候補も入れない（pickCensusRows の maxPriceUnits）。金の関門（checkL1Budget・
  // reserveSpend の 1 文）は変えない——ここは候補の並びだけ。
  const fairBudgetUnits = DAILY_BUDGET_UNITS - spentToday;
  const fairOn = censusOn && fairBudgetUnits > 0n;
  const retestParams = fairOn ? await readRetestSellers(db) : null;
  const plan = await planCensusAndRetest({
    censusOn: fairOn,
    maxPriceUnits: fairBudgetUnits,
    retestOn: fairOn && retestParams !== null && retestParams.hostCount > 0,
    perRun: CENSUS_PER_RUN,
    censusMin: censusOn ? censusMinPerRun() : 0,
    excludeIds: laneIds,
    fetchCensus: fetchCensusRows,
    fetchRetest: async (limit) =>
      await withDailyFallback(
        async () => await db.execute(censusTargetsSql(true, limit, "retest", retestParams ?? undefined)),
        async () => await db.execute(censusTargetsSql(false, limit, "retest", retestParams ?? undefined)),
      ),
  });
  summary.retestCandidates = plan.retestCount;
  summary.censusCandidates = plan.censusCount;
  if (censusOn) summary.censusRemaining = await countCensusRemaining(db);
  // 並びは「レーン枠 → 優先ホスト → retest → census → 主候補の残り」（独立レビュー W1・2026-09-28）。方法論は
  // 優先ホスト（PRIORITY_SELLER_HOSTS）を「候補選択の先頭に固定」と書いているので、retest / census の最大 40 件を
  // その前に置かない。retest も census も 0 件の日（旗 OFF を含む）は従来の並びのまま（何も動かさない）。
  // census の最低枠（OBSERVATORY_L1_CENSUS_MIN_PER_RUN・2026-09-29）があれば、その分の census は retest より前
  // （planCensusAndRetest）。1 回のバッチが実際に回せるのは 50〜70 件なので、後ろに置くと枠があっても買われない。
  const fairHead = plan.head;
  const priorityHead =
    fairHead.length > 0
      ? candidates.filter((c) => c.isPriority && !laneIds.has(c.id))
      : [];
  const priorityIds = new Set(priorityHead.map((c) => c.id));
  const head = [...laneHead.head, ...priorityHead, ...fairHead.filter((c) => !priorityIds.has(c.id))];
  if (head.length > 0) {
    // 主候補にも入っていた行は先頭へ移す（同じ売り手を 1 回のバッチで 2 度買わない）。
    const headIds = new Set(head.map((c) => c.id));
    candidates = [...head, ...candidates.filter((c) => !headIds.has(c.id))];
  }

  // 購入元残高の関門（2026-09-17 Issue #29）。チェーンごとに 1 バッチ 1 回だけ読み、
  // 読めなければ署名しない側へ倒す。ログはチェーンごとに 1 回。
  const payerFunds = createPayerFunds(options.getPayerUsdcBalance ?? defaultPayerUsdcBalance);
  const unfundedLogged = new Set<string>();
  const onPayerUnfunded = (chain: string, detail: Record<string, unknown>) => {
    summary.payerUnfunded++;
    if (detail.reason === "unreadable" && !summary.payerFundsUnreadable.includes(chain)) summary.payerFundsUnreadable.push(chain);
    if (unfundedLogged.has(chain)) return;
    unfundedLogged.add(chain);
    logServerErrorSafe("observatory.l1.payer_unfunded", new Error(`payer_unfunded chain=${chain} ${JSON.stringify(detail)}`));
  };

  // XRPL は **1 バッチ 1 件**（2026-09-17 レビュー #2）。署名は account_info の Sequence を使うので、
  // 同じバッチで 2 件署名すると同じ Sequence の tx が 2 本できる（片方は tefPAST_SEQ）。署名した後の
  // XRPL 候補は候補選択の段階で外し、行を書かず別枠も減らさない（翌バッチにまた候補になる）。
  // 網の手数料が上限を超えていた（xrpl_fee_over_cap）ときも同じく、そのバッチの XRPL は閉じる。
  let xrplLaneClosed = false;
  // 我々の側の XRPL 障害（署名の材料が読めない・購入元の資金切れ）で閉じたとき（2026-09-18 レビュー W1）。このときは
  // XRPL の accept を優先しないだけで、Base 先頭のレーン候補は **Base の通常経路へ落とす**
  // （行を書かずに飛ばし続けると、RPC が直るまでその売り手を誰の経路でも測れない）。
  // 主ネットワークが XRPL の行は他に買う経路が無いので飛ばす（同じ RPC を叩き直して request_error を積まない）。
  let xrplLaneUnavailable = false;
  // Celo（2026-10-10・点検の所見）: Celo の購入元残高が足りない／読めないと分かったら、そのバッチの Celo レーンの
  // **優先**を閉じる（XRPL の xrplLaneUnavailable と同じ型）。閉じないと、Base が先頭で Celo の accept も持つ出品は
  // レーン枠から Celo で買おうとして毎回 payer_unfunded（行なし）になり、Celo に入金するまで Base でも買えない。
  // 閉じた後のレーン候補は Base の通常経路（preferNetworks 無し）で買う。金の関門は何も変えない。
  let celoLaneUnavailable = false;
  // BNB（2026-10-19・段B2）: Celo の celoLaneUnavailable と同じ型。未入金のあと、以後の bnb の優先を閉じ、
  // Base 先頭のその候補は優先なしで 1 回だけ買い直す。主ネットワークが eip155:56 の行はやり直さない。
  // 支払い付きの待ちは 20 秒のまま（Celo の 45 秒には広げない）。
  let bnbLaneUnavailable = false;
  // Arbitrum（2026-10-22）: Celo の celoLaneUnavailable と同じ型。未入金のあと、以後の arbitrum の優先を閉じ、
  // Base 先頭のその候補は優先なしで 1 回だけ買い直す。主ネットワークが eip155:42161 の行はやり直さない。
  let arbitrumLaneUnavailable = false;
  // Avalanche（2026-10-26）: Arbitrum の arbitrumLaneUnavailable と同じ型。未入金のあと、以後の avalanche の優先を閉じ、
  // Base 先頭のその候補は優先なしで 1 回だけ買い直す。主ネットワークが eip155:43114 の行はやり直さない。
  let avalancheLaneUnavailable = false;
  // Circle Gateway（2026-10-25）: 残高が足りない／読めないと分かったら、そのバッチの Gateway 優先を閉じる。
  // Gateway しか受けない出品はやり直さない（selectAccept が別の accept を見つけるときだけ 1 回買い直す）。
  let arcGatewayLaneUnavailable = false;
  let gatewayRead: Promise<bigint | null> | null = null;
  let gatewayCommitted = 0n;
  const readArcGatewayAvailable = async (): Promise<bigint | null> => {
    if (!gatewayRead) {
      const read = options.readArcGatewayAvailable ?? (() => readArcGatewayAvailableProd(account.address));
      gatewayRead = Promise.resolve()
        .then(() => read())
        .then(
          (v) => (typeof v === "bigint" && v >= 0n ? v : null),
          (error) => {
            logServerErrorSafe("observatory.l1.arc_gateway_balance", error);
            return null;
          },
        );
    }
    const available = await gatewayRead;
    if (available === null) return null;
    const left = available - gatewayCommitted;
    return left >= 0n ? left : 0n;
  };
  const commitArcGateway = (amount: bigint) => {
    gatewayCommitted += amount;
  };
  // Stellar（2026-10-18・段4）: 未入金、または署名器が落ちたら、以後の stellar の優先を閉じる
  // （Celo の celoLaneUnavailable と同じ型）。閉じないと、Base 先頭で Stellar の accept も持つ出品は
  // レーン枠から Stellar で買おうとして毎回 payer_unfunded（行なし）になり、入金するまで Base でも買えない。
  // 署名前の故障だけ、その Base 先頭の候補を Base の通常経路で 1 回買い直す。署名後
  // （auth entry に署名したあとの再シミュレーション・空の payload）は予約を残し、買い直さない。
  // 主ネットワークが pubnet の行は他に買う経路が無いので飛ばす。summary に閉じた理由は足さない。
  let stellarLaneUnavailable = false;

  // 売り手ごとの日次上限に届いた受取先・ホスト（2026-09-29 監査 5 周目）。予約が断ったら、このバッチの残りの
  // 同じ売り手の候補には 402 も取りに行かない（行も書かない）。締めるのは reserveSpend で、ここは無駄を省くだけ。
  const cappedPayTos = new Set<string>();
  const cappedHosts = new Set<string>();
  const cappedDomains = new Set<string>();

  // レーン枠の時間の上限（2026-10-27・budget.ts laneTimeShare）。使った時間がこれを超えたら、残りのレーン候補は
  // 買わずに飛ばして、持ち時間を Base の主候補に回す。並びは変えない（時間で飛ばすだけ）。
  const laneTimeLimitMs = batchBudgetMs * laneTimeShare();
  summary.setupMs = now() - runStartedAt;

  for (const [index, candidate] of candidates.entries()) {
    // Start nothing we cannot finish inside maxDuration. Purchases already in
    // flight are never interrupted — the whole point is that a signed
    // authorization must always reach its ledger row.
    // Celo レーンの候補は支払い付きを 45 秒として見込む（無払いは timeoutMs のまま）。ほかは従来どおり。
    const paidBudgetMs = paidTimeoutForBudget(candidate, timeoutMs, celoPaidTimeoutMs);
    if (!canStartAnotherPurchase(deadline.remaining(), timeoutMs, paidBudgetMs)) {
      summary.stoppedForDeadline = true;
      summary.notAttempted = candidates.length - index;
      break;
    }
    // レーン枠から来た候補（Gateway の pinned を含む）だけ。主ネットワークがそのチェーンの主候補（laneChain が null）は
    // 対象外。402 も取りに行かず、行も書かない（予約・別枠・署名の関門には届かない）。
    if (candidate.laneChain !== null && now() - runStartedAt > laneTimeLimitMs) {
      summary.skipped++;
      summary.laneSkippedForTime++;
      continue;
    }
    // XRPL の候補 = 主ネットワークが XRPL の行と、XRPL のレーン枠から来た行（Base 先頭・XRPL 2 番目）。
    // 1 バッチ 1 件のガードは両方に掛かる: 署名した後は行を書かずに飛ばす（Base でも買わない——買うと
    // スイープ窓のあいだ XRPL の枠に戻らない）。翌バッチにまた XRPL の候補になる。
    const isXrplCandidate = candidate.network === XRPL_MAINNET_CAIP2 || candidate.laneChain === "xrpl";
    if (isXrplCandidate && xrplLaneClosed) {
      summary.skipped++;
      continue;
    }
    if (xrplLaneUnavailable && candidate.network === XRPL_MAINNET_CAIP2) {
      summary.skipped++;
      continue;
    }
    if (stellarLaneUnavailable && candidate.network === STELLAR_PUBNET_CAIP2) {
      summary.skipped++;
      continue;
    }
    // Gateway の優先が閉じている間、残りの Gateway 出品には 402 も取りに行かない（no_eligible_accept を売り手に書かない）。
    if (candidate.laneChain === "arc_gateway" && (arcGatewayLaneUnavailable || !laneOpen("arc_gateway"))) {
      summary.skipped++;
      continue;
    }
    const arcGatewayPreferred = candidate.laneChain === "arc_gateway" && !arcGatewayLaneUnavailable && laneOpen("arc_gateway");
    // XRPL の secondary accept の優先（2026-09-18・Arc の preferNetworks と同じ条件）: レーン枠から来た
    // 候補にだけ、別枠がまだ開いていて、この endpoint に XRPL での決済主張も非決済も無いとき。
    const xrplLanePreferred =
      candidate.laneChain === "xrpl" &&
      candidate.network !== XRPL_MAINNET_CAIP2 &&
      !xrplLaneUnavailable &&
      laneOpen("xrpl") &&
      !candidate.settledNetworks.includes(XRPL_MAINNET_CAIP2) &&
      !candidate.failedNetworks.includes(XRPL_MAINNET_CAIP2);
    // Stellar の secondary accept の優先（2026-10-18・段4・XRPL と同じ条件）。主ネットワークが pubnet の行は
    // isStellar が先に入るので、ここは Base 先頭のレーン候補だけ。
    const stellarLanePreferred =
      candidate.laneChain === "stellar" &&
      candidate.network !== STELLAR_PUBNET_CAIP2 &&
      !stellarLaneUnavailable &&
      laneOpen("stellar") &&
      !candidate.settledNetworks.includes(STELLAR_PUBNET_CAIP2) &&
      !candidate.failedNetworks.includes(STELLAR_PUBNET_CAIP2);
    // SQL が外しているはずだが、二重防御（2026-09-02 A1）。テンプレート URL に
    // 署名して予算を燃やす経路は、どの入口からも開かない。
    if (isPathTemplate(candidate.resourceUrl)) {
      summary.skipped++;
      continue;
    }
    if (
      (candidate.payTo !== null && cappedPayTos.has(normalizedPayTo(candidate.payTo))) ||
      cappedHosts.has(censusHostOf(laneHostOf(candidate.resourceUrl))) ||
      cappedDomains.has(sellerDomainOf(candidate.resourceUrl))
    ) {
      summary.skipped++;
      summary.sellerCapped++;
      continue;
    }
    try {
      // レーンの accept 優先（LANE_NETWORK・レビュー C2/C4）: レーン枠から来た候補にだけ、その
      // レーンがまだ開いていて（別枠が残る）、この endpoint にそのチェーンでの決済主張も非決済も
      // 無いときに、そのレーンの network を先に選ばせる。主候補には掛けない。
      const laneNetwork = candidate.laneChain !== null ? LANE_NETWORK[candidate.laneChain] : undefined;
      const preferNetworks =
        candidate.laneChain !== null &&
        laneNetwork !== undefined &&
        laneOpen(candidate.laneChain) &&
        !(candidate.laneChain === "celo" && celoLaneUnavailable) &&
        !(candidate.laneChain === "stellar" && stellarLaneUnavailable) &&
        !(candidate.laneChain === "bnb" && bnbLaneUnavailable) &&
        !(candidate.laneChain === "arbitrum" && arbitrumLaneUnavailable) &&
        !(candidate.laneChain === "avalanche" && avalancheLaneUnavailable) &&
        !candidate.settledNetworks.includes(laneNetwork) &&
        !candidate.failedNetworks.includes(laneNetwork)
          ? [laneNetwork]
          : [];
      const purchaseInput = { candidate, xrplLanePreferred, stellarLanePreferred, arcGatewayPreferred, account, solanaKeypair, getSolanaBlockhash, xrplPayer, xrplWallet, getXrplSigningInputs, stellarPayer, stellarAddress: stellarAccount?.address ?? null, createStellarPayment, fetchImpl, timeoutMs, celoPaidTimeoutMs, db, spentToday, payerFunds, onPayerUnfunded, tempoEnabled: laneSelectable.get("tempo") ?? false, mppxCharge: options.mppxCharge, readArcGatewayAvailable, commitArcGateway, signArcGateway: options.signArcGateway ?? signArcGatewayPayment };
      let outcome = await purchaseOne({ ...purchaseInput, preferNetworks });
      // Celo の残高が足りない／読めない（署名していない・行も予約も無い）。以後の Celo レーンの優先を閉じる。
      // いまの候補が「Celo を優先された Base 先頭の出品」なら、優先なしでもう 1 回だけ通す——壁の並びどおり Base の
      // accept が選ばれ、Base の残高・Base の関門で買う。Celo が主ネットワークの候補はやり直さない（優先を外しても
      // 選ばれるのは Celo の accept で、結果は同じ）。残高の読み取りはバッチ内でキャッシュ済みなので RPC は増えない。
      if (outcome.kind === "payer_unfunded" && outcome.payerChain === "celo") {
        celoLaneUnavailable = true;
        if (preferNetworks.includes(CELO_CAIP2)) outcome = await purchaseOne({ ...purchaseInput, preferNetworks: [] });
      }
      // BNB の残高が足りない／読めない（署名していない・行も予約も無い）。以後の BNB レーンの優先を閉じる。
      // いまの候補が「BNB を優先された Base 先頭の出品」なら、優先なしでもう 1 回だけ通す。BNB が主ネットワークの
      // 候補はやり直さない。残高の読み取りはバッチ内でキャッシュ済みなので RPC は増えない。
      if (outcome.kind === "payer_unfunded" && outcome.payerChain === "bnb") {
        bnbLaneUnavailable = true;
        if (preferNetworks.includes(BNB_CAIP2)) outcome = await purchaseOne({ ...purchaseInput, preferNetworks: [] });
      }
      // Arbitrum の残高が足りない／読めない（署名していない・行も予約も無い）。以後の Arbitrum レーンの優先を閉じる。
      // いまの候補が「Arbitrum を優先された Base 先頭の出品」なら、優先なしでもう 1 回だけ通す。Arbitrum が主ネットワークの
      // 候補はやり直さない。残高の読み取りはバッチ内でキャッシュ済みなので RPC は増えない。
      if (outcome.kind === "payer_unfunded" && outcome.payerChain === "arbitrum") {
        arbitrumLaneUnavailable = true;
        if (preferNetworks.includes(ARBITRUM_CAIP2)) outcome = await purchaseOne({ ...purchaseInput, preferNetworks: [] });
      }
      // Avalanche の残高が足りない／読めない（署名していない・行も予約も無い）。以後の Avalanche レーンの優先を閉じる。
      // いまの候補が「Avalanche を優先された Base 先頭の出品」なら、優先なしでもう 1 回だけ通す。Avalanche が主ネットワークの
      // 候補はやり直さない。残高の読み取りはバッチ内でキャッシュ済みなので RPC は増えない。
      if (outcome.kind === "payer_unfunded" && outcome.payerChain === "avalanche") {
        avalancheLaneUnavailable = true;
        if (preferNetworks.includes(AVALANCHE_CAIP2)) outcome = await purchaseOne({ ...purchaseInput, preferNetworks: [] });
      }
      // Stellar の未入金は、優先を閉じてから Base 先頭の候補だけ 1 回買い直す。
      // 主ネットワークが pubnet の行は stellarLanePreferred が偽なので買い直さない。
      if (outcome.kind === "payer_unfunded" && outcome.payerChain === "stellar") {
        stellarLaneUnavailable = true;
        if (stellarLanePreferred) outcome = await purchaseOne({ ...purchaseInput, stellarLanePreferred: false, preferNetworks: [] });
      }
      // 署名前の故障だけ（retryBase）。署名後は行を残したまま下の枝でレーンを閉じ、Base では買わない。
      if (outcome.kind === "stellar_signing_unavailable" && outcome.retryBase === true && stellarLanePreferred) {
        stellarLaneUnavailable = true;
        outcome = await purchaseOne({ ...purchaseInput, stellarLanePreferred: false, preferNetworks: [] });
      }
      if (outcome.kind === "payer_unfunded" && outcome.payerChain === "arc_gateway") {
        arcGatewayLaneUnavailable = true;
        if (outcome.retryWithoutGateway) {
          outcome = await purchaseOne({ ...purchaseInput, arcGatewayPreferred: false, preferNetworks: [] });
        }
      }
      spentToday += outcome.spent;
      // バッチ内のレーン支出を加算する（署名した額。決済は非同期なので使ったとみなす）。
      const outcomeLane = outcome.capChain ?? (outcome.network ? cappedChainFor(outcome.network) : null);
      if (outcomeLane !== null && outcome.spent > 0n) laneSpent.set(outcomeLane, (laneSpent.get(outcomeLane) ?? 0n) + outcome.spent);
      // XRPL で署名したら閉じる（主でも secondary でも）。Base へ落ちて買われた secondary 候補は閉じない。
      if (outcome.network === XRPL_MAINNET_CAIP2 && outcome.spent > 0n) xrplLaneClosed = true;
      summary.spentUnitsTotal = String(BigInt(summary.spentUnitsTotal) + outcome.spent);
      if (outcome.kind === "attempted") {
        summary.attempted++;
        const attemptNetwork = outcome.network ?? "unknown";
        summary.attemptsByNetwork[attemptNetwork] = (summary.attemptsByNetwork[attemptNetwork] ?? 0) + 1;
        if (outcome.settled) summary.settled++;
        else if (outcome.status === "delivered_no_receipt") summary.deliveredNoReceipt++;
        else summary.settleFailed++;
      } else if (outcome.kind === "halted") {
        // 停止は「この候補には高すぎた」ではなく「もう買うな」。予算否認と違い、
        // 残りの候補を歩き続ける理由がひとつも無いのでバッチごと降りる。
        summary.halted = true;
        summary.haltReason = outcome.haltReason ?? null;
        summary.disabledReason = "spending_halted";
        summary.notAttempted = candidates.length - index - 1;
        break;
      } else if (outcome.kind === "payer_unfunded") {
        // 署名していない。summary.payerUnfunded は onPayerUnfunded が数える。残りの候補は
        // 安いものなら買える（バッチ内の署名額を差し引いた残高で比べる）ので歩き続ける。
        // XRPL（2026-09-19）だけは 1 回目でレーンを閉じる: XRPL を優先したまま歩くと、残りのレーン候補は
        // 全部ここへ落ちて行も書かれず、購入元に資金が戻るまで Base 先頭の売り手をどの経路でも測れない。
        // 署名の材料が読めないときと同じく、以降の Base 先頭のレーン候補は Base の通常経路で買う
        // （主ネットワークが XRPL の行は飛ばす）。残高はチェーンごとなので他チェーンの購入は止めない。
        if (outcome.payerChain === "xrpl") {
          xrplLaneUnavailable = true;
          summary.xrplLaneClosed ??= "payer_unfunded";
        }
        // 上で優先は閉じている。主ネットワークが pubnet の行（買い直さない）と、買い直しが再び stellar を
        // 返したときのために印を残す。secondary の Base 買い直しが通ったあとはここへ来ない。
        if (outcome.payerChain === "stellar") stellarLaneUnavailable = true;
      } else if (outcome.kind === "stellar_signing_unavailable") {
        // 署名後は spent を残した request_error（outcome.spent は予約額。上で日次に足してある）。
        // 署名前の主ネットワークは spent 0 の request_error。どちらも Base では買い直さない。
        stellarLaneUnavailable = true;
        summary.skipped++;
      } else if (outcome.kind === "xrpl_fee_over_cap") {
        // 網の open_ledger_fee が上限超。署名していない・行も無い。このバッチの XRPL は閉じ、
        // 他チェーンの候補は歩き続ける。理由は summary とサーバログに残す。
        summary.xrplFeeOverCap++;
        if (!xrplLaneClosed) {
          logServerErrorSafe("observatory.l1.xrpl_fee_over_cap", new Error(`open_ledger_fee above ${1_000} drops; XRPL lane closed for this batch`));
        }
        xrplLaneClosed = true;
        summary.xrplLaneClosed ??= "fee_over_cap";
      } else if (outcome.kind === "xrpl_lane_unavailable") {
        // 署名の材料が読めなかった（我々の側の障害）。1 回目で XRPL の優先を外し、以降の Base 先頭の
        // レーン候補は Base の通常経路で買う。理由は summary とサーバログ（purchaseOne 側）に残る。
        xrplLaneUnavailable = true;
        summary.xrplLaneClosed ??= "signing_inputs_unavailable";
        summary.skipped++;
      } else if (outcome.kind === "seller_capped") {
        summary.skipped++;
        summary.sellerCapped++;
        if (outcome.sellerCap) {
          // 受取先で届いたなら受取先を、ホストで届いたならホストを閉じる（片方で届いた売り手の別の単位は開けておく）。
          if (outcome.sellerCap.scope === "payto") cappedPayTos.add(outcome.sellerCap.payTo);
          else if (outcome.sellerCap.scope === "host") cappedHosts.add(outcome.sellerCap.host);
          else cappedDomains.add(outcome.sellerCap.domain);
        }
      } else if (outcome.kind === "budget_denied") {
        summary.budgetDenied++;
        // Budget exhausted for anything at this price — later candidates may
        // be cheaper, so keep walking rather than break (prices vary 100x).
      } else {
        summary.skipped++;
        if (outcome.gatewayPostBodyUnknownAtSign) summary.gatewayPostBodyUnknownSignSkipped++;
      }
    } catch (error) {
      logServerErrorSafe("observatory.l1.purchase", error);
      summary.skipped++;
    }
  }

  return summary;
}

/** 候補 SQL の 1 行 → Candidate（主候補とレーン枠の候補が同じ形になるように共有）。 */
function rowToCandidate(r: Record<string, unknown>): Candidate {
  return {
    id: String(r.id),
    resourceUrl: String(r.resource_url),
    method: (r.method as string | null) ?? null,
    priceAmount: (r.price_amount as string | null) ?? null,
    payTo: (r.pay_to as string | null) ?? null,
    network: (r.network as string | null) ?? null,
    declaredSchema: r.declared_schema ?? null,
    isPriority: r.is_priority === true,
    isMature: r.is_mature === true,
    settledNetworks: parseTextArray(r.settled_networks),
    failedNetworks: parseTextArray(r.failed_networks),
    xrplDeclaredPayTos: parseTextArray(r.xrpl_declared_pay_tos),
    arcDeclaredPayTos: declaredPayTosFor(ARC_CHAIN, r.arc_declared_accepts),
    celoDeclaredPayTos: declaredPayTosFor(CELO_CHAIN, r.celo_declared_accepts),
    bnbDeclaredPayTos: declaredPayTosFor(BNB_CHAIN, r.bnb_declared_accepts),
    arbitrumDeclaredPayTos: declaredPayTosFor(ARBITRUM_CHAIN, r.arbitrum_declared_accepts),
    avalancheDeclaredPayTos: declaredPayTosFor(AVALANCHE_CHAIN, r.avalanche_declared_accepts),
    stellarDeclaredPayTos: parseTextArray(r.stellar_declared_pay_tos),
    gatewayDeclaredPayTos: gatewayDeclaredPayTosFor(r.arc_declared_accepts),
    laneChain: null,
    selection: null,
  };
}

/** text[] は pg では配列、経路によっては '{a,b}' の文字列で来る。どちらも読む。無ければ空。 */
function parseTextArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string" && v.startsWith("{") && v.endsWith("}")) {
    const inner = v.slice(1, -1);
    return inner === "" ? [] : inner.split(",").map((x) => x.replace(/^"|"$/g, ""));
  }
  return [];
}

/**
 * チェーンごとの候補の最低枠（2026-09-17）。別枠を持つレーン（CHAIN_DAILY_CAPS の表）を順に
 * 回し、有効なレーンごとに最大 `floor` 件を取って主候補の先頭に置く行を返す。
 *
 *  - レーン同士は id で重複排除する。主候補との重複は呼び手が主候補側から抜く（先頭へ移す）。
 *  - 旗が off（`ready` でない）レーンは問い合わせない。別枠が尽きたレーンは候補 SQL の
 *    laneExclusions が同じ WHERE で外すので 0 行になる（行は書かない・従来どおり除外）。
 *  - 1 レーンの問い合わせが失敗しても、バッチは止めない（枠は並びの補助であって金の関門では
 *    ない）。ログに残して 0 件として続ける。
 *  - 問い合わせは全レーンを並べて走らせ（2026-10-27）、組み立て（重複排除・ホスト上限・件数）は従来どおりレーンの順に行う。
 *    返す並び（head）は、各レーンの 1 件目を順に → 2 件目を順に → …（interleaveLanes・2026-10-27）。
 *  - 購入の可否はここでは決めない。返した候補は主候補と同じく purchaseOne を通り、デッドライン・
 *    別枠・残高・原子的予約の関門をそのまま受ける。
 *  - 同じホストはレーンの枠の中で最大 `maxPerHost` 件（既定 LANE_FLOOR_MAX_PER_HOST = 2・2026-09-18）。
 *    1 ホストの endpoint 群が枠を独占すると、その売り手が署名前に断られる形（Tempo の
 *    `fee_payer_absent`）のとき 1 バッチがまるごと空振りになる。間引いても枠を埋められるよう、
 *    クエリは枠の LANE_FLOOR_OVERSAMPLE 倍（上限 LANE_FLOOR_FETCH_MAX 行）を同じ並びで取る。
 */
export function laneHostOf(resourceUrl: string): string {
  try {
    return new URL(resourceUrl).hostname.toLowerCase();
  } catch {
    // 読めない URL はそれ自身を 1 つのホストとして数える（まとめて 1 ホスト扱いにしない）。
    return resourceUrl;
  }
}

export async function laneFloorCandidates(input: {
  lanes: readonly { chain: CappedChain; ready: boolean }[];
  floor: number;
  fetchLane: (chain: CappedChain, limit: number) => Promise<unknown>;
  /** 同じホストの上限（テスト用に差し替え可）。 */
  maxPerHost?: number;
  /** レーンごとの取得時間（fetchMs）を測る時計。既定は Date.now（runL1Batch は自分の now を渡す）。 */
  now?: () => number;
}): Promise<{
  head: Candidate[];
  counts: Partial<Record<CappedChain, number>>;
  hostCapped: Partial<Record<CappedChain, number>>;
  /** 問い合わせたレーンごとの取得のミリ秒（2026-10-27）。問い合わせなかったレーン（旗 off・枠 0）は載せない。 */
  fetchMs: Partial<Record<CappedChain, number>>;
}> {
  const maxPerHost = input.maxPerHost ?? LANE_FLOOR_MAX_PER_HOST;
  const now = input.now ?? Date.now;
  const hostCapped: Partial<Record<CappedChain, number>> = {};
  const counts: Partial<Record<CappedChain, number>> = {};
  const fetchMs: Partial<Record<CappedChain, number>> = {};
  const seen = new Set<string>();
  // 取得だけを並べて走らせる（2026-10-27）。本番の実測（読み取り）では、準備の中でレーンの取得を 1 本ずつ順に
  // 待っていた（レーン 10 本・1 本 0.1〜1.2 秒）。組み立て（seen・ホスト上限・counts）は全部そろってから、
  // 今までと同じレーンの順に行うので、どの候補を選ぶかは変わらない。
  const fetched = await Promise.all(
    input.lanes.map(async (lane): Promise<{ rows: Record<string, unknown>[] } | { error: unknown } | null> => {
      if (!lane.ready || input.floor <= 0) return null;
      const started = now();
      try {
        const raw = await input.fetchLane(lane.chain, Math.min(input.floor * LANE_FLOOR_OVERSAMPLE, LANE_FLOOR_FETCH_MAX));
        return { rows: (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[] };
      } catch (error) {
        return { error };
      } finally {
        fetchMs[lane.chain] = now() - started;
      }
    }),
  );
  const perLane: Candidate[][] = [];
  for (const [index, lane] of input.lanes.entries()) {
    counts[lane.chain] = 0;
    hostCapped[lane.chain] = 0;
    const got = fetched[index];
    if (got === null) continue;
    if ("error" in got) {
      // 1 レーンの問い合わせが失敗しても、バッチは止めない。ログに残して 0 件として続ける（従来どおり）。
      if (!isMissingSchemaError(got.error)) logServerErrorSafe(`observatory.l1.lane_floor_${lane.chain}`, redactedError(got.error));
      continue;
    }
    const picked: Candidate[] = [];
    const perHost = new Map<string, number>();
    for (const row of got.rows) {
      if ((counts[lane.chain] ?? 0) >= input.floor) break;
      const candidate = { ...rowToCandidate(row), laneChain: lane.chain };
      if (seen.has(candidate.id)) continue;
      const host = laneHostOf(candidate.resourceUrl);
      const used = perHost.get(host) ?? 0;
      if (used >= maxPerHost) {
        hostCapped[lane.chain] = (hostCapped[lane.chain] ?? 0) + 1;
        continue;
      }
      perHost.set(host, used + 1);
      seen.add(candidate.id);
      picked.push(candidate);
      counts[lane.chain] = (counts[lane.chain] ?? 0) + 1;
    }
    perLane.push(picked);
  }
  return { head: interleaveLanes(perLane), counts, hostCapped, fetchMs };
}

/**
 * レーン枠の並び（2026-10-27）: 各レーンの 1 件目をレーンの順に、次に各レーンの 2 件目を…と交互に並べる。
 * 以前は「solana の 5 件 → arc の 5 件 → …」とレーンごとにまとめていたので、時間の上限（L1_LANE_TIME_SHARE）で
 * 後ろが切られると、後ろのレーン（Avalanche・Stellar）は 1 件も試せなかった。レーンの中の並びは変えない。
 */
export function interleaveLanes<T>(perLane: readonly (readonly T[])[]): T[] {
  const out: T[] = [];
  const depth = perLane.reduce((m, list) => Math.max(m, list.length), 0);
  for (let i = 0; i < depth; i++) {
    for (const list of perLane) if (i < list.length) out.push(list[i]);
  }
  return out;
}

/**
 * 売り手の census の候補（2026-09-28）。`fetchCensus` の行（censusTargetsSql: 1 ホスト 1 件・安い順）を
 * Candidate にして返す。SQL が既に選んでいるが、金の経路に入る前にここでも同じ規則を掛け直す（二重防御）:
 *
 *  - 値段（census_price＝払う額 e.price_amount・USDC 基本単位）が正の整数として読めない行・$1（MAX_PER_PURCHASE_UNITS）を
 *    超える行は入れない;
 *  - 1 ホスト 1 件（ホスト名は censusHostOf: 小文字・ポート無視）。同じホストが複数あれば値段の小さい方、同額なら id の小さい方;
 *  - `excludeIds`（レーン枠に既に入った行）は入れない——レーン枠は削らない;
 *  - 並びは安い順（同額ならホスト名順）で、最大 `perRun` 件。
 *
 * 旗が off なら問い合わせもしない（空を返す）。問い合わせが失敗してもバッチは止めない（census は並びの
 * 補助であって金の関門ではない）。ログに残して 0 件で続ける。
 */
export async function censusCandidates(input: {
  enabled: boolean;
  perRun: number;
  excludeIds: ReadonlySet<string>;
  /** 既に別の選び方（retest）で入った売り手（censusHostOf のホスト名）。 */
  excludeHosts?: ReadonlySet<string>;
  /** 行に残す selection（既定 "census"）。 */
  selection?: CensusSelection;
  /** これより高い候補は入れない（2026-09-29 W2）。省略なら MAX_PER_PURCHASE_UNITS だけ。 */
  maxPriceUnits?: bigint;
  fetchCensus: (limit: number) => Promise<unknown>;
}): Promise<Candidate[]> {
  if (!input.enabled || input.perRun <= 0) return [];
  const selection = input.selection ?? "census";
  const excludeHosts = input.excludeHosts ?? new Set<string>();
  let rows: Record<string, unknown>[] = [];
  try {
    // レーン枠と重なった行を除いても perRun 件を埋められるよう、除外ぶんだけ多めに取る。
    rows = rowsOf(await input.fetchCensus(input.perRun + input.excludeIds.size + excludeHosts.size));
  } catch (error) {
    if (!isMissingSchemaError(error)) logServerErrorSafe(`observatory.l1.${selection}`, redactedError(error));
    return [];
  }
  return pickCensusRows(rows, input.perRun, input.excludeIds, selection, excludeHosts, input.maxPriceUnits);
}

/**
 * census と retest の枠の配分（2026-09-29）。CENSUS_PER_RUN を分け合う。
 *
 *  - censusMin = 0（既定・OBSERVATORY_L1_CENSUS_MIN_PER_RUN 未設定）: 従来どおり。retest が先に perRun 件まで取り、
 *    census は残り（perRun − retest）。並びは retest → census。
 *  - censusMin > 0: census を先に censusMin 件まで取り（候補が足りなければ取れた件数だけ）、retest は
 *    perRun − その件数まで、census の残りの枠があればその後にもう一度 census を取る。並びは
 *    census（最低枠）→ retest → census（残り）。同じ売り手（ホスト）・同じ出品を 2 度入れない。
 *
 * どの候補も同じ経路（上限・別枠・残高・原子的予約）で買う。ここは並びと件数を決めるだけ。
 */
export async function planCensusAndRetest(input: {
  censusOn: boolean;
  retestOn: boolean;
  perRun: number;
  censusMin: number;
  excludeIds: ReadonlySet<string>;
  fetchCensus: (limit: number) => Promise<unknown>;
  fetchRetest: (limit: number) => Promise<unknown>;
  /** これより高い候補は入れない（バッチ開始時点の日次の残り・2026-09-29 W2）。省略なら MAX_PER_PURCHASE_UNITS だけ。 */
  maxPriceUnits?: bigint;
}): Promise<{ head: Candidate[]; censusCount: number; retestCount: number }> {
  const perRun = Math.max(0, input.perRun);
  const censusMin = input.censusOn ? Math.min(Math.max(0, input.censusMin), perRun) : 0;
  const ids = new Set(input.excludeIds);
  const hosts = new Set<string>();
  const take = (list: Candidate[]) => {
    for (const c of list) {
      ids.add(c.id);
      hosts.add(censusHostOf(laneHostOf(c.resourceUrl)));
    }
    return list;
  };
  const reserved = take(
    await censusCandidates({
      enabled: input.censusOn && censusMin > 0,
      perRun: censusMin,
      excludeIds: new Set(ids),
      excludeHosts: new Set(hosts),
      maxPriceUnits: input.maxPriceUnits,
      fetchCensus: input.fetchCensus,
    }),
  );
  const retest = take(
    await censusCandidates({
      enabled: input.retestOn,
      perRun: perRun - reserved.length,
      excludeIds: new Set(ids),
      excludeHosts: new Set(hosts),
      selection: "retest",
      maxPriceUnits: input.maxPriceUnits,
      fetchCensus: input.fetchRetest,
    }),
  );
  const rest = take(
    await censusCandidates({
      enabled: input.censusOn,
      perRun: perRun - reserved.length - retest.length,
      excludeIds: new Set(ids),
      excludeHosts: new Set(hosts),
      maxPriceUnits: input.maxPriceUnits,
      fetchCensus: input.fetchCensus,
    }),
  );
  return { head: [...reserved, ...retest, ...rest], censusCount: reserved.length + rest.length, retestCount: retest.length };
}

/** censusCandidates の選び方（純関数・DB 無しで固定するため公開）。 */
export function pickCensusRows(
  rows: readonly Record<string, unknown>[],
  perRun: number,
  excludeIds: ReadonlySet<string> = new Set(),
  selection: CensusSelection = "census",
  excludeHosts: ReadonlySet<string> = new Set(),
  maxPriceUnits?: bigint,
): Candidate[] {
  type Row = { row: Record<string, unknown>; id: string; host: string; price: bigint; preferred: boolean };
  const usable: Row[] = [];
  for (const row of rows) {
    const id = String(row.id);
    if (excludeIds.has(id)) continue;
    const raw = typeof row.census_price === "string" ? row.census_price.trim() : "";
    // "123" と、numeric の text 化で付きうる "123.000…" だけを読む。小数部に 0 以外があれば読まない。
    const m = /^(\d{1,30})(?:\.0*)?$/.exec(raw);
    if (!m) continue;
    const price = BigInt(m[1]);
    if (price <= 0n || price > MAX_PER_PURCHASE_UNITS) continue;
    if (maxPriceUnits !== undefined && price > maxPriceUnits) continue;
    const host = censusHostOf(
      typeof row.census_host === "string" && row.census_host !== "" ? row.census_host : laneHostOf(String(row.resource_url)),
    );
    if (excludeHosts.has(host)) continue;
    // retest の (b): 失敗した出品そのもの（SQL の census_preferred）を、同じ売り手の安い出品より先に取る。
    const preferred = row.census_preferred === true || row.census_preferred === "t" || row.census_preferred === "true";
    usable.push({ row, id, host, price, preferred });
  }
  const byPriceThenId = (a: Row, b: Row) =>
    a.preferred !== b.preferred ? (a.preferred ? -1 : 1) : a.price < b.price ? -1 : a.price > b.price ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const cheapestPerHost = new Map<string, Row>();
  for (const r of [...usable].sort(byPriceThenId)) {
    if (!cheapestPerHost.has(r.host)) cheapestPerHost.set(r.host, r);
  }
  return [...cheapestPerHost.values()]
    .sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : a.host < b.host ? -1 : a.host > b.host ? 1 : 0))
    .slice(0, Math.max(0, perRun))
    .map((r) => ({ ...rowToCandidate(r.row), selection }));
}

/** retest の候補の問い合わせへ渡すパラメータ（RETEST_SELLERS_SQL の結果・JSON の文字列 1 つずつ）。 */
export type RetestParams = {
  hostsJson: string;
  preferredIdsJson: string;
  hostCount: number;
  /**
   * 出品単位の旗が on のときだけ: 売り手単位で選ばれたホスト（RETEST_SELLERS_SQL）。出品単位でだけ入ったホストは
   * 失敗した出品そのもの（preferredIds）に限り、同じ売り手の別の出品は買わない（独立レビュー 2026-10-03 BLOCK:
   * 失敗した出品が WHERE で落ちると、届いている別の出品を毎バッチ買い直し続ける）。
   */
  sellerHostsJson?: string;
};

/** 出品単位の買い直し（2026-10-03）の旗。既定 OFF。 */
export function retestListingsEnabled(): boolean {
  return process.env.OBSERVATORY_L1_RETEST_LISTINGS?.trim().toLowerCase() === "on";
}

/**
 * RETEST_SELLERS_SQL を 1 回流し、対象の売り手（ホスト名）と、(b) の売り手で優先して買い直す出品の id を返す。
 * 読めなければ null（retest はそのバッチでは 0 件——金の関門ではないのでバッチは止めない）。
 */
export async function readRetestSellers(db: NonNullable<ReturnType<typeof getDb>>): Promise<RetestParams | null> {
  try {
    const rows = rowsOf(await db.execute(RETEST_SELLERS_SQL));
    // 出品単位（2026-10-03・旗 OBSERVATORY_L1_RETEST_LISTINGS=on）: 売り手の最新の行が届いていても、こちらの落ち度で
    // 失敗したままの出品があれば、その売り手を候補に入れ、失敗した出品そのものを優先する（財布切れの行も含む）。
    const listingRows = retestListingsEnabled() ? rowsOf(await db.execute(RETEST_LISTINGS_SQL)) : [];
    const hosts = [...new Set([...rows, ...listingRows].map((r) => String(r.host)))];
    // (b)(c) は失敗した出品そのものを優先する。(a)（財布切れ）はどの出品でもこちらの落ち度なので最安のまま。
    const preferred = [
      ...new Set([
        ...rows
          .filter((r) => (r.reason === "body" || r.reason === "query") && typeof r.endpoint_id === "string")
          .map((r) => String(r.endpoint_id)),
        ...listingRows.filter((r) => typeof r.endpoint_id === "string").map((r) => String(r.endpoint_id)),
      ]),
    ];
    const sellerHosts = [...new Set(rows.map((r) => String(r.host)))];
    return {
      hostsJson: JSON.stringify(hosts),
      preferredIdsJson: JSON.stringify(preferred),
      hostCount: hosts.length,
      ...(listingRows.length > 0 || retestListingsEnabled() ? { sellerHostsJson: JSON.stringify(sellerHosts) } : {}),
    };
  } catch (error) {
    if (!isMissingSchemaError(error)) logServerErrorSafe("observatory.l1.retest_sellers", redactedError(error));
    return null;
  }
}

/**
 * まだ L1 の購入行が 1 件も無い Base のホストの数（summary.censusRemaining）。分母は active で Base の accept
 * （CAIP-2 か v1 の `base`）を 1 つでも宣言している行のホスト。読めなければ null（0 と混ぜない）。
 */
export async function countCensusRemaining(db: NonNullable<ReturnType<typeof getDb>>): Promise<number | null> {
  try {
    const raw = await db.execute(sql`
      SELECT count(DISTINCT ${CENSUS_HOST_SQL})::text AS n
      FROM x402_endpoints e
      WHERE e.status = 'active'
        AND jsonb_typeof(e.raw_accepts) = 'array'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.raw_accepts) x WHERE x->>'network' IN (${BASE_CAIP2}, 'base'))
        AND ${CENSUS_HOST_SQL} NOT IN (${CENSUS_TRIED_HOSTS_SQL})
    `);
    const n = rowsOf(raw)[0]?.n;
    if (typeof n !== "string" || !/^\d+$/.test(n)) return null;
    return Number(n);
  } catch (error) {
    if (!isMissingSchemaError(error)) logServerErrorSafe("observatory.l1.census_remaining", redactedError(error));
    return null;
  }
}

/**
 * 支払い付き要求に、売り手が宣言したクエリを足すか（2026-09-20・既定 OFF）。
 * `OBSERVATORY_L1_DECLARED_QUERY_NETWORKS` は CAIP-2 の許可リスト（カンマ区切り・完全一致・例 `xrpl:0`）で、
 * **署名する accept の network** がそこに載っているときだけ足す。未設定・空は全 OFF。boolean にしないのは、
 * XRPL の 4 行のための変更が ON の瞬間に Base / Solana / Arc の全行へ同時に効かないようにするため
 * （独立レビュー W-3）。旧 `OBSERVATORY_L1_DECLARED_QUERY_ENABLED` は読まない（二重の意味にしない）。
 * 許可リストに無いあいだ purchaseOne の要求と台帳の行は 1 バイトも変わらない（tests/l1-declared-query.pg.test.ts）。
 */
function declaredQueryEnabled(network: string): boolean {
  const allowed = (process.env.OBSERVATORY_L1_DECLARED_QUERY_NETWORKS ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
  return network.length > 0 && allowed.includes(network);
}

async function purchaseOne(input: {
  candidate: Candidate;
  /** selectAccept に先に選ばせる network（LANE_NETWORK・settled 済みは除く）。 */
  preferNetworks: readonly string[];
  /** XRPL のレーン枠から来た Base 先頭の候補で、XRPL の accept を先に試してよいか（2026-09-18）。 */
  xrplLanePreferred: boolean;
  /** Stellar のレーン枠から来た Base 先頭の候補で、Stellar の accept を先に試してよいか（2026-10-18・段4）。 */
  stellarLanePreferred: boolean;
  /** Gateway レーンの候補で、GatewayWalletBatched を先に試してよいか。ネイティブ Arc がある出品では偽のまま。 */
  arcGatewayPreferred: boolean;
  readArcGatewayAvailable: () => Promise<bigint | null>;
  commitArcGateway: (amount: bigint) => void;
  signArcGateway: ArcGatewaySigner;
  account: ReturnType<typeof privateKeyToAccount>;
  solanaKeypair: Keypair | null;
  getSolanaBlockhash: () => Promise<string>;
  xrplPayer: XrplPayerModule | null;
  xrplWallet: XrplWallet | null;
  getXrplSigningInputs: (address: string) => Promise<XrplSigningInputs>;
  stellarPayer: StellarPayerModule | null;
  stellarAddress: string | null;
  createStellarPayment: (input: StellarPaymentInput) => Promise<{ transaction: string }>;
  fetchImpl: (url: string, init?: RequestInit, call?: SafeFetchCallOptions) => Promise<Response>;
  timeoutMs: number;
  /** Celo の支払い付き要求の待ち。ほかの要求は timeoutMs。 */
  celoPaidTimeoutMs: number;
  db: NonNullable<ReturnType<typeof getDb>>;
  spentToday: bigint;
  payerFunds: PayerFunds;
  onPayerUnfunded: (chain: string, detail: Record<string, unknown>) => void;
  /** Tempo（MPP）を買ってよいか（フラグ・別枠）。false なら Tempo 候補は試行しない。 */
  tempoEnabled: boolean;
  mppxCharge?: MppxCharge;
}): Promise<{
  kind: "attempted" | "skipped" | "budget_denied" | "halted" | "payer_unfunded" | "xrpl_fee_over_cap" | "xrpl_lane_unavailable" | "stellar_signing_unavailable" | "seller_capped";
  /** kind === "seller_capped" のとき、どちらの単位で届いたかと、その売り手（受取先・ホスト）。 */
  sellerCap?: { scope: "payto" | "host" | "domain"; payTo: string; host: string; domain: string };
  settled: boolean;
  spent: bigint;
  /** 台帳に書いた status（attempted のときのみ）——summary の集計はこれを見る。 */
  status?: string;
  /** kind === "halted" のときの判定理由（cron 応答とログに出る）。 */
  haltReason?: string;
  /** 署名した accept の network（attempted のとき）。バッチ内のレーン支出の加算に使う。 */
  network?: string;
  /** kind === "payer_unfunded" のとき、残高が足りなかった（読めなかった）購入元のチェーン。 */
  payerChain?: PayerChain;
  /** Gateway の支出は eip155:5042 でも別枠 arc_gateway に足す。 */
  capChain?: CappedChain | null;
  /** Gateway の残高不足のあと、別レールの accept があるので優先なしで 1 回買い直す。 */
  retryWithoutGateway?: boolean;
  /** Gateway + POST で live 402 が本文を宣言していないため、署名前に見送った。 */
  gatewayPostBodyUnknownAtSign?: boolean;
  /**
   * Stellar の署名前の故障で、secondary の未署名予約を消したときだけ true。
   * バッチはその候補を Base で 1 回買い直す。署名後は付けない。
   */
  retryBase?: boolean;
}> {
  const { candidate, preferNetworks, xrplLanePreferred, stellarLanePreferred, arcGatewayPreferred, account, solanaKeypair, getSolanaBlockhash, xrplPayer, xrplWallet, getXrplSigningInputs, stellarPayer, stellarAddress, createStellarPayment, fetchImpl, timeoutMs, celoPaidTimeoutMs, db, spentToday, payerFunds, onPayerUnfunded, tempoEnabled, mppxCharge, readArcGatewayAvailable, commitArcGateway, signArcGateway } = input;
  const method = (candidate.method ?? "GET").toUpperCase();
  const startedAt = Date.now();
  const isSolana = candidate.network === SOLANA_MAINNET_CAIP2;
  // 旗 OFF では Stellar として扱わない。origin/main と同じく EVM の selectAccept へ落とす
  // （:2255 の早期 return も、このとき走らない）。
  const isStellarPrimary =
    process.env.OBSERVATORY_STELLAR_L1_ENABLED === "true" && candidate.network === STELLAR_PUBNET_CAIP2;
  // secondary は壁を読んで selectStellarAccept が通ったときにだけ true になる（下で payerLabel も切り替える）。
  let isStellar = isStellarPrimary;
  // Tempo（MPP・2026-09-17）: 壁は x402 の封筒ではなく WWW-Authenticate: Payment。
  const isTempo = candidate.network === TEMPO_MAINNET_CAIP2;
  // XRPL レール（2026-09-18）: 主ネットワークが XRPL の行は最初から、Base 先頭の行は壁の 402 を読んで
  // selectXrplSecondaryAccept が通ったときにだけ入る（下で isXrpl / payerLabel を切り替える）。
  const isXrplPrimary = candidate.network === XRPL_MAINNET_CAIP2;
  let isXrpl = isXrplPrimary;
  let isArcGateway = false;
  let gatewaySigned: ArcGatewaySigned | null = null;
  // 台帳上の payer 表記: EVM は小文字（既存の join 規約）・base58 は原文
  // （小文字化は base58 を破壊する——catalog-source と同じ理由）。
  let payerLabel = isSolana
    ? (solanaKeypair?.publicKey.toBase58() ?? "solana_key_missing")
    : isXrpl
      ? (xrplWallet?.classicAddress ?? "xrpl_key_missing")
      : isStellar
        ? (stellarAddress ?? "stellar_key_missing")
        : account.address.toLowerCase();

  // census / retest の候補（2026-09-28）なら、この候補について書く行の raw_response_meta に selection を残す。
  // census でなければ null で、tagMeta は受け取った値をそのまま返す（従来の行と 1 バイトも変わらない）。
  const selectionMeta = candidate.selection ? { selection: candidate.selection } : null;
  const tagMeta = <T,>(meta: T): T | Record<string, unknown> =>
    selectionMeta
      ? { ...(typeof meta === "object" && meta !== null && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {}), ...selectionMeta }
      : meta;

  const record = async (row: Partial<typeof x402L1Purchases.$inferInsert>) => {
    const meta = selectionMeta ? tagMeta(row.rawResponseMeta ?? null) : row.rawResponseMeta;
    // 売り手の応答から来た文字列（本文の先頭・誤りの文）に U+0000 等が残ると行ごと落ちる（pgSafeJson・2026-09-29）。
    // 変えたら印を残す（pgSanitizedMark）。
    const safe = meta === undefined ? null : pgSafeJsonChanged(meta);
    const safeMeta =
      safe === null
        ? undefined
        : safe.changed && typeof safe.value === "object" && safe.value !== null && !Array.isArray(safe.value)
          ? { ...(safe.value as Record<string, unknown>), ...pgSanitizedMark(["rawResponseMeta"]) }
          : safe.value;
    await db.insert(x402L1Purchases).values({
      endpointId: candidate.id,
      status: "request_error",
      payer: payerLabel,
      ...row,
      ...(safeMeta !== undefined ? { rawResponseMeta: safeMeta } : {}),
    });
    invalidateDecisionCache(candidate.id); // 購入結果は判定材料（このインスタンスのみ・cache.ts 参照）
  };

  // runL1Batch が solanaReady で候補を絞るので、ここに solana 候補が来て
  // 鍵が無いのは onlyEndpointId 経路等の異常系だけ——黙って進まない。
  if (isSolana && !solanaKeypair) {
    return { kind: "skipped", settled: false, spent: 0n };
  }
  // 同じく二重防御: フラグ無しの Tempo 候補はここへ来ないが、来ても 1 リクエストも出さない。
  if (isTempo && !tempoEnabled) {
    return { kind: "skipped", settled: false, spent: 0n };
  }
  if (isXrpl && (!xrplWallet || !xrplPayer)) {
    return { kind: "skipped", settled: false, spent: 0n };
  }
  if (isStellar && (!stellarPayer || !stellarAddress)) {
    return { kind: "skipped", settled: false, spent: 0n };
  }
  // 2026-09-29 監査 5 周目（中・お金）: 買うのは https の出品だけ、かつカタログが受取先（pay_to）を宣言している
  // 行だけ。平文 http の 402 は経路上の誰でも書き換えられ、宣言の無い行では壁の payTo を照合する相手が無い
  // （selectAccept 等は宣言 null を「照合なしで通す」）。候補 SQL が両方を外しているが、ここが署名する唯一の
  // 入口なので二重に止める。行は書かない——我々の側の見送りで、売り手についての測定ではない。
  if (!isL1PurchasableListing(candidate)) {
    return { kind: "skipped", settled: false, spent: 0n };
  }

  // Unpaid request → expect the wall.
  //
  // 2026-08-22 (audit, Critical): the abort timer MUST still be armed while the
  // BODY is read. AbortController only bounds the response up to its headers —
  // clearing the timer before `.text()` (what this code did) left a seller free
  // to dribble a body out forever, and timeoutMs stopped meaning anything. The
  // clear now lives in `finally`, so the whole request+body is inside one
  // budget and a slow body aborts like any other timeout.
  // 無払いの要求の本文は `{}` のまま（2026-09-17 Issue #29 で判断）。売り手の本文の宣言
  // （extensions.bazaar.info.input.body）はこの要求への 402 応答に載っていて、読む前に
  // 送れる宣言は無い。x402 の壁は本文を見る前に 402 を返すので `{}` で足りる——公開
  // export（2026-09-16 取得・30 日）で無払いが 402 にならなかった行（no_402）は 24 行／約 6,700 行。
  let first: Response;
  let firstBody = "";
  const firstController = new AbortController();
  const firstTimer = setTimeout(() => firstController.abort(), timeoutMs);
  try {
    first = await fetchImpl(candidate.resourceUrl, {
      method,
      signal: firstController.signal,
      redirect: "follow",
      headers: {
        accept: "application/json",
        "user-agent": "vet402-observatory-l1/1.0 (+https://vet402.com/observatory/methodology)",
        // MPP の壁は Accept-Payment を見て challenge を出す（govlaws 実測 2026-09-17: 無いと 200）。L0 と同じ値。
        ...(isTempo ? { "accept-payment": "tempo/charge" } : {}),
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: "{}" } : {}),
    }, { httpsOnly: true });
    firstBody = await readBodyCapped(first, 16_000);
  } catch (error) {
    await record({
      status: "request_error",
      rawResponseMeta: {
        phase: "unpaid",
        // A target the SSRF guard refused records OUR decision, not a
        // measurement of the seller — kept as its own reason code so the two
        // never get read as the same thing.
        reason: error instanceof UnsafeTargetError ? error.reason : null,
        error: String(error).slice(0, 300),
      },
    });
    return { kind: "skipped", settled: false, spent: 0n };
  } finally {
    clearTimeout(firstTimer);
  }

  if (first.status !== 402) {
    await record({ status: "no_402", httpStatusPaid: null, rawResponseMeta: { phase: "unpaid", status: first.status } });
    return { kind: "skipped", settled: false, spent: 0n };
  }

  // MPP の challenge（Tempo）は WWW-Authenticate に載る。x402 の封筒は Tempo では読まない
  // （x402 の accept に署名する経路が Tempo に向かって開かない）。
  // 読むのは mppx の Challenge.deserializeList（2026-09-17 レビュー #5/#6）。mppx が読めない
  // ヘッダは署名器も読めない＝ unsignable。**予約より前に**落とす（2026-09-04 監査 P1-2 と同じ規律。
  // status の語彙は閉じているので no_eligible_accept に載せ、detail に unsignable を残す）。
  const mppParsed = isTempo ? await parseMppChallengesFromHeaders(first.headers) : { challenges: [], error: null };
  const mppChallenges = mppParsed.challenges;
  const challenge = isTempo
    ? mppChallenges.length > 0
      ? { x402Version: 2 as const, accepts: [] as never[] }
      : null
    : parseChallenge({ bodyText: firstBody, headers: first.headers });
  if (!challenge) {
    await record({
      status: "no_eligible_accept",
      rawResponseMeta: {
        phase: "unpaid",
        note: isTempo ? (mppParsed.error ? "mppx could not deserialize the Payment challenge" : "no MPP Payment challenge") : "unparseable challenge",
        ...(isTempo ? { protocol: "mpp", ...(mppParsed.error ? { detail: "unsignable", error: mppParsed.error } : {}) } : {}),
      },
    });
    return { kind: "skipped", settled: false, spent: 0n };
  }

  const mppSelection = isTempo
    ? selectMppChallenge(mppChallenges, { declaredAmount: candidate.priceAmount, declaredPayTo: candidate.payTo })
    : null;
  // XRPL の secondary accept（2026-09-18）。レーンとして優先された Base 先頭の候補に限り、壁の 402 に
  // 宣言どおりの XRPL の RLUSD accept があれば XRPL レールへ入る。通らなければ従来どおり EVM の
  // selectAccept（Base）へ落ち、断られた理由だけを行の raw_response_meta.xrplLane に残す。
  // 封筒は v2 だけ（正本に v1 の形が無い）。
  const xrplSecondary =
    xrplLanePreferred && !isXrplPrimary && !isSolana && !isTempo && xrplPayer && xrplWallet
      ? challenge.x402Version === 2
        ? xrplPayer.selectXrplSecondaryAccept(challenge.accepts, {
            declaredAmount: candidate.priceAmount,
            declaredNetwork: candidate.network,
            declaredPayTo: candidate.payTo,
            declaredXrplPayTos: candidate.xrplDeclaredPayTos,
            lanePreferred: true,
          })
        : ({ accept: null, reason: "no_eligible_accept", detail: null } as const)
      : null;
  const xrplLaneRefusal =
    xrplSecondary && !xrplSecondary.accept
      ? { reason: xrplSecondary.reason, detail: challenge.x402Version === 2 ? xrplSecondary.detail : "x402_v1_unsupported" }
      : null;
  if (xrplSecondary?.accept) {
    isXrpl = true;
    payerLabel = xrplWallet!.classicAddress;
  }
  // Stellar の secondary accept（2026-10-18・段4）。レーンとして優先された Base 先頭の候補に限り、
  // 壁の stellar:pubnet の USDC accept を selectStellarAccept で選ぶ。payTo はカタログが宣言した集合と
  // 完全一致でなければ通らない。通らなければ EVM の selectAccept（Base）へ落ち、理由は xrplLane と同じく
  // 行の raw_response_meta.stellarLane に残す。封筒は v2 だけ。
  const stellarSecondary =
    stellarLanePreferred && !isStellarPrimary && !isSolana && !isTempo && !isXrpl && stellarPayer && stellarAddress
      ? challenge.x402Version === 2
        ? stellarPayer.selectStellarAccept(challenge.accepts, {
            declaredAmount: candidate.priceAmount,
            declaredPayTo: candidate.payTo,
            declaredPayTos: candidate.stellarDeclaredPayTos,
            declaredNetwork: candidate.network,
          })
        : ({ accept: null, reason: "no_eligible_accept" as const, detail: null })
      : null;
  const stellarLaneRefusal =
    stellarSecondary && !stellarSecondary.accept
      ? { reason: stellarSecondary.reason, detail: challenge.x402Version === 2 ? stellarSecondary.detail : "x402_v1_unsupported" }
      : null;
  if (stellarSecondary?.accept) {
    isStellar = true;
    payerLabel = stellarAddress!;
  }
  // StellarAcceptSelection は accept の有無で stellarUnits（bigint）と signingAsset が分かれる。
  // 他レーンの selection と一つの合併に溶かすと、成功側の bigint が失敗側の undefined と混ざり、
  // 署名口へ渡せない。Stellar だけ型を保つ。secondary が断ったときは null のまま Base へ落とす。
  const stellarSelection = stellarSecondary?.accept
    ? stellarSecondary
    : isStellar
      ? stellarPayer!.selectStellarAccept(challenge.accepts, {
          declaredAmount: candidate.priceAmount,
          declaredPayTo: candidate.payTo,
        })
      : null;
  // Gateway は、他の有効チェーンに署名できる accept がある出品では選ばない（native_present は下の selectAccept へ落とす）。
  // 署名できる accept が他に無いときの拒否だけ行に残す。
  const gatewayPick =
    arcGatewayPreferred && !isSolana && !isTempo && !isXrpl && !isStellar
      ? selectArcGatewayAccept(challenge.accepts, {
          nativeArcSignable: hasSignableNativeArcAccept(challenge.accepts),
          otherChainSignable: hasSignableOtherRailAccept(challenge.accepts),
          declaredAmount: candidate.priceAmount,
          declaredPayTo: candidate.payTo,
          declaredNetwork: candidate.network,
          gatewayDeclaredPayTos: candidate.gatewayDeclaredPayTos,
        })
      : null;
  if (
    gatewayPick &&
    !gatewayPick.accept &&
    gatewayPick.reason !== "native_present" &&
    !hasSignableOtherRailAccept(challenge.accepts) &&
    !hasSignableNativeArcAccept(challenge.accepts)
  ) {
    await record({
      status: gatewayPick.reason,
      rawResponseMeta: tagMeta({
        phase: "select",
        declaredAmount: candidate.priceAmount,
        declaredPayTo: candidate.payTo,
        circleGateway: { reason: gatewayPick.reason },
      }),
    });
    return { kind: "skipped", settled: false, spent: 0n };
  }
  const selection = gatewayPick?.accept
    ? gatewayPick
    : mppSelection
    ? mppSelection
    : xrplSecondary?.accept
    ? xrplSecondary
    : stellarSelection !== null
    ? stellarSelection
    : isSolana
    ? selectSolanaAccept(challenge.accepts, {
        declaredAmount: candidate.priceAmount,
        declaredPayTo: candidate.payTo,
        payerAddress: solanaKeypair?.publicKey.toBase58() ?? null,
      })
    : isXrplPrimary
      ? xrplPayer!.selectXrplAccept(challenge.accepts, {
          declaredAmount: candidate.priceAmount,
          declaredPayTo: candidate.payTo,
        })
      : selectAccept(challenge.accepts, {
          declaredAmount: candidate.priceAmount,
          declaredPayTo: candidate.payTo,
          // 宣言額はカタログの先頭 accept（e.network）の値。別チェーンの accept とは比べない。
          declaredNetwork: candidate.network,
          preferNetworks,
          // 優先された別チェーン（Arc・Celo）の accept の payTo は、カタログがそのチェーンについて宣言した集合と照合する
          // （2026-09-19）。優先していない accept（Base）の照合先は従来どおり candidate.payTo。
          declaredPayTosByNetwork: { [ARC_CAIP2]: candidate.arcDeclaredPayTos, [CELO_CAIP2]: candidate.celoDeclaredPayTos, [BNB_CAIP2]: candidate.bnbDeclaredPayTos, [ARBITRUM_CAIP2]: candidate.arbitrumDeclaredPayTos, [AVALANCHE_CAIP2]: candidate.avalancheDeclaredPayTos },
        });
  if (gatewayPick?.accept) isArcGateway = true;
  // ここから先の台帳の network・別枠（reserveSpend の cappedChainFor）・残高の chain（payerChain）は
  // すべて「選んだ accept の network」で決まる——Base 先頭の exa の行を Arc の accept で買えば、
  // 行は eip155:5042・別枠 arc・残高 arc になる（tests/l1-lane-accept-preference.pg.test.ts）。
  // XRPL の封筒は v2 だけ（正本に v1 の形が無い）。v1 の壁には署名しない。
  const xrplV1Wall = isXrpl && selection.accept !== null && challenge.x402Version !== 2;
  // Stellar の exact も v2 だけ（@x402/stellar の client は v2 の payload を返す）。v1 の壁には署名しない。
  const stellarV1Wall = isStellar && selection.accept !== null && challenge.x402Version !== 2;
  if (!selection.accept || xrplV1Wall || stellarV1Wall) {
    await record({
      status: xrplV1Wall || stellarV1Wall ? "no_eligible_accept" : selection.reason!,
      rawResponseMeta: {
        phase: "select",
        declaredAmount: candidate.priceAmount,
        declaredPayTo: candidate.payTo,
        ...(mppSelection
          ? {
              protocol: "mpp",
              detail: mppSelection.detail,
              challenges: mppChallenges.slice(0, 4).map((c) => ({
                id: c.id,
                realm: c.realm,
                method: c.method,
                intent: c.intent,
                chainId: c.request?.methodDetails.chainId ?? null,
                currency: c.request?.currency ?? null,
                amount: c.request?.amount ?? null,
                recipient: c.request?.recipient ?? null,
                expires: c.expires,
              })),
            }
          : {
              challengeAccepts: challenge.accepts.slice(0, 4),
              ...(xrplLaneRefusal ? { xrplLane: xrplLaneRefusal } : {}),
              ...(stellarLaneRefusal ? { stellarLane: stellarLaneRefusal } : {}),
              // XRPL の no_eligible_accept の内訳（asset_not_usd = XRP 建てだけの壁・v1 は RLUSD のみ）。
              ...(xrplV1Wall || stellarV1Wall ? { reason: "x402_v1_unsupported" } : "detail" in selection && selection.detail ? { reason: selection.detail } : {}),
            }),
      },
    });
    return { kind: "skipped", settled: false, spent: 0n };
  }
  const accept = selection.accept;
  // XRPL の IOU は "0.01" のような単位の 10 進文字列（selectXrplAccept が 6 桁 units に落とす）。
  // EVM / Solana は基本単位の整数文字列。台帳（amount_units / spent_units）は常に 6 桁 units。
  const amount: bigint = "amountUnits" in selection ? (selection.amountUnits as bigint) : BigInt(accept.amount);
  const amountUnitsText = String(amount);
  // 行に書く network は定数（2026-09-17 レビュー #1）。selectXrplAccept は完全一致しか通さないので accept.network と
  // 同じ値だが、別枠の `LIKE 'xrpl:%'` と照合の `=== "xrpl:0"` が壁の表記に依存しないことをここで固定する。
  const ledgerNetwork = purchaseLedgerNetwork({ isXrpl, isStellar, acceptNetwork: accept.network });
  // asset も定数の大文字 hex で書く（2026-09-18 レビュー S2）: 壁が `RLUSD` リテラルや小文字 hex を名乗っても、
  // 台帳・照合・索引（index-xrpl.ts）が同じ 1 つの表記を読む。封筒の accepted には壁の原文をそのまま返す。
  // Arc も定数で書く（2026-09-19 レビュー N3）: selectAccept は固定 USDC と大小無視で一致した accept しか通さないので
  // 同じアドレスだが、台帳の表記を壁の書き方に依存させない。Base は従来どおり壁の原文。
  // Celo も定数で書く（2026-10-10・Arc と同じ理由）。
  const ledgerAsset = isXrpl
    ? RLUSD_CURRENCY_HEX
    : isStellar
      ? accept.asset === STELLAR_USDC_CLASSIC
        ? STELLAR_USDC_CLASSIC
        : STELLAR_USDC_SAC
      : accept.network === ARC_CAIP2
      ? ARC_CHAIN.usdc
      : accept.network === CELO_CAIP2
        ? CELO_CHAIN.usdc
        : accept.network === BNB_CAIP2
          ? BNB_CHAIN.usdc
          : accept.network === ARBITRUM_CAIP2
            ? ARBITRUM_CHAIN.usdc
            : accept.network === AVALANCHE_CAIP2
              ? AVALANCHE_CHAIN.usdc
              : accept.asset;
  // 支払い付き POST の本文（2026-09-17 Issue #29）。売り手が 402 で宣言した input.body を
  // そのまま送り、無ければ従来どおり `{}`。規則は declared-input.ts。
  const paidRequestBody: { body: string; source: RequestBodySource } | null =
    method === "POST" ? declaredRequestBody({ bodyText: firstBody, headers: first.headers }) : null;
  // Gateway の POST で 402 が本文を宣言していなければ、署名・予約の前に見送る（`{}` を送って払わない）。
  // 行は書かないので、次の回も選ばれ直す。目録が declared なのに 402 が宣言しない出品は 2026-10-29 の実測で 0 件。
  // summary.gatewayPostBodyUnknownSignSkipped が増え続けたら、no_eligible_accept の行を書いて窓から外す形に変える。
  if (isArcGateway && method === "POST" && paidRequestBody?.source !== "declared") {
    return { kind: "skipped", settled: false, spent: 0n, capChain: "arc_gateway", gatewayPostBodyUnknownAtSign: true };
  }
  // 支払い付き要求のクエリ（2026-09-20）。売り手が 402 で宣言した input.queryParams を URL に足す
  // （規則は declared-input.ts）。accept の network が許可リストに無ければ（既定）null＝URL も行も従来どおり。
  // 差し替えるのは**要求の URL だけ**: 封筒の resource.url・署名する額と宛先は candidate / accept のまま。
  // Tempo（MPP）は x402 の文書を読まないので対象外。
  const paidRequestUrl: { url: string; source: RequestQuerySource; query: string | null } | null =
    declaredQueryEnabled(accept.network) && !isTempo
      ? declaredRequestUrl({ resourceUrl: candidate.resourceUrl, bodyText: firstBody, headers: first.headers })
      : null;

  // Budget gate — BEFORE signing. The ledger, not memory, is the truth.
  const budget = checkL1Budget({
    spentTodayUsd: unitsToUsd(spentToday),
    requestUsd: unitsToUsd(amount),
  });
  if (!budget.allowed) {
    // census / retest の候補は行を書かない（下の予約の daily_budget_exceeded と同じ理由・2026-09-29）。
    if (candidate.selection && budget.reason === "daily_budget_exceeded") return { kind: "budget_denied", settled: false, spent: 0n };
    await record({
      status: "budget_denied",
      amountUnits: amountUnitsText,
      rawResponseMeta: { reason: budget.reason, dailyBudgetUsd: DAILY_BUDGET_USD },
    });
    return { kind: "budget_denied", settled: false, spent: 0n };
  }

  // Solana は署名の材料に blockhash（外部RPC）が要る。予約の後に外部I/Oで
  // 失敗すると「signed → counted」の不変条件が破れるので、予約の前に取る。
  let solanaBlockhash: string | null = null;
  if (isSolana) {
    try {
      solanaBlockhash = await getSolanaBlockhash();
    } catch (error) {
      await record({
        status: "request_error",
        rawResponseMeta: { phase: "blockhash", error: redactForLog(error) },
      });
      return { kind: "skipped", settled: false, spent: 0n };
    }
  }
  // XRPL（2026-09-17）: Sequence と validated ledger（LastLedgerSequence の基準）。Solana の blockhash と
  // 同じ理由で予約の前に取る。
  let xrplSigningInputs: XrplSigningInputs | null = null;
  if (isXrpl) {
    try {
      xrplSigningInputs = await getXrplSigningInputs(xrplWallet!.classicAddress);
    } catch (error) {
      // secondary（Base 先頭の行）では行を書かない: 我々の RPC の失敗を Base の売り手の request_error に
      // しない（書くとスイープ窓のあいだ再選択されず、冷却の streak にも数えられる）。
      logServerErrorSafe("observatory.l1.xrpl_signing_inputs", redactedError(error));
      if (!isXrplPrimary) {
        return { kind: "xrpl_lane_unavailable", settled: false, spent: 0n };
      }
      await record({
        status: "request_error",
        rawResponseMeta: { phase: "xrpl_signing_inputs", error: redactForLog(error) },
      });
      // 主ネットワークが XRPL の行は従来どおり行を残すが、レーンは同じく 1 回目で閉じる（W1）。
      return { kind: "xrpl_lane_unavailable", settled: false, spent: 0n };
    }
    // 手数料が上限超（clampFeeDrops → null）。署名せず、行も書かない（payer_unfunded と同じ作法）。
    if (xrplSigningInputs.feeDrops === null) {
      return { kind: "xrpl_fee_over_cap", settled: false, spent: 0n };
    }
  }

  // Self-dealing backstop (2026-08-22 audit), the LAST gate before money is
  // committed. Candidate selection excludes our own payTo, but it can only
  // filter the CATALOG's e.pay_to — a wall is free to answer with a different
  // address, and when the catalog declared none (declaredPayTo === null) the
  // payto_mismatch gate above has nothing to compare against either. An
  // on-chain self-transfer dressed up as a "settle-through verified" receipt
  // would make the neutrality that is the whole moat a lie, so it is refused
  // here and recorded (operator.ts).
  if (isOperatorPayTo(accept.payTo)) {
    await record({
      status: "payto_operator_self",
      network: ledgerNetwork,
      asset: ledgerAsset,
      payTo: accept.payTo.startsWith("0x") ? accept.payTo.toLowerCase() : accept.payTo,
      amountUnits: amountUnitsText,
      rawResponseMeta: {
        phase: "select",
        reason: "wall named the operator's own payTo",
        declaredPayTo: candidate.payTo,
      },
    });
    return { kind: "skipped", settled: false, spent: 0n };
  }

  // 実行時の停止スイッチ・1 回目（2026-09-05 監査 P0）。予約の**前**に読む。
  // バッチ開始時の判定はここまでに数十秒〜数分古くなっている——運用者が
  // 「いま止めろ」と言ったのに、走行中のバッチが残りを買い切ってしまう窓が
  // その差分。予約を取る前に落とせば、日次予算も食わない。
  const preReserveHalt = await haltGate(db);
  if (preReserveHalt.halted) {
    // 行を書く（黙って飛ばさない）。副作用として、この endpoint はスイープ窓
    // （既定 6 日）のあいだ再選択されない——budget_denied と同じ挙動で、停止は
    // 稀なので許容する。バッチは次の候補へ進まず降りるので、行は 1 件だけ。
    await record({
      status: "halted",
      amountUnits: amountUnitsText,
      rawResponseMeta: { phase: "pre_reserve", reason: preReserveHalt.reason },
    });
    return { kind: "halted", settled: false, spent: 0n, haltReason: preReserveHalt.reason };
  }

  // 購入元残高の関門（2026-09-17 Issue #29）。予約と署名の**前**。2026-09-13〜15 に Base の
  // 購入元の USDC が尽きたまま署名を続け、売り手の 402 を `settle_failed` として 972 行
  // 記録した——我々の資金切れを売り手の失敗にした。足りない／読めないなら署名しない。
  // 行は書かない（chain_daily_cap と同じ: 書くとスイープ窓のあいだ再選択されない）。
  // 2026-09-17 Arc レーン: 残高はチェーンごと。Arc は Base と同じ EOA だが Arc の USDC は別。
  // XRPL（2026-09-17）は独立の seed。残高は RLUSD + 手数料ぶんの XRP（payer-funds.ts）。
  // Celo（2026-10-10）も同じ: 同じ EOA だが Celo の USDC は別。ここで "celo" に分けないと、Celo の accept に署名する前に
  // **Base の残高**を見てしまう（Celo が空でも署名し、売り手の 402 を settle_failed として記録する——Issue #29 と同じ事故）。
  const evmPayChainId = evmChainFor(accept.network)?.chainId;
  const payerChain: PayerChain = isTempo ? "tempo" : isSolana ? "solana" : isXrpl ? "xrpl" : isStellar ? "stellar" : evmPayChainId === 5042 ? "arc" : evmPayChainId === 42220 ? "celo" : evmPayChainId === 56 ? "bnb" : evmPayChainId === 42161 ? "arbitrum" : evmPayChainId === 43114 ? "avalanche" : "base";
  const payerOwner = isSolana ? solanaKeypair!.publicKey.toBase58() : isXrpl ? xrplWallet!.classicAddress : isStellar ? stellarAddress! : account.address;
  if (isArcGateway) {
    let available: bigint | null = null;
    try {
      available = await readArcGatewayAvailable();
    } catch {
      available = null;
    }
    if (!arcGatewayFundsOk(available, amount)) {
      const fallback = selectAccept(challenge.accepts, {
        declaredAmount: candidate.priceAmount,
        declaredPayTo: candidate.payTo,
        declaredNetwork: candidate.network,
        preferNetworks: [],
        declaredPayTosByNetwork: { [ARC_CAIP2]: candidate.arcDeclaredPayTos, [CELO_CAIP2]: candidate.celoDeclaredPayTos, [BNB_CAIP2]: candidate.bnbDeclaredPayTos, [ARBITRUM_CAIP2]: candidate.arbitrumDeclaredPayTos, [AVALANCHE_CAIP2]: candidate.avalancheDeclaredPayTos },
      });
      onPayerUnfunded("arc_gateway", {
        reason: available === null ? "unreadable" : "insufficient",
        amountUnits: String(amount),
        ...(available === null ? {} : { balanceUnits: String(available) }),
      });
      return { kind: "payer_unfunded", settled: false, spent: 0n, payerChain: "arc_gateway", retryWithoutGateway: fallback.accept !== null };
    }
  } else {
    const funds = await payerFunds.check(payerChain, payerOwner, amount);
    if (!funds.ok) {
      onPayerUnfunded(payerChain, { ...funds, amountUnits: String(amount) });
      return { kind: "payer_unfunded", settled: false, spent: 0n, payerChain };
    }
  }

  // 2026-10-27: 購入ごとの証拠①（受け取った 402）。予約行と同じ INSERT で書く（内部専用の列・purchase-evidence.ts）。
  const challenge402 = buildPurchaseEvidence("challenge_402", () =>
    challengeEvidenceForRow(
      isTempo
        ? mppChallengeEvidence({ httpStatus: first.status, headers: first.headers, challenges: mppChallenges, selectedAccept: accept })
        : x402ChallengeEvidence({ httpStatus: first.status, headers: first.headers, bodyText: firstBody, selectedAccept: accept }),
    ),
  );

  // Reserve BEFORE signing. This is the authoritative gate: it re-reads the
  // day's total and the sweep window inside one statement and writes the row
  // that carries spent_units, so the money is on the ledger before it can
  // exist. A kill, a timeout or a DB error after this point loses the outcome
  // detail, never the spend.
  const reservation = await reserveSpend({
    challenge402,
    db,
    endpointId: candidate.id,
    payer: payerLabel,
    network: ledgerNetwork,
    asset: ledgerAsset,
    payTo: accept.payTo.startsWith("0x") ? accept.payTo.toLowerCase() : accept.payTo,
    amountUnits: String(amount),
    windowDays: sweepWindowDaysFor({
      isPriority: candidate.isPriority,
      isMature: candidate.isMature,
    }),
    meta: isArcGateway ? { ...(selectionMeta ?? {}), circleGatewayRail: "true" } : selectionMeta,
    ...(isArcGateway ? { capChain: "arc_gateway" as const } : {}),
    // census の初回購入だけ census の枠（2026-09-29・既定は同じ 120）。retest・主候補・レーンは従来の枠。
    ...(candidate.selection === "census" ? { firstPurchaseQuota: censusFirstPurchaseQuota(FIRST_PURCHASE_DAILY_QUOTA) } : {}),
  });
  if (!reservation.ok) {
    if (reservation.reason === "already_purchased") {
      // A concurrent run got this endpoint first — its row is the record.
      return { kind: "skipped", settled: false, spent: 0n };
    }
    if (reservation.reason === "first_purchase_quota") {
      // その UTC 日の初回購入の枠が尽きた。行を書かない——書くとスイープ窓の
      // あいだ再選択されず、翌日の枠にも戻らない（枠は延期であって除外ではない）。
      return { kind: "skipped", settled: false, spent: 0n };
    }
    if (reservation.reason === "seller_daily_cap") {
      // 売り手ごとの日次上限（2026-09-29 監査 5 周目）。行を書かない——書くとこの出品はスイープ窓のあいだ
      // 再選択されず、正直な売り手の翌日の購入まで止める。翌 UTC 日にまた候補になる。バッチは同じ売り手の
      // 残りの候補を飛ばす（runL1Batch の sellerCapped）。
      return {
        kind: "seller_capped",
        settled: false,
        spent: 0n,
        sellerCap: {
          scope: reservation.scope ?? "payto",
          payTo: normalizedPayTo(accept.payTo),
          host: censusHostOf(laneHostOf(candidate.resourceUrl)),
          domain: sellerDomainOf(candidate.resourceUrl),
        },
      };
    }
    if (reservation.reason === "chain_daily_cap") {
      // そのチェーン（Solana・Arc）の別枠に届かなかった。行を書かない——書くとこの売り手は
      // スイープ窓のあいだ再選択されず、掃引が終わらない。翌 UTC 日にまた候補になる。
      return { kind: "skipped", settled: false, spent: 0n };
    }
    // census / retest の候補（2026-09-29）: 日次 $25 に届いたら行を書かない。書くとそのホストに行ができ、census は
    // 「一巡済み」、retest は「最新の行がこちらの落ち度ではない」と読んで、翌日以降に二度と選ばない（買っていないのに）。
    // この扱いは新しい env（OBSERVATORY_L1_CENSUS_MIN_PER_RUN・_FIRST_PURCHASE_QUOTA）に関係なく、census / retest の候補
    // （OBSERVATORY_L1_CENSUS=on の日）すべてに効く。同じホストへ無償の要求を出し直さないよう、日次の残りが無い日・残りより
    // 高い候補は runL1Batch が census / retest の候補の取得の段で外す（金の関門は変えない）。
    if (candidate.selection) return { kind: "budget_denied", settled: false, spent: 0n };
    await record({
      status: "budget_denied",
      amountUnits: amountUnitsText,
      rawResponseMeta: { reason: "daily_budget_exceeded", dailyBudgetUsd: DAILY_BUDGET_USD },
    });
    return { kind: "budget_denied", settled: false, spent: 0n };
  }

  // 2026-09-04 監査 P1-2: **予約より後は、何が飛んでも行を in_flight のまま
  // 置かない。** reserveSpend は署名の前に spent_units を立てる（正しい——
  // 署名済み EIP-3009 は validBefore まで生きた金）。だから予約の後で例外が
  // 出ると、一円も動いていないのに日次 $25 の観測予算だけが減り、行は
  // in_flight のまま残る。in_flight は冷却のどの status にも当たらないので、
  // 同じ売り手に何度でも同じことをさせられた（可用性への攻撃）。
  //
  // 署名できない accept は selectAccept / selectSolanaAccept が予約より前に
  // 落とすようになったが、それは既知の形だけを塞ぐ。ここは**未知の形**の
  // 受け皿で、落ちた行は settle_failed（分母に入る status・冷却の対象）へ倒す。
  // 実行時の停止スイッチ・2 回目（2026-09-05 監査 P0）。**署名の直前**。
  // 予約は署名の前に spent_units を立てるので、ここで止めるなら予約を
  // 0 へ戻す必要がある——署名していない予約は「金」ではないのに、放置すると
  // 停止したぶんだけ日次予算が消えてしまう。行は消さず `halted` で残す
  // （何が起きたかを台帳が答えられる状態を崩さない）。
  const preSignHalt = await haltGate(db);
  if (preSignHalt.halted) {
    // 2026-09-29 監査4周目: 停止の理由が「DB が読めない」なら、この UPDATE も同じ DB へ行く。
    // 投げて予約を in_flight のまま残さない（releaseUnsignedReservation の節）。
    await releaseUnsignedReservation(db, reservation.rowId, {
      status: "halted",
      rawResponseMeta: tagMeta({ phase: "pre_sign", reason: preSignHalt.reason }),
    });
    invalidateDecisionCache(candidate.id);
    return { kind: "halted", settled: false, spent: 0n, haltReason: preSignHalt.reason };
  }

  // ここから先は署名する。このバッチの残高の見積もりから差し引く（決済は非同期なので、
  // 成立を待たずに「使った」とみなす——過大に見積もって署名し続けないため）。
  // Gateway はウォレットの USDC ではなく、バッチ内の Gateway available から引く。
  if (isArcGateway) commitArcGateway(amount);
  else payerFunds.commit(payerChain, payerOwner, amount);

  try {
    // Sign — from here on the money is live, so the ledger row ALWAYS carries
    // spent_units, whatever the seller does next.
    let header: { headerName: string; headerValue: string };
    // 我々しか作れない一回性の値。行に残して初めて「その決済 tx はこの購入のもの」
    // と照合できる（2026-09-04 監査 P1-1・settlement-verify.ts の nonce 束縛）。
    let authNonce: string;
    if (mppSelection && mppSelection.accept) {
      // Tempo（MPP）: 署名は参照実装 mppx に委ね、ピン（chainId 4217・受取先の許可リスト・
      // pull）は我々が渡す。memo（帰属 bytes32）を auth_nonce として残し、決済照合が
      // tx の TransferWithMemo と突き合わせる。
      //
      // 2026-09-19（横断監査 W2）: この 1 行は **Tempo RPC へ出る**（mppx の
      // prepareTransactionRequest が nonce・gas を読む）。Solana の blockhash・XRPL の
      // Sequence と違って予約より前へは出せない: mppx は材料の取得と署名を 1 つの
      // createCredential に畳んでいて、切り離すには type 0x76 の封筒を自前で持つことに
      // なる（この module が明示的に避けている）。丸ごと予約の前へ動かすと今度は
      // 「署名したのに予約が取れない」（別枠・初回枠・同時実行）が起きて、reserveSpend を
      // 署名の前に置いた理由そのものが壊れる。
      //
      // だから順番は変えず、落ちたら**予約をその場で `request_error` へ倒す**（独立レビュー W-2）。
      // `spent_units` は 0 に戻す——署名していない予約は金ではない（pre_sign の halted と同じ扱い）。
      // 行を消さないのは、この throw が一過性の RPC 障害だけではないから: gas 見積りが必ず
      // revert する売り手なら毎バッチ同じ所で落ち、行が無ければ dup 判定（窓内の行の有無だけを
      // 見る）が空のままで翌バッチも先頭に戻る。Tempo のレーン枠は 1 回 5 件・1 ホスト 2 件なので、
      // そういう売り手が数件あるだけでレーンが永久に 1 件も買わない。`request_error` は
      // export.csv・decisions・backtest・PAID_ATTEMPT_STATUSES のどれにも入らない（冤罪にならない）
      // 一方で、冷却の 3 連続と掃引の窓には数えられる＝必要な backoff がそのまま効く。
      let cred: Awaited<ReturnType<typeof createMppCredential>>;
      try {
        cred = await createMppCredential(
          { account, challenge: mppSelection.accept.mpp, recipient: accept.payTo },
          mppxCharge ? { mppxCharge } : {},
        );
      } catch (error) {
        // spent_units を 0 に戻してよいのは mppx へ渡すピンが `mode: "pull"` 固定だから
        // ——pull の createCredential は署名した封筒を返すだけで送信しない（push は
        // sendTransactionSync でブロードキャストした後に throw しうる＝金が動いている）。
        // ログにも RPC の URL を出さない（レビュー W-1: logServerError は message をそのまま出す）。
        logServerErrorSafe("observatory.l1.mpp_credential", redactedError(error));
        await db
          .update(x402L1Purchases)
          .set({
            status: "request_error",
            spentUnits: "0",
            rawResponseMeta: tagMeta({ phase: "mpp_credential", error: redactForLog(error) }),
          })
          .where(eq(x402L1Purchases.id, reservation.rowId));
        invalidateDecisionCache(candidate.id);
        return { kind: "skipped", settled: false, spent: 0n };
      }
      authNonce = cred.memo;
      header = { headerName: cred.headerName, headerValue: cred.headerValue };
    } else if (isSolana) {
      const built = await buildSolanaPaymentTransaction({
        accept,
        payer: solanaKeypair!,
        recentBlockhash: solanaBlockhash!,
      });
      authNonce = built.memo;
      header = encodeSolanaPaymentHeader({
        accept,
        transactionB64: built.transactionB64,
        resourceUrl: candidate.resourceUrl,
      });
    } else if (isXrpl) {
      // XRPL（2026-09-17）: 署名済み blob の hash が「その tx はこの購入のもの」の材料。
      // 提出前に我々だけが知り、売り手には選べない（照合器は claimed tx == この hash を要求する）。
      const tx = xrplPayer!.buildXrplPayment({
        account: xrplWallet!.classicAddress,
        accept,
        sequence: xrplSigningInputs!.sequence,
        validatedLedgerIndex: xrplSigningInputs!.validatedLedgerIndex,
        feeDrops: xrplSigningInputs!.feeDrops ?? undefined,
      });
      const signed = xrplPayer!.signXrplPayment(xrplWallet!, tx);
      authNonce = signed.hash;
      header = encodePaymentHeader({
        x402Version: 2,
        accept,
        // payload は { signedTxBlob, invoiceId }（2026-09-19）: t54 の facilitator は invoiceId が無いと invalid_payload で断る。
        payload: xrplPayer!.xrplPaymentPayload(accept, signed.signedTxBlob),
        resourceUrl: candidate.resourceUrl,
      });
    } else if (isStellar) {
      // 予約の後・有料の要求の前。署名前に落ちたら署名は売り手に届いていないので、secondary は予約を消して
      // Base を買い直す。署名後（auth entry のあと）は releaseUnsignedReservation を呼ばない。
      // spent_units は予約のまま（署名したら使ったと数える）。request_error を残し、Base では買わない。
      // どちらの故障でもレーンの残りは閉じる（同じ RPC へ署名を積み直さない）。
      let payload: { transaction: string };
      try {
        // accept が非 null のときだけ stellarUnits は bigint、signingAsset は SAC。
        if (stellarSelection === null || stellarSelection.accept === null) {
          throw new Error("stellar_sign_failed_pre: stellar_selection");
        }
        payload = await createStellarPayment({
          accept,
          signingAsset: stellarSelection.signingAsset,
          stellarUnits: stellarSelection.stellarUnits,
        });
      } catch (error) {
        logServerErrorSafe("observatory.l1.stellar_sign", redactedError(error));
        // 署名後（stellar_sign_failed_post と、印の無い誤り）。auth entry に署名したあとは
        // releaseUnsignedReservation を呼ばない（それは spent_units を 0 に戻す）。予約の額を残す。
        if (!stellarSignFailedPre(error)) {
          try {
            await db
              .update(x402L1Purchases)
              .set({
                status: "request_error",
                rawResponseMeta: tagMeta({ phase: "stellar_sign", error: redactForLog(error) }),
              })
              .where(and(eq(x402L1Purchases.id, reservation.rowId), eq(x402L1Purchases.status, "in_flight")));
          } catch (writeError) {
            logServerErrorSafe("observatory.l1.stellar_sign_keep_spend", redactedError(writeError));
          }
          invalidateDecisionCache(candidate.id);
          return { kind: "stellar_signing_unavailable", settled: false, spent: amount };
        }
        // 署名前（stellar_sign_failed_pre）かつ secondary だけ、未署名の予約を消す。
        // 行が残ると掃引窓の dup が、同じ候補の Base の買い直しを拒む。
        // 主ネットワークが pubnet の行は署名前でも request_error を残す（買い直す経路が無い）。
        if (!isStellarPrimary) {
          try {
            await db.delete(x402L1Purchases).where(
              and(eq(x402L1Purchases.id, reservation.rowId), eq(x402L1Purchases.status, "in_flight"), isNull(x402L1Purchases.authNonce)),
            );
            invalidateDecisionCache(candidate.id);
            return { kind: "stellar_signing_unavailable", settled: false, spent: 0n, retryBase: true };
          } catch (deleteError) {
            logServerErrorSafe("observatory.l1.stellar_sign_release", redactedError(deleteError));
          }
        }
        await releaseUnsignedReservation(db, reservation.rowId, {
          status: "request_error",
          rawResponseMeta: tagMeta({ phase: "stellar_sign", error: redactForLog(error) }),
        });
        invalidateDecisionCache(candidate.id);
        return { kind: "stellar_signing_unavailable", settled: false, spent: 0n };
      }
      authNonce = createHash("sha256").update(payload.transaction).digest("hex");
      header = encodePaymentHeader({
        x402Version: 2,
        accept,
        payload,
        resourceUrl: candidate.resourceUrl,
      });
    } else if (isArcGateway) {
      // BatchEvmScheme は署名するだけ（ブロードキャストしない）。payload が返る前の throw は金が動いていない。
      try {
        gatewaySigned = await signArcGateway({
          account,
          accept,
          x402Version: challenge.x402Version,
          resourceUrl: candidate.resourceUrl,
          sellerResource: gatewaySellerResource({ bodyText: firstBody, headers: first.headers }),
        });
      } catch (error) {
        logServerErrorSafe("observatory.l1.arc_gateway_sign", redactedError(error));
        if (error instanceof Error && error.message === "gateway_validity_window") {
          try {
            await db.delete(x402L1Purchases).where(
              and(eq(x402L1Purchases.id, reservation.rowId), eq(x402L1Purchases.status, "in_flight"), isNull(x402L1Purchases.authNonce)),
            );
          } catch (deleteError) {
            logServerErrorSafe("observatory.l1.arc_gateway_sign_release", redactedError(deleteError));
          }
          invalidateDecisionCache(candidate.id);
          return { kind: "skipped", settled: false, spent: 0n, capChain: "arc_gateway" };
        }
        await releaseUnsignedReservation(db, reservation.rowId, {
          status: "request_error",
          rawResponseMeta: tagMeta({ phase: "arc_gateway_sign", error: redactForLog(error), circleGatewayRail: "true" }),
        });
        invalidateDecisionCache(candidate.id);
        return { kind: "skipped", settled: false, spent: 0n, capChain: "arc_gateway" };
      }
      const nowSec = Math.floor(Date.now() / 1000);
      if (!gatewayAuthWindowOk(gatewaySigned.authorization.validBefore, nowSec)) {
        try {
          await db.delete(x402L1Purchases).where(
            and(eq(x402L1Purchases.id, reservation.rowId), eq(x402L1Purchases.status, "in_flight"), isNull(x402L1Purchases.authNonce)),
          );
        } catch (deleteError) {
          logServerErrorSafe("observatory.l1.arc_gateway_window_release", redactedError(deleteError));
        }
        invalidateDecisionCache(candidate.id);
        return { kind: "skipped", settled: false, spent: 0n, capChain: "arc_gateway" };
      }
      authNonce = gatewaySigned.authorization.nonce;
      header = gatewaySigned.header;
    } else {
      const authorization = buildAuthorization({
        from: account.address,
        to: accept.payTo,
        value: accept.amount,
        nowSec: Math.floor(Date.now() / 1000),
        maxTimeoutSeconds: accept.maxTimeoutSeconds,
      });
      authNonce = authorization.nonce;
      const { signature } = await signX402Payment({ account, accept, authorization });
      header = encodePaymentHeader({
        x402Version: challenge.x402Version,
        accept,
        payload: { signature, authorization },
        resourceUrl: candidate.resourceUrl,
      });
    }
    // 署名の直後に nonce を確定させる。ここから先で落ちても、行には
    // 「何に署名したか」が残る（予約行は既にあるので UPDATE）。
    const gatewayAuthMeta =
      isArcGateway && gatewaySigned
        ? {
            ...(selectionMeta ?? {}),
            circleGatewayRail: "true",
            circleGateway: {
              from: gatewaySigned.authorization.from,
              to: gatewaySigned.authorization.to,
              value: gatewaySigned.authorization.value,
              validAfter: gatewaySigned.authorization.validAfter,
              validBefore: gatewaySigned.authorization.validBefore,
              nonce: gatewaySigned.authorization.nonce,
              signature: gatewaySigned.signature,
              verifyingContract: gatewaySigned.verifyingContract,
            },
          }
        : null;
    // 2026-10-27: 購入ごとの証拠②（有料の要求に載せる支払いペイロードのデコード結果・内部専用の列）。
    // auth_nonce と同じ UPDATE に載せる: 有料の要求より前に残るので、この後で落ちても残る。この UPDATE が落ちたら
    // 従来どおり有料の要求を出さずに止まる（auth_nonce と同じ扱い——記録の無い支払いを売り手へ出さない）。
    const paymentPayload = buildPurchaseEvidence("payment_payload", () => paymentPayloadEvidence(header));
    try {
      await db
        .update(x402L1Purchases)
        .set(gatewayAuthMeta ? { authNonce, paymentPayload, rawResponseMeta: gatewayAuthMeta } : { authNonce, paymentPayload })
        .where(eq(x402L1Purchases.id, reservation.rowId));
    } catch (error) {
      // 2026-10-27 独立点検 H1: drizzle の誤りは message に params（署名済みペイロード・Gateway の signature）を持つ。
      // 外の catch はそれをログと raw_response_meta.error に書くので、SQLSTATE と原因の本文だけで作り直して投げる。
      throw dbWriteErrorWithoutParams("auth_nonce_write", error);
    }

    let paid: Response | null = null;
    let paidBody = "";
    let paidError: string | null = null;
    let paidErrorRaw: unknown = null;
    // 2026-09-29: 受け取った本文の生のバイト数と、本文の読み取りの失敗（途中まで受け取っていても例外にしない）。
    let paidBodyBytes = 0;
    let paidBodyFailure: unknown | null = null;
    // Same 2026-08-22 fix as the unpaid leg: the timer covers the body read too.
    // On the PAID leg an aborted body is not a lost measurement — the settlement
    // receipt lives in the HEADERS, which we already hold — so the outcome is
    // still recorded, with the body error kept in rawResponseMeta.bodyError.
    const paidController = new AbortController();
    // Celo の支払い付き要求だけ 45 秒（2026-10-18）。無払いの firstTimer と、ほかのチェーンは timeoutMs。
    const paidTimeoutMs = l1PaidTimeoutMs(accept.network, { timeoutMs, celoPaidTimeoutMs });
    const paidTimer = setTimeout(() => paidController.abort(), paidTimeoutMs);
    // 2026-09-19（独立レビュー W-4）: safe-fetch が別オリジンの境界で資格情報を落としたら、
    // その事実をここで受け取る（最初の 1 回だけ）。下の status の判定で使う。
    let credentialStripped: { from: string; to: string } | null = null;
    try {
      paid = await fetchImpl(paidRequestUrl?.url ?? candidate.resourceUrl, {
        method,
        signal: paidController.signal,
        redirect: "follow",
        headers: {
          accept: "application/json",
          "user-agent": "vet402-observatory-l1/1.0 (+https://vet402.com/observatory/methodology)",
          [header.headerName]: header.headerValue,
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        ...(paidRequestBody ? { body: paidRequestBody.body } : {}),
      },
        {
          // 2026-09-19（横断監査 W1）: この要求が資格情報を載せるヘッダ名を gate へ宣言する。
          // x402 の 2 つ（X-PAYMENT / PAYMENT-SIGNATURE）は safe-fetch の固定名の表にあるが、
          // MPP（Tempo）のヘッダ名は**売り手の challenge** が決める（mppx の `header` パラメータ）
          // ので表に載せようがない。毎回この 1 本を渡し、別オリジンへの転送では必ず落とす。
          sensitiveHeaders: [header.headerName],
          // 2026-09-29 監査 5 周目: 資格情報を載せた要求を http のホップへ運ばない（転送先も含めて）。
          httpsOnly: true,
          onCredentialsStripped: (hop) => {
            credentialStripped ??= hop;
          },
          // 2026-09-17（Issue #29 独立検証）: 宣言本文は売り手のオリジンから出さない。別オリジンへ
          // 本文を運ぶ転送には従わず 3xx をそのまま記録する（safe-fetch.ts の crossOriginBody）。
          // `{}` の要求は従来どおり。
          ...(paidRequestBody?.source === "declared" ? { crossOriginBody: "refuse" as const } : {}),
        },
      );
      // 2026-09-29（監査 6 周目・計器）: 上限を 16,000 バイトから L1_PAID_BODY_CAP_BYTES へ上げた。1 バイト余分に
      // 読み、上限を超えたかを下の paidBodyRead で**生のバイト数**で判定する（L0 の L0_BODY_CAP_BYTES と同じ考え方）。
      // 本文の読み取りが途中で落ちても（時間切れ・切断）受け取った分は捨てない。失敗は従来どおり paidError に残す。
      const read = await readBodyCappedDetailed(paid, L1_PAID_BODY_CAP_BYTES + 1);
      paidBody = read.text;
      paidBodyBytes = read.bytes;
      if (read.error !== null) {
        paidBodyFailure = read.error;
        paidError = String(read.error).slice(0, 300);
        paidErrorRaw = read.error;
      }
    } catch (error) {
      paidError = String(error).slice(0, 300);
      paidErrorRaw = error;
    } finally {
      clearTimeout(paidTimer);
    }

    const latencyMs = Date.now() - startedAt;
    // MPP の受領証は Payment-Receipt（base64url JSON・reference = tx hash）。x402 と同じ形へ写してある。
    const mppReceipt = paid && isTempo ? parseMppReceipt(paid.headers) : null;
    const settlement = paid ? (isTempo ? mppReceipt : parseSettlementResponse(paid.headers)) : null;
    // 「中身が届いたか」は従来どおり: 本文の読み取りが落ちた応答は空として扱う（2026-09-29 に途中まで受け取った分を
    // 残すようにしたが、「払ったのに届かない」に数える条件は変えない）。
    const payloadNonEmpty = paidBodyFailure === null && paidBody.trim().length > 0;
    const contentType = paid?.headers.get("content-type") ?? null;
    const contentTypeMatch = contentType === null ? null : contentType.includes("json");

    // L2 — minimal structural check against the catalog-declared schema.
    // 2026-09-29: 本文を読み切れなかった応答（上限超え・読み取りの途中の失敗）は判定しない（not_checked）。
    // 2026-10-20: x402 だけ、無払い 402 の extensions.bazaar.info.output.example を影で記録する。
    // l2_schema はカタログの宣言だけで決める（見本で決めると判定の declaration_hash・conform の文と食い違う。
    // 点検 2 周目 高）。影は「見本を当てたら」の結果で、status・判定・公開の値は変えない。Tempo（MPP）は x402 の封筒を読まない。
    const paidBodyRead = paidBodyReadOf(paidBody, paidBodyBytes, paidBodyFailure);
    paidBody = paidBodyRead.body;
    let l2Schema: string = "not_checked";
    let l2Detail: (L2Detail & { liveOutputExample?: LiveOutputExampleShadow }) | null = null;
    // 2026-09-29 監査 7 周目（高 1）: 判定する条件は配達と同じ（delivery.ts isDeliveryHttp: 2xx・202 を除く）。以前は 200 だけで、
    // 201 等の配達は not_checked のまま判定の L2 を素通りしていた。
    if (paid && isDeliveryHttp(paid.status)) {
      const d = checkL2Detailed(candidate.declaredSchema, paidBody, contentType, paidBodyRead.incomplete);
      l2Schema = d.status;
      l2Detail = { missing: d.missing, declarationHash: d.declarationHash, responseHash: d.responseHash, reason: d.reason };
      if (!isTempo) {
        // 影は購入の記録を落とさない（点検 3 周目 低）。shadowSource が catalog_schema ならカタログが勝った結果。
        try {
          const liveOutputExample = liveOutputExampleOf({ bodyText: firstBody, headers: first.headers });
          if (liveOutputExample) {
            const shadow = checkL2Detailed(candidate.declaredSchema, paidBody, contentType, paidBodyRead.incomplete, liveOutputExample);
            l2Detail.liveOutputExample = {
              exampleHash: liveOutputExampleHash(liveOutputExample),
              shadowStatus: shadow.status,
              shadowReason: shadow.reason,
              shadowSource: shadow.declarationSource,
            };
          }
        } catch {
          // 影だけを諦める。l2_schema と l2Detail の本体はカタログの判定のまま。
        }
      }
    }
    // 2026-10-15: 2xx で返った本文が答えの形をしていないか（200 の中のエラー・HTML・空の箱）。影の記録だけで、
    // status・L2・公開の判定は変えない（answer-shape.ts の冒頭）。最後まで読めた空でない本文だけを見る。
    const answerShape =
      paid && isDeliveryHttp(paid.status) && payloadNonEmpty && !paidBodyRead.incomplete
        ? answerShapeOf(paidBody, contentType)
        : null;
    // 2026-10-19 段S1: 上の型を、影の記録の中だけで仕分ける（answer-shape-sort.ts）。status・L2・公開の値は変えない。
    // 段S1b: 仕分けが落ちても、支払い済みの行の記録を巻き込まない。落ちたら answerShapeSort は unknown。
    // 段S1c: 許可リスト外でも、宣言クエリの source だけを仕分けへ渡す。送る URL・支払い・行の requestQuery は変えない。
    // Tempo は x402 の文書を読まない。ここで empty と読むと「宣言にクエリが無い」と誤るので、source は付けない。
    let answerShapeSort: ReturnType<typeof sortAnswerShapeFromRun> | null = null;
    if (answerShape) {
      try {
        const declaredQuerySource: RequestQuerySource | null = isTempo
          ? null
          : (paidRequestUrl?.source ??
            declaredRequestUrl({
              resourceUrl: candidate.resourceUrl,
              bodyText: firstBody,
              headers: first.headers,
            }).source);
        answerShapeSort = sortAnswerShapeCaught(() =>
          sortAnswerShapeFromRun({
            answerShape,
            bodyHead: paidBody.slice(0, 500),
            requestQuery: paidRequestUrl?.source ?? null,
            requestBody: requestBodyRecord(paidRequestBody).requestBody,
            declaredSchema: candidate.declaredSchema,
            declaredInput: declaredQuerySource
              ? { query: declaredQuerySource, body: paidRequestBody?.source ?? "empty" }
              : null,
            sentQuery: paidRequestUrl?.query ?? null,
            sentBody: paidRequestBody?.body ?? null,
          }),
        );
      } catch {
        answerShapeSort = "unknown";
      }
    }

    // 2026-08-23 監査: ここまで `transaction` は「空でない文字列」以外を何も見ていなかった。
    // 値は売り手の PAYMENT-RESPONSE ヘッダそのままで、決済せずに success:true と
    // 架空の文字列を返すだけで「決済成功」の行を作れた。その行は公開台帳になり、
    // 2026-08-22 以降は observed_purchases 経由でスコアの最上位軸にも流れる。
    //
    // 形式検査は権威ではない（形だけ正しい偽ハッシュは通る）。本当の関門は
    // オンチェーン照合で、それが入るまでは「売り手申告＋形式検査済み」と公開面に書く。
    // ここで分けるのは「決済したと言い、識別子も筋が通っている」ことと
    // 「決済したと言うが、識別子がトランザクションIDですらない」ことの区別——
    // 後者は売り手についての所見なので、delivered_no_receipt（レシートを主張して
    // いない）に潰さず独立した status にする。
    const claimedSettlement = settlement?.success === true && !!settlement.transaction;
    const settlementTxWellFormed =
      claimedSettlement &&
      isWellFormedSettlementTx(settlement!.transaction, isSolana ? "solana" : isXrpl ? "xrpl" : isStellar ? "stellar" : "evm");

    // 2026-08-23 監査 C-4: ここで `settled` と名乗らない。
    // settled の定義は「我々がチェーンで確認した」であって、売り手が success:true と
    // 返したことではない。購入直後にチェーンを読みに行くと、確定を待つ間に
    // バッチのデッドラインを食い潰す（しかも確定前の tx を確認済みと刻む事故になる）。
    // だから購入は `settle_claimed` で置き、日次の照合 cron が
    // `settled` / `settle_claim_refuted` へ確定させる。
    const claimedAndWellFormed = claimedSettlement && settlementTxWellFormed;
    // 2026-09-19（レビュー 2 巡目 W-4）: 資格情報を境界で落とした要求が 401/402 で
    // 返ってきても、**status は変えない**（`settle_failed` のまま）。
    //
    // 一度は「我々の関門が起こした事実だから request_error」と書いたが、同じ事実から
    // 逆の結論になる: 有料レグは必ず `candidate.resourceUrl` と同じ origin・同じ経路（2026-09-20 以降は
    // 売り手が宣言したクエリを足した URL のことがある）——台帳で採点している売り手自身の origin——へ最初に出るので、境界が立つ頃には売り手は 1 ホップ目で署名済みの
    // 資格情報を受け取り終えている（だから `spent_units` も戻さない）。つまり売り手は
    // 有料の口に `302 → 別オリジン` を 1 行足すだけで、$1 を引ける状態を手にしたまま
    // 「払ったのに何も返ってこなかった」という観測を公開台帳から消せてしまう
    // （request_error は export.csv・decisions・backtest・PAID_ATTEMPT_STATUSES のどれにも
    // 入らない）。損失は冷却で 1 エンドポイント 1 窓 3 × $1 に収まるが、消えるのは台帳の
    // 意味のほうで、それがこの製品の資産である。
    // 語の定義とも合わない: `request_error` は「我々のランナーが死んだ」という我々側の
    // 事実（この file の resolveReservationAsFailed の節）で、転送を選んだのは売り手の壁。
    // `PAID_ATTEMPT_STATUSES` の定義（reader.ts）は「署名して実際に払った試行」で、
    // これはまさにそれ。
    //
    // 正直な売り手が巻き込まれる形は実在しうるが、**まだ 1 件も観測していない**。
    // 数えられるようにだけしておく: 境界は下の `rawResponseMeta.credentialStripped` に
    // 残るので、`raw_response_meta ? 'credentialStripped'` で件数を数えられる。
    // 実在するほど多いと分かってから分母の扱いを決める。
    // 2026-09-29 監査4周目: 応答を 1 つも得られなかった失敗（!paid）の原因が、こちらの機械の中にしか
    // 無いもの（ファイル記述子・バッファ・メモリの枯渇）か、売り手が起こせる形かを transportFailure.side
    // に残す。status はどちらも settle_failed（下の独立レビューの節）。spent_units はどちらも残す。
    // 2026-09-29 独立レビュー（BLOCK）: ここは資格情報（署名した支払い）を送った後の段。status を
    // request_error にすると遅延回収（recover-late.ts は request_error を「署名していない行」として外す）
    // から外れ、売り手が後で決済した tx が台帳に結び付かない。status は常に settle_failed のままにし、
    // 我々の機械の中の失敗だったことは transportFailure.side の印だけで残す（今は印を残すだけで、読む側はまだ無い）。
    const transportSide = !paid ? paidTransportFailureSide(paidErrorRaw) : null;
    // Gateway には支払いごとの tx が無い。応答なし・402・500 は settle_failed。
    // 200 で受領証が無い行は delivered_no_receipt。請求は照合が settled に上げる。
    const status = isArcGateway ? gatewaySignedStatus(paid, claimedSettlement) : !paid
      ? "settle_failed"
      : claimedAndWellFormed
        ? "settle_claimed"
        : claimedSettlement
          ? "settle_claimed_unverifiable" // 決済したと主張したが識別子が形式不正
          : paid.status === 200
            ? "delivered_no_receipt" // goods returned but no settlement receipt header
            : "settle_failed";
    // summary の互換のため「売り手が決済を主張したか」は残すが、これは
    // settled ではない。名前で取り違えないよう別名にしてある。
    // Gateway は売り手が tx を名乗っても、ここでは settled にしない。
    const settled = isArcGateway ? false : claimedAndWellFormed;

    // Resolve the reservation in place — spent_units stays exactly what was
    // reserved (signed = counted, success or not); only the outcome is filled in.
    const gatewayFacts =
      isArcGateway && gatewaySigned
        ? gatewayLeafFacts({
            resourceUrl: candidate.resourceUrl,
            method,
            paidUrl: paidRequestUrl?.url ?? candidate.resourceUrl,
            requestBody: paidRequestBody?.body ?? "",
            responseBody: paidBody,
            httpStatus: paid?.status ?? 0,
          })
        : null;
    const gatewayMeta =
      isArcGateway && gatewaySigned
        ? {
            circleGatewayRail: "true" as const,
            circleGateway: {
              from: gatewaySigned.authorization.from,
              to: gatewaySigned.authorization.to,
              value: gatewaySigned.authorization.value,
              validAfter: gatewaySigned.authorization.validAfter,
              validBefore: gatewaySigned.authorization.validBefore,
              nonce: gatewaySigned.authorization.nonce,
              signature: gatewaySigned.signature,
              verifyingContract: gatewaySigned.verifyingContract,
              ...(gatewayFacts ?? {}),
            },
          }
        : null;
    const rawResponseMeta = {
      phase: "paid",
      // 支払い付き要求で張った待ち（ミリ秒）。分類はこれを読む。無い行は 20 秒とみなす。
      paidTimeoutMs,
      status: paid?.status ?? null,
      contentType,
      // Tempo は MPP（WWW-Authenticate: Payment / Authorization: Payment / Payment-Receipt）。
      ...(isTempo ? { protocol: "mpp" } : {}),
      // XRPL のレーン候補だったが XRPL の accept を選べず Base へ落ちた理由（2026-09-18）。
      ...(xrplLaneRefusal ? { xrplLane: xrplLaneRefusal } : {}),
      // Stellar のレーン候補だったが Stellar の accept を選べず Base へ落ちた理由（2026-10-18・段4）。
      ...(stellarLaneRefusal ? { stellarLane: stellarLaneRefusal } : {}),
      // どのオリジン境界で資格情報を落としたか（2026-09-19 レビュー W-4）。status が
      // request_error になった行の理由はこれ。
      ...(credentialStripped ? { credentialStripped } : {}),
      bodyHead: paidBody.slice(0, 500),
      // 2026-09-29: 本文の読み取りが落ちた行の bodyHead は、落ちる前に受け取った分（L2 は not_checked）。
      // 応答が無かった行だけ: どちら側の失敗か（2026-09-29）。status はどちらも settle_failed
      // （資格情報は送った後なので遅延回収の対象に残す）。"vet402" は我々の機械の中の失敗の印。
      ...(transportSide ? { transportFailure: { side: transportSide, code: transportErrorCode(paidErrorRaw) } } : {}),
      // どの本文で有料の要求を出したか（2026-09-17 Issue #29）。"declared" は売り手の 402 が宣言した
      // input.body、"empty" は `{}`。2026-09-20: POST 以外にも "none" を残し（行はメソッドを持たないので、
      // 記録が無いと「本文なし」と「記録なし」を後から分けられない）、宣言本文には送ったバイト列の
      // SHA-256 を添える。公開 export の request_body / request_body_sha256 の元（request-body.ts）。
      ...requestBodyRecord(paidRequestBody),
      // A response whose HEADERS arrived but whose body aborted/failed: the
      // error would otherwise be dropped (rawSettlement keeps the settlement
      // when one exists), so it is kept here rather than silently lost.
      ...(paid && paidError ? { bodyError: paidError } : {}),
      // §6.3: L2 の判定材料。mismatch の公開に要る宣言ハッシュ・応答ハッシュ・欠落キー。
      // 2026-09-29: reason（何で決まったか）を足した。body_over_cap の行の responseHash は読んだ分だけのハッシュ。
      ...(l2Detail ? { l2: l2Detail } : {}),
      // 答えの形をしていない本文の型と、その影の仕分け（2026-10-15・2026-10-19・小さいので縮めた記録にも残す）。
      ...(answerShape ? { answerShape, answerShapeSort } : {}),
      // 読んだ本文のバイト数（上限で頭打ち）と、上限を超えて切ったか（2026-09-29）。
      ...(paid ? { bodyBytes: paidBodyRead.bytes, bodyCapBytes: L1_PAID_BODY_CAP_BYTES } : {}),
      ...(paidBodyRead.incomplete === L1_BODY_OVER_CAP_REASON ? { bodyTruncated: true } : {}),
      // どの URL で払ったか（2026-09-20）。"declared" は売り手の 402 が宣言した input.queryParams を
      // 足した URL。"empty"（売り手が宣言していない）と "refused"（宣言は在ったが我々の規則で使わなかった）は
      // カタログの URL のまま。許可リストに無い network の行には付けない。
      // "declared" の行には SHA-256 を別キーで添える（独立レビュー W-4。形は本文側の requestBody ＋
      // requestBodySha256 と揃える）。元は「先頭の区切りを除いた、足した対だけの form-urlencoded 文字列」で、
      // 再計算の取り決め 5 条は declared-input.ts の DeclaredRequestUrl。文字列も 402 の宣言も保存しないので、
      // 出来るのは照合（2 行が同じ要求か・402 を取り直して同じ文字列になるか）まで。
      ...(paidRequestUrl ? { requestQuery: paidRequestUrl.source } : {}),
      ...(paidRequestUrl?.query != null
        ? { requestQuerySha256: createHash("sha256").update(paidRequestUrl.query, "utf8").digest("hex") }
        : {}),
      // census / retest の候補から来た行（2026-09-28）。どちらでもなければ鍵ごと無い。
      ...(selectionMeta ?? {}),
      ...(gatewayMeta ?? {}),
    };
    // 売り手から来た文字列（本文の先頭・受領証・tx）は pgSafeJson / pgSafeText を通す（2026-09-29）。通さないと
    // バイナリの本文の U+0000 で UPDATE ごと落ち、払った後の行が tx も HTTP status も無い settle_failed になった。
    // 変えた列は raw_response_meta.pgSanitized に名前を残す（2026-09-29 独立レビュー）。
    const sanitizedFields: string[] = [];
    const safe = <T,>(field: string, value: T): T => {
      const r = pgSafeJsonChanged(value);
      if (r.changed) sanitizedFields.push(field);
      return r.value;
    };
    const claimedTx = isArcGateway ? null : (settlement?.transaction ? safe("txHash", settlement.transaction) : null);
    const safeSettlement = safe(
      "rawSettlement",
      settlement
        ? isTempo && mppReceipt
          ? { ...settlement, receipt: mppReceipt.receipt, header: paid?.headers.get("payment-receipt") ?? null }
          : settlement
        : paidError
          ? { error: paidError }
          : null,
    );
    const safeMeta = safe("rawResponseMeta", rawResponseMeta);
    const outcomeRow = {
      status,
      txHash: claimedTx,
      httpStatusPaid: paid?.status ?? null,
      latencyMs,
      payloadNonEmpty: paid ? payloadNonEmpty : null,
      contentTypeMatch,
      l2Schema,
      rawSettlement: safeSettlement,
      rawResponseMeta: { ...safeMeta, ...pgSanitizedMark(sanitizedFields) },
    };
    let recordedStatus = status;
    // 2026-09-04 監査 P1-1: 売り手が**別の購入で既に使われた tx**をレシートとして
    // 返した。部分一意 index（x402_l1_purchases_tx_unique）が書き込みを弾いた
    // ——それ自体が売り手についての所見なので、行を in_flight のまま残さず
    // その場で確定させる。tx_hash は null で入れる（一意 index を再び踏まないため。
    // 主張された値は raw_response_meta に残るので消えていない）。
    const writeRefuted = async (base: Omit<typeof outcomeRow, "rawSettlement" | "rawResponseMeta"> & { rawSettlement: unknown; rawResponseMeta: unknown }) => {
      recordedStatus = "settle_claim_refuted";
      await db
        .update(x402L1Purchases)
        .set({
          ...base,
          status: recordedStatus,
          txHash: null,
          settlementVerified: false,
          settlementVerifiedAt: new Date(),
          settlementVerifyReason: `tx_hash_reused: ${claimedTx ?? ""}`.slice(0, 500),
          rawResponseMeta: { ...(base.rawResponseMeta as Record<string, unknown>), reusedTxHash: claimedTx },
        })
        .where(eq(x402L1Purchases.id, reservation.rowId));
    };
    try {
      await db.update(x402L1Purchases).set(outcomeRow).where(eq(x402L1Purchases.id, reservation.rowId));
    } catch (error) {
      if (isDuplicateTxHashError(error)) {
        await writeRefuted(outcomeRow);
      } else {
        // 2026-09-29: 結果の UPDATE が未知の理由で落ちても、**払った事実の芯**（status・売り手が名指した tx・
        // HTTP status・nonce は署名の直後に書き済み）は失わない。売り手の本文・受領証の中身を外した小さな行で
        // 書き直す。これも落ちたら外側の catch（resolveReservationAsFailed）が settle_failed に倒す——そのときも
        // auth_nonce は残っているので、遅延回収（recover-late: 索引とチェーン直読み）が着金を結び付ける。
        logServerErrorSafe("observatory.l1.outcome_write_failed", new Error(`cause=${JSON.stringify(dbErrorCause(error))} ${redactedError(error).message}`));
        // 受領証は形を保つ（独立レビュー W1）: /sellers は raw_settlement が object かで「PAYMENT-RESPONSE があったか」を、
        // success の型で「記載なし」を読む。null にすると「no PAYMENT-RESPONSE recorded」と誤って出る。落とすのは
        // MPP の receipt・header（長い原文）だけで、success は元の値のまま、文字列は無害化して短くする。
        const short = (v: unknown, n: number) => (typeof v === "string" ? pgSafeText(v).slice(0, n) : v ?? null);
        const minimalSettlement = settlement
          ? {
              success: settlement.success,
              transaction: claimedTx,
              network: short(settlement.network, 100),
              payer: short(settlement.payer, 100),
              errorReason: short(settlement.errorReason, 200),
            }
          : paidError
            ? { error: short(paidError, 300) }
            : null;
        const minimal = {
          ...outcomeRow,
          rawSettlement: minimalSettlement,
          rawResponseMeta: {
            ...pgSafeJson({
              phase: "paid",
              paidTimeoutMs,
              status: paid?.status ?? null,
              contentType,
              ...(isTempo ? { protocol: "mpp" } : {}),
              ...(credentialStripped ? { credentialStripped } : {}),
              ...(transportSide ? { transportFailure: { side: transportSide, code: transportErrorCode(paidErrorRaw) } } : {}),
              // L2 の証拠（宣言と応答のハッシュ・欠落キー）は小さいので残す（独立レビュー W1）。
              ...(l2Detail ? { l2: l2Detail } : {}),
              // 答えの形をしていない本文の型と、その影の仕分け（2026-10-15・2026-10-19・小さいので縮めた記録にも残す）。
              ...(answerShape ? { answerShape, answerShapeSort } : {}),
              // 本文の読んだバイト数と切った印も L2 の証拠（2026-09-29・小さいので残す）。
              ...(paid ? { bodyBytes: paidBodyRead.bytes, bodyCapBytes: L1_PAID_BODY_CAP_BYTES } : {}),
              ...(paidBodyRead.incomplete === L1_BODY_OVER_CAP_REASON ? { bodyTruncated: true } : {}),
              ...requestBodyRecord(paidRequestBody),
              ...(selectionMeta ?? {}),
              ...(gatewayMeta ?? {}),
              outcomeWriteFailed: { cause: dbErrorCause(error), error: redactForLog(error).slice(0, 200) },
            }),
            ...pgSanitizedMark(sanitizedFields),
          },
        };
        try {
          await db.update(x402L1Purchases).set(minimal).where(eq(x402L1Purchases.id, reservation.rowId));
        } catch (secondError) {
          if (!isDuplicateTxHashError(secondError)) throw secondError;
          await writeRefuted(minimal);
        }
      }
    }
    invalidateDecisionCache(candidate.id);

    // observed_purchases への記帳（2026-08-22 監査・項目1）。
    //
    // この表は scoreEconomicActivity（重み0.40の最上位軸）の L1 枝・
    // scoreL1Receiving・payee-engine の l1DeliveryDepth の唯一の材料で、
    // 「trusted-writer ingest」と設計されながら**全リポで呼び手が存在せず**
    // 0行だった（本番実測 2026-08-22: observed_purchases 0行 /
    // x402_l1_purchases 1,167行・決済成功496）。その間ずっと
    // signals.x402.l1PurchaseCount 等は常に 0 を公開していた。
    //
    // 何を1行とするか（schema と observed-purchases.ts の意味論に従う）:
    //  - tx_hash は NOT NULL かつ一意＝この表の自然キー。決済レシート
    //    （PAYMENT-RESPONSE の transaction）が無い試行は行にできないので、
    //    書けるのは settled のときだけ。delivered_no_receipt は「品は来たが
    //    レシートが無い」＝オンチェーンの購入として名指せないので書かない;
    //  - delivery_verified は**書き手側の保証**（reader は読み取り時に導出
    //    できず、このフラグを信じるだけ）。だから「品が実際に届いた」と
    //    我々が観測した時だけ true にする: HTTP 200 かつ本文が空でなく、
    //    宣言スキーマに対して mismatch でないこと。1つでも欠ければ false で
    //    記録する——行を捨てるのではなく、x402 相当の事実として残す;
    //  - block_timestamp は取らない（L1 はレシートのハッシュしか持たず、
    //    ブロック時刻を引く経路がまだ無い）。null なら reader は created_at を
    //    日次軸に使う（settledAt の coalesce）ので、数秒差で正しい日に入る。
    //    推測で埋めない。
    //
    // 大文字小文字: recordObservedPurchase は wallet/counterparty を小文字化
    // する。base58（Solana）には情報が失われるが、読み手
    // （getObservedPurchaseStats / getObservedDeliveryStats）も引数を小文字化
    // して比較するので、書き・読みで一貫している。台帳（x402_l1_purchases）
    // 側は base58 の原文を保つ、という既存の分担はそのまま。
    //
    // graceful: ここで何が起きても購入の記帳（正典は x402_l1_purchases）は
    // 既に完了している。ただし黙って消さない——失敗は logServerError に残す。
    // 2026-08-23 監査 C-4: **ここでは書かない。** 上の長いコメントが説明している
    // 配線は 2026-08-22 に入れたもので方向は正しかったが、当時の `settled` は
    // 「売り手が success:true と言った」でしかなかった。つまり売り手の自己申告が
    // そのままスコアの最上位軸へ流れていた。
    //
    // observed_purchases への書き込みは
    // src/lib/observatory/settlement-verifier.ts へ移した。オンチェーンで
    // 宛先・金額・トークン・チェーン・確定数を確認できた行だけが証拠になる。
    // delivery_verified の判定規則（isDeliveryVerified）は共有していて、
    // 遡及行と実時間行が食い違わないようにしてある。

    // ERC-8004 への公開（C4）は**ここでは呼ばない**（2026-09-02 監査 P1-7）。
    // この時点の `settled` は売り手の自己申告で、オンチェーンに書く verdict には
    // なれない。発火点は settlement-verifier（チェーンで settled / refuted が
    // 確定した後）。

    return {
      kind: "attempted",
      // 再利用 tx を弾いた行は settled の候補ではない。Gateway は claimedAndWellFormed でも settled にしない。
      settled: settled && recordedStatus === status,
      spent: amount,
      status: recordedStatus,
      network: ledgerNetwork,
      ...(isArcGateway ? { capChain: "arc_gateway" as const } : {}),
    };
  } catch (error) {
    logServerErrorSafe("observatory.l1.purchase_after_reservation", redactedError(error));
    const writtenStatus = await resolveReservationAsFailed(db, reservation.rowId, error);
    invalidateDecisionCache(candidate.id);
    // spent はこのバッチの見積もり（spentToday）用で、過大側に倒したまま（予約を戻したかは DB が正）。
    return {
      kind: "attempted",
      settled: false,
      spent: amount,
      status: writtenStatus,
      network: ledgerNetwork,
      ...(isArcGateway ? { capChain: "arc_gateway" as const } : {}),
    };
  }
}

/** 例外（undici は cause に包む）から errno 風のコードを取り出す。無ければ null。 */
export function transportErrorCode(error: unknown): string | null {
  let e: unknown = error;
  for (let depth = 0; depth < 4 && e && typeof e === "object"; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code.slice(0, 40);
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * 原因がこの機械の中にしか無い errno（2026-09-29 監査4周目）。売り手はどれも起こせない:
 * 記述子・バッファ・メモリの枯渇。
 * DNS（EAI_AGAIN 等）・ENETUNREACH・タイムアウトは入れない——売り手が転送先を選べば起こせる。
 */
const VET402_SIDE_TRANSPORT_CODES: ReadonlySet<string> = new Set([
  "EMFILE",
  "ENFILE",
  "ENOBUFS",
  "ENOMEM",
  // ENETDOWN・EADDRNOTAVAIL は外した（2026-09-29 独立レビュー）: 売り手が AAAA だけを返す等で
  // 起こせる可能性があり、「売り手はどれも起こせない」を満たさない。
]);

/** 有料の要求が応答を 1 つも得られなかったときの帰属。 */
export function paidTransportFailureSide(error: unknown): "vet402" | "seller_or_path" {
  const code = transportErrorCode(error);
  return code !== null && VET402_SIDE_TRANSPORT_CODES.has(code) ? "vet402" : "seller_or_path";
}

/**
 * 「別の購入が既に使っている決済 tx」の一意違反か（2026-09-04 監査 P1-1）。
 *
 * postgres-js / neon-http でエラーの形が違うので、SQLSTATE と制約名の
 * どちらかで判定する。ここを取り違えると、無関係な DB 障害を売り手の
 * 所見（settle_claim_refuted）として記録してしまうので、制約名まで見る。
 */
function isDuplicateTxHashError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  const text = `${(error as { constraint_name?: string })?.constraint_name ?? ""} ${String(error)}`;
  return (code === "23505" || /23505|duplicate key/i.test(text)) && /x402_l1_purchases_tx_unique/.test(text);
}

/**
 * 購入ごとの証拠（challenge_402 / payment_payload）を組む（2026-10-27）。組み立ての不具合で購入を止めない:
 * 例外は印だけの記録にして、ログには列の名前と誤りの型だけを出す（中身・ヘッダーの値は出さない）。
 * 書き込みの失敗は別で、呼び手の INSERT / UPDATE ごと落ちる（予約・auth_nonce と同じ扱い）。
 */
function buildPurchaseEvidence(column: "challenge_402" | "payment_payload", build: () => Record<string, unknown>): Record<string, unknown> {
  try {
    return build();
  } catch (error) {
    logServerErrorSafe(`observatory.l1.evidence_${column}`, error instanceof Error ? error.name : typeof error);
    return { v: PURCHASE_EVIDENCE_VERSION, error: "evidence_build_failed" };
  }
}

/**
 * DB の書き込みの誤りを、値（params）を含めずに作り直す（2026-10-27 独立点検 H1）。
 * drizzle の DrizzleQueryError は message に `params: <値>` を持ち、値には署名済みの支払いペイロードが入りうる。
 * 残すのは段の名前・SQLSTATE・原因（postgres の誤り）の本文だけ。cause には同じ 2 つだけを持つ Error を置き、
 * resolveReservationAsFailed の dbErrorCause が従来どおり SQLSTATE を台帳に残せるようにする。
 */
export function dbWriteErrorWithoutParams(phase: string, error: unknown): Error {
  const cause = dbErrorCause(error);
  const code = cause?.code ?? null;
  const text = cause ? cause.message : error instanceof Error ? error.name : typeof error;
  const inner = Object.assign(new Error(text), { code: code ?? undefined });
  return new Error(`${phase} failed: ${code ?? "no_sqlstate"} ${text}`, { cause: inner });
}

/**
 * Postgres の text / jsonb が受け付けない文字を落とす（2026-09-29・支払った後の台帳の更新が落ちた件）。
 *
 * 本番の実測: 2026-09-21〜29 の 6 行（agents.dexl.io の音声・api.x-402.online のスクリーンショット・
 * cloud.trycorpus.ai の gzip TSV など、**本文がバイナリの出品だけ**）で、支払い付き要求の結果の UPDATE が落ち、
 * 行は `threw_after_reservation` の settle_failed になった——売り手が返した tx（settle_claimed）も、HTTP 200 も失った。
 * 原因は bodyHead（本文の先頭 500 文字）: バイナリを文字列にすると U+0000 が残り、jsonb は `\u0000` を受け付けない
 * （22P05 unsupported Unicode escape sequence）。gzip は 4 バイト目で必ず 0x00。slice の切れ目の孤立サロゲートも
 * jsonb は受け付けない（22P02）。U+0000 は落とし、孤立サロゲートは U+FFFD に置き換える（キーも同じ）。
 */
export function pgSafeText(value: string): string {
  return value
    .replaceAll("\u0000", "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}

/** pgSafeText を JSON の値の全ての文字列（キーを含む）に掛ける。文字列以外の葉はそのまま。 */
export function pgSafeJson<T>(value: T): T {
  if (typeof value === "string") return pgSafeText(value) as T;
  if (Array.isArray(value)) return value.map((v) => pgSafeJson(v)) as T;
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[pgSafeText(k)] = pgSafeJson(v);
    return out as T;
  }
  return value;
}

/**
 * pgSafeJson を掛け、値が変わったか（何かを落とした・置き換えた）も返す（2026-09-29 独立レビュー）。変わった行には
 * raw_response_meta.pgSanitized に印を残す——台帳の文字列が売り手の原文そのものではないことを後から言えるように。
 */
export function pgSafeJsonChanged<T>(value: T): { value: T; changed: boolean } {
  const out = pgSafeJson(value);
  return { value: out, changed: JSON.stringify(out) !== JSON.stringify(value) };
}

/** pgSanitized の印（変わった列の名前）。変わっていなければ空。 */
export function pgSanitizedMark(fields: readonly string[]): Record<string, unknown> {
  return fields.length > 0
    ? { pgSanitized: { fields: [...fields], note: "U+0000 removed and lone UTF-16 surrogates replaced with U+FFFD before writing (Postgres text/jsonb refuse them)" } }
    : {};
}

/**
 * DB の例外の原因（SQLSTATE と本文）を短く取り出す（2026-09-29）。drizzle は「Failed query: <文> params: <値>」で
 * 包み、原因（postgres の誤り）を cause に置く。従来は包みの先頭 300 文字だけを残していたので、原因は params の
 * 途中で切れて一度も台帳に残らなかった。URL は伏字（redactForLog）。
 */
export function dbErrorCause(error: unknown): { code: string | null; message: string } | null {
  let e: unknown = error;
  for (let depth = 0; depth < 4 && e && typeof e === "object"; depth++) {
    const next = (e as { cause?: unknown }).cause;
    if (!next || typeof next !== "object") break;
    e = next;
  }
  if (!e || typeof e !== "object" || e === error) return null;
  const code = (e as { code?: unknown }).code;
  return {
    code: typeof code === "string" && code.length > 0 ? code.slice(0, 10) : null,
    message: pgSafeText(redactForLog(e)).slice(0, 200),
  };
}

/**
 * L2 contract conformance, minimal and honest: with no declaration the
 * verdict is `no_declaration` (never a failure); with a declaration we check
 * what is machine-checkable without a full JSON-Schema engine — the body
 * parses as JSON and carries the declared top-level required/properties keys.
 */
/**
 * §6.3 / §14 P2（2026-09-02）: mismatch の公開には宣言のハッシュ・実レスポンスのハッシュ・
 * 差分の機械可読リストを付ける（生の有料コンテンツ全文は公開しない）。
 * 2026-09-29: 実装は l2-check.ts へ移した（判定の読み手が支払いのモジュールを読み込まずに使えるように）。
 */
export const checkL2Detailed = checkL2DetailedImpl;
