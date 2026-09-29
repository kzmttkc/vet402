// ============================================================
// §8.1 売り手事実。集計は純関数 assembleSellerFacts に置き、DB 読みは loadSellerFacts。
//
//   l0.status        = publishedVerdict（2 連続 fail ゲート。1 回の fail を公開しない）
//   l1.n_attempts    = 署名した試行（spent が立つ status）。署名前の拒否は数えない
//   l1.n_settled     = チェーンで確定（status = settled）
//   l1.n_inconclusive= 売り手の不履行として数えない署名済みの試行（delivery.ts の heldReasonOf）:
//                      settled かつ 4xx／決済レシートなしで 4xx（402 以外）／資金切れ期間の 402・5xx。
//                      n_attempts に含める（/purchases と同じ集合・2026-09-08／2026-09-17 拡張）。
//                      判定は rules.ts が conclusive = n_attempts − n_inconclusive（と下の l1NotCountedOf）で読む
//   （2026-09-29 監査 7 周目）1 行の分類は fix-modes.ts classifySellerRow の 1 本だけ（/sellers・記録頁・export.csv と同じ）。
//                      判定はその結果（届いたか・お金が動いたか・誰の側か）から l1NotCountedOf と l1TimelineOf を作る。
//                      「数える」＝届いた、または売り手の側（確定）。BLOCK は売り手の側（確定）の「払ったのに届かない」が
//                      最後の配達より後に 2 回以上のときだけ。facts の形（SDK・openapi と対）は変えない
//   l1.n_delivered   = delivery.ts isDelivered（settled・2xx（202 を除く）・本文が空でない）
//   l2.status        = 宣言が無ければ undeclared。あれば直近の配達の l2_schema:
//                      match → conform、mismatch → mismatch、それ以外（配達が無い・not_checked 等）は、出力を宣言して
//                      いれば not_checked、していなければ undeclared（未検査を mismatch とも undeclared とも書かない・
//                      2026-09-29 監査 7 周目）
//                      2026-09-29: 印（l2.reason）の無い古い mismatch は legacyL2SchemaOf で読み直す。16,000 バイトで
//                      切った JSON が読めずに「全部欠けた」と記録された行を、売り手の不一致として数えない（l2-check.ts）
//   offer_stability  = 24h 窓で (amount, asset, payTo) の実質変更 ≥ 3 → drifting
//   wash_dominated   = raw ≥ 10 かつ real ≤ raw × 10%
// trustScore はここに入れない（§8.3）。
// ============================================================
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { ACCEPTED_NOT_DONE_HTTP, DELIVERED_HTTP_MAX, DELIVERED_HTTP_MIN, isDelivered, isDeliveryHttp, isInconclusive } from "@/lib/observatory/delivery";
import { classifySellerRow, ONCE_SUFFIX, type Bucket, type MoneyMoved, type SellerRowFacts } from "@/lib/sellers/fix-modes";
import { recordRowKey } from "@/lib/sellers/board";
import { readRecordSides } from "@/lib/sellers/reader";
import { publishedVerdict } from "@/lib/observatory/l0-probe";
import { declaredOutputOf, legacyL2SchemaOf } from "@/lib/observatory/l2-check";
import { purchaseId as toPurchaseId } from "@/lib/ids/canonical";
import { toCaip2 } from "@/lib/observatory/chains";
import { getSettlementCounts } from "@/lib/settlements/census";
import { rowsOf } from "@/lib/settlements/upsert";
import { toIsoUtc } from "@/lib/util/iso-utc";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import type { Dialect, Evidence, L2Status, OfferStability, SellerFacts, VerifiedTerms } from "./types";
import type { L1Timeline } from "./rules";

export type ProbeInput = {
  probedAt: string;
  verdict: string;
  dialect: string | null;
  failReason: string | null;
  priceAmount: string | null;
  priceAsset: string | null;
  payTo: string | null;
};

export type PurchaseInput = {
  attemptedAt: string;
  status: string;
  latencyMs: number | null;
  httpStatusPaid: number | null;
  payloadNonEmpty: boolean | null;
  l2Schema: string | null;
  txHash: string | null;
  network: string | null;
  /** §6.3: l1-runner が raw_response_meta.l2 に残す判定材料（2026-09-02 以降の行だけ持つ）。 */
  l2Detail?: { missing: string[]; declarationHash: string | null; responseHash: string; reason?: string | null } | null;
  /**
   * 2026-09-29: 支払い付き応答の本文の先頭 500 文字（raw_response_meta.bodyHead）。L2 = mismatch の行だけ読む。
   * 印の無い古い mismatch を読み直す材料（legacyL2SchemaOf）。公開面には出さない。
   */
  bodyHead?: string | null;
  /**
   * 2026-09-29: 帰属の判定（classifyRow）が読む raw_response_meta の部分だけ（requestBody の有無・requestQuery の値）。
   * 無ければ null（記録なし）。
   */
  requestMeta?: Record<string, unknown> | null;
  /**
   * 2026-09-29 第2巡: 署名した額と支払ったウォレット（x402_l1_purchases.amount_units / payer）。帰属の (c)
   * （署名時点の残高・payer-balance-history.ts）に使う。残高が価格未満だったと示せる行は vet402 の側として除く。
   */
  amountUnits?: string | null;
  payer?: string | null;
  /**
   * 2026-09-29.2（独立レビュー）: tx の付いた settle_failed の支払いが確かめられたか。決済の索引（settlements）に
   * その tx が在る、または照合で settlement_verified = true になった行だけ true。売り手が success:false と一緒に
   * 返しただけの tx は false／null（支払い済みに数えない）。
   */
  settlementConfirmed?: boolean | null;
  /**
   * 2026-09-29 監査 7 周目: 同じ行の分類（fix-modes.ts classifySellerRow の結果・/sellers と記録頁が読むのと同じ 1 本
   * readRecordSides から）。判定はこれだけを読んで「届いたか」「お金が動いたか」「誰の側か」を決める。読めなければ
   * rowViewOf が同じ関数を行の事実だけで当てる（売り手の側は確定しない＝L1 で BLOCK にならない）。
   */
  sellerView?: SellerRowView | null;
  /** 2026-09-29 監査 7 周目: 署名した EIP-3009 の nonce（遅延回収の待ちの判定・fallback 用）。 */
  authNonce?: string | null;
  /** 2026-09-29.3: 支払い付き応答の Content-Type（raw_response_meta.contentType・60 文字まで）。L2 の evidence に使う。 */
  contentType?: string | null;
};

