"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * 売り手頁の出品ごとの「判定 API の今の答え」（2026-09-29 敵対的監査 5 周目）。
 *
 * 売り手頁は失敗を「vet402 に落ち度が無いと行の記録で示せる」ときだけ売り手の側に置く。判定 API は払う側に慎重で、
 * 除くのは vet402 の落ち度を示せる行だけ。だから同じ出品で頁は「not sorted」、判定は WARN / BLOCK になりうる
 * （意図どおりの非対称）。頁が黙っていると矛盾に見えるので、出品ごとに判定 API そのものの答えを並べる。
 * 2026-09-29（規則 2026-09-29.3）: 非対称はお金が動いた行だけになった。お金の動いていない失敗は、頁が売り手の側
 * （確定）に置いた行だけを判定も数え、WARN まで。L1 の BLOCK は「払ったのに届かなかった」が最後の配達より後に 2 回以上
 * だけ。l2_mismatch の BLOCK は欠けたキーを記録したときだけ（無ければ l2_mismatch_unexplained・WARN）。
 * 本文を読み切れなかった応答（256 KiB 超・閉じていない JSON）は L2 を判定しない（not_checked）。
 *
 * なぜ閲覧者のブラウザから公開の判定 API を呼ぶか: 判定を組む関数（src/lib/decision/seller-facts.ts）は L0 プローブ
 * （src/lib/observatory/l0-probe.ts）を経て支払いのモジュールを読み込むので、/sellers の頁のサーバ側から呼ぶと
 * tests/sellers-no-payment-imports.test.ts の関門（頁のバンドルに支払いのコードを持ち込まない）を破る。判定のコードも
 * L0 プローブも別の担当なので変えない。公開の API（鍵なし・同じ IP から 10 回/分）をそのまま呼べば、頁に出るのは
 * 判定 API が実際に返した答えそのもの（別の経路で組み直した答えではない）。
 *
 * 2026-09-29 監査 6 周目: 以前は WARN / BLOCK に一律で「頁が not sorted に置く試行も数えるので」と添えていたが、答えを
 * 決めたのが L0 の失敗（l0_fail）や古い配達（l1_stale）のときは当てはまらなかった。答えを決めた否定のコードを先に並べ、
 * コードごとの 1 文（codeExplanation）を出す。数え方の違いは、数えた試行から出るコードのときだけ（decisionWhy）。
 *
 * 自動で問い合わせるのは頁の先頭の数件だけ（auto・SellersViews の DECISION_AUTO_LISTINGS）。残りはボタンで 1 件ずつ。
 * JS が無くても「the full answer」のリンクで同じ答えを開ける。429 は「1 分後にもう一度」と書く。読んだ答えは同じタブで
 * 5 分使い回す（sessionStorage・開き直しで枠を使い切らない）。
 */

/** 判定 API が L1 について読んだ数と時刻のうち、説明の文に使うもの（応答の l1_basis）。 */
type Basis = {
  freshDays: number | null;
  windowDays: number | null;
  nCounted: number | null;
  nPaidUndeliveredSince: number | null;
  daysSinceLastDelivery: number | null;
  lastDeliveredAt: string | null;
};
type Answer = {
  recommendation: "ALLOW" | "WARN" | "BLOCK";
  /** 表示の順（答えを決めた否定のコード → 残りの否定のコード → 残り）。 */
  reasonCodes: string[];
  /** 答えを決めた否定のコード（ALLOW は空）。 */
  decisive: string[];
  scoredAt: string | null;
  basis: Basis | null;
  /** facts.l2.missing_keys（mismatch のとき・無ければ null）。 */
  l2MissingKeys: string[] | null;
  /** facts.l0.fail_reason（無ければ null）。 */
  l0FailReason: string | null;
};
type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "done"; answer: Answer }
  | { kind: "rate_limited" }
  | { kind: "error" };

/** 頁に出す理由コードの数の下限（答えを決めたコードは全部出す・残りは「+N more」・全部は API の応答にある）。 */
export const DECISION_CODES_SHOWN = 3;

/** 理由コードの説明（別の担当が /docs/api に作る節）。 */
export const REASON_CODES_HREF = "/docs/api#reason-codes";

