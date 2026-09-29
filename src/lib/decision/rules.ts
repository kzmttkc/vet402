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
//     (5) 鮮度: ALLOW は最新の配達が L1_FRESH_DAYS 日以内のときだけ。古ければ WARN・l1_stale。
//         allow_without_l1 のオプトインは「L1 の証拠が無い／古い」だけを免除する（失敗は免除しない）。
//     (6) l1_inconclusive の数は応答の l1_basis.n_not_counted（= n_attempts − 数えた試行）。
//         facts.l1.n_inconclusive は /purchases と同じ「判定保留」の部分集合のまま（facts の意味は変えない）。
//   BLOCK if l0 = fail ∨ (l0 = unverified ∧ 原因 ≠ single_fail) ∨ paid_undelivered_since_delivery ≥ 2
//            ∨ (conclusive ≥ 3 ∧ n_delivered = 0) ∨ l2 = mismatch ∨ wash_dominated ∨ operator_blacklist
//   WARN  if l0 の 1 回 fail ∨ L1 の証拠なし／古い（オプトイン無し）∨ 結論なし（l1_inconclusive）
//            ∨ 未配達（conclusive ≥ 1）∨ paid_undelivered_since_delivery = 1 ∨ 最新の数えた試行が失敗
//            ∨ drifting ∨ thin ∨ 呼び手方言と不一致
//   ALLOW if l0 = pass ∧ (n_delivered ≥ 1 ∨ L1 なし ALLOW をオプトイン) ∧ l2 ≠ mismatch ∧ ¬BLOCK ∧ ¬WARN
//
//   L1 の主語は 5 つで排他（2026-09-29.2 で l1_stale を足した）:
//     l1_not_attempted   n_attempts = 0 ∧ 全履歴で署名した試行が無い
//     l1_stale           n_attempts = 0 ∧ 署名した試行は 30 日の窓の外にだけある
//     l1_inconclusive    n_attempts > 0 ∧ conclusive = 0 ∧ n_delivered = 0
//                        （金は動いたが、結論の出た応答が 1 件も無い。我々の測定の穴であって
//                          売り手への反証ではない——中立・WARN）
//     l1_never_delivered conclusive ≥ 1 ∧ n_delivered = 0
//     l1_delivered       n_delivered ≥ 1
//   添える語（主語に加えて）: l1_paid_not_delivered（最後の配達より後の支払い済み・未配達 ≥ 1）、
//     l1_latest_failed（配達はあるが、数えた最新の試行が失敗）、l1_stale（配達はあるが最新の配達が古い）
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
export type L1NotCountedInput = { total: number; by: { vet402_side: number; held: number; no_charge: number } };

export type Recommendation = "ALLOW" | "WARN" | "BLOCK";
export type Decision = { recommendation: Recommendation; reason_codes: string[] };

/** 規則の版。判定の意味が変わる変更は必ず上げる（YYYY-MM-DD.n）。 */
export const DECISION_RULES_VERSION = "2026-09-29.2";

export const L1_NEVER_DELIVERED_MIN_ATTEMPTS = 3;
/** 2026-09-29.2: 最後の配達より後の「支払い済み・未配達」がこの回数に届いたら BLOCK（1 回は WARN）。 */
export const L1_PAID_UNDELIVERED_BLOCK = 2;
/** 2026-09-29.2: ALLOW に要る最新の配達の新しさ（日）。これより古い配達だけなら WARN・l1_stale。 */
export const L1_FRESH_DAYS = 14;
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
  /** 鮮度の基準時刻。省略時は今。 */
  now?: Date;
};

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
} as const;

/** facts だけから作る保守的な並び（l1Timeline を渡さない呼び手・旧フィクスチャ用）。 */
function timelineFromFacts(f: SellerFacts, conclusive: number): L1Timeline {
  return {
    n_counted: conclusive,
    n_paid_undelivered: 0,
    n_paid_undelivered_since_delivery: 0,
    latest_counted: null,
    // 最後の配達は最後に署名した時刻より新しくはない（上から抑える）。
    last_delivered_at: f.l1.n_delivered >= 1 ? f.l1.observed_at : null,
    last_signed_attempt_at: f.l1.n_attempts >= 1 ? f.l1.observed_at : null,
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
  const timeline = o.l1Timeline ?? timelineFromFacts(f, conclusive);
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
  // L0: 公開規則（2 回連続の fail で公表）にそろえる。1 回の fail は WARN の理由（2026-09-29.2）。
  const l0SingleFail = f.l0.status === "unverified" && o.l0UnverifiedCause === "single_fail";
  r.push(`l0_${f.l0.status}`);
  if (f.l0.status === "unverified" && o.l0UnverifiedCause && /^[a-z0-9_]{1,40}$/.test(o.l0UnverifiedCause)) {
    r.push(`${L0_UNVERIFIED_CAUSE_PREFIX}${o.l0UnverifiedCause}`);
  }
  if (f.l1.n_attempts === 0) r.push(v.staleOutsideWindow ? "l1_stale" : "l1_not_attempted");
  else if (f.l1.n_delivered >= 1) r.push("l1_delivered");
  else if (conclusive === 0) r.push("l1_inconclusive");
  else r.push("l1_never_delivered");
  if (f.l1.n_delivered === 0 && o.l1NotCounted) {
    for (const k of ["vet402_side", "held", "no_charge"] as const) {
      if (o.l1NotCounted.by[k] > 0) r.push(NOT_COUNTED_REASON_CODES[k]);
    }
  }
  const paidUndelivered = t.n_paid_undelivered_since_delivery;
  if (paidUndelivered >= 1) r.push("l1_paid_not_delivered");
  const latestFailed = f.l1.n_delivered >= 1 && t.latest_counted !== null && !t.latest_counted.delivered;
  if (latestFailed) r.push("l1_latest_failed");
  if (v.staleDelivery) r.push("l1_stale");
  r.push(`l2_${f.l2.status}`);
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
  if ((noL1Evidence || v.staleDelivery) && o.allowWithoutL1) r.push("l1_waived_by_operator");

  const block =
    f.l0.status === "fail" ||
    (f.l0.status === "unverified" && !l0SingleFail) ||
    paidUndelivered >= L1_PAID_UNDELIVERED_BLOCK ||
    (conclusive >= L1_NEVER_DELIVERED_MIN_ATTEMPTS && f.l1.n_delivered === 0) ||
    f.l2.status === "mismatch" ||
    f.wash_dominated ||
    !!o.operatorBlacklist;
  if (block) return { recommendation: "BLOCK", reason_codes: r };

  const warn =
    l0SingleFail ||
    (noL1Evidence && !o.allowWithoutL1) ||
    (conclusive > 0 && f.l1.n_delivered === 0) ||
    paidUndelivered >= 1 ||
    latestFailed ||
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