/** 1 行の分類の要点（fix-modes.ts classifySellerRow の結果・board.ts の ShownRow から）。 */
export type SellerRowView = { bucket: Bucket; modeKey: string | null; held: string | null; money: MoneyMoved; delivered: boolean };

/**
 * 売り手の不履行として数えない理由（数える行は null）。「数える」の意味は全面で 1 つ（2026-09-29 監査 7 周目）:
 * **売り手の記録に数える＝届いた、または /sellers が売り手の側（確定）に置いた**。それ以外の署名した行は数えない。
 *   settlement_unknown  お金が動いたか未確定（照合待ち・遅延回収の待ち・決済の結び付いていない空の 2xx）。WARN
 *   vet402_side         vet402 の側
 *   no_charge           課金なしで断られた・無料で答えた
 *   held                判定保留（held_reason）
 *   unconfirmed         売り手の側だが 1 日だけ（once）
 *   unproven            それ以外の not sorted（vet402 に落ち度が無いと示せない等）。お金が動いていれば WARN
 */
export type NotCountedReason = "vet402_side" | "held" | "no_charge" | "unproven" | "unconfirmed" | "settlement_unknown";

const NO_CHARGE_MODES: ReadonlySet<string> = new Set(["refused_no_charge", "answered_no_charge"]);

/** 行の分類。sellerView（/sellers と同じ 1 本から読んだ分類）が無ければ同じ関数を行の事実だけで当てる。 */
export function rowViewOf(
  p: PurchaseInput,
  endpoint: { method: string | null; declaredSchema: unknown; declaredInput?: unknown },
  now: number = Date.now(),
): SellerRowView {
  if (p.sellerView) return p.sellerView;
  const facts: SellerRowFacts = {
    endpointId: "",
    status: p.status,
    httpStatusPaid: p.httpStatusPaid,
    txHash: p.txHash,
    attemptedAt: toIsoUtc(p.attemptedAt) ?? p.attemptedAt,
    network: p.network,
    method: endpoint.method,
    meta: p.requestMeta ?? null,
    schema: endpoint.declaredSchema ?? null,
    declaredInput: endpoint.declaredInput ?? null,
    unpaidStatus: null,
    selection: null,
    verifyReason: null,
    amountUnits: p.amountUnits ?? null,
    payer: p.payer ?? null,
    payloadNonEmpty: p.payloadNonEmpty,
    settlementConfirmed: p.settlementConfirmed ?? null,
    authNonce: p.authNonce ?? null,
  };
  const c = classifySellerRow(facts, { now });
  return { bucket: c.bucket, modeKey: c.mode?.key ?? null, held: c.held, money: c.money, delivered: c.delivered };
}

/** お金が動いたか未確定で、届いた形の中身も無い行（判定は WARN・l1_empty_2xx_settlement_unknown）。 */
function isSettlementUnknown(v: SellerRowView, p: PurchaseInput): boolean {
  if (v.money !== "unknown" || v.delivered) return false;
  const answered = isDeliveryHttp(p.httpStatusPaid) && p.payloadNonEmpty === true;
  if (v.bucket === "pending") return !answered;
  return isDeliveryHttp(p.httpStatusPaid) && p.payloadNonEmpty !== true;
}

/** 売り手の不履行として数えない理由（上の NotCountedReason）。分類（SellerRowView）だけから決める。 */
export function notCountedReasonOf(v: SellerRowView, p: PurchaseInput): NotCountedReason | null {
  if (v.delivered || v.bucket === "seller") return null;
  if (isSettlementUnknown(v, p)) return "settlement_unknown";
  if (v.bucket === "vet402") return "vet402_side";
  if (v.modeKey !== null && NO_CHARGE_MODES.has(v.modeKey)) return "no_charge";
  if (v.bucket === "pending" || v.held !== null) return "held";
  if (v.modeKey !== null && v.modeKey.endsWith(ONCE_SUFFIX)) return "unconfirmed";
  return "unproven";
}

/**
 * お金が動いて届かなかった行（l1_paid_not_delivered の材料）。vet402 の側・判定保留（held_reason）は入れない。
 * このうち売り手の側（確定）の行だけが BLOCK の根拠になる（rules.ts L1_PAID_UNDELIVERED_BLOCK）。
 */
function isPaidUndelivered(v: SellerRowView): boolean {
  return v.money === "moved" && !v.delivered && v.bucket !== "vet402" && v.held === null;
}

export type SellerFactsInput = {
  /** newest first */
  probes: ProbeInput[];
  /** newest first */
  purchases: PurchaseInput[];
  settlements30d: { raw: number; real: number; test: number; uniquePayersReal: number };
  payees: string[];
  declaredSchema: unknown | null;
  /** 2026-09-29: 帰属の判定に使う出品の宣言メソッドと宣言の要約（declared_input）。 */
  method?: string | null;
  declaredInput?: unknown;
  /**
   * 全履歴での最終試行時刻（ISO8601 UTC）。`purchases` から導かない——あちらは
   * 直近 30 日 / 200 行の窓なので、窓の外の試行が「一度も無い」に化ける。
   */
  lastAttemptAt: string | null;
  /**
   * 2026-09-29.2: 全履歴での最後の署名した試行と最後の配達（ISO8601 UTC）。窓の外の試行を「一度も無い」と
   * 読まないため（l1_stale）。省略時は purchases（窓の中）から導く。
   */
  lastSignedAttemptAt?: string | null;
  lastDeliveredAt?: string | null;
};

