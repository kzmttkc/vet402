// ============================================================
// 失敗の分類表（/sellers・/sellers/[host]・/sellers/fix-first の正典・2026-09-28）。
//
// 売り手が自分の行を見て「何が起きたか・何を直せばよいか・それは自分の側か vet402 の側か」が
// 分かるように、L1 の購入行を 1 つの失敗の種類（FixMode）へ決定的に振り分ける。材料は台帳に
// 既にある列だけ: status・http_status_paid・tx_hash・attempted_at・network と、delivery.ts の
// heldReasonOf（held_reason 列と同じ規則）、raw_response_meta の requestBody / status / reason、
// そのエンドポイントの宣言（method・declared_schema の本文）。
//
// どの規則にも当たらない行は unsorted（"other"）に落とす。だから種類ごとの件数の合計は、
// 必ず「届かなかった出品」の数と一致する（tests/sellers-fix-modes.test.ts が固定する）。
//
// side は「その失敗は誰の側で起きたか」:
//   vet402   こちらの落ち度・こちらの制限。売り手に直すものは無い。
//            payer_unfunded（購入元の残高切れ）と body_not_sent（宣言本文を送っていなかった期間の
//            400/422）は、retest（l1-runner の RETEST_SELLERS_SQL・2026-09-28）と同じ条件にしてある。
//            ここで vet402 の側と書いた行と、買い直しの対象になる行がずれないため。
//   seller   売り手の応答・出品の宣言で説明がつく。
//   unsorted まだ分類していない。
// effort は直す手間: 1 = 出品・設定の変更、2 = サーバーの変更、3 = facilitator 次第。
//
// 公開面の文言を持つので tests/claims-registry.test.ts の走査対象（publicSurfaces）に入っている。
// ============================================================
import { heldReasonOf, isDelivered, type HeldReason } from "@/lib/observatory/delivery";

export type FixSide = "seller" | "vet402" | "unsorted";
export type FixEffort = 1 | 2 | 3;

export interface FixMode {
  key: string;
  title: string;
  /** What vet402 saw, in plain words. */
  what: string;
  /** One line for the seller (or "nothing to fix" when the side is vet402). */
  fix: string;
  side: FixSide;
  effort: FixEffort;
}

/**
 * 宣言された本文を有料の POST に載せ始めた時刻（本番デプロイの完了）。これより前の POST は、
 * 売り手が本文を宣言していても `{}` を送っていた。l1-runner の DECLARED_BODY_SENT_SINCE
 * （census-fair-0928 で追加）と同じ値。両方が main に入ったら片方を import に置き換える。
 */
export const DECLARED_BODY_SENT_SINCE = "2026-09-16T23:25:55Z";

const NOTHING_FOR_SELLER = "Nothing for the seller to fix.";

