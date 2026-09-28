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
// side は「その失敗は誰の側で起きたか」（2026-09-29 敵対的監査で規則を締めた・判定の順もこの順）:
//   vet402   こちらの落ち度・こちらの制限。売り手に直すものは無い。
//            payer_unfunded（購入元の残高切れ）、body_not_sent（宣言本文を送っていなかった期間の 400/422）、
//            query_not_sent（Base で宣言クエリを送っていなかった期間の 400/422）。本文とクエリは決済済みの行も
//            こちらの側に置く（独立レビュー 2026-09-28: 入力を送らなかったのはこちら）。retest の対象
//            （買い直しの予定）とは別の判定で、頁が「eligible for a re-buy」と書くのは retest の SQL の結果がある時だけ（board.ts）。
//            本文・クエリの「宣言」は、送る規則と同じ情報源（x402_endpoints.declared_input＝`bazaar.info.input` の
//            見本値に送る規則を当てた要約）とスキーマの両方で見る（2026-09-29）。本文は 415 も入る。
//   unsorted 売り手の側に数えない行（2026-09-29）:
//            held       判定保留（delivery.ts の held_reason がある: settled_4xx / unsettled_4xx）。頁は「保留の行は
//                       売り手に不利に数えない」と書くので、seller の側にも置かない。
//            no charge  課金されていない（決済の申告＝レシートも、着金＝tx も無い）。4xx の拒否（unsettled_4xx）と、
//                       レシート無しの 2xx（delivered_no_receipt・tx なし）。宣言どおりの無料応答（「外れは無料」）を
//                       売り手の失敗と書かない。着金があれば遅延回収（recover-late.ts）が tx を貼って settle_claimed に移す。
//            other      まだ分類していない組み合わせ。
//   seller   上のどれにも当たらず、売り手の応答・出品の宣言で説明がつく。
// effort は直す手間: 1 = 出品・設定の変更、2 = サーバーの変更、3 = facilitator 次第。
//
// 公開面の文言を持つので tests/claims-registry.test.ts の走査対象（publicSurfaces）に入っている。
// ============================================================
import { heldReasonOf, isDelivered, type HeldReason } from "@/lib/observatory/delivery";
import {
  BODY_NOT_SENT_REFUSAL_HTTP,
  bodyNotSentOnOurSide,
  DECLARED_BODY_SENT_SINCE,
  declaredInputProperty,
  declaresBodyForSending,
  type NotSentRowInput,
} from "@/lib/observatory/request-body";
import { BASE_DECLARED_QUERY_SINCE, BASE_NETWORKS, declaresQueryForSending, queryNotSentOnOurSide } from "@/lib/observatory/request-query";

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
  /** 「どちらの側か」の列の語。無ければ SIDE_LABEL[side]。 */
  sideLabel?: string;
}

/** 宣言本文を送り始めた時刻（retest と同じ値・定義は request-body.ts の 1 か所）。 */
export { DECLARED_BODY_SENT_SINCE };
/** Base で宣言クエリを送り始めた時刻（定義は request-query.ts の 1 か所）。 */
export { BASE_DECLARED_QUERY_SINCE };

const NOTHING_FOR_SELLER = "Nothing for the seller to fix.";

/**
 * 遅延回収（recover-late.ts）が着金を探す窓（試行の何分前から何分後まで）。値は recover-late.ts と同じ
 * （tests/sellers-fix-modes.test.ts が一致を固定する）。recover-late は DB を import するので、公開頁の分類表は
 * 数字だけを持つ。
 */