/** 署名した（＝支払い済み・spent が立つ）status。§6.2 の n_attempts。 */
export const SIGNED_STATUSES = new Set([
  "settled",
  "settle_claimed",
  "settle_claim_refuted",
  "settle_claimed_unverifiable",
  "delivered_no_receipt",
  "settle_failed",
]);

/** delivery.ts isDelivered と同じ述語の SQL（定数だけから作る・202 を除く・payload_non_empty が false の行を除く）。 */
const DELIVERED_ROW_SQL = `status = 'settled' AND http_status_paid BETWEEN ${DELIVERED_HTTP_MIN} AND ${DELIVERED_HTTP_MAX} AND http_status_paid <> ${ACCEPTED_NOT_DONE_HTTP} AND payload_non_empty IS NOT FALSE`;

/** SIGNED_STATUSES の SQL リテラル列（定数だけから作る・利用者入力は通らない）。 */
const SIGNED_STATUS_SQL_LIST = [...SIGNED_STATUSES].map((v) => `'${v.replace(/[^a-z_]/g, "")}'`).join(",");

export const DRIFT_CHANGES_PER_24H = 3;
export const WASH_DOMINATED_MIN_RAW = 10;
export const WASH_DOMINATED_REAL_SHARE = 0.1;

const DIALECTS = new Set(["v1", "v2", "both", "unpayable", "mpp"]);

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function offerStabilityOf(probesNewestFirst: readonly ProbeInput[]): OfferStability {
  const passes = probesNewestFirst.filter((p) => p.verdict === "pass");
  if (passes.length < 2) return "unknown";
  const asc = [...passes].reverse();
  const key = (p: ProbeInput) => `${p.priceAmount ?? ""}|${(p.priceAsset ?? "").toLowerCase()}|${(p.payTo ?? "").toLowerCase()}`;
  const changes: number[] = [];
  for (let i = 1; i < asc.length; i++) {
    if (key(asc[i]) !== key(asc[i - 1])) changes.push(Date.parse(asc[i].probedAt));
  }
  for (let i = 0; i < changes.length; i++) {
    let n = 1;
    for (let j = i + 1; j < changes.length && changes[j] - changes[i] <= 86_400_000; j++) n++;
    if (n >= DRIFT_CHANGES_PER_24H) return "drifting";
  }
  return "stable";
}

/** 判定（rules.ts decidePayer）へ渡す、売り手の不履行として数えない署名済みの試行の数と内訳。 */
export type L1NotCounted = { total: number; by: Record<NotCountedReason, number> };

type L1Input = Pick<SellerFactsInput, "purchases" | "declaredSchema" | "method" | "declaredInput" | "lastSignedAttemptAt" | "lastDeliveredAt">;

/** 窓の中の署名した行（新しい順）と、それぞれの分類。 */
function signedViews(input: L1Input, now: number): { p: PurchaseInput; v: SellerRowView; reason: NotCountedReason | null; t: number }[] {
  const decl = { method: input.method ?? null, declaredSchema: input.declaredSchema, declaredInput: input.declaredInput ?? null };
  // newest first（loadSellerFacts の ORDER BY）。念のため時刻で並べ直す（同時刻は元の順）。
  return input.purchases
    .filter((p) => SIGNED_STATUSES.has(p.status))
    .map((p, i) => ({ p, i, t: epoch(p.attemptedAt) }))
    .sort((a, b) => (Number.isFinite(b.t) && Number.isFinite(a.t) && b.t !== a.t ? b.t - a.t : a.i - b.i))
    .map(({ p, t }) => {
      const v = rowViewOf(p, decl, now);
      return { p, v, reason: notCountedReasonOf(v, p), t };
    });
}

/**
 * 署名した試行のうち、売り手の不履行として数えないもの（classifySellerRow の結果から・/sellers と同じ）。
 * facts には載せない（公開の facts の形は SDK・openapi と対で、変えない）。理由は判定の reason_codes（l1_not_counted_*）に出る。
 */
export function l1NotCountedOf(input: Pick<SellerFactsInput, "purchases" | "declaredSchema" | "method" | "declaredInput">, now: number = Date.now()): L1NotCounted {
  const by: Record<NotCountedReason, number> = { vet402_side: 0, held: 0, no_charge: 0, unproven: 0, unconfirmed: 0, settlement_unknown: 0 };
  let total = 0;
  for (const x of signedViews(input, now)) {
    if (x.reason === null) continue;
    by[x.reason]++;
    total++;
  }
  return { total, by };
}

/**
 * 時刻（ISO8601 か Postgres の ::text "2026-09-26 09:56:04.556+09"）をミリ秒へ。読めなければ NaN。
 * toIsoUtc と同じ解釈（new Date）を使う——セッションの TZ が UTC でない DB（手元の検査 DB は +09）でも
 * 同じ瞬間を指す（2026-09-29 の DB テストで "+09" を NaN にして未配達を 0 と数えた不具合の再発防止）。
 */
const epoch = (iso: string | null | undefined): number => {
  if (!iso) return Number.NaN;
  const iso8601 = toIsoUtc(iso);
  return iso8601 === null ? Number.NaN : Date.parse(iso8601);
};

