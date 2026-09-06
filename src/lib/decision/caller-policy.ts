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
//   - WARN の扱いは `require_vet402_allow`（既定 true）が決める。SDK の `requireVet402Allow` の鏡:
//     true なら ALLOW でない判定は `payee_recommendation_not_allow` で REFUSE、false なら WARN は
//     意見として床で通す（`recommendation` にはそのまま残る）。**false は床（`min_l1_deliveries` ≥1）
//     が無ければ `invalid_policy`**——判定を外すなら代わりを置け（§3.2・SDK の assertOverridePolicy
//     と同じ。0 の床は床として数えない）。2026-09-07 までは既定が「WARN を床で通す」で、生 HTTP の
//     呼び手が `caller_policy` だけを読むと SDK の既定より緩い答えを受け取れた。その穴を閉じる
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

/**
 * サーバが policy として出し得る語の**全部**。SDK の `PAY_REFUSE_REASONS` の部分集合で、
 * 実行時に読める形で置く（型は実行時に無いので、tests/caller-policy-sdk-parity.test.ts が
 * SDK の定数・openapi の enum・語彙表と突合するのに使う）。ここに無い語をサーバは出さない。
 */
export const CALLER_POLICY_REASONS = [
  "price_above_ceiling",
  "evidence_unavailable",
  "payee_recommendation_block",
  "payee_recommendation_not_allow",
  "insufficient_delivery_evidence",
] as const;

/** SDK の PayRefuseReason の部分集合。{@link CALLER_POLICY_REASONS} から導く。 */
export type CallerPolicyReason = (typeof CALLER_POLICY_REASONS)[number];

export type CallerPolicy = {
  /** 何を当てたか。`amount_usd` は呼び手が名乗らなければ null（上限は当てられない）。 */
  applied: { amount_usd: number | null; max_per_tx_usd: number; min_l1_deliveries: number; require_vet402_allow: boolean };
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
  /** SDK の `requireVet402Allow`。既定 true。false は minL1Deliveries ≥1 を要する（parse が保証）。 */
  requireVet402Allow: boolean;
};

/** 呼び出し側の誤り。語は SDK が throw する語と同じ（invalid_amount_usd / invalid_policy / invalid_evidence_policy）。 */
export type CallerPolicyParseError = "invalid_amount_usd" | "invalid_policy" | "invalid_evidence_policy";

export const CALLER_POLICY_QUERY_KEYS = ["amount_usd", "max_per_tx_usd", "min_l1_deliveries", "require_vet402_allow"] as const;

/**
 * クエリを読む。1 つも無ければ `null`（policy を評価しない＝応答は従来どおり）。
 * 数の読み方は SDK と同じ厳しさ: 有限・`amount_usd` は 0 以上・`max_per_tx_usd` は正・
 * `min_l1_deliveries` は 0 以上の整数・`require_vet402_allow` は `true` | `false` の 2 語だけ。
 * 空文字は「書いていない」ではなく不正値として扱う（`?amount_usd=` のような取りこぼしを黙って 0 にしない）。
 * `require_vet402_allow=false` で床が 1 つも無ければ `invalid_policy`（SDK と同じ語・同じ理由）。
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
  let requireVet402Allow = true;
  if (params.has("require_vet402_allow")) {
    const raw = (params.get("require_vet402_allow") ?? "").trim();
    if (raw !== "true" && raw !== "false") return { ok: false, error: "invalid_policy" };
    requireVet402Allow = raw === "true";
  }
  // §3.2: 判定を外すなら代わりを置け。サーバが当てられる床は L1 の配達件数だけなので、それが
  // 1 以上でなければ呼び出し側エラー。subgraph の床はここでは代わりにならない（サーバは読めない）。
  if (!requireVet402Allow && minL1Deliveries < 1) return { ok: false, error: "invalid_policy" };
  return { ok: true, input: { amountUsd, maxPerTxUsd, minL1Deliveries, requireVet402Allow } };
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
    require_vet402_allow: input.requireVet402Allow,
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
  // SDK A1: ALLOW 以外（WARN）は、呼び手が `require_vet402_allow=false` で免除しない限り止める。
  // 免除できるのは parse で床を確かめた呼び手だけ（判定を外すなら代わりを置け・§3.2）。
  if (input.requireVet402Allow && result.recommendation !== "ALLOW") return refuse("payee_recommendation_not_allow");
  // SDK evaluateEvidencePolicy（source vet402）: 配達件数は我々の台帳の数だけで当てる。
  if (input.minL1Deliveries > 0) {
    const l1 = (result.facts as { l1?: { n_delivered?: unknown } } | undefined)?.l1;
    const delivered = typeof l1?.n_delivered === "number" ? l1.n_delivered : 0;
    if (delivered < input.minL1Deliveries) return refuse("insufficient_delivery_evidence");
  }
  return { applied, verdict: "ALLOW", reason_codes: [], not_evaluated };
}
