// ============================================================
// §8.3 判定。recommendation は事実から関数で出す。関数は版管理する。
//
// 支払前（買い手 → 売り手・role=payer）:
//   conclusive = n_attempts − n_inconclusive（2026-09-08。inconclusive は settled だが
//                有料応答が 4xx で、我々の要求の形で説明がつく行。売り手の不履行に数えない。
//                2026-09-17 Issue #29: 決済レシートなしの 4xx（402 以外）と、我々の資金切れ
//                期間の 402・5xx も含む。規則の正典は delivery.ts の heldReasonOf。式は変えていないが
//                BLOCK に届く行が変わるので版を上げた）
//   2026-09-29（開発者の試走・/sellers の帰属と同じ規則）: conclusive = n_attempts − notCounted.total
//                （seller-facts.ts l1NotCountedOf・facts には載せず options で渡す）。判定保留に加え、vet402 の側（資金切れ・宣言の本文／クエリを送っていなかった）、
//                課金なし（レシートも着金も無い 2xx・4xx）、照合待ちを含む。stableenrich.dev の people-search は
//                L1 3 回がすべて「レシート無しの 200・着金なし」で BLOCK だったが、他の買い手の実決済は 30 日で 259 件。
//                売り手に課金されていない試行・こちらの落ち度の試行だけでは BLOCK にしない（l1_inconclusive＝WARN）。
//                除いた理由は reason_codes に l1_not_counted_vet402_side / l1_not_counted_held /
//                l1_not_counted_no_charge として載せる（配達 0 のときだけ）。
//   2026-09-29（再監査）: l0 = unverified の BLOCK は、原因を下位コード l0_unverified_<cause> で添える
//                （seller-facts.ts l0UnverifiedCauseOf・options で渡す。判定は変えない）。
//   2026-09-29.2（敵対的監査 4 周目・競合エンジニアの実測）: 版を上げた。意味が変わる点:
//     (1) 支払い済み・未配達（決済が確認できる行＝settled、または tx の付いた settle_failed で、
//         2xx の非空本文が届かなかった行。除外は下の notCounted と同じ＝vet402 の落ち度を示せる行だけ）を
//         強く数える。窓の中の**最後の配達より後**に 2 回以上 → BLOCK（l1_paid_not_delivered）、1 回 → WARN。
//         cnvrt.ing/api/analyze-image は 30 日で決済済み・HTTP 500 が 2 回、ALLOW でも BLOCK でもなく WARN だった。
//     (2) 数えられる最新の試行が失敗なら ALLOW にしない（WARN・l1_latest_failed）。spark-solana は
//         30 日で 1 回届いた後、最新が失敗でも ALLOW だった。
//     (3) 署名した試行が 30 日の窓の外にしか無いときは l1_not_attempted ではなく l1_stale
//         （api.sirenic.eu …/dirigeants は 08-24 に 2 回払っていたのに「一度も試していない」と読めた）。
//     (4) L0 を公開規則にそろえる: 1 回の fail（l0_unverified_single_fail）は WARN、2 回連続の fail
//         （l0_fail）が BLOCK。degraded も立てない（測れている）。その他の unverified は従来どおり BLOCK。
//         独立レビュー（BLOCK・Critical）で範囲を絞った: WARN に緩めるのは、出品が掲載中（active）で、
//         最新プローブが L0_SINGLE_FAIL_MAX_AGE_HOURS（120h）以内で、直前のプローブが pass のときだけ
//         （active のプローブ間隔は p50 18h・p95 119h）。delisted・最新プローブが古い・連続が切れた
//         （fail → unverified → fail）等は BLOCK のまま l0_unverified_single_fail_unconfirmed を添え、degraded も立てる
//         （require_vet402_allow=false の呼び手が払わないように）。
//     (5) 鮮度: ALLOW は最新の配達が L1_FRESH_DAYS 日以内のときだけ。古ければ WARN・l1_stale。
//         allow_without_l1 のオプトインは「L1 の証拠が無い／古い」だけを免除する（失敗は免除しない）。
//     (6) l1_inconclusive の数は応答の l1_basis.n_not_counted（= n_attempts − 数えた試行）。
//         facts.l1.n_inconclusive は /purchases と同じ「判定保留」の部分集合のまま（facts の意味は変えない）。
//   2026-09-29.3（監査 6 周目・お金が動いていない失敗で BLOCK にしていた）: 版を上げた。意味が変わる点:
//     (1) L1 で BLOCK の根拠になるのは「お金が動いた（settled、または照合で確かめた tx の付いた settle_failed）のに
//         届かなかった」行だけ（l1_paid_not_delivered: 最後の配達より後に 2 回以上）。旧来の
//         「conclusive ≥ 3 ∧ n_delivered = 0 → BLOCK」は消した。weather.cyberwarex.com/forecast は
//         お金の動いていない 502 が 3 回（/sellers は 3 行とも not sorted: vet402 unproven）で BLOCK
//         （l1_never_delivered）だった。同じ 30 日に他の買い手の実決済 46 件。
//     (2) お金が動いていない失敗は、/sellers の売り手の側（確定・別の UTC 日に 2 回以上）の行だけ数える（WARN の
//         理由にはなるが、単独で BLOCK にしない）。vet402 に落ち度が無いと示せない行（not sorted: vet402 unproven・
//         stopped waiting・未分類）は l1_not_counted_unproven、売り手の側だが 1 日だけの行（not sorted: one failure
//         so far）は l1_not_counted_unconfirmed として数えない（seller-facts.ts notCountedReasonOf・/sellers の
//         classifySellerRow が正典）。お金が動いた行の扱いは変えない（払う側に慎重）。
//     (3) l1_never_delivered の意味: 窓の中に数えた失敗があり、配達が 0（WARN）。BLOCK になるのは同時に
//         l1_paid_not_delivered が 2 回以上のときだけ。
//     (4) l2 = mismatch で、記録に欠けたキーが無い（missing_keys が空・記録なし）ものは l2_mismatch_unexplained を
//         添えて WARN（BLOCK にしない）。x402.twit.sh/users/following は missing_keys: [] で BLOCK だった。vet402 は
//         支払い付き応答の先頭 16,000 バイトしか読まなかったので、それより長い JSON は解析できず「不一致」に見えた
//         （l1-runner の readBodyCapped）。欠けたキーを記録した不一致だけが BLOCK の根拠。2026-09-29 から上限は 256 KiB、
//         上限を超えた・途中で切れた本文は not_checked。最後まで読めて閉じていない JSON は mismatch（欠けたキーは作らない
//         ＝unexplained の WARN）。印の無い古い行は seller-facts が legacyL2SchemaOf（l2-check.ts）で読み直し、記録した
//         欠けたキーが保存した頭の最上位に見える（切れた証拠がある）行だけ売り手の不一致として数えない。
//     (5) 独立レビュー 警告 2: 空の 2xx で決済がまだ結び付いていない行（レシートの無い 200・払う側の残高不足の
//         期間の空の 200・照合待ち）は、お金が動いたかどうか未確定。失敗には数えないが、最後の配達より後に 1 行でも
//         あれば WARN（l1_empty_2xx_settlement_unknown）。確定するまで ALLOW に戻さない（allow_without_l1 でも免除
//         しない）。BLOCK にするのは、遅延回収で決済が結び付いて l1_paid_not_delivered になったときだけ。
//   BLOCK if l0 = fail ∨ (l0 = unverified ∧ ¬確かめられた single_fail) ∨ paid_undelivered_since_delivery ≥ 2
//            ∨ (l2 = mismatch ∧ missing_keys ≠ ∅) ∨ wash_dominated ∨ operator_blacklist
//   WARN  if 確かめられた L0 の 1 回 fail（掲載中・120h 以内・直前 pass）∨ L1 の証拠なし／古い（オプトイン無し）∨ 結論なし（l1_inconclusive）
//            ∨ 未配達（conclusive ≥ 1）∨ paid_undelivered_since_delivery = 1 ∨ 最新の数えた試行が失敗
//            ∨ settlement_unknown_since_delivery ≥ 1（空の 2xx・決済が未確定）
//            ∨ (l2 = mismatch ∧ missing_keys = ∅) ∨ drifting ∨ thin ∨ 呼び手方言と不一致
//   ALLOW if l0 = pass ∧ (n_delivered ≥ 1 ∨ L1 なし ALLOW をオプトイン) ∧ l2 ≠ mismatch ∧ ¬BLOCK ∧ ¬WARN
//
//   L1 の主語は 5 つで排他（2026-09-29.2 で l1_stale を足した）:
//     l1_not_attempted   n_attempts = 0 ∧ 全履歴で署名した試行が無い
//     l1_stale           n_attempts = 0 ∧ 署名した試行は 30 日の窓の外にだけある
//     l1_inconclusive    n_attempts > 0 ∧ conclusive = 0 ∧ n_delivered = 0
//                        （金は動いたが、結論の出た応答が 1 件も無い。我々の測定の穴であって
//                          売り手への反証ではない——中立・WARN）
//     l1_never_delivered conclusive ≥ 1 ∧ n_delivered = 0（2026-09-29.3 から WARN。BLOCK は l1_paid_not_delivered ≥ 2 だけ）
//     l1_delivered       n_delivered ≥ 1
//   添える語（主語に加えて）: l1_paid_not_delivered（最後の配達より後の支払い済み・未配達 ≥ 1）、
//     l1_latest_failed（配達はあるが、数えた最新の試行が失敗）、l1_stale（配達はあるが最新の配達が古い）、
//     l1_empty_2xx_settlement_unknown（最後の配達より後の、決済が未確定の空の 2xx ≥ 1）
//
// 仕様解釈（開示）: §8.3 は「WARN if l2 == undeclared」と「ALLOW if … l2 != mismatch」を
// 同時に書く。宣言の無い店が本番の大多数であり、§9.1 の例は reason_codes に
// l2_undeclared を持ちながら ALLOW を返している。採用: l2_undeclared は reason_code に
// 必ず載せるが、それ単独では ALLOW を妨げない（他の WARN 事由があれば WARN）。
//
// 提供前（売り手 → 買い手・role=payee）:
//   BLOCK if operator_blacklist ∨ sybil 高 ∨ retry_burst 超過 ∨ degraded 入力
//   WARN  if thin history ∨ shared_funder ∨ 新規（first_seen < 7d）
//   ALLOW 上記なし
//
// L3（意見）はここに入らない。入力型に存在しない＝型で保証。
// ============================================================
import type { BuyerFacts, SellerFacts } from "./types";