export function decisionApiHref(resourceId: string): string {
  return `/api/v1/resources/${resourceId}/decision?role=payer`;
}

/** 否定でない（それだけでは WARN / BLOCK にしない）コード。 */
const NEUTRAL = new Set(["l0_pass", "l1_delivered", "l2_conform", "l2_undeclared", "l1_waived_by_operator"]);
const isNeutral = (c: string) => NEUTRAL.has(c) || c.startsWith("l1_not_counted_");
/** l0_unverified の原因を添える下位コード（l0_unverified_<cause>）。 */
const isL0Cause = (c: string) => c.startsWith("l0_unverified_");
/**
 * 数えた試行から出るコード。規則 2026-09-29.3 では、頁が not sorted に置く試行を判定が数えるのはお金が動いた行だけ
 * なので、このコードが答えを決めたときだけ数え方の違い（COUNTING_NOTE）を書く。
 */
export const COUNTED_ATTEMPT_CODES: ReadonlySet<string> = new Set(["l1_never_delivered", "l1_paid_not_delivered", "l1_latest_failed"]);

/**
 * そのコードが BLOCK を決めうるか（公開の規則・/docs/api の表と同じ: rules.ts は import しない）。数の要るコードは
 * l1_basis があれば数で決め、無ければ決めうる側に倒す（BLOCK の理由を黙らない）。
 */
function blockCapable(code: string, codes: readonly string[], basis: Basis | null): boolean {
  switch (code) {
    case "l0_fail":
    case "wash_dominated":
    case "operator_blacklist":
      return true;
    case "l0_unverified":
      // 確かめられた 1 回の fail（single_fail で unconfirmed が無い）だけ WARN。
      return !(codes.includes("l0_unverified_single_fail") && !codes.includes("l0_unverified_single_fail_unconfirmed"));
    case "l1_paid_not_delivered":
      return basis?.nPaidUndeliveredSince == null || basis.nPaidUndeliveredSince >= 2;
    case "l2_mismatch":
      // 規則 2026-09-29.3: 欠けたキーを記録した不一致だけが BLOCK。記録が無ければ l2_mismatch_unexplained・WARN。
      return !codes.includes("l2_mismatch_unexplained");
    // l1_never_delivered は規則 2026-09-29.3 から WARN（BLOCK は l1_paid_not_delivered が 2 回以上のときだけ）。
    default:
      return false;
  }
}

/** 答えを決めた否定のコード（応答の順）。BLOCK で決めうるコードが見つからなければ否定のコード全部。 */
export function decisiveCodes(recommendation: string, codes: readonly string[], basis: Basis | null = null): string[] {
  if (recommendation === "ALLOW") return [];
  const negatives = codes.filter((c) => !isNeutral(c) && !isL0Cause(c));
  if (recommendation === "WARN") return negatives;
  const block = negatives.filter((c) => blockCapable(c, codes, basis));
  return block.length > 0 ? block : negatives;
}

/**
 * 表示の順（2026-09-29 監査 6 周目）: 答えを決めた否定のコードを先に、次に残りの否定のコード、最後に否定でないコード。
 * l0_unverified の原因のコードは l0_unverified のすぐ後。同じ組の中は応答の順。表示の並べ替えだけ（コードは変えない）。
 */