/**
 * 判定（rules.ts decidePayer）へ渡す窓の中の並び（2026-09-29.2・2026-09-29 監査 7 周目で分類を 1 本にした）。
 *
 * 「数える」は l1NotCountedOf の裏返し＝届いた行と、売り手の側（確定）の行。お金が動いて届かなかった行
 * （isPaidUndelivered）は、最後の配達より後に 1 回でもあれば WARN、そのうち売り手の側（確定）が 2 回以上なら BLOCK。
 * 実例: cnvrt.ing/api/analyze-image は決済済み・HTTP 500 が 2 回だが /sellers は not sorted（vet402 unproven）。
 * 以前は BLOCK だった（売り手への誤った非難）。今は WARN。
 */
export function l1TimelineOf(input: L1Input, now: number = Date.now()): L1Timeline {
  const rows = signedViews(input, now);
  const counted = rows.filter((x) => x.reason === null);
  const lastDeliveredInWindow = rows.find((x) => x.v.delivered) ?? null;
  const cut = lastDeliveredInWindow ? lastDeliveredInWindow.t : Number.NEGATIVE_INFINITY;
  // 最後の配達より**後**（同時刻は後に数えない）。配達が無ければ窓の中の全部。
  // 時刻が読めない行は数える（払う側に慎重: 読めないことを理由に BLOCK・WARN を逃さない）。
  const afterCut = (t: number): boolean => !Number.isFinite(t) || t > cut;
  const paidUndelivered = rows.filter((x) => isPaidUndelivered(x.v));
  const paidSince = paidUndelivered.filter((x) => afterCut(x.t));
  const latest = counted[0] ?? null;
  const newer = (a: string | null | undefined, b: string | null | undefined): string | null => {
    const ta = epoch(a);
    const tb = epoch(b);
    if (!Number.isFinite(ta)) return Number.isFinite(tb) ? (b as string) : null;
    if (!Number.isFinite(tb)) return a as string;
    return ta >= tb ? (a as string) : (b as string);
  };
  return {
    n_counted: counted.length,
    n_paid_undelivered: paidUndelivered.length,
    n_paid_undelivered_since_delivery: paidSince.length,
    n_paid_undelivered_seller_side_since_delivery: paidSince.filter((x) => x.v.bucket === "seller").length,
    n_settlement_unknown_since_delivery: rows.filter((x) => x.reason === "settlement_unknown" && afterCut(x.t)).length,
    // 公開面は ISO8601 UTC（::text の "2026-09-16 00:00:10.94+00" をそのまま出さない）。
    latest_counted: latest ? { at: toIsoUtc(latest.p.attemptedAt) ?? latest.p.attemptedAt, delivered: latest.v.delivered } : null,
    last_delivered_at: toIsoUtc(newer(lastDeliveredInWindow?.p.attemptedAt ?? null, input.lastDeliveredAt ?? null)),
    last_signed_attempt_at: toIsoUtc(newer(rows[0]?.p.attemptedAt ?? null, input.lastSignedAttemptAt ?? null)),
  };
}

/**
 * L0 が unverified のとき、なぜ測れていないか（2026-09-29 再監査・判定の理由コード）。
 *
 * biosfera …/public-holidays は /decision が BLOCK なのに、reason_codes は `l0_unverified` だけで、
 * 何が測れなかったのか（直近のプローブが TLS で届かなかった）が本文から読めなかった。/sellers は
 * 同じ売り手に「Nothing for you to fix」（L1 の vet402 側の失敗について）と出しており、BLOCK の
 * 理由を探す手掛かりが無かった。判定は変えず、原因を下位コードとして足すための材料を返す。
 *
 *   not_probed   まだ 1 度もプローブしていない
 *   single_fail  直近は fail だが公開ゲート（連続 fail 本数）に届いていない
 *   <reason>     直近のプローブ自体が unverified で、その記録された理由（tls / unsafe_target /
 *                path_template / request_shape / rate_limited …）。記録が無ければ unrecorded
 *
 * 公開判定が unverified でなければ null。語は [a-z0-9_] に丸める（reason code に混ぜるため）。
 */
export function l0UnverifiedCauseOf(probesNewestFirst: readonly ProbeInput[]): string | null {
  if (publishedVerdict(probesNewestFirst.map((p) => p.verdict)) !== "unverified") return null;
  const latest = probesNewestFirst[0];
  if (!latest) return "not_probed";
  if (latest.verdict === "fail") return "single_fail";
  const reason = (latest.failReason ?? "").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return reason === "" ? "unrecorded" : reason.slice(0, 40);
}