/** 売り手の不履行として数えない署名済みの試行（seller-facts.ts の l1NotCountedOf と同じ形）。 */
export type L1NotCountedInput = {
  total: number;
  by: {
    vet402_side: number;
    held: number;
    no_charge: number;
    /** 2026-09-29.3: お金が動いていない失敗で、vet402 に落ち度が無いと示せない行（/sellers の not sorted: vet402 unproven 等）。 */
    unproven?: number;
    /** 2026-09-29.3: お金が動いていない失敗で、売り手の側だが 1 日だけの行（/sellers の not sorted: one failure so far）。 */
    unconfirmed?: number;
    /** 2026-09-29.3（独立レビュー 警告 2）: 空の 2xx で、お金が動いたかどうか未確定の行。 */
    settlement_unknown?: number;
  };
};

export type Recommendation = "ALLOW" | "WARN" | "BLOCK";
export type Decision = { recommendation: Recommendation; reason_codes: string[] };

/** 規則の版。判定の意味が変わる変更は必ず上げる（YYYY-MM-DD.n）。 */
export const DECISION_RULES_VERSION = "2026-09-29.3";

/** 2026-09-29.2: 最後の配達より後の「支払い済み・未配達」がこの回数に届いたら BLOCK（1 回は WARN）。 */
export const L1_PAID_UNDELIVERED_BLOCK = 2;
/** 2026-09-29.2: ALLOW に要る最新の配達の新しさ（日）。これより古い配達だけなら WARN・l1_stale。 */
// 2026-09-29: 14 日から 30 日へ。配達済みの売り手の買い直しの間隔は 30 日なので、14 日では
// 届けている売り手ほど仕組みの上で必ず WARN に落ちる（本番で ALLOW 1,958 件中 634 件）。
// 経過日数は l1_basis に必ず出し、読み手が自分の基準で判断できるようにする。
export const L1_FRESH_DAYS = 30;
/**
 * 2026-09-29.2（独立レビュー）: L0 の 1 回の fail を WARN に緩めてよい最新プローブの新しさ（時間）。
 * active のプローブ間隔は p50 18h・p95 119h なので、これを超えたら次のプローブが来ていない＝確かめられていない。
 */