export const LATE_LINK_BEFORE_MIN = 2;
export const LATE_LINK_AFTER_MIN = 30;

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
    what: "The paid request got a 2xx and no settlement receipt, and the transaction on the row could not be confirmed as this payment.",
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
    what: "Before 2026-09-16 23:25 UTC, vet402 sent an empty JSON body on paid POST requests, even when the listing declares a body. The seller refused it with 400, 415 or 422, before or after the payment settled.",
    fix: NOTHING_FOR_SELLER,
    side: "vet402",
    effort: 1,
  },
  {
    key: "query_not_sent",
    title: "vet402 did not send the declared query",
    what: "Before 2026-09-27 23:27 UTC, vet402 did not add the query parameters the seller's 402 declares to paid requests on Base, and this listing declares them (example values, or required names). The seller refused the request with 400 or 422.",
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
  // ---------- unsorted: held (not counted against the seller) ----------
  {
    key: "settled_then_rejected",
    title: "Payment settled, then the input was rejected",
    what: "The payment settled on-chain, and then the paid request got 400, 404, 415 or 422. vet402 holds this row (held_reason settled_4xx): its own request may have been the problem, so the row is not counted against the seller.",
    fix: "Nothing is counted against the seller. Checking the input before settling avoids taking a payment for a refused request, and declaring the input with example values that work as written lets vet402 send a valid one.",
    side: "unsorted",
    effort: 2,
    sideLabel: "not sorted (held)",
  },
  {
    key: "settled_then_refused",
    title: "Payment settled, then the request was refused",
    what: "The payment settled on-chain, and then the paid request got another 4xx (for example 401, 403, 405 or 429). vet402 holds this row (held_reason settled_4xx), so it is not counted against the seller.",
    fix: "Nothing is counted against the seller. If the paid request should have been served, let the x402 payment be enough for it.",
    side: "unsorted",
    effort: 2,
    sideLabel: "not sorted (held)",
  },
  // ---------- unsorted: no charge ----------
  {
    key: "refused_no_charge",
    title: "Refused, and no payment was taken",
    what: "vet402 signed the payment and the paid request got a 4xx other than 402, with no settlement receipt and no transaction on the row. No money moved, and vet402 cannot rule out that its own request was the problem (held_reason unsettled_4xx), so the row is not counted against the seller. Since 2026-09-16 23:25 UTC vet402 sends the request body the seller's 402 declares (an empty JSON body when it declares none), and since 2026-09-27 23:27 UTC it adds the query parameters the seller's 402 declares on Base.",
    fix: "Nothing is counted against the seller. If the request was meant to succeed, declare the input in the listing (body or query) with example values that work as written.",
    side: "unsorted",
    effort: 1,
    sideLabel: "not sorted: no charge",
  },
  {
    key: "answered_no_charge",
    title: "Answered without taking payment",
    what: `The paid request got a 2xx with no settlement receipt, and vet402 has not linked a matching transfer on-chain to it (it links a transfer that lands from ${LATE_LINK_BEFORE_MIN} minutes before to ${LATE_LINK_AFTER_MIN} minutes after the attempt, then verifies it). vet402 has not identified a charge for this call, so the row is not counted against the seller; if a matching transfer is found later, the row is re-sorted.`,
    fix: "Nothing is counted against the seller. If the route is meant to charge, settle the payment and return the PAYMENT-RESPONSE header with the 2xx.",
    side: "unsorted",
    effort: 2,
    sideLabel: "not sorted: no charge",
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
  /**
   * 行の raw_response_meta のうち、共有の判定（request-body.ts / request-query.ts）が読むキーだけ
   * （requestBody の有無・requestQuery の値）。読み取り側（reader.ts）が DB で間引く。記録が無ければ null。
   */
  meta: Record<string, unknown> | null;
  /**
   * 出品の今のカタログのスキーマ（x402_endpoints.declared_schema）のうち、共有の判定が読む部分だけ
   * （properties.input.properties の body と queryParams.required）。無ければ null。
   */
  schema: unknown;
  /**
   * 出品の宣言の要約（x402_endpoints.declared_input・送る規則を掲載に当てた結果・2026-09-29）。無ければ null。
   */
  declaredInput?: unknown;
  /** raw_response_meta.status（支払い前の応答の HTTP。no_402 の行で読む）。 */
  unpaidStatus: number | null;
  /** raw_response_meta.selection（census / retest / null）。 */
  selection: string | null;
  /** x402_l1_purchases.settlement_verify_reason（照合が通らなかった理由・例 tx_not_found）。無ければ null。 */
  verifyReason: string | null;
}

/**
 * pending = 照合待ち（settle_claimed）。売り手はレシートを返したが、vet402 がまだチェーンで読み直していない。
 * 成功とも失敗とも決まっていないので、失敗（seller / vet402 / unsorted）にも delivered にも数えない。
 */
export type Bucket = "delivered" | "pending" | "seller" | "vet402" | "unsorted";

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

/** 共有の判定（request-body.ts / request-query.ts）へ渡す形。 */
export function notSentInput(r: SellerRowFacts): NotSentRowInput {
  return {
    status: r.status,
    txHash: r.txHash === "" ? null : r.txHash,
    httpStatusPaid: r.httpStatusPaid,
    attemptedAt: r.attemptedAt,
    rawResponseMeta: r.meta,
    network: r.network,
    method: r.method,
    declaredSchema: r.schema,
    declaredInput: r.declaredInput ?? null,
  };
}

/**
 * 決済済みの 400/422 を、共有の判定（決済されなかった行だけを見る retest の条件）に掛けるための見方。
 * /sellers の方針（2026-09-28 独立レビュー）: こちらが宣言の本文・クエリを送っていなかった行は、決済されていても
 * vet402 の側。決済の有無以外（時刻・400/422・POST・記録・宣言）は共有の判定そのものを使う。
 */
function asIfUnsettled(r: SellerRowFacts): NotSentRowInput {
  const input = notSentInput(r);
  const refusal = typeof r.httpStatusPaid === "number" && (BODY_NOT_SENT_REFUSAL_HTTP as readonly number[]).includes(r.httpStatusPaid);
  return r.status === "settled" && refusal ? { ...input, status: "settle_failed", txHash: null } : input;
}

/** 宣言本文を送る前の POST の 400/415/422（共有の bodyNotSentOnOurSide・決済済みの行を含む）。 */
export function isBodyNotSent(r: SellerRowFacts): boolean {
  return bodyNotSentOnOurSide(asIfUnsettled(r));
}

/** Base で宣言クエリを送る前の 400/422（共有の queryNotSentOnOurSide・決済済みの行を含む）。 */
export function isQueryNotSent(r: SellerRowFacts): boolean {
  return queryNotSentOnOurSide(asIfUnsettled(r));
}

/**
 * 課金なしの 2xx: レシート無しの 2xx（delivered_no_receipt、または 2xx の settle_failed）で、行に tx も無い。
 * 着金があれば遅延回収が tx を貼って settle_claimed に移すので、この形のまま残る行は「決済の申告も着金も無い」。
 */
export function isAnsweredWithoutCharge(r: Pick<SellerRowFacts, "status" | "txHash" | "httpStatusPaid">): boolean {
  if (!(r.txHash === null || r.txHash === "")) return false;
  if (r.status === "delivered_no_receipt") return true;
  return r.status === "settle_failed" && inRange(r.httpStatusPaid, 200, 299);
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
function paidMode(code: number | null, settled: boolean): string {
  if (code === null) return "no_response_paid";
  if (inRange(code, 200, 299)) return "no_receipt";
  if (code === 402) return "payment_refused";
  if (code === 400 || code === 404 || code === 415 || code === 422) return settled ? "settled_then_rejected" : "other";
  if (code === 401 || code === 403) return "auth";
  if (code === 405) return "wrong_method";
  if (code === 408) return "no_response_paid";
  if (code === 429) return "rate_limited";
  if (inRange(code, 500, 599)) return "server_error_paid";
  return "other";
}

const REJECTED_INPUT_HTTP = new Set([400, 404, 415, 422]);

/**
 * 判定の順（2026-09-29）: vet402 の側 → 判定保留（held）→ 課金なし → 売り手の側。
 * 保留と課金なしは seller の側に置かない（件数にも入れない）。
 */
function modeKeyOf(r: SellerRowFacts, held: HeldReason | null): string {
  if (held === "payer_unfunded") return "payer_unfunded";
  if (isBodyNotSent(r)) return "body_not_sent";
  if (isQueryNotSent(r)) return "query_not_sent";
  if (VET402_LIMIT_STATUSES.has(r.status)) return "vet402_limit";
  if (VET402_ERROR_STATUSES.has(r.status)) return "vet402_error";
  if (held === "settled_4xx") return REJECTED_INPUT_HTTP.has(r.httpStatusPaid ?? -1) ? "settled_then_rejected" : "settled_then_refused";
  if (held === "unsettled_4xx") return "refused_no_charge";
  if (isAnsweredWithoutCharge(r)) return "answered_no_charge";
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
      return paidMode(r.httpStatusPaid, r.status === "settled");
    default:
      return "other";
  }
}

/**
 * 行ごとの注記: 宣言本文を送る前の有料 POST が入力で断られ、出品が本文を宣言していない（＝vet402 の側に
 * 置かない）行に、こちらが `{}` を送っていた事実を並べる。本文を宣言している出品の行は body_not_sent
 * （vet402 の側）に入るので、ここには来ない。
 */
export function rowNote(r: SellerRowFacts, modeKey: string | null): string | null {
  if (modeKey !== "settled_then_rejected" && modeKey !== "refused_no_charge") return null;
  const notes = [bodyNote(r), optionalQueryNote(r)].filter((x): x is string => x !== null);
  return notes.length ? notes.join(" ") : null;
}

/** 本文: 境目より前の POST・本文の記録なし・出品が本文を宣言していない（宣言していれば body_not_sent に入る）。 */
function bodyNote(r: SellerRowFacts): string | null {
  if ((r.method ?? "").toUpperCase() !== "POST" || (r.meta !== null && "requestBody" in r.meta)) return null;
  if (declaresBodyForSending({ declaredSchema: r.schema, declaredInput: r.declaredInput ?? null })) return null;
  if (!(Date.parse(r.attemptedAt) < Date.parse(DECLARED_BODY_SENT_SINCE))) return null;
  return "This purchase is from before 2026-09-16 23:25 UTC, when vet402 sent an empty JSON body on paid POST requests; this listing declares no body.";
}

/**
 * クエリ: Base・境目より前・クエリを送った記録なし（無いか empty）・出品が queryParams を宣言しているが必須が無い
 * （必須があれば query_not_sent に入る）。側は seller のまま、こちらがクエリを足していなかった事実を並べる。
 */
function optionalQueryNote(r: SellerRowFacts): string | null {
  if (!(BASE_NETWORKS as readonly string[]).includes(r.network ?? "")) return null;
  if (!(Date.parse(r.attemptedAt) < Date.parse(BASE_DECLARED_QUERY_SINCE))) return null;
  const kind = r.meta?.requestQuery;
  if (!(kind === undefined || kind === null || kind === "empty")) return null;
  const qp = declaredInputProperty(r.schema, "queryParams");
  if (typeof qp !== "object" || qp === null || Array.isArray(qp)) return null;
  if (declaresQueryForSending({ declaredSchema: r.schema, declaredInput: r.declaredInput ?? null })) return null;
  return "Before 2026-09-27 23:27 UTC, vet402 did not add query parameters to paid requests on Base; this listing declares optional ones.";
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
  if (r.status === "settle_claimed") return { bucket: "pending", mode: null, held };
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

/** 行・種類の「どちらの側か」の語（種類ごとの sideLabel があればそれ）。 */
export function sideLabelOf(m: FixMode): string {
  return m.sideLabel ?? SIDE_LABEL[m.side];
}