export function assembleSellerFacts(input: SellerFactsInput): SellerFacts {
  const { probes, purchases } = input;
  const latestProbe = probes[0] ?? null;
  const l0Status = publishedVerdict(probes.map((p) => p.verdict));

  // inconclusive: 決済は確定したが有料応答が 4xx——我々のリクエストの形（POST に `{}`・
  // API キー無し）で説明がつく行。判定は `@/lib/observatory/delivery` の 1 定義に従う
  // （/purchases の inconclusiveCount・/observatory/state と同じ述語）。
  //
  // 2026-09-02 までは「n_attempts に数えない（probe_error）」だったが、同じ行を
  // /purchases は attempt / settled として数えていた。api.exa.ai は purchases 10/10/
  // inconclusive 10 なのに facts 0/0 で `/decision` が `l1_not_attempted`——
  // 「金が 10 回動いた」相手を「未試行」と公開していた（2026-09-08 本番実測）。
  // 以後 n_attempts / n_settled は purchases と同じ集合（inconclusive を含む）で数え、
  // 売り手の不履行として読まない役目は rules.ts の conclusive（n_attempts −
  // n_inconclusive）が持つ。F-1（2026-08-26）型の冤罪はそちらで防ぐ。
  //
  // 2026-09-17（Issue #29）: 保留は settled の中だけではない。決済レシートが返らずに
  // 4xx（402 以外）で断られた settle_failed と、我々の資金切れ期間の 402・5xx も保留に入る
  // （delivery.ts の heldReasonOf が正典）。n_inconclusive は署名した試行全体から数え、
  // n_settled に入るのはそのうち settled のものだけ。
  const signed = purchases.filter((p) => SIGNED_STATUSES.has(p.status));
  const settled = signed.filter((p) => p.status === "settled");
  const inconclusive = signed.filter((p) => isInconclusive(p));

  const conclusiveSettled = settled.filter((p) => !isInconclusive(p));
  // 配達の述語は delivery.ts isDelivered の 1 つ（settled・2xx（202 を除く）・本文が空でない）。/sellers と同じ。
  const delivered = conclusiveSettled.filter((p) => isDelivered(p));
  // 遅延は結論のある settled だけで測る（4xx の往復は配達の遅延ではない）。
  const latencies = conclusiveSettled
    .map((p) => p.latencyMs)
    .filter((v): v is number => typeof v === "number")
    .sort((a, b) => a - b);
  // 最新の決済レシート。inconclusive でも金は動いており、レシートは在る。
  const lastSettled = settled[0] ?? null;

  const declared = input.declaredSchema !== null && input.declaredSchema !== undefined;
  // 2026-09-29 監査 7 周目（高 1）: 出力を宣言している出品（declaredOutputOf: 必須キーか例のプロパティ）は undeclared と
  // 書かない。直近の配達を宣言と照合できていなければ（配達が無い・本文を読み切れなかった・照合の前の行）not_checked
  // （判定は WARN・l2_not_checked）。宣言の本体（declared_schema）はあっても出力を宣言していなければ undeclared のまま。
  const { requiredKeys: outKeys, exampleProps: outProps } = declaredOutputOf(input.declaredSchema);
  const declaresOutput = declared && (outKeys.length > 0 || outProps !== null);
  let l2Status: L2Status = declaresOutput ? "not_checked" : "undeclared";
  let l2ObservedAt: string | null = null;
  let l2Detail: PurchaseInput["l2Detail"] = null;
  if (declared) {
    const lastDelivered = delivered[0] ?? null;
    if (lastDelivered) {
      l2ObservedAt = lastDelivered.attemptedAt;
      // 2026-09-29: 印の無い古い mismatch を読み直す（読めなかった本文は not_checked → undeclared と同じ扱い）。
      const l2 = legacyL2SchemaOf({
        l2Schema: lastDelivered.l2Schema,
        l2Reason: lastDelivered.l2Detail?.reason,
        missing: lastDelivered.l2Detail?.missing,
        bodyHead: lastDelivered.bodyHead,
        contentType: lastDelivered.contentType,
        declaredSchema: input.declaredSchema,
      });
      if (l2.l2Schema === "match") l2Status = "conform";
      else if (l2.l2Schema === "mismatch") l2Status = "mismatch";
      l2Detail = lastDelivered.l2Detail ? { ...lastDelivered.l2Detail, missing: l2.missing ?? lastDelivered.l2Detail.missing } : null;
    }
  }
  const sha256 = (v: string) => createHash("sha256").update(v, "utf8").digest("hex");
  const declarationHash = declared ? sha256(JSON.stringify(input.declaredSchema)) : null;
  // §6.3: response_hash は conform でも出す。diff_hash / missing_keys は mismatch のときだけ。
  // 詳細の無い旧行はハッシュを捏造しない（null）。
  const responseHash = (l2Status === "conform" || l2Status === "mismatch") && l2Detail ? l2Detail.responseHash : null;
  const missingKeys = l2Status === "mismatch" && l2Detail ? [...l2Detail.missing].sort() : null;
  const diffHash =
    l2Status === "mismatch" && l2Detail
      ? sha256(JSON.stringify({ declaration_hash: declarationHash, response_hash: l2Detail.responseHash, missing: missingKeys }))
      : null;

  const within = (days: number) => {
    const cutoff = Date.now() - days * 86_400_000;
    return probes.filter((p) => Date.parse(p.probedAt) >= cutoff);
  };
  const availability = (list: ProbeInput[]) => (list.length === 0 ? null : list.filter((p) => p.verdict === "pass").length / list.length);

  const { raw, real, test, uniquePayersReal } = input.settlements30d;
  const thirdPartyRaw = Math.max(0, raw - test);
  return {
    l0: {
      status: l0Status,
      observed_at: latestProbe?.probedAt ?? null,
      dialect: latestProbe && latestProbe.dialect && DIALECTS.has(latestProbe.dialect) ? (latestProbe.dialect as Dialect) : null,
      fail_reason: l0Status === "fail" ? (latestProbe?.failReason ?? null) : null,
    },
    l1: {
      n_delivered: delivered.length,
      n_settled: settled.length,
      n_attempts: signed.length,
      n_inconclusive: inconclusive.length,
      n_probe_error: inconclusive.length,
      p50_ms: percentile(latencies, 50),
      p95_ms: percentile(latencies, 95),
      last_purchase_id:
        lastSettled && lastSettled.txHash && lastSettled.network
          ? toPurchaseId(toCaip2(lastSettled.network) ?? lastSettled.network, lastSettled.txHash)
          : null,
      observed_at: signed[0]?.attemptedAt ?? null,
      last_attempt_at: input.lastAttemptAt,
    },
    l2: {
      status: l2Status,
      declaration_hash: declarationHash,
      response_hash: responseHash,
      diff_hash: diffHash,
      missing_keys: missingKeys,
      observed_at: l2ObservedAt,
    },
    availability_7d: availability(within(7)),
    availability_30d: availability(within(30)),
    offer_stability: offerStabilityOf(probes),
    payees: input.payees,
    settlement_30d_real: real,
    settlement_30d_raw: raw,
    settlement_30d_test: test,
    unique_payers_30d_real: uniquePayersReal,
    wash_dominated: thirdPartyRaw >= WASH_DOMINATED_MIN_RAW && real <= thirdPartyRaw * WASH_DOMINATED_REAL_SHARE,
  };
}