export const L0_SINGLE_FAIL_MAX_AGE_HOURS = 120;
/** 確かめられていない 1 回の fail に添える語（BLOCK のまま）。 */
export const L0_SINGLE_FAIL_UNCONFIRMED = "l0_unverified_single_fail_unconfirmed";
/** L1 の事実を数える窓（seller-facts.ts の SQL と同じ 30 日）。 */
export const L1_WINDOW_DAYS = 30;
export const RETRY_BURST_BLOCK = 0.3;
export const THIN_HISTORY_MAX = 2;
export const NEW_PAYER_DAYS = 7;

export type PayerOptions = {
  callerDialect?: "v1" | "v2";
  /** オペレータが「L1 無しでも ALLOW」を明示オプトインした。 */
  allowWithoutL1?: boolean;
  operatorBlacklist?: boolean;
  dataDepth?: "thin" | "moderate" | "rich";
  /**
   * 2026-09-29: 売り手の不履行として数えない署名済みの試行（seller-facts.ts l1NotCountedOf）。渡さなければ
   * facts.l1.n_inconclusive（判定保留）だけを除く（従来）。
   */
  l1NotCounted?: L1NotCountedInput;
  /**
   * 2026-09-29: facts.l0.status が unverified のとき、その原因（seller-facts.ts l0UnverifiedCauseOf）。
   * 渡されれば reason_codes に `l0_unverified_<cause>` を足す。recommendation には効かない。
   */
  l0UnverifiedCause?: string | null;
  /**
   * 2026-09-29.2: 窓の中の試行の並び（seller-facts.ts l1TimelineOf）。本番の呼び手（decide.ts）は必ず渡す。
   * 渡さなければ facts から保守的に作る（支払い済み・未配達と最新の試行は不明＝0／null、最新の配達時刻は
   * facts.l1.observed_at＝最後に署名した時刻で上から抑える）。
   */
  l1Timeline?: L1Timeline;
  /**
   * 2026-09-29.2（独立レビュー）: l0UnverifiedCause が single_fail のときの材料（seller-facts.ts l0SingleFailContextOf）。
   * 無ければ 1 回の fail は確かめられていないとして BLOCK のまま（fail-closed）。
   */
  l0SingleFailContext?: L0SingleFailContext | null;
  /** 鮮度の基準時刻。省略時は今。 */
  now?: Date;
};

