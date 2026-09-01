// ============================================================
// §8.3 判定。recommendation は事実から関数で出す。関数は版管理する。
//
// 支払前（買い手 → 売り手・role=payer）:
//   BLOCK if l0 ∈ {fail, unverified} ∨ (n_attempts ≥ 3 ∧ n_delivered = 0) ∨ l2 = mismatch
//            ∨ wash_dominated ∨ operator_blacklist
//   WARN  if L1 未実施（オプトイン無し）∨ drifting ∨ thin ∨ 呼び手方言と不一致
//   ALLOW if l0 = pass ∧ (n_delivered ≥ 1 ∨ L1 なし ALLOW をオプトイン) ∧ l2 ≠ mismatch ∧ ¬BLOCK
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

export type Recommendation = "ALLOW" | "WARN" | "BLOCK";
export type Decision = { recommendation: Recommendation; reason_codes: string[] };

/** 規則の版。判定の意味が変わる変更は必ず上げる（YYYY-MM-DD.n）。 */
export const DECISION_RULES_VERSION = "2026-09-02.1";

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
};

export function decidePayer(f: SellerFacts, o: PayerOptions = {}): Decision {
  const r: string[] = [];
  r.push(`l0_${f.l0.status}`);
  if (f.l1.n_attempts === 0) r.push("l1_not_attempted");
  else if (f.l1.n_delivered >= 1) r.push("l1_delivered");
  else r.push("l1_never_delivered");
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
  if (f.l1.n_attempts === 0 && o.allowWithoutL1) r.push("l1_waived_by_operator");

  const block =
    f.l0.status !== "pass" ||
    (f.l1.n_attempts >= L1_NEVER_DELIVERED_MIN_ATTEMPTS && f.l1.n_delivered === 0) ||
    f.l2.status === "mismatch" ||
    f.wash_dominated ||
    !!o.operatorBlacklist;
  if (block) return { recommendation: "BLOCK", reason_codes: r };

  const warn =
    (f.l1.n_attempts === 0 && !o.allowWithoutL1) ||
    (f.l1.n_attempts > 0 && f.l1.n_delivered === 0) ||
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