/**
 * L2 の evidence（§6.3 / 2026-09-02 監査 P1-11）。conform / mismatch のときだけ。
 * 宣言・応答・差分のハッシュを載せる——第三者が同じ宣言・同じ本文から再計算できる。
 */
export function l2EvidenceOf(facts: SellerFacts, observatoryId: string, l2ContentType?: string | null): Evidence | null {
  if (facts.l2.status !== "conform" && facts.l2.status !== "mismatch") return null;
  // 2026-09-29.3（監査 6 周目）: mismatch のときは、記録してある不一致の中身を出す。欠けたキーの名前があれば
  // missing_keys、無ければ unexplained（何が違ったかを示せない＝判定は WARN・l2_mismatch_unexplained）。
  const mismatch =
    facts.l2.status === "mismatch"
      ? {
          mismatch_kind: (Array.isArray(facts.l2.missing_keys) && facts.l2.missing_keys.length > 0 ? "missing_keys" : "unexplained") as
            | "missing_keys"
            | "unexplained",
          ...(l2ContentType !== undefined ? { content_type: l2ContentType } : {}),
        }
      : {};
  return {
    level: "L2",
    source: "vet402",
    ...(facts.l1.last_purchase_id ? { purchase_id: facts.l1.last_purchase_id } : {}),
    url: `https://vet402.com/observatory/e/${observatoryId}`,
    declaration_hash: facts.l2.declaration_hash,
    response_hash: facts.l2.response_hash,
    diff_hash: facts.l2.diff_hash,
    missing_keys: facts.l2.missing_keys,
    ...mismatch,
  };
}

/**
 * 2026-09-29.3: facts.l2 を決めた応答（窓の中の最新の配達）の Content-Type。L2 が undeclared なら undefined
 * （evidence に載せない）、記録が無ければ null。assembleSellerFacts と同じ「配達」の述語で選ぶ。
 */
export function l2ContentTypeOf(purchases: readonly PurchaseInput[], facts: SellerFacts): string | null | undefined {
  if (facts.l2.status !== "conform" && facts.l2.status !== "mismatch") return undefined;
  const d = purchases.find((p) => isDelivered(p) && !isInconclusive(p));
  return d?.contentType ?? null;
}

export type SellerFactsLoaded = {
  facts: SellerFacts;
  /**
   * 最終試行の行（全履歴・status を問わない）。`at` は facts.l1.last_attempt_at と
   * 同じ値で、`status` は公開面には出さず `not_attempted_reason` の判別だけに使う
   * （生の status をそのまま出すと、我々の内部語彙が売り手の記録として読まれる）。
   */
  lastAttempt: { at: string | null; status: string | null };
  /** 2026-09-29: 判定へ渡す「売り手の不履行として数えない」試行（l1NotCountedOf）。公開の facts には載せない。 */
  l1NotCounted?: L1NotCounted;
  /**
   * 2026-09-29: L0 が unverified の原因（l0UnverifiedCauseOf）。判定の下位コードに使い、2026-09-29.2 からは
   * single_fail（公開ゲート未満の 1 回の fail）を BLOCK でなく WARN に読む材料にもなる。
   */
  l0UnverifiedCause?: string | null;
  /** 2026-09-29.2: 判定へ渡す窓の中の並び（l1TimelineOf）。応答の l1_basis の材料。 */
  l1Timeline?: L1Timeline;
  /** 2026-09-29 監査 5 周目: 最後に配達を確かめた購入の条件（応答の verified_terms）。無ければ null。 */
  verifiedTerms?: VerifiedTerms | null;
  /** 2026-09-29.3: L2 を決めた応答の Content-Type（l2ContentTypeOf）。L2 の evidence の content_type。 */
  l2ContentType?: string | null;
  endpoint: {
    id: string;
    resourceId: string | null;
    endpointHash: string | null;
    canonicalUrl: string;
    method: string;
    payTo: string | null;
    network: string | null;
    payeeId: string | null;
  };
};

/** raw_response_meta.l2（l1-runner の checkL2Detailed の出力）。形が違えば null。 */
function parseL2Detail(v: unknown): PurchaseInput["l2Detail"] {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.responseHash !== "string") return null;
  return {
    missing: Array.isArray(o.missing) ? o.missing.filter((k): k is string => typeof k === "string") : [],
    declarationHash: typeof o.declarationHash === "string" ? o.declarationHash : null,
    responseHash: o.responseHash,
    reason: typeof o.reason === "string" ? o.reason : null,
  };
}

/** Tempo（MPP）の CAIP-2。mpp-payer（支払いの依存）を判定の読み手へ持ち込まないため、値だけ置く。 */
const TEMPO_MAINNET_NETWORK = "eip155:4217";