/** L0 の 1 回の fail を WARN に緩めてよいかの材料。 */
export type L0SingleFailContext = {
  /** 出品が掲載中（x402_endpoints.status = active）。 */
  listing_active: boolean;
  /** 最新プローブ（fail）の時刻。 */
  latest_probe_at: string | null;
  /** 最新の 1 つ前のプローブの判定（無ければ null）。pass でなければ連続が切れている／初回の fail。 */
  previous_verdict: string | null;
};

/**
 * L0 の 1 回の fail を WARN に緩めてよいか（2026-09-29.2・独立レビュー）: 原因が single_fail で、掲載中で、
 * 最新プローブが 120h 以内で、直前のプローブが pass。どれか欠ければ false（BLOCK のまま・degraded）。
 */
export function l0SingleFailConfirmed(f: SellerFacts, o: PayerOptions): boolean {
  if (f.l0.status !== "unverified" || o.l0UnverifiedCause !== "single_fail") return false;
  const c = o.l0SingleFailContext;
  if (!c || !c.listing_active || c.previous_verdict !== "pass" || !c.latest_probe_at) return false;
  const t = new Date(c.latest_probe_at).getTime();
  if (!Number.isFinite(t)) return false;
  const ageHours = ((o.now ?? new Date()).getTime() - t) / 3_600_000;
  return ageHours <= L0_SINGLE_FAIL_MAX_AGE_HOURS;
}

