// ============================================================
// 判定の理由コードの表（2026-09-29.3・監査 6 周目）。
//
// 売り手頁のリンク先 /docs/api#verdicts が旧スコア帯の説明で、理由コードの意味が HTML のどこにも無かった。
// この 1 本を正典にし、/docs/api の表（#reason-codes）と docs/openapi.yaml の DecisionReasonCode（enum と
// x-vet402-patterns）を tests/decision-reason-codes.test.ts が一致で固定する。rules.ts（decidePayer /
// decidePayee）が出しうる語は、同じテストが入力の組み合わせを回して、この表に全部あることを確かめる。
//
// 公開面のコピー（英語）。tests/claims-registry.test.ts の走査範囲に入れてある（断定語を使わない）。
// ============================================================

export type ReasonRole = "payer" | "payee" | "both";
/** その語が単独で出す判定。none は判定を動かさない（説明・内訳）。 */
export type ReasonEffect = "BLOCK" | "WARN" | "WARN_OR_BLOCK" | "none";
/** 売り手が自分で直せるか。n/a は売り手の問題ではない（良い知らせ・呼び手の設定）。 */
export type SellerCanFix = "yes" | "partly" | "no" | "n/a";

export type ReasonCodeDoc = {
  /** 固定の語。`pattern` のときは `<…>` を含む表示用の形。 */
  code: string;
  /** 固定の語ではなく、接頭辞・接尾辞で作られる語（l0_unverified_<cause> 等）。 */
  pattern?: RegExp;
  role: ReasonRole;
  effect: ReasonEffect;
  /** 平易な 1 文。 */
  meaning: string;
  /** 払う側にとっての意味。 */
  forPayer: string;
  sellerCanFix: SellerCanFix;
};