/** 台帳の 1 行 → VerifiedTerms。欠けた列・読めない額は null（照合の材料を作らない）。純関数。 */
export function verifiedTermsOf(r: Record<string, unknown> | null): VerifiedTerms | null {
  if (!r) return null;
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
  const tx = str(r.tx_hash);
  const payTo = str(r.pay_to);
  const asset = str(r.asset);
  const amount = str(r.amount_units);
  const network = str(r.network);
  const at = toIsoUtc(str(r.attempted_at));
  if (!payTo || !asset || !amount || !/^[0-9]+$/.test(amount) || !network || !at) return null;
  // 2026-09-29 独立レビュー: XRPL の資産は台帳に通貨コードしか無く発行者が入らないので、偽の RLUSD と
  // 区別できない条件を「確かめた条件」として返さない（発行者を記録するまで null）。
  if (/^xrpl:/i.test(toCaip2(network) ?? network)) return null;
  const mpp = r.is_mpp === true || r.is_mpp === "t" || r.is_mpp === "true";
  return {
    // facts.l1.last_purchase_id と同じ形（CAIP-2:tx）。tx の無い行は null。
    purchase_id: tx ? toPurchaseId(toCaip2(network) ?? network, tx) : null,
    pay_to: /^0x/i.test(payTo) ? payTo.toLowerCase() : payTo,
    // Tempo 等の台帳は 0x の資産アドレスに大文字小文字が混じる。受取先と同じく小文字にそろえる。
    asset: /^0x/i.test(asset) ? asset.toLowerCase() : asset,
    amount,
    decimals: 6,
    network: toCaip2(network) ?? network,
    scheme: mpp ? "charge" : "exact",
    protocol: mpp ? "mpp" : "x402",
    verified_at: at,
  };
}

