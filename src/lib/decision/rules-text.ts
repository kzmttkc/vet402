// ============================================================
// 判定の規則の文（英語・公開面の正典・2026-09-29 監査 7 周目）。
//
// /docs/api・llms-full.txt・public/llms.txt・docs/openapi.yaml・MCP の check_resource_decision の説明は、
// 以前は同じ規則を面ごとに手で書き、版が変わるたびに一部だけ古い文が残った（7 周目の監査）。ここを唯一の正典にし、
//   動的な面（/docs/api・llms-full.txt）は import して埋め込む、
//   静的な面（public/llms.txt・docs/openapi.yaml・packages/mcp-server/src/rules-text.generated.ts）は
//   scripts/gen-rules-text.ts が書き出し、tests/rules-text-canon.test.ts が一致しないと落ちる。
// 数と語は rules.ts・fix-modes.ts・l2-check.ts の定数から作る（文に数字を手で書かない）。
// 理由コードごとの意味は reason-codes.ts（/docs/api#reason-codes）が正典で、ここは規則の骨組みだけ。
// ============================================================
import { BUCKET_DOCS, LATE_LINK_PENDING_MINUTES, MONEY_DOC, SELLER_CONFIRM_DAYS } from "@/lib/sellers/fix-modes";
import { L1_PAID_BODY_CAP_BYTES } from "@/lib/observatory/l2-check";
import { DECISION_RULES_VERSION, L1_FRESH_DAYS, L1_PAID_UNDELIVERED_BLOCK, L1_WINDOW_DAYS } from "./rules";

const KIB = Math.round(L1_PAID_BODY_CAP_BYTES / 1024);
const TWO = L1_PAID_UNDELIVERED_BLOCK === 2 ? "two" : String(L1_PAID_UNDELIVERED_BLOCK);

/** 1 回の購入の分類の文（/sellers・export.csv・判定が同じ関数で読む）。 */
export const PURCHASE_CLASSIFICATION_TEXT =
  "Each paid attempt (one L1 purchase row) is sorted by one function, the same one /sellers, /api/v1/sellers/export.csv and this decision read: " +
  `whether money moved, whether it delivered, and whose side a failure is on. ${MONEY_DOC} ` +
  `The outcome is one of: ${Object.values(BUCKET_DOCS).join("; ")}. ` +
  "An attempt counts for or against the seller only when it delivered or is on the seller's side; every other signed attempt is left out with an l1_not_counted_* code " +
  "(l1_not_counted_held counts both kinds together: held, a row with a held_reason in the ledger export, and a receipt awaiting on-chain verification that brought a result, whose held_reason is empty).";

/** 判定の規則の文（版・BLOCK・WARN・ALLOW の骨組み）。 */
export const DECISION_RULES_TEXT =
  `Rules ${DECISION_RULES_VERSION} (rules_version). ${PURCHASE_CLASSIFICATION_TEXT} ` +
  `L1: after the last delivery in the ${L1_WINDOW_DAYS}-day window, an attempt that moved money and did not deliver adds l1_paid_not_delivered; ` +
  `it is a BLOCK only when ${TWO} or more of them are on the seller's side (seen on ${SELLER_CONFIRM_DAYS} different UTC days), and a WARN otherwise, including when /sellers leaves them not sorted. ` +
  "A failure where no money moved is at most a WARN (l1_never_delivered when nothing was delivered). " +
  `When no result came back and it is not yet known whether money moved (an empty 2xx with no settlement linked, a receipt still awaiting on-chain verification, or a signed attempt that failed less than ${LATE_LINK_PENDING_MINUTES} minutes ago), ` +
  "l1_empty_2xx_settlement_unknown makes it a WARN, never an ALLOW, until it settles. " +
  "l1_latest_failed (something delivered, but the latest counted attempt did not) is a WARN. " +
  `ALLOW needs a delivery within ${L1_FRESH_DAYS} days (l1_basis.fresh_days); otherwise l1_stale and a WARN, also the word when every signed attempt is older than the window (l1_not_attempted means none was ever signed). ` +
  "l1_basis carries the counts, the last attempt, signed attempt and delivery, and the days since each. " +
  "L0: l0_fail (two measured failures in a row) is a BLOCK. l0_unverified (not probed yet, a URL with a path parameter vet402 cannot fill, a probe that could not complete, or one failure so far) is a WARN with degraded: true, " +
  "next to l0_unverified_<cause>; unverified is not a failure. " +
  `L2: l2_mismatch is a BLOCK when the evidence names missing keys (mismatch_kind missing_keys), otherwise l2_mismatch_unexplained and a WARN. A listing that declares an output schema but whose latest delivery vet402 has not checked against it (no delivery, a body over ${KIB} KiB or cut off) is l2_not_checked, a WARN; l2_undeclared means the listing declares no output schema. ` +
  "Every code, its effect and whether the seller can fix it: https://vet402.com/docs/api#reason-codes.";

/** 判定の 3 語の説明（/docs/api#verdicts の箇条書き）。 */
export const VERDICT_DOCS: Readonly<Record<"BLOCK" | "WARN" | "ALLOW", string>> = {
  BLOCK:
    `The record shows a reason not to pay: the L0 probe failed twice in a row (l0_fail), money moved without delivery ${TWO} or more times on the seller's side (l1_paid_not_delivered), the body lacks declared keys, wash volume, or your own block list.`,
  WARN:
    "Not cleared: evidence is missing, old, unverified, not yet settled or not sorted to a side. A failure where no money moved, or one /sellers leaves not sorted, is a WARN at most. The SDK and the middleware refuse a WARN unless you opt out.",
  ALLOW: `Needs a passing L0 probe, a delivery within ${L1_FRESH_DAYS} days, and no BLOCK or WARN reason. Compare the 402 you get with verified_terms before you pay.`,
};

/** 方法の限界（/docs/api・openapi の説明に同じ文を置く）。 */
export const METHOD_LIMIT_TEXT =
  "Limit of the method: vet402 buys with a fixed, published User-Agent, so a seller could answer vet402 differently from other buyers; other buyers' settlements show that they paid, not that they received, so the decision cannot detect this.";

/** openapi の DecisionResult.reason_codes の説明（scripts/gen-rules-text.ts が書き出す）。 */
export const OPENAPI_REASON_CODES_TEXT =
  "Machine-readable reasons. Every code, with its meaning, what it means for the payer and whether the seller can fix it, is in `DecisionReasonCode` and in the table at /docs/api#reason-codes. " +
  `${DECISION_RULES_TEXT} ${METHOD_LIMIT_TEXT}`;

/** 売り手頁の「How to read this」の判定の文（/sellers）。 */
export const SELLERS_PAGE_DECISION_TEXT =
  "It reads the same sorting as this page: a failure counts against the seller only when this page puts it on the seller's side. " +
  `A paid attempt that took payment and did not deliver is a WARN, and ${TWO} or more of them on the seller's side since the last delivery are the only way a failed purchase makes it a BLOCK; ` +
  "a listing whose failures this page leaves not sorted gets at most a WARN from them. An L0 check that is unverified (not probed yet, or not measurable) is a WARN, not a BLOCK.";