/**
 * 2026-09-29.2: 判定の L1 が読む「並び」。facts（公開の形・SDK と対）には載せず、応答の l1_basis に出す。
 *   n_counted                           窓の中の署名した試行のうち、売り手の不履行として数えるもの
 *   n_paid_undelivered                  そのうち支払い済み（settled、または tx の付いた settle_failed）で配達されなかったもの
 *   n_paid_undelivered_since_delivery   そのうち窓の中の最後の配達より後のもの（配達が無ければ全部）
 *   latest_counted                      数えた最新の試行（無ければ null）
 *   last_delivered_at                   最後の配達（全履歴。窓の中にあればその時刻）
 *   last_signed_attempt_at              最後に署名した試行（全履歴。窓で切らない）
 */
export type L1Timeline = {
  n_counted: number;
  n_paid_undelivered: number;
  n_paid_undelivered_since_delivery: number;
  latest_counted: { at: string; delivered: boolean } | null;
  last_delivered_at: string | null;
  last_signed_attempt_at: string | null;
  /**
   * 2026-09-29.3（独立レビュー 警告 2）: 最後の配達より後（配達が無ければ窓の中の全部）の、空の 2xx で決済が
   * 未確定の行（seller-facts.ts isSettlementUnknownRow）。1 以上なら WARN。省略時は l1NotCounted.by.settlement_unknown。
   */
  n_settlement_unknown_since_delivery?: number;
};

/** 応答の l1_basis（role=payer）。判定が L1 について何を読んだかを、そのまま数と時刻で出す。 */
export type L1Basis = {
  window_days: number;
  fresh_days: number;
  n_counted: number;
  /** n_attempts − n_counted。l1_inconclusive はこれが n_attempts に等しい（> 0）とき。 */
  n_not_counted: number;
  n_paid_undelivered: number;
  n_paid_undelivered_since_last_delivery: number;
  latest_counted_delivered: boolean | null;
  last_attempt_at: string | null;
  last_signed_attempt_at: string | null;
  last_delivered_at: string | null;
  days_since_last_attempt: number | null;
  days_since_last_delivery: number | null;
};

/** l0_unverified の下位コードの接頭辞（例: l0_unverified_tls / l0_unverified_single_fail）。 */
export const L0_UNVERIFIED_CAUSE_PREFIX = "l0_unverified_";

/**
 * 結論の出た試行数。売り手の不履行として数えない試行（notCounted・2026-09-29）を除く。
 * 渡されなければ n_inconclusive（判定保留）だけを除く。保留は必ず除く（max）。
 */
export function conclusiveAttempts(f: SellerFacts, notCounted?: L1NotCountedInput): number {
  const n = Math.max(notCounted?.total ?? 0, f.l1.n_inconclusive);
  return Math.max(0, f.l1.n_attempts - n);
}

/** 除いた理由の reason code（配達 0 のときだけ載せる・件数 > 0 の理由だけ）。 */
export const NOT_COUNTED_REASON_CODES = {
  vet402_side: "l1_not_counted_vet402_side",
  held: "l1_not_counted_held",
  no_charge: "l1_not_counted_no_charge",
  unproven: "l1_not_counted_unproven",
  unconfirmed: "l1_not_counted_unconfirmed",
} as const;

/**
 * 2026-09-29.3（独立レビュー 警告 2）: 空の 2xx で、お金が動いたかどうか未確定（レシートが無い・照合待ち）。
 * 失敗には数えないが WARN（ALLOW に戻さない）。決済が結び付けば l1_paid_not_delivered として数える。
 */