export const REASON_CODES: readonly ReasonCodeDoc[] = [
  // ---------------- L0: does the URL answer with a valid 402? ----------------
  {
    code: "l0_pass",
    role: "payer",
    effect: "none",
    meaning: "vet402's latest probe got a valid 402 payment request from this URL.",
    forPayer: "The URL is up and asks for payment as listed.",
    sellerCanFix: "n/a",
  },
  {
    code: "l0_fail",
    role: "payer",
    effect: "BLOCK",
    meaning: "Two probes in a row got no valid 402 payment request.",
    forPayer: "Do not pay: the URL is not answering as an x402 seller right now.",
    sellerCanFix: "yes",
  },
  {
    code: "l0_unverified",
    role: "payer",
    effect: "WARN_OR_BLOCK",
    meaning: "vet402 could not measure the 402 recently; the l0_unverified_<cause> code next to it says why.",
    forPayer: "BLOCK and degraded, except the confirmed one-off failure (l0_unverified_single_fail), which is a WARN.",
    sellerCanFix: "partly",
  },
  {
    code: "l0_unverified_single_fail",
    role: "payer",
    effect: "WARN",
    meaning: "One probe failed right after a pass; the published rule needs two failures in a row.",
    forPayer: "Probably temporary. Retry later, or pay under your own ceiling.",
    sellerCanFix: "yes",
  },
  {
    code: "l0_unverified_single_fail_unconfirmed",
    role: "payer",
    effect: "BLOCK",
    meaning: "One probe failed and vet402 cannot confirm it was a one-off (listing delisted, failed probe older than 120 hours, or the probe before it did not pass).",
    forPayer: "Do not pay yet; the answer is degraded.",
    sellerCanFix: "yes",
  },
  {
    code: "l0_unverified_<cause>",
    pattern: /^l0_unverified_[a-z0-9_]{1,40}$/,
    role: "payer",
    effect: "BLOCK",
    meaning: "Why the probe could not be measured, for example l0_unverified_tls, l0_unverified_not_probed or l0_unverified_request_shape.",
    forPayer: "Not measured, so BLOCK and degraded. A measurement gap, not a finding against the seller.",
    sellerCanFix: "partly",
  },
  // ---------------- L1: did a paid request deliver? ----------------
  {
    code: "l1_delivered",
    role: "payer",
    effect: "none",
    meaning: "vet402 paid and got a non-empty 2xx at least once in the 30-day window.",
    forPayer: "Delivery evidence exists. ALLOW needs it to be at most 30 days old.",
    sellerCanFix: "n/a",
  },
  {
    code: "l1_not_attempted",
    role: "payer",
    effect: "WARN",
    meaning: "vet402 has not signed a paid attempt against this URL.",
    forPayer: "No purchase evidence. Pay under your own policy, or pass allow_without_l1=true.",
    sellerCanFix: "no",
  },
  {
    code: "l1_stale",
    role: "payer",
    effect: "WARN",
    meaning: "vet402's purchase evidence is older than 30 days.",
    forPayer: "Evidence is old; treat as unmeasured until the next re-buy.",
    sellerCanFix: "no",
  },
  {
    code: "l1_inconclusive",
    role: "payer",
    effect: "WARN",
    meaning: "vet402 signed paid attempts in the window, but none counts for or against the seller.",
    forPayer: "A gap in vet402's measurement, not evidence against the seller. The l1_not_counted_* codes say why.",
    sellerCanFix: "no",
  },
  {
    code: "l1_never_delivered",
    role: "payer",
    effect: "WARN",
    meaning: "Counted failures in the window and no delivery.",
    forPayer: "Nothing reached vet402. It is a BLOCK when l1_paid_not_delivered is also there twice (money moved).",
    sellerCanFix: "yes",
  },
  {
    code: "l1_paid_not_delivered",
    role: "payer",
    effect: "WARN_OR_BLOCK",
    meaning: "A payment settled on-chain and no non-empty 2xx came back, after the last delivery in the window.",
    forPayer: "You can lose the payment. Once is a WARN; twice or more is a BLOCK.",
    sellerCanFix: "yes",
  },
  {
    code: "l1_latest_failed",
    role: "payer",
    effect: "WARN",
    meaning: "Something was delivered in the window, but the latest counted attempt failed.",
    forPayer: "It worked before and failed last time; retry later or pay under your own ceiling.",
    sellerCanFix: "yes",
  },
  {
    code: "l1_empty_2xx_settlement_unknown",
    role: "payer",
    effect: "WARN",
    meaning:
      "After the last delivery in the window, a paid attempt got a 2xx with an empty body and vet402 has not yet linked a settlement to it (no receipt, or a transfer awaiting on-chain verification), so it is not known whether money moved.",
    forPayer: "Not counted as a failure yet, and not an ALLOW until it is settled. If a settlement is linked, the attempt counts as l1_paid_not_delivered.",
    sellerCanFix: "yes",
  },
  {
    code: "l1_not_counted_vet402_side",
    role: "payer",
    effect: "none",
    meaning: "Attempts left out because the record shows vet402's side of the fault (its wallet short of funds, or the declared input not sent).",
    forPayer: "These attempts say nothing about the seller.",
    sellerCanFix: "no",
  },
  {
    code: "l1_not_counted_held",
    role: "payer",
    effect: "none",
    meaning: "Attempts left out while held: a 4xx vet402 attributes to its own request shape, or a receipt awaiting on-chain verification.",
    forPayer: "Not counted until the hold is resolved.",
    sellerCanFix: "no",
  },
  {
    code: "l1_not_counted_no_charge",
    role: "payer",
    effect: "none",
    meaning: "Attempts left out because the seller answered without taking a payment.",
    forPayer: "No money moved; not a failed purchase.",
    sellerCanFix: "no",
  },
  {
    code: "l1_not_counted_unproven",
    role: "payer",
    effect: "none",
    meaning: "Attempts left out because no money moved and vet402 cannot show the failure was not its own (shown as not sorted on /sellers).",
    forPayer: "No money moved and the cause is unclear, so these attempts do not count against the seller.",
    sellerCanFix: "no",
  },
  {
    code: "l1_not_counted_unconfirmed",
    role: "payer",
    effect: "none",
    meaning: "Attempts left out because no money moved and the seller-side failure was seen on one UTC day so far; the seller's side needs two different days.",
    forPayer: "Not counted until the same failure shows up on a second day.",
    sellerCanFix: "partly",
  },
  {
    code: "l1_waived_by_operator",
    role: "payer",
    effect: "none",
    meaning: "You passed allow_without_l1=true, so missing or old L1 evidence does not hold back an ALLOW.",
    forPayer: "Your own opt-in; failures are not waived.",
    sellerCanFix: "n/a",
  },
  // ---------------- L2: does the body match the listing? ----------------
  {
    code: "l2_conform",
    role: "payer",
    effect: "none",
    meaning: "The latest delivered body has the keys the listing's output schema requires.",
    forPayer: "The shape matches what the listing declares.",
    sellerCanFix: "n/a",
  },
  {
    code: "l2_undeclared",
    role: "payer",
    effect: "none",
    meaning: "The listing declares no output schema, or no delivered body was checked against it.",
    forPayer: "Nothing to compare; this alone does not stop an ALLOW.",
    sellerCanFix: "partly",
  },
  {
    code: "l2_mismatch",
    role: "payer",
    effect: "WARN_OR_BLOCK",
    meaning: "The latest delivered body did not match the listing's output schema.",
    forPayer: "A BLOCK when the evidence names the missing keys (mismatch_kind missing_keys); otherwise l2_mismatch_unexplained and a WARN.",
    sellerCanFix: "yes",
  },
  {
    code: "l2_mismatch_unexplained",
    role: "payer",
    effect: "WARN",
    meaning: "A mismatch with no missing key on record. vet402 reads the first 16,000 bytes of a paid body, so a longer JSON body cannot be parsed and shows up here.",
    forPayer: "Not a BLOCK: vet402 cannot say what differed. Check the body yourself.",
    sellerCanFix: "partly",
  },
  // ---------------- other seller signals ----------------
  {
    code: "offer_drifting",
    role: "payer",
    effect: "WARN",
    meaning: "The price, asset or payTo changed three or more times within 24 hours.",
    forPayer: "Compare the 402 you get with verified_terms before paying.",
    sellerCanFix: "yes",
  },
  {
    code: "wash_dominated",
    role: "payer",
    effect: "BLOCK",
    meaning: "Most settlements to this seller are self-dealing or circular: real payments are 10% or less of at least 10 raw ones.",
    forPayer: "The payment volume does not reflect real buyers.",
    sellerCanFix: "partly",
  },
  {
    code: "dialect_mismatch",
    role: "payer",
    effect: "WARN",
    meaning: "The 402 speaks a different x402 version than the caller_dialect you sent.",
    forPayer: "Your client may not be able to pay this 402 as it is.",
    sellerCanFix: "partly",
  },
  {
    code: "data_thin",
    role: "payer",
    effect: "WARN",
    meaning: "Little data behind the answer. Reserved: the public route does not set it today.",
    forPayer: "Treat as a WARN.",
    sellerCanFix: "no",
  },
  // ---------------- both roles ----------------
  {
    code: "operator_blacklist",
    role: "both",
    effect: "BLOCK",
    meaning: "The counterparty is on your own block list (keyed calls).",
    forPayer: "Your own rule; vet402 applies it and keeps it out of facts.",
    sellerCanFix: "no",
  },
  // ---------------- role=payee: should the seller serve this payer? ----------------
  {
    code: "sybil_high",
    role: "payee",
    effect: "BLOCK",
    meaning: "The payer shares an owner with several agents and a funder with other payers.",
    forPayer: "For the seller: likely one operator behind many identities.",
    sellerCanFix: "n/a",
  },
  {
    code: "retry_burst",
    role: "payee",
    effect: "BLOCK",
    meaning: "More than 30% of the payer's recent payments are retry bursts.",
    forPayer: "For the seller: an unusual retry pattern.",
    sellerCanFix: "n/a",
  },
  {
    code: "<input>_unavailable",
    pattern: /^(settlements|funder_index|erc8004)_unavailable$/,
    role: "payee",
    effect: "BLOCK",
    meaning: "An input could not be read (settlements_unavailable, funder_index_unavailable or erc8004_unavailable).",
    forPayer: "For the seller: degraded, so fail-closed. Retry later.",
    sellerCanFix: "n/a",
  },
  {
    code: "thin_history",
    role: "payee",
    effect: "WARN",
    meaning: "The payer has two or fewer settled payments in 30 days.",
    forPayer: "For the seller: little history to go on.",
    sellerCanFix: "n/a",
  },
  {
    code: "shared_funder",
    role: "payee",
    effect: "WARN",
    meaning: "The payer's wallet was funded by the same address as other payers.",
    forPayer: "For the seller: possibly related identities.",
    sellerCanFix: "n/a",
  },
  {
    code: "new_payer",
    role: "payee",
    effect: "WARN",
    meaning: "vet402 first saw this payer less than 7 days ago.",
    forPayer: "For the seller: a new counterparty.",
    sellerCanFix: "n/a",
  },
  {
    code: "erc8004_registered",
    role: "payee",
    effect: "none",
    meaning: "The payer is registered as an ERC-8004 agent.",
    forPayer: "For the seller: an on-chain identity exists.",
    sellerCanFix: "n/a",
  },
  {
    code: "history_ok",
    role: "payee",
    effect: "none",
    meaning: "None of the payee checks above fired.",
    forPayer: "For the seller: ALLOW.",
    sellerCanFix: "n/a",
  },
];

/** 固定の語（openapi の DecisionReasonCode.enum と同じ集合）。 */
export const FIXED_REASON_CODES: readonly string[] = REASON_CODES.filter((r) => !r.pattern).map((r) => r.code);

/** 語が表のどれかに当たるか（固定の語か、パターンの語）。 */
export function reasonCodeDocOf(code: string): ReasonCodeDoc | null {
  return REASON_CODES.find((r) => (r.pattern ? r.pattern.test(code) : r.code === code)) ?? null;
}

export const EFFECT_LABEL: Record<ReasonEffect, string> = {
  BLOCK: "BLOCK",
  WARN: "WARN",
  WARN_OR_BLOCK: "WARN or BLOCK",
  none: "—",
};
