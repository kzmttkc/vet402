/**
 * Pure verdict logic — the two functions that decide whether an x402 payment
 * is allowed to settle.
 *
 * WHY THIS FILE EXISTS (2026-08-05). These two functions used to live in
 * sybil.ts and engine.ts, both of which import the database, the RPC client
 * and the cache at module load. That made the most safety-critical logic in
 * the product the hardest thing in it to test: you could not call
 * assessSybilRisk without a DATABASE_URL. The functions are pure, so they now
 * live somewhere that imports nothing.
 *
 * THE INVARIANT THEY ENFORCE. Every external read that fails is converted by
 * the engine into a `*_unavailable` flag; assessSybilRisk maps any of those to
 * risk = "high"; resolveRecommendation turns "high" into an unconditional
 * BLOCK. That chain is the whole fail-closed design — "we could not check"
 * must never be reported as "we checked and it was fine". It is also the
 * chain most likely to break silently, because breaking it produces a
 * plausible-looking ALLOW rather than an error.
 */
import { SCORE_THRESHOLDS } from "@/lib/chain/config";
import type { Recommendation } from "./types";

export type SybilRisk = "low" | "medium" | "high";
export type ManualList = "none" | "whitelist" | "blacklist";

export function toRecommendation(score: number, isBlacklisted: boolean): Recommendation {
  if (isBlacklisted || score < SCORE_THRESHOLDS.warn) return "BLOCK";
  if (score < SCORE_THRESHOLDS.allow) return "WARN";
  return "ALLOW";
}

/**
 * Was this verdict computed with at least one input we could not read?
 *
 * The single definition of "degraded", used both to decide risk (below) and to
 * decide how long a verdict may be cached. Those two had drifted apart:
 * the engine refuses to cache a degraded score, while /api/demo/score froze
 * one for 5 minutes and told the CDN it could serve it for 15 — so a
 * momentary upstream failure became a quarter-hour of BLOCK on the showcase,
 * long after the underlying reads had recovered. A verdict we are not
 * confident enough to cache is a verdict nobody downstream should pin either.
 */
export function hasUnavailableInput(flags: readonly string[]): boolean {
  return flags.some((flag) => flag.endsWith("_unavailable"));
}

/**
 * 無条件 BLOCK の票数に数えないフラグ（2026-08-23 監査）。
 *
 * 「主体が何か悪いことをした」ではなく、「我々の計測が遅れている」または
 * 「正当だが目立つ構成である」ことを表すもの。開示は続けるし、スコアの割引も
 * そのまま効く——票数だけから外す。
 *
 * denylist にしているのは意図的。新しいフラグは既定で**数える**ので、
 * 追加時に忘れても fail-open しない。
 */
const SOFT_FLAGS = new Set(["owner_index_stale", "multi_agent_owner"]);

/** 主体についての所見だけを数える。 */
export function countHardFlags(flags: readonly string[]): number {
  return flags.filter((f) => !SOFT_FLAGS.has(f)).length;
}

export function assessSybilRisk(flags: string[]): SybilRisk {
  if (flags.includes("wallet_mismatch")) return "high";
  if (flags.includes("wallet_verification_failed")) return "high";
  // Any read we could not complete is high risk, by the invariant above.
  // Enumerating them one by one meant every NEW `*_unavailable` flag had to
  // remember to be added here, and a forgotten one fails OPEN — it would slip
  // through as a single flag ("medium") and could still clear an ALLOW gate.
  // Matching the whole class closes that hole for present and future flags.
  // The named checks below stay for readability and as executable documentation.
  if (hasUnavailableInput(flags)) return "high";
  if (flags.includes("owner_count_unavailable")) return "high";
  if (flags.includes("feedback_stats_unavailable")) return "high";
  if (flags.includes("reputation_summary_unavailable")) return "high";
  if (flags.includes("wallet_metrics_unavailable")) return "high";
  if (flags.includes("no_bound_wallet") && flags.includes("review_velocity_anomaly")) {
    return "high";
  }
  // 2026-08-23 監査: ここは「フラグが3本立ったら無条件 BLOCK」だが、
  // 数えていた中に**主体の行いではないもの**が混ざっていた。
  //   owner_index_stale  — 我々の索引が遅れているだけ。相手に非はない
  //                        （chain/config.ts は「hard-block ではない控えめな
  //                        −5 の割引」と定義している）
  //   multi_agent_owner  — 3体以上を運用する正当な運営者。単独では通常の構成で、
  //                        sybil を示すのは funding_cluster との同時成立
  //                        （その組み合わせは下で明示的に high にしている）
  // この2つが票に入ると、
  //   索引が少し遅れている + 複数エージェント + 新しい運用ウォレット = 3
  // という**何も悪いことをしていない運営者**が、スコアがいくつであろうと
  // 無条件 BLOCK になった。「測れなかった／柔らかい不確実性」を
  // 「高リスク確定」に変換するのは、この製品が直してきた欠陥と同じ形。
  //
  // 除外は allowlist ではなく denylist にしてある。将来フラグが増えたとき、
  // 数え漏れ（fail-open）ではなく数えすぎ（fail-closed）へ倒れる方が安全。
  if (countHardFlags(flags) >= 3) return "high";
  if (flags.includes("funding_cluster") && flags.includes("multi_agent_owner")) {
    return "high";
  }
  if (flags.length >= 1) return "medium";
  return "low";
}

export function resolveRecommendation(
  trustScore: number,
  effectiveList: ManualList,
  sybilRisk: SybilRisk,
  override?: Recommendation,
): Recommendation {
  if (override) return override;

  // Incomplete or high-risk sybil checks must not clear x402 ALLOW gates.
  if (sybilRisk === "high") {
    return "BLOCK";
  }

  const recommendation = toRecommendation(trustScore, false);
  if (effectiveList === "whitelist" && recommendation === "WARN" && sybilRisk === "low") {
    return "ALLOW";
  }

  return recommendation;
}

// ---- N-18 (2026-08-05): machine-readable reason codes ----------------------
// Integrators logging ALLOW/BLOCK decisions for compliance need WHY in a
// stable, parseable form — not prose. Codes are derived from the same
// signals the verdict used, so they cannot disagree with it.
export interface ReasonSignalView {
  identity: { registered: boolean; hasMetadataUri: boolean };
  reputation: { feedbackCount: number };
  wallet: { ageDays: number; isBurner: boolean };
  x402: { paymentCount: number };
  sybil: { risk: SybilRisk; flags: string[] };
  manual: { list: ManualList };
}

export function reasonCodes(
  signals: ReasonSignalView,
  trustScore: number,
  recommendation: Recommendation,
): string[] {
  const codes: string[] = [];
  if (signals.manual.list === "blacklist") codes.push("manual:blacklisted");
  if (signals.manual.list === "whitelist") codes.push("manual:whitelisted");
  if (signals.sybil.risk === "high") codes.push("sybil:high_risk_block");
  for (const flag of signals.sybil.flags) codes.push(`sybil:${flag}`);
  if (!signals.identity.registered) codes.push("identity:not_registered");
  else if (!signals.identity.hasMetadataUri) codes.push("identity:no_metadata");
  if (signals.reputation.feedbackCount === 0) codes.push("reputation:no_feedback");
  if (signals.wallet.isBurner) codes.push("wallet:burner");
  if (signals.x402.paymentCount === 0) codes.push("x402:no_settlement_history");
  if (recommendation === "ALLOW") codes.push(`score:above_allow_threshold:${trustScore}`);
  else if (recommendation === "WARN") codes.push(`score:between_thresholds:${trustScore}`);
  else codes.push(`score:${trustScore}`);
  return codes;
}
