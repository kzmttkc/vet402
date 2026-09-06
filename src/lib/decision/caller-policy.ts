// ============================================================
// 呼び手の policy を /decision がサーバ側で当てる（ETHOnline 2026・WINDOW_PLAN §16.3・
// 2026-09-07 Takeshi 採用）。
//
// WHY: §16.3 の実 A/B（20 試行）で、上限超え（F4）の正解 `price_above_ceiling` は
// **どのツールも返さなかった**。SDK の呼び手側 policy の語だったからで、Recipe に
// 書いても出てこない——「ツールに無い語は、Recipe があっても出てこない」。
// これは設計の穴であって、モデルの欠陥ではない。だから製品側で閉じる:
// 呼び手が 402 の金額・自分の上限・L1 配達の床をクエリで名乗れば、判定と同じ文書に
// `caller_policy` を足し、SDK と**1字違わず同じ語**で答える。
//
// 規律（テスト tests/decision-caller-policy.test.ts が固定する）:
//   - 語は `packages/sdk/src/pay-or-refuse.ts` の PayRefuseReason から借りる。**新語を作らない**
//   - 順序も SDK と同じ: 上限超え → degraded → BLOCK → L1 の床。SDK は判定を引く前に上限を
//     当てるので、BLOCK でも上限超えが先に立つ
//   - **BLOCK と degraded は床では外れない**（§3.2.1: WARN は意見、BLOCK は遮断）
//   - WARN は止めない。WARN は vet402 の意見で `recommendation` にそのまま残り、policy は
//     「呼び手が名乗った関門を通ったか」だけを答える。読み手は両方を見る（SDK の既定
//     `requireVet402Allow: true` は SDK 側の関門として残る＝二重防御）
//   - `recommendation` は書き換えない。policy は別欄
//   - subgraph の床はサーバでは扱わない（呼び手の Graph 鍵でしか読めない・§1.5）。
//     見ていないことを `not_evaluated` に**明示**する。黙って ALLOW に倒さない
//   - クエリが 1 つも無ければ何も足さない（応答は従来と完全一致）
// ============================================================
import type { DecisionResult } from "./decide";

/**
 * 1 件あたりの既定上限。SDK の `DEFAULT_MAX_PER_TX_USD`（packages/sdk/src/pay-or-refuse.ts）と
 * 同値でなければならない——呼び手が `max_per_tx_usd` を書かなくても、SDK と同じ床が立つ。
 */
export const DEFAULT_MAX_PER_TX_USD = 1;

/** SDK の PayRefuseReason の部分集合。ここに無い語をサーバは policy として出さない。 */
export type CallerPolicyReason =
  | "price_above_ceiling"
  | "evidence_unavailable"
  | "payee_recommendation_block"
  | "insufficient_delivery_evidence";

export type CallerPolicy = {
  /** 何を当てたか。`amount_usd` は呼び手が名乗らなければ null（上限は当てられない）。 */
  applied: { amount_usd: number | null; max_per_tx_usd: number; min_l1_deliveries: number };
  verdict: "ALLOW" | "REFUSE";
  /** SDK と同じ語。ALLOW のときは空。REFUSE のときは SDK の短絡と同じく最初に落ちた 1 語。 */
  reason_codes: CallerPolicyReason[];
  /**
   * サーバが**見ていない**もの。`min_subgraph_receipts` は常に載る（The Graph は呼び手の鍵で
   * しか読まない）。`amount_usd` が無いときは `max_per_tx_usd` も載る（比べる相手が無い）。
   */
  not_evaluated: ("max_per_tx_usd" | "min_subgraph_receipts")[];
};

export type CallerPolicyInput = {
  amountUsd: number | null;
  maxPerTxUsd: number;
  minL1Deliveries: number;
};

/** 呼び出し側の誤り。語は SDK が throw する語と同じ（invalid_amount_usd / invalid_policy / invalid_evidence_policy）。 */
export type CallerPolicyParseError = "invalid_amount_usd" | "invalid_policy" | "invalid_evidence_policy";