export const L1_EMPTY_2XX_SETTLEMENT_UNKNOWN = "l1_empty_2xx_settlement_unknown";

/** 2026-09-29.3: l2 = mismatch だが、記録に欠けたキーが無い（何が違ったかを示せない）。WARN・BLOCK にしない。 */
export const L2_MISMATCH_UNEXPLAINED = "l2_mismatch_unexplained";

/** l2 = mismatch で、欠けたキーを記録している（BLOCK の根拠になる不一致）。 */
export function l2MismatchExplained(f: SellerFacts): boolean {
  return f.l2.status === "mismatch" && Array.isArray(f.l2.missing_keys) && f.l2.missing_keys.length > 0;
}

/**
 * facts だけから作る保守的な並び（l1Timeline を渡さない呼び手・旧フィクスチャ用）。
 * 2026-09-29.3: L1 の BLOCK はお金が動いた未配達だけになったので、配達が 0 のときは settled の未配達の下限
 * （n_settled − n_delivered − 数えない試行。数えない試行が全部 settled でも残る数）を支払い済み・未配達に数える。
 * 配達があるときは「最後の配達より後か」が facts から分からないので 0（従来どおり）。
 */
function timelineFromFacts(f: SellerFacts, conclusive: number, notCounted?: L1NotCountedInput): L1Timeline {
  const excluded = Math.max(notCounted?.total ?? 0, f.l1.n_inconclusive);
  const paidLowerBound = Math.min(conclusive, Math.max(0, f.l1.n_settled - f.l1.n_delivered - excluded));
  return {
    n_counted: conclusive,
    n_paid_undelivered: paidLowerBound,
    n_paid_undelivered_since_delivery: f.l1.n_delivered === 0 ? paidLowerBound : 0,
    latest_counted: null,
    // 最後の配達は最後に署名した時刻より新しくはない（上から抑える）。
    last_delivered_at: f.l1.n_delivered >= 1 ? f.l1.observed_at : null,
    last_signed_attempt_at: f.l1.n_attempts >= 1 ? f.l1.observed_at : null,
    // 並びが無いので「最後の配達より後か」は分からない。WARN にしかならない語なので、全部を後として数える（慎重側）。
    n_settlement_unknown_since_delivery: notCounted?.by.settlement_unknown ?? 0,
  };
}

const DAY_MS = 86_400_000;
function daysSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  // ISO8601 も Postgres の ::text（"… +09" を含む）も new Date と同じ解釈で読む（seller-facts.ts の epoch と同じ）。
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round(((now.getTime() - t) / DAY_MS) * 10) / 10);
}

type L1View = {
  conclusive: number;
  timeline: L1Timeline;
  /** 最新の配達からの日数（配達が無ければ null）。 */
  deliveryAge: number | null;
  /** 窓の中に配達があるが、最新の配達が L1_FRESH_DAYS より古い（または時刻が読めない）。 */
  staleDelivery: boolean;
  /** 窓の中に署名した試行が無いが、窓の外にはある。 */
  staleOutsideWindow: boolean;
};

function l1ViewOf(f: SellerFacts, o: PayerOptions): L1View {
  const conclusive = conclusiveAttempts(f, o.l1NotCounted);
  const now = o.now ?? new Date();
  const timeline = o.l1Timeline ?? timelineFromFacts(f, conclusive, o.l1NotCounted);
  const deliveryAge = daysSince(timeline.last_delivered_at, now);
  return {
    conclusive,
    timeline,
    deliveryAge,
    staleDelivery: f.l1.n_delivered >= 1 && (deliveryAge === null || deliveryAge > L1_FRESH_DAYS),
    staleOutsideWindow: f.l1.n_attempts === 0 && timeline.last_signed_attempt_at !== null,
  };
}