/** Order here is the tie-break on /sellers/fix-first after side, sellers and effort. */
export const FIX_MODES: readonly FixMode[] = [
  // ---------- seller: the listing or the 402 ----------
  {
    key: "gone",
    title: "The listed URL is gone",
    what: "The unpaid request got 404 or 410.",
    fix: "Remove the listing from the Bazaar, or serve the endpoint at the listed URL again.",
    side: "seller",
    effort: 1,
  },
  {
    key: "free_200",
    title: "Answered without asking for payment",
    what: "The unpaid request got a 2xx instead of 402.",
    fix: "Answer 402 until the request is paid, or take the URL out of the paid listing.",
    side: "seller",
    effort: 1,
  },
  {
    key: "no_402",
    title: "No 402 to an unpaid request",
    what: "The unpaid request got a status other than 402 (for example 400 or 422), so there was nothing to pay.",
    fix: "Return the 402 challenge before validating the input, so a buyer can see the price first.",
    side: "seller",
    effort: 2,
  },
  {
    key: "no_accept",
    title: "No payment option vet402 can pay on Base",
    what: "The 402 had no exact-scheme accept for USDC on Base mainnet that vet402 could sign.",
    fix: "Offer an exact accept for USDC on Base mainnet (asset 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913).",
    side: "seller",
    effort: 1,
  },
  {
    key: "price_mismatch",
    title: "The 402 asked for a different price than the listing",
    what: "The amount in the 402 did not match the price the listing declares. vet402 pays the declared price, so it did not sign.",
    fix: "Make the listing's price and the 402's amount the same.",
    side: "seller",
    effort: 1,
  },
  {
    key: "payto_mismatch",
    title: "The 402 named a different receiving address",
    what: "The payTo in the 402 was not the address the listing declares. vet402 did not sign.",
    fix: "Make the listing's payTo and the 402's payTo the same address.",
    side: "seller",
    effort: 1,
  },
  {
    key: "input_rejected",
    title: "The paid request was refused as invalid",
    what: "vet402 signed the payment and the paid request got 400, 404, 415 or 422. vet402 sends the body and query the listing declares, and an empty JSON body when it declares none.",
    fix: "Declare the input in the listing (body or query) with example values that work as written.",
    side: "seller",
    effort: 1,
  },
  {
    key: "wrong_method",
    title: "The listed method is not accepted",
    what: "The request got 405 to the method the listing declares.",
    fix: "Declare the method the route accepts (GET or POST), or accept the declared one.",
    side: "seller",
    effort: 1,
  },
  // ---------- seller: the server ----------
  {
    key: "auth",
    title: "Asks for its own login or key",
    what: "The request got 401 or 403 (before or after payment).",
    fix: "Let the x402 payment be enough: answer 402 to an unpaid request and the data to a paid one.",
    side: "seller",
    effort: 2,
  },
  {
    key: "down",
    title: "Server error before payment",
    what: "The unpaid request got a 5xx, so there was nothing to pay.",
    fix: "Bring the server back up, or remove the listing while it is down.",
    side: "seller",
    effort: 2,
  },
  {
    key: "server_error_paid",
    title: "Server error on the paid request",
    what: "vet402 signed the payment and the paid request got a 5xx.",
    fix: "Check the route's logs: the handler or its upstream failed on the paid request.",
    side: "seller",
    effort: 2,
  },
  {
    key: "no_response_paid",
    title: "No answer to the paid request",
    what: "vet402 signed the payment and the paid request got no HTTP answer in time (timeout, 408 or a closed connection).",
    fix: "Make the paid route answer within a few seconds; look for slow upstream calls or cold starts.",
    side: "seller",
    effort: 2,
  },
  {
    key: "rate_limited",
    title: "Rate-limited",
    what: "The request got 429 Too Many Requests.",
    fix: "Let paid requests through the rate limiter.",
    side: "seller",
    effort: 2,
  },
  {
    key: "no_receipt",
    title: "Answered 2xx, but the payment was not confirmed",
    what: "The paid request got a 2xx, but no settlement receipt came back, so the payment could not be confirmed as settled.",
    fix: "Settle the payment and return the PAYMENT-RESPONSE header with the 2xx.",
    side: "seller",
    effort: 2,
  },
  {
    key: "claim_malformed",
    title: "The receipt named a transaction id that is not valid",
    what: "The receipt's transaction id is not a well-formed id for that chain.",
    fix: "Return the settlement transaction hash from your facilitator in PAYMENT-RESPONSE.",
    side: "seller",
    effort: 2,
  },
  // ---------- seller: settlement ----------
  {
    key: "payment_refused",
    title: "A signed payment got 402 again",
    what: "vet402 sent a signed payment and the server answered 402 again.",
    fix: "Check the route's verify and settle step, and return the facilitator's error as errorReason.",
    side: "seller",
    effort: 3,
  },
  {
    key: "claim_refuted",
    title: "The receipt's transaction does not show the payment",
    what: "vet402 re-read the transaction named in the receipt on-chain and did not find the expected USDC transfer to the declared payee.",
    fix: "Check which transaction your facilitator returns; it must be the transfer for this payment.",
    side: "seller",
    effort: 3,
  },
  // ---------- vet402 ----------
  {
    key: "payer_unfunded",
    title: "vet402's wallet was out of USDC",
    what: "Between 2026-09-13 00:00 and 2026-09-15 23:49 UTC, vet402's Base payer wallet had run out of USDC. The seller refused a payment that had nothing behind it (402 or 5xx).",
    fix: NOTHING_FOR_SELLER,
    side: "vet402",
    effort: 1,
  },
  {
    key: "body_not_sent",
    title: "vet402 did not send the declared request body",
    what: "Before 2026-09-16 23:25 UTC, vet402 sent an empty JSON body on paid POST requests, even when the listing declares a body. The seller refused it with 400 or 422.",
    fix: NOTHING_FOR_SELLER,
    side: "vet402",
    effort: 1,
  },
  {
    key: "vet402_limit",
    title: "vet402's own limits",
    what: "vet402 did not pay: the price was over its per-purchase ceiling, its budget for the day was used up, its operator halted spending, or the 402 named vet402's own receiving address.",
    fix: NOTHING_FOR_SELLER,
    side: "vet402",
    effort: 1,
  },
  {
    key: "vet402_error",
    title: "vet402's own run did not finish",
    what: "vet402's request did not complete on its side (its run was cut off, or a step failed inside vet402).",
    fix: NOTHING_FOR_SELLER,
    side: "vet402",
    effort: 1,
  },
  {
    key: "settlement_pending",
    title: "Waiting for vet402's on-chain check",
    what: "The seller returned a receipt. vet402 has not re-read that transaction on-chain yet, so the row is not counted either way.",
    fix: NOTHING_FOR_SELLER,
    side: "vet402",
    effort: 1,
  },
  // ---------- unsorted ----------
  {
    key: "other",
    title: "Not grouped yet",
    what: "A combination of status and HTTP code this page does not group yet.",
    fix: "See the recorded status and HTTP code on the seller page.",
    side: "unsorted",
    effort: 3,
  },
];