export function orderCodes(recommendation: string, codes: readonly string[], basis: Basis | null = null): string[] {
  const decisive = new Set(decisiveCodes(recommendation, codes, basis));
  const rank = (c: string) => {
    const k = isL0Cause(c) ? "l0_unverified" : c;
    if (decisive.has(k)) return 0;
    if (!isNeutral(c)) return 1;
    return 2;
  };
  // 応答は l0_unverified の直後に原因のコードを置くので、同じ組の中は応答の順のままでよい。
  return codes
    .map((c, i) => ({ c, i, r: rank(c) }))
    .sort((x, y) => x.r - y.r || x.i - y.i)
    .map((x) => x.c);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function basisOf(v: unknown): Basis | null {
  if (typeof v !== "object" || v === null) return null;
  const b = v as Record<string, unknown>;
  return {
    freshDays: num(b.fresh_days),
    windowDays: num(b.window_days),
    nCounted: num(b.n_counted),
    nPaidUndeliveredSince: num(b.n_paid_undelivered_since_last_delivery),
    daysSinceLastDelivery: num(b.days_since_last_delivery),
    lastDeliveredAt: typeof b.last_delivered_at === "string" ? b.last_delivered_at : null,
  };
}

/** 応答の本文から、頁に出す部分だけを取り出す（形が違えば null）。 */
export function answerOf(body: unknown): Answer | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.recommendation !== "ALLOW" && b.recommendation !== "WARN" && b.recommendation !== "BLOCK") return null;
  const codes = Array.isArray(b.reason_codes) ? b.reason_codes.filter((c): c is string => typeof c === "string") : [];
  const basis = basisOf(b.l1_basis);
  const facts = typeof b.facts === "object" && b.facts !== null ? (b.facts as Record<string, unknown>) : {};
  const l2 = typeof facts.l2 === "object" && facts.l2 !== null ? (facts.l2 as Record<string, unknown>) : {};
  const l0 = typeof facts.l0 === "object" && facts.l0 !== null ? (facts.l0 as Record<string, unknown>) : {};
  const missing = Array.isArray(l2.missing_keys) ? l2.missing_keys.filter((k): k is string => typeof k === "string") : null;
  return {
    recommendation: b.recommendation,
    reasonCodes: orderCodes(b.recommendation, codes, basis),
    decisive: decisiveCodes(b.recommendation, codes, basis),
    scoredAt: typeof b.scoredAt === "string" ? b.scoredAt : null,
    basis,
    l2MissingKeys: missing,
    l0FailReason: typeof l0.fail_reason === "string" ? l0.fail_reason : null,
  };
}