/** 応答の l1_basis。decidePayer と同じ l1ViewOf から作る（数と語がずれない）。 */
export function l1BasisOf(f: SellerFacts, o: PayerOptions = {}): L1Basis {
  const v = l1ViewOf(f, o);
  const now = o.now ?? new Date();
  return {
    window_days: L1_WINDOW_DAYS,
    fresh_days: L1_FRESH_DAYS,
    n_counted: v.conclusive,
    n_not_counted: Math.max(0, f.l1.n_attempts - v.conclusive),
    n_paid_undelivered: v.timeline.n_paid_undelivered,
    n_paid_undelivered_since_last_delivery: v.timeline.n_paid_undelivered_since_delivery,
    latest_counted_delivered: v.timeline.latest_counted ? v.timeline.latest_counted.delivered : null,
    last_attempt_at: f.l1.last_attempt_at,
    last_signed_attempt_at: v.timeline.last_signed_attempt_at,
    last_delivered_at: v.timeline.last_delivered_at,
    days_since_last_attempt: daysSince(f.l1.last_attempt_at, now),
    days_since_last_delivery: v.deliveryAge,
  };
}

export function decidePayer(f: SellerFacts, o: PayerOptions = {}): Decision {
  const r: string[] = [];
  const v = l1ViewOf(f, o);
  const { conclusive, timeline: t } = v;
  // L1 の証拠が無い（未試行・窓の外だけ、または結論の出た試行が無い）。オプトインの対象はこの 2 つと、古い配達。
  const noL1Evidence = f.l1.n_delivered === 0 && conclusive === 0;
  // L0: 公開規則（2 回連続の fail で公表）にそろえる。確かめられた 1 回の fail だけ WARN の理由（2026-09-29.2）。
  const l0SingleFail = l0SingleFailConfirmed(f, o);
  r.push(`l0_${f.l0.status}`);
  if (f.l0.status === "unverified" && o.l0UnverifiedCause && /^[a-z0-9_]{1,40}$/.test(o.l0UnverifiedCause)) {
    r.push(`${L0_UNVERIFIED_CAUSE_PREFIX}${o.l0UnverifiedCause}`);
    if (o.l0UnverifiedCause === "single_fail" && !l0SingleFail) r.push(L0_SINGLE_FAIL_UNCONFIRMED);
  }
  if (f.l1.n_attempts === 0) r.push(v.staleOutsideWindow ? "l1_stale" : "l1_not_attempted");
  else if (f.l1.n_delivered >= 1) r.push("l1_delivered");
  else if (conclusive === 0) r.push("l1_inconclusive");
  else r.push("l1_never_delivered");
  if (f.l1.n_delivered === 0 && o.l1NotCounted) {
    for (const k of ["vet402_side", "held", "no_charge", "unproven", "unconfirmed"] as const) {
      if ((o.l1NotCounted.by[k] ?? 0) > 0) r.push(NOT_COUNTED_REASON_CODES[k]);
    }
  }
  const paidUndelivered = t.n_paid_undelivered_since_delivery;
  if (paidUndelivered >= 1) r.push("l1_paid_not_delivered");
  const settlementUnknown = t.n_settlement_unknown_since_delivery ?? o.l1NotCounted?.by.settlement_unknown ?? 0;
  if (settlementUnknown >= 1) r.push(L1_EMPTY_2XX_SETTLEMENT_UNKNOWN);
  const latestFailed = f.l1.n_delivered >= 1 && t.latest_counted !== null && !t.latest_counted.delivered;
  if (latestFailed) r.push("l1_latest_failed");
  if (v.staleDelivery) r.push("l1_stale");
  r.push(`l2_${f.l2.status}`);
  const l2Explained = l2MismatchExplained(f);
  const l2Unexplained = f.l2.status === "mismatch" && !l2Explained;
  if (l2Unexplained) r.push(L2_MISMATCH_UNEXPLAINED);
  if (f.offer_stability === "drifting") r.push("offer_drifting");
  if (f.wash_dominated) r.push("wash_dominated");
  if (o.operatorBlacklist) r.push("operator_blacklist");
  if (o.dataDepth === "thin") r.push("data_thin");
  const dialectMismatch =
    !!o.callerDialect &&
    !!f.l0.dialect &&
    f.l0.dialect !== "both" &&
    f.l0.dialect !== "unpayable" &&
    f.l0.dialect !== o.callerDialect;
  if (dialectMismatch) r.push("dialect_mismatch");
  // 2026-09-29.3（判定のレビュー）: オプトインが免除するのは「L1 の証拠が無い／古い」だけ。免除できない L1 の理由
  // （未確定の空の 2xx・払ったのに届かない・数えた失敗・最新の失敗）が答えを WARN / BLOCK に留めているときは、
  // l1_waived_by_operator を付けない（「免除した」と「L1 で WARN」が同じ応答に並んで食い違って読めた）。
  const l1Unwaivable = settlementUnknown >= 1 || paidUndelivered >= 1 || latestFailed || (conclusive > 0 && f.l1.n_delivered === 0);
  if ((noL1Evidence || v.staleDelivery) && o.allowWithoutL1 && !l1Unwaivable) r.push("l1_waived_by_operator");

  const block =
    f.l0.status === "fail" ||
    (f.l0.status === "unverified" && !l0SingleFail) ||
    // 2026-09-29.3: L1 で BLOCK の根拠はお金が動いた未配達だけ（数えた失敗が何回でも、お金が動いていなければ WARN）。
    paidUndelivered >= L1_PAID_UNDELIVERED_BLOCK ||
    l2Explained ||
    f.wash_dominated ||
    !!o.operatorBlacklist;
  if (block) return { recommendation: "BLOCK", reason_codes: r };

  const warn =
    l0SingleFail ||
    (noL1Evidence && !o.allowWithoutL1) ||
    (conclusive > 0 && f.l1.n_delivered === 0) ||
    paidUndelivered >= 1 ||
    // 2026-09-29.3（独立レビュー 警告 2）: 決済が未確定の空の 2xx。allow_without_l1 でも免除しない。
    settlementUnknown >= 1 ||
    latestFailed ||
    l2Unexplained ||
    (v.staleDelivery && !o.allowWithoutL1) ||
    f.offer_stability === "drifting" ||
    o.dataDepth === "thin" ||
    dialectMismatch;
  if (warn) return { recommendation: "WARN", reason_codes: r };

  const allow = f.l0.status === "pass" && (f.l1.n_delivered >= 1 || !!o.allowWithoutL1) && f.l2.status !== "mismatch";
  return { recommendation: allow ? "ALLOW" : "WARN", reason_codes: r };
}

