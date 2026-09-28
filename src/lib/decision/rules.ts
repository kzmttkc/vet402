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
//   BLOCK if l0 ∈ {fail, unverified} ∨ (conclusive ≥ 3 ∧ n_delivered = 0) ∨ l2 = mismatch
//            ∨ wash_dominated ∨ operator_blacklist
//   WARN  if L1 未実施（オプトイン無し）∨ 結論なし（l1_inconclusive）∨ 未配達（conclusive ≥ 1）
//            ∨ drifting ∨ thin ∨ 呼び手方言と不一致
//   ALLOW if l0 = pass ∧ (n_delivered ≥ 1 ∨ L1 なし ALLOW をオプトイン) ∧ l2 ≠ mismatch ∧ ¬BLOCK
//
//   L1 の語は 4 つで排他:
//     l1_not_attempted   n_attempts = 0（署名した試行が無い）
//     l1_inconclusive    n_attempts > 0 ∧ conclusive = 0 ∧ n_delivered = 0
//                        （金は動いたが、結論の出た応答が 1 件も無い。我々の測定の穴であって
//                          売り手への反証ではない——中立・WARN）
//     l1_never_delivered conclusive ≥ 1 ∧ n_delivered = 0
//     l1_delivered       n_delivered ≥ 1
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
export const DECISION_RULES_VERSION = "2026-09-29.1";

export const L1_NEVER_DELIVERED_MIN_ATTEMPTS = 3;
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

export function decidePayer(f: SellerFacts, o: PayerOptions = {}): Decision {
  const r: string[] = [];
  const conclusive = conclusiveAttempts(f, o.l1NotCounted);
  // L1 の証拠が無い（未試行、または結論の出た試行が無い）。オプトインの対象はこの 2 つ。
  const noL1Evidence = f.l1.n_delivered === 0 && conclusive === 0;
  r.push(`l0_${f.l0.status}`);
  if (f.l0.status === "unverified" && o.l0UnverifiedCause && /^[a-z0-9_]{1,40}$/.test(o.l0UnverifiedCause)) {
    r.push(`${L0_UNVERIFIED_CAUSE_PREFIX}${o.l0UnverifiedCause}`);
  }
  if (f.l1.n_attempts === 0) r.push("l1_not_attempted");
  else if (f.l1.n_delivered >= 1) r.push("l1_delivered");
  else if (conclusive === 0) r.push("l1_inconclusive");
  else r.push("l1_never_delivered");
  if (f.l1.n_delivered === 0 && o.l1NotCounted) {
    for (const k of ["vet402_side", "held", "no_charge"] as const) {
      if (o.l1NotCounted.by[k] > 0) r.push(NOT_COUNTED_REASON_CODES[k]);
    }
  }
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
  if (noL1Evidence && o.allowWithoutL1) r.push("l1_waived_by_operator");

  const block =
    f.l0.status !== "pass" ||
    (conclusive >= L1_NEVER_DELIVERED_MIN_ATTEMPTS && f.l1.n_delivered === 0) ||
    f.l2.status === "mismatch" ||
    f.wash_dominated ||
    !!o.operatorBlacklist;
  if (block) return { recommendation: "BLOCK", reason_codes: r };

  const warn =
    (noL1Evidence && !o.allowWithoutL1) ||
    (conclusive > 0 && f.l1.n_delivered === 0) ||
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