/** 売り手の書いた短い語（キー名・理由）を表示用に: 印字できる ASCII だけ・短く。 */
function safe(v: string, n = 40): string {
  return v.replace(/[^\x20-\x7e]/g, "").trim().slice(0, n);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * 答えを決めたコードごとの 1 文（2026-09-29 監査 6 周目・高）。以前は WARN / BLOCK に一律で「頁が not sorted に置く
 * 試行も数えるので」と書いていたが、答えを決めたのが L0 の失敗や古い配達のときは当てはまらなかった
 * （keyring-agent…/swap-token は l0_fail、agentdata…/crypto/scan は l1_stale）。数え方の違いを書くのは
 * COUNTED_ATTEMPT_CODES のときだけ（呼び手が付ける）。知らないコードは null（書かない）。
 */
export function codeExplanation(code: string, a: Pick<Answer, "reasonCodes" | "basis" | "l2MissingKeys" | "l0FailReason">): string | null {
  const b = a.basis;
  const fresh = b?.freshDays ?? 30;
  switch (code) {
    case "l0_fail": {
      const reason = a.l0FailReason ? safe(a.l0FailReason) : "";
      return `The check before payment failed: two L0 probes in a row did not get a valid 402 to an unpaid request${reason ? ` (reason ${reason})` : ""}.`;
    }
    case "l0_unverified": {
      const cause = a.reasonCodes.find((c) => isL0Cause(c) && c !== "l0_unverified_single_fail_unconfirmed")?.slice("l0_unverified_".length) ?? null;
      if (cause === "single_fail") {
        return a.reasonCodes.includes("l0_unverified_single_fail_unconfirmed")
          ? "The latest check before payment (L0) failed once, and no newer probe has confirmed it either way."
          : "The latest check before payment (L0) failed once; the one before it passed. Two failures in a row publish a fail.";
      }
      if (cause === "not_probed") return "The 402 to an unpaid request has not been checked yet (no L0 probe).";
      return `The check before payment could not confirm a valid 402 to an unpaid request (L0 unverified${cause ? `: ${safe(cause)}` : ""}).`;
    }
    case "l1_stale":
      if (b?.lastDeliveredAt && b.daysSinceLastDelivery !== null && b.daysSinceLastDelivery > fresh) {
        return `The last delivery was ${Math.floor(b.daysSinceLastDelivery)} days ago, more than ${fresh}.`;
      }
      if (b && !b.lastDeliveredAt) return `vet402 has no paid attempt here in the last ${b.windowDays ?? 30} days; its last one is older.`;
      return `The last delivery, or vet402's last paid attempt, is more than ${fresh} days old.`;
    case "l1_not_attempted":
      return "vet402 has not made a paid attempt here yet, so there is no delivery to go on.";
    case "l1_inconclusive":
      return "None of the paid attempts in the last 30 days counts either way: each is on vet402's side, held, took no payment, or failed without money moving in a way this page has not put on the seller's side.";
    case "l1_never_delivered":
      return b?.nCounted != null
        ? `None of the ${plural(b.nCounted, "counted paid attempt", "counted paid attempts")} in the last 30 days delivered. On its own this is a WARN.`
        : "No counted paid attempt in the last 30 days delivered. On its own this is a WARN.";
    case "l1_paid_not_delivered":
      return b?.nPaidUndeliveredSince != null
        ? `${plural(b.nPaidUndeliveredSince, "paid attempt", "paid attempts")} since the last delivery took payment and did not deliver.`
        : "Paid attempts since the last delivery took payment and did not deliver.";
    case "l1_latest_failed":
      return "The latest counted paid attempt did not deliver.";
    case "l1_empty_2xx_settlement_unknown":
      return "Since the last delivery, a paid attempt got an empty 2xx and no settlement is linked to it yet, so it is not known whether money moved.";
    case "l2_mismatch": {
      const keys = (a.l2MissingKeys ?? []).map((k) => safe(k)).filter((k) => k !== "");
      if (keys.length === 0) {
        return "The paid response did not match the output schema the listing declares, but no missing field is on record (the body was not JSON, was JSON that was not closed, was not an object, or was not sent as JSON), so this is a WARN.";
      }
      const shown = keys.slice(0, 5).join(", ");
      return `The paid response lacked fields the listing's output schema declares: ${shown}${keys.length > 5 ? `, +${keys.length - 5} more` : ""}.`;
    }
    case "offer_drifting":
      return "The listing's price or receiving address changed between observations.";
    case "wash_dominated":
      return "Almost none of the settlements reported for this listing come from third-party payers.";
    case "operator_blacklist":
      return "The operator has blocked this seller.";
    case "data_thin":
      return "There is too little recorded about this listing to go on.";
    case "dialect_mismatch":
      return "The listing speaks a different x402 version from the caller's.";
    default:
      return null;
  }
}

/** 数え方の違いの 1 文（COUNTED_ATTEMPT_CODES が答えを決め、頁が売り手の側に置いていないときだけ）。 */
export const COUNTING_NOTE =
  "The decision counts a paid attempt that took payment and did not deliver even when this page leaves it not sorted. A failure where no money moved counts only once this page puts it on the seller's side, and then only toward a WARN.";

function fmtUtc(iso: string | null): string | null {
  return iso && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso) ? `${iso.slice(0, 16).replace("T", " ")} UTC` : null;
}

const TAP = "inline-flex min-h-6 items-center underline";

/**
 * 同じタブで読んだ答えを持つ時間（判定 API の応答のキャッシュと同じ 5 分）。頁を開き直すたびに鍵なしの枠
 * （10 回/分）を使い切らないため。読めない・書けない（プライベートウィンドウ等）ときは毎回問い合わせる。
 */
const REUSE_MS = 5 * 60_000;
const storeKey = (resourceId: string) => `vet402:decision:${resourceId}`;

function reused(resourceId: string): Answer | null {
  try {
    const raw = sessionStorage.getItem(storeKey(resourceId));
    if (!raw) return null;
    const v = JSON.parse(raw) as { at?: number; answer?: unknown };
    if (typeof v.at !== "number" || Date.now() - v.at > REUSE_MS) return null;
    return answerOf(v.answer);
  } catch {
    return null;
  }
}