/** endpoint uuid から 30 日分の事実を組む。無ければ null。 */
export async function loadSellerFacts(endpointUuid: string): Promise<SellerFactsLoaded | null> {
  const db = getDb();
  if (!db) return null;
  const eps = rowsOf<{
    id: string;
    resource_id: string | null;
    endpoint_hash: string | null;
    canonical_url: string;
    method: string;
    pay_to: string | null;
    network: string | null;
    payee_id: string | null;
    declared_schema: unknown | null;
    raw_method: string | null;
    declared_input: unknown | null;
    listing_status: string | null;
  }>(
    await db.execute(sql`
      SELECT id::text AS id, resource_id, endpoint_hash, coalesce(canonical_url, resource_url) AS canonical_url,
             coalesce(method, 'GET') AS method, pay_to, network, payee_id, declared_schema,
             method AS raw_method, declared_input, status AS listing_status
      FROM x402_endpoints WHERE id = ${endpointUuid}::uuid LIMIT 1
    `),
  );
  const ep = eps[0];
  if (!ep) return null;

  const probes = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      SELECT probed_at::text AS probed_at, verdict, dialect, fail_reason, price_consistent, metadata_consistent
      FROM x402_l0_probes WHERE endpoint_id = ${endpointUuid}::uuid AND probed_at > now() - interval '30 days'
      ORDER BY probed_at DESC LIMIT 200
    `),
  ).map<ProbeInput>((r) => ({
    probedAt: String(r.probed_at),
    verdict: String(r.verdict),
    dialect: r.dialect === null ? null : String(r.dialect),
    failReason: r.fail_reason === null ? null : String(r.fail_reason),
    // 封筒の価格・受取先はプローブ行に個別保存していないので、カタログ宣言との
    // 一致（price_consistent / metadata_consistent）を offer_stability の材料にする。
    // 一致していれば宣言と同じ、一致していなければ「変わった」とみなす。
    priceAmount: r.price_consistent === false ? "changed" : "declared",
    priceAsset: null,
    payTo: r.metadata_consistent === false ? "changed" : "declared",
  }));

  const purchaseRows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      SELECT attempted_at::text AS attempted_at, status, latency_ms, http_status_paid, payload_non_empty, l2_schema, tx_hash, network,
             to_char(attempted_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS attempted_at_utc,
             CASE WHEN jsonb_typeof(raw_response_meta) = 'object' THEN left(raw_response_meta->>'contentType', 60) END AS content_type,
             raw_response_meta->'l2' AS l2_detail,
             CASE WHEN l2_schema = 'mismatch' AND jsonb_typeof(raw_response_meta) = 'object' THEN left(raw_response_meta->>'bodyHead', 500) END AS body_head,
             CASE WHEN jsonb_typeof(raw_response_meta) = 'object' THEN jsonb_strip_nulls(jsonb_build_object(
               'requestBody', CASE WHEN raw_response_meta ? 'requestBody' THEN
                 CASE WHEN jsonb_typeof(raw_response_meta->'requestBody') = 'string' THEN to_jsonb(left(raw_response_meta->>'requestBody', 16)) ELSE 'true'::jsonb END END,
               'requestQuery', raw_response_meta->'requestQuery')) END AS request_meta,
             amount_units, payer, left(auth_nonce, 80) AS auth_nonce,
             CASE WHEN status = 'settle_failed' AND tx_hash IS NOT NULL THEN
               (settlement_verified IS TRUE OR EXISTS (SELECT 1 FROM settlements s WHERE s.tx_hash IN (p.tx_hash, lower(p.tx_hash))))
             END AS settlement_confirmed
      FROM x402_l1_purchases p WHERE endpoint_id = ${endpointUuid}::uuid AND attempted_at > now() - interval '30 days'
      ORDER BY attempted_at DESC LIMIT 200
    `),
  );
  // 2026-09-29.3: 同じ行を /sellers と記録頁がどちらの側に置いたか（readRecordSides・記録頁と同じ 1 本）。
  // 読めなければ分類なし（お金が動いていない失敗を数える側＝WARN まで）で続ける。理由はログに残す。
  let sides: Awaited<ReturnType<typeof readRecordSides>> | null = null;
  try {
    sides = await readRecordSides(db, endpointUuid);
  } catch (error) {
    logServerErrorSafe("decision.seller_view", error);
  }
  const viewOf = (r: Record<string, unknown>): SellerRowView | null => {
    if (!sides || typeof r.attempted_at_utc !== "string") return null;
    const shown = sides.rows.get(recordRowKey(r.attempted_at_utc, String(r.status), r.tx_hash === null ? null : String(r.tx_hash)));
    return shown ? { bucket: shown.bucket, modeKey: shown.mode?.key ?? null, held: shown.held, money: shown.money, delivered: shown.bucket === "delivered" } : null;
  };
  const purchases = purchaseRows.map<PurchaseInput>((r) => ({
    attemptedAt: String(r.attempted_at),
    status: String(r.status),
    latencyMs: r.latency_ms === null ? null : Number(r.latency_ms),
    httpStatusPaid: r.http_status_paid === null ? null : Number(r.http_status_paid),
    payloadNonEmpty: r.payload_non_empty === null ? null : Boolean(r.payload_non_empty),
    l2Schema: r.l2_schema === null ? null : String(r.l2_schema),
    txHash: r.tx_hash === null ? null : String(r.tx_hash),
    network: r.network === null ? null : String(r.network),
    l2Detail: parseL2Detail(r.l2_detail),
    bodyHead: typeof r.body_head === "string" ? r.body_head : null,
    requestMeta:
      typeof r.request_meta === "object" && r.request_meta !== null && !Array.isArray(r.request_meta)
        ? (r.request_meta as Record<string, unknown>)
        : null,
    amountUnits: r.amount_units === null || r.amount_units === undefined ? null : String(r.amount_units),
    payer: r.payer === null || r.payer === undefined ? null : String(r.payer),
    settlementConfirmed: r.settlement_confirmed === null || r.settlement_confirmed === undefined ? null : Boolean(r.settlement_confirmed),
    sellerView: viewOf(r),
    authNonce: typeof r.auth_nonce === "string" && r.auth_nonce !== "" ? r.auth_nonce : null,
    contentType: typeof r.content_type === "string" && r.content_type !== "" ? r.content_type : null,
  }));

  // 最終試行は 30 日窓の外も見る（窓で切ると 31 日前の試行が「一度も無い」に化ける）。
  // status を問わないので、署名前に終わった行（no_eligible_accept / over_cap /
  // halted …）でも時刻が立つ。endpoint_id の索引で 1 行取るだけ。
  const lastAttemptRows = rowsOf<{ attempted_at: string | null; status: string | null }>(
    await db.execute(sql`
      SELECT attempted_at::text AS attempted_at, status
      FROM x402_l1_purchases WHERE endpoint_id = ${endpointUuid}::uuid
      ORDER BY attempted_at DESC LIMIT 1
    `),
  );
  const lastAttempt = {
    // ::text は "2026-09-04 19:02:29.789686+00" を返す。公開面は ISO8601 UTC で出す
    // （payOrRefuse がこの時刻を拒否理由の文面へそのまま載せる）。
    at: toIsoUtc(lastAttemptRows[0]?.attempted_at ?? null),
    status: lastAttemptRows[0]?.status ?? null,
  };

  // 2026-09-29.2: 全履歴の最後の署名した試行と最後の配達（窓の外の試行を「一度も無い」と読まない・l1_stale）。
  // 配達の述語は facts.l1.n_delivered と同じ（settled・2xx・非空）。
  const lastSignedRows = rowsOf<{ last_signed: string | null; last_delivered: string | null }>(
    await db.execute(sql`
      SELECT max(attempted_at) FILTER (WHERE status IN (${sql.raw(SIGNED_STATUS_SQL_LIST)}))::text AS last_signed,
             max(attempted_at) FILTER (WHERE ${sql.raw(DELIVERED_ROW_SQL)})::text AS last_delivered
      FROM x402_l1_purchases WHERE endpoint_id = ${endpointUuid}::uuid
    `),
  );

  // 2026-09-29 監査 5 周目: 最後に配達を確かめた購入で払った条件（全履歴・配達の述語は上と同じ）。
  const verifiedTermsRows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      SELECT tx_hash, pay_to, asset, amount_units, network, attempted_at::text AS attempted_at,
             (raw_response_meta->>'protocol' = 'mpp' OR network = ${TEMPO_MAINNET_NETWORK}) AS is_mpp
      FROM x402_l1_purchases
      WHERE endpoint_id = ${endpointUuid}::uuid
        AND ${sql.raw(DELIVERED_ROW_SQL)}
        AND pay_to IS NOT NULL AND asset IS NOT NULL AND amount_units IS NOT NULL AND network IS NOT NULL
      ORDER BY attempted_at DESC LIMIT 1
    `),
  );
  const verifiedTerms = verifiedTermsOf(verifiedTermsRows[0] ?? null);

  const settlements30d = await getSettlementCounts({ endpointId: endpointUuid });
  const factsInput = {
    probes,
    purchases,
    settlements30d,
    payees: ep.payee_id ? [ep.payee_id] : [],
    declaredSchema: ep.declared_schema ?? null,
    method: ep.raw_method,
    declaredInput: ep.declared_input ?? null,
    lastAttemptAt: lastAttempt.at,
    lastSignedAttemptAt: toIsoUtc(lastSignedRows[0]?.last_signed ?? null),
    lastDeliveredAt: toIsoUtc(lastSignedRows[0]?.last_delivered ?? null),
  };
  const facts = assembleSellerFacts(factsInput);
  return {
    facts,
    lastAttempt,
    l1NotCounted: l1NotCountedOf(factsInput),
    l0UnverifiedCause: l0UnverifiedCauseOf(probes),
    l1Timeline: l1TimelineOf(factsInput),
    verifiedTerms,
    l2ContentType: l2ContentTypeOf(purchases, facts),
    endpoint: {
      id: ep.id,
      resourceId: ep.resource_id,
      endpointHash: ep.endpoint_hash,
      canonicalUrl: ep.canonical_url,
      method: ep.method,
      payTo: ep.pay_to,
      network: ep.network,
      payeeId: ep.payee_id,
    },
  };
}