const MODE = new Map(FIX_MODES.map((m) => [m.key, m]));

export function fixMode(key: string): FixMode {
  return MODE.get(key) ?? MODE.get("other")!;
}

/** 1 行の購入の事実（台帳の列と、そのエンドポイントの今の宣言）。 */
export interface SellerRowFacts {
  endpointId: string;
  status: string;
  httpStatusPaid: number | null;
  txHash: string | null;
  /** ISO8601 UTC（`2026-09-20T12:00:01Z`）。 */
  attemptedAt: string;
  network: string | null;
  /** エンドポイントの宣言メソッド（x402_endpoints.method）。 */
  method: string | null;
  /** 今のカタログのそのエンドポイントが本文を宣言している（declared_schema の properties.input.properties.body）。 */
  declaresBody: boolean;
  /** raw_response_meta に requestBody の記録がある（2026-09-17 以降の有料の要求）。 */
  bodyRecorded: boolean;
  /** raw_response_meta.status（支払い前の応答の HTTP。no_402 の行で読む）。 */
  unpaidStatus: number | null;
  /** raw_response_meta.selection（census / retest / null）。 */
  selection: string | null;
}

export type Bucket = "delivered" | "seller" | "vet402" | "unsorted";

export interface RowClass {
  bucket: Bucket;
  /** 届いた行は null。 */
  mode: FixMode | null;
  /** delivery.ts の held_reason（export.csv の held_reason 列と同じ）。 */
  held: HeldReason | null;
}

const VET402_LIMIT_STATUSES = new Set(["over_cap", "budget_denied", "halted", "payto_operator_self"]);
const VET402_ERROR_STATUSES = new Set(["request_error", "in_flight"]);
/** export.csv が載せない status（vet402 の側の状態）。route.ts の WHERE と同じ集合。 */
export const NOT_IN_EXPORT_STATUSES: ReadonlySet<string> = new Set(["budget_denied", "halted", "request_error", "in_flight"]);