export const CALLER_POLICY_QUERY_KEYS = ["amount_usd", "max_per_tx_usd", "min_l1_deliveries"] as const;

/**
 * クエリを読む。1 つも無ければ `null`（policy を評価しない＝応答は従来どおり）。
 * 数の読み方は SDK と同じ厳しさ: 有限・`amount_usd` は 0 以上・`max_per_tx_usd` は正・
 * `min_l1_deliveries` は 0 以上の整数。空文字は「書いていない」ではなく不正値として扱う
 * （`?amount_usd=` のような取りこぼしを黙って 0 にしない）。
 */
export function parseCallerPolicy(
  params: URLSearchParams,
): { ok: true; input: CallerPolicyInput | null } | { ok: false; error: CallerPolicyParseError } {
  const has = CALLER_POLICY_QUERY_KEYS.some((k) => params.has(k));
  if (!has) return { ok: true, input: null };

  let amountUsd: number | null = null;
  if (params.has("amount_usd")) {
    const n = numberOf(params.get("amount_usd"));
    if (n === null || n < 0) return { ok: false, error: "invalid_amount_usd" };
    amountUsd = n;
  }
  let maxPerTxUsd = DEFAULT_MAX_PER_TX_USD;
  if (params.has("max_per_tx_usd")) {
    const n = numberOf(params.get("max_per_tx_usd"));
    if (n === null || n <= 0) return { ok: false, error: "invalid_policy" };
    maxPerTxUsd = n;
  }
  let minL1Deliveries = 0;
  if (params.has("min_l1_deliveries")) {
    const n = numberOf(params.get("min_l1_deliveries"));
    if (n === null || n < 0 || !Number.isInteger(n)) return { ok: false, error: "invalid_evidence_policy" };
    minL1Deliveries = n;
  }
  return { ok: true, input: { amountUsd, maxPerTxUsd, minL1Deliveries } };
}

function numberOf(raw: string | null): number | null {
  if (raw === null) return null;
  const s = raw.trim();
  if (s === "" || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * 判定に policy を当てる。判定そのものには触らない（呼び手は `result` と並べて読む）。
 * 順序は SDK の `decideAndPay` と同じ。
 */
export function evaluateCallerPolicy(result: DecisionResult, input: CallerPolicyInput): CallerPolicy {
  const applied: CallerPolicy["applied"] = {
    amount_usd: input.amountUsd,
    max_per_tx_usd: input.maxPerTxUsd,
    min_l1_deliveries: input.minL1Deliveries,
  };
  const not_evaluated: CallerPolicy["not_evaluated"] = [];
  if (input.amountUsd === null) not_evaluated.push("max_per_tx_usd");
  not_evaluated.push("min_subgraph_receipts");

  const refuse = (reason: CallerPolicyReason): CallerPolicy => ({ applied, verdict: "REFUSE", reason_codes: [reason], not_evaluated });

  // SDK C9: 呼び手が名乗った上限は判定より先に当てる。
  if (input.amountUsd !== null && input.amountUsd > input.maxPerTxUsd) return refuse("price_above_ceiling");
  // SDK A2 / J7: 測れなかったことは、ALLOW でないことと別。床では埋まらない。
  if (result.degraded === true) return refuse("evidence_unavailable");
  // §3.2.1: BLOCK は遮断。呼び手の床では外れない。
  if (String(result.recommendation).toUpperCase() === "BLOCK") return refuse("payee_recommendation_block");
  // SDK evaluateEvidencePolicy（source vet402）: 配達件数は我々の台帳の数だけで当てる。
  if (input.minL1Deliveries > 0) {
    const l1 = (result.facts as { l1?: { n_delivered?: unknown } } | undefined)?.l1;
    const delivered = typeof l1?.n_delivered === "number" ? l1.n_delivered : 0;
    if (delivered < input.minL1Deliveries) return refuse("insufficient_delivery_evidence");
  }
  return { applied, verdict: "ALLOW", reason_codes: [], not_evaluated };
}