async function fetchAnswer(resourceId: string): Promise<State> {
  const kept = reused(resourceId);
  if (kept) return { kind: "done", answer: kept };
  try {
    const res = await fetch(decisionApiHref(resourceId), { headers: { accept: "application/json" } });
    if (res.status === 429) return { kind: "rate_limited" };
    if (!res.ok) return { kind: "error" };
    const body: unknown = await res.json();
    const answer = answerOf(body);
    if (!answer) return { kind: "error" };
    try {
      const b = body as Record<string, unknown>;
      sessionStorage.setItem(
        storeKey(resourceId),
        JSON.stringify({
          at: Date.now(),
          answer: {
            recommendation: b.recommendation,
            reason_codes: b.reason_codes,
            scoredAt: b.scoredAt,
            l1_basis: b.l1_basis,
            // 説明の文に使う 2 つだけ（応答の facts 全体は持たない）。
            facts: { l2: { missing_keys: answer.l2MissingKeys }, l0: { fail_reason: answer.l0FailReason } },
          },
        }),
      );
    } catch {
      // 保存できなくても答えは出す。
    }
    return { kind: "done", answer };
  } catch {
    return { kind: "error" };
  }
}

export default function DecisionAnswer({
  resourceId,
  auto,
  sellerSide,
}: {
  resourceId: string;
  /** 描画の直後に自動で問い合わせる（頁の先頭の数件だけ）。 */
  auto: boolean;
  /** 頁がこの出品の最新の失敗を売り手の側（確定）に置いている。置いていなければ WARN / BLOCK に 1 文を添える。 */
  sellerSide: boolean;
}) {
  const [state, setState] = useState<State>(auto ? { kind: "loading" } : { kind: "idle" });

  async function ask() {
    setState({ kind: "loading" });
    setState(await fetchAnswer(resourceId));
  }

  useEffect(() => {
    if (!auto) return;
    let live = true;
    void fetchAnswer(resourceId).then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, [auto, resourceId]);

  const full = (
    <a href={decisionApiHref(resourceId)} className={TAP} rel="nofollow">
      the full answer
    </a>
  );

  if (state.kind !== "done") {
    return (
      <span className="block">
        <strong>Decision API now:</strong>{" "}
        {state.kind === "loading" ? (
          <>asking… · {full}</>
        ) : state.kind === "rate_limited" ? (
          <>the key-less limit (10 per minute) is used up; try again in a minute · {full}</>
        ) : (
          <>
            {state.kind === "error" && <>could not be read just now · </>}
            <button type="button" onClick={() => void ask()} className={`${TAP} cursor-pointer`}>
              ask for this listing
            </button>{" "}
            · {full}
          </>
        )}
      </span>
    );
  }
  const a = state.answer;
  const shown = a.reasonCodes.slice(0, Math.max(DECISION_CODES_SHOWN, a.decisive.length));
  const more = a.reasonCodes.length - shown.length;
  const at = fmtUtc(a.scoredAt);
  const why = decisionWhy(a, sellerSide);
  return (
    <span className="block">
      <span className="block">
        <strong>Decision API now:</strong> <code>{a.recommendation}</code>
        {shown.length > 0 && (
          <>
            {" "}
            (
            {shown.map((c, i) => (
              <span key={c}>
                {i > 0 && ", "}
                <code>{c}</code>
              </span>
            ))}
            {more > 0 && <>, +{more} more</>})
          </>
        )}
        {at && <>, computed {at}</>} · {full} ·{" "}
        <Link href={REASON_CODES_HREF} className={TAP}>
          what the codes mean
        </Link>
      </span>
      {why.length > 0 && (
        <span className="block">
          <strong>Why {a.recommendation}:</strong> {why.join(" ")}
        </span>
      )}
    </span>
  );
}

/**
 * WARN / BLOCK の理由の文（答えを決めたコードの順・知らないコードは書かない）。数え方の違い（COUNTING_NOTE）は、
 * 数えた試行から出るコードが答えを決め、頁がこの出品の失敗を売り手の側に置いていないときだけ最後に 1 回。
 */
export function decisionWhy(a: Pick<Answer, "recommendation" | "decisive" | "reasonCodes" | "basis" | "l2MissingKeys" | "l0FailReason">, sellerSide: boolean): string[] {
  if (a.recommendation === "ALLOW") return [];
  const lines = a.decisive.map((c) => codeExplanation(c, a)).filter((x): x is string => x !== null);
  if (!sellerSide && a.decisive.some((c) => COUNTED_ATTEMPT_CODES.has(c))) lines.push(COUNTING_NOTE);
  return lines;
}