function inRange(code: number | null, lo: number, hi: number): code is number {
  return typeof code === "number" && code >= lo && code <= hi;
}

/** retest の (b) と同じ条件: 宣言本文を送る前の、決済されなかった POST の 400/422。 */
export function isBodyNotSent(r: SellerRowFacts): boolean {
  return (
    r.status === "settle_failed" &&
    (r.txHash === null || r.txHash === "") &&
    (r.httpStatusPaid === 400 || r.httpStatusPaid === 422) &&
    Date.parse(r.attemptedAt) < Date.parse(DECLARED_BODY_SENT_SINCE) &&
    (r.method ?? "").toUpperCase() === "POST" &&
    !r.bodyRecorded &&
    r.declaresBody
  );
}

/** 支払い前の応答（no_402）の HTTP から。 */
function unpaidMode(code: number | null): string {
  if (inRange(code, 200, 299)) return "free_200";
  if (code === 404 || code === 410) return "gone";
  if (code === 401 || code === 403) return "auth";
  if (code === 405) return "wrong_method";
  if (code === 429) return "rate_limited";
  if (inRange(code, 500, 599)) return "down";
  return "no_402";
}

/** 有料の要求（署名した後）の HTTP から。 */
function paidMode(code: number | null): string {
  if (code === null) return "no_response_paid";
  if (inRange(code, 200, 299)) return "no_receipt";
  if (code === 402) return "payment_refused";
  if (code === 400 || code === 404 || code === 415 || code === 422) return "input_rejected";
  if (code === 401 || code === 403) return "auth";
  if (code === 405) return "wrong_method";
  if (code === 408) return "no_response_paid";
  if (code === 429) return "rate_limited";
  if (inRange(code, 500, 599)) return "server_error_paid";
  return "other";
}

function modeKeyOf(r: SellerRowFacts, held: HeldReason | null): string {
  if (r.status === "settle_claimed") return "settlement_pending";
  if (held === "payer_unfunded") return "payer_unfunded";
  if (isBodyNotSent(r)) return "body_not_sent";
  if (VET402_LIMIT_STATUSES.has(r.status)) return "vet402_limit";
  if (VET402_ERROR_STATUSES.has(r.status)) return "vet402_error";
  switch (r.status) {
    case "no_402":
      return unpaidMode(r.unpaidStatus);
    case "no_eligible_accept":
      return "no_accept";
    case "price_mismatch":
      return "price_mismatch";
    case "payto_mismatch":
      return "payto_mismatch";
    case "settle_claim_refuted":
      return "claim_refuted";
    case "settle_claimed_unverifiable":
      return "claim_malformed";
    case "delivered_no_receipt":
      return "no_receipt";
    case "settled":
    case "settle_failed":
      return paidMode(r.httpStatusPaid);
    default:
      return "other";
  }
}

/** 1 行を分類する（届いた行は mode が null）。決定的・DB 無し。 */
export function classifyRow(r: SellerRowFacts): RowClass {
  const held = heldReasonOf({
    status: r.status,
    httpStatusPaid: r.httpStatusPaid,
    txHash: r.txHash === "" ? null : r.txHash,
    attemptedAt: r.attemptedAt,
    network: r.network,
  });
  if (isDelivered({ status: r.status, httpStatusPaid: r.httpStatusPaid })) return { bucket: "delivered", mode: null, held };
  const mode = fixMode(modeKeyOf(r, held));
  return { bucket: mode.side, mode, held };
}

export const EFFORT_LABEL: Record<FixEffort, string> = {
  1: "a listing or config change",
  2: "a server change",
  3: "depends on the facilitator",
};

export const SIDE_LABEL: Record<FixSide, string> = {
  seller: "seller's side",
  vet402: "vet402's side",
  unsorted: "not sorted yet",
};