export type PayeeOptions = { now: Date; operatorBlacklist?: boolean };

export function decidePayee(f: BuyerFacts, o: PayeeOptions): Decision {
  const r: string[] = [];
  const degraded = f.sybil.unavailable.length > 0;
  const sybilHigh = f.sybil.multi_agent_owner && f.sybil.shared_funder;
  const burst = f.retry_burst_rate !== null && f.retry_burst_rate > RETRY_BURST_BLOCK;
  const ageDays = f.first_seen ? (o.now.getTime() - Date.parse(f.first_seen)) / 86_400_000 : null;

  if (o.operatorBlacklist) r.push("operator_blacklist");
  if (sybilHigh) r.push("sybil_high");
  if (burst) r.push("retry_burst");
  if (degraded) r.push(...f.sybil.unavailable.map((u) => `${u}_unavailable`));
  if (o.operatorBlacklist || sybilHigh || burst || degraded) return { recommendation: "BLOCK", reason_codes: r };

  if (f.settled_count_30d <= THIN_HISTORY_MAX) r.push("thin_history");
  if (f.sybil.shared_funder) r.push("shared_funder");
  if (ageDays !== null && ageDays < NEW_PAYER_DAYS) r.push("new_payer");
  if (f.erc8004.agent_id) r.push("erc8004_registered");
  const warn = r.some((c) => c === "thin_history" || c === "shared_funder" || c === "new_payer");
  if (warn) return { recommendation: "WARN", reason_codes: r };
  r.push("history_ok");
  return { recommendation: "ALLOW", reason_codes: r };
}
