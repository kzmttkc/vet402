"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * 売り手頁の出品ごとの「判定 API の今の答え」（2026-09-29 敵対的監査 5 周目）。
 *
 * 売り手頁は失敗を「vet402 に落ち度が無いと行の記録で示せる」ときだけ売り手の側に置く。判定 API は払う側に慎重で、
 * 除くのは vet402 の落ち度を示せる行だけ。だから同じ出品で頁は「not sorted」、判定は WARN / BLOCK になりうる
 * （意図どおりの非対称）。頁が黙っていると矛盾に見えるので、出品ごとに判定 API そのものの答えを並べる。
 *
 * なぜ閲覧者のブラウザから公開の判定 API を呼ぶか: 判定を組む関数（src/lib/decision/seller-facts.ts）は L0 プローブ
 * （src/lib/observatory/l0-probe.ts）を経て支払いのモジュールを読み込むので、/sellers の頁のサーバ側から呼ぶと
 * tests/sellers-no-payment-imports.test.ts の関門（頁のバンドルに支払いのコードを持ち込まない）を破る。判定のコードも
 * L0 プローブも別の担当なので変えない。公開の API（鍵なし・同じ IP から 10 回/分）をそのまま呼べば、頁に出るのは
 * 判定 API が実際に返した答えそのもの（別の経路で組み直した答えではない）。
 *
 * 自動で問い合わせるのは頁の先頭の数件だけ（auto・SellersViews の DECISION_AUTO_LISTINGS）。残りはボタンで 1 件ずつ。
 * JS が無くても「the full answer」のリンクで同じ答えを開ける。429 は「1 分後にもう一度」と書く。読んだ答えは同じタブで
 * 5 分使い回す（sessionStorage・開き直しで枠を使い切らない）。
 */

type Answer = { recommendation: string; reasonCodes: string[]; scoredAt: string | null };
type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "done"; answer: Answer }
  | { kind: "rate_limited" }
  | { kind: "error" };

/** 頁に出す理由コードの数（残りは「+N more」・全部は API の応答にある）。 */
export const DECISION_CODES_SHOWN = 3;

export function decisionApiHref(resourceId: string): string {
  return `/api/v1/resources/${resourceId}/decision?role=payer`;
}

/**
 * 主な理由コードを先に（表示の並べ替えだけ・コードは変えない）: L1 の語 → L0 の pass 以外 → L2 の undeclared 以外 → 残り。
 * 応答の順（L0 → L1 → L2）のまま先頭 3 件を出すと、BLOCK の理由でない l0_pass が先頭に来た（2026-09-29 画面の確認）。
 */
export function codeRank(code: string): number {
  if (code.startsWith("l1_")) return 0;
  if (code.startsWith("l0_") && code !== "l0_pass") return 1;
  if (code.startsWith("l2_") && code !== "l2_undeclared") return 2;
  return 3;
}

/** 応答の本文から、頁に出す部分だけを取り出す（形が違えば null）。 */
export function answerOf(body: unknown): Answer | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.recommendation !== "ALLOW" && b.recommendation !== "WARN" && b.recommendation !== "BLOCK") return null;
  const codes = Array.isArray(b.reason_codes) ? b.reason_codes.filter((c): c is string => typeof c === "string") : [];
  const ordered = codes.map((c, i) => ({ c, i })).sort((x, y) => codeRank(x.c) - codeRank(y.c) || x.i - y.i).map((x) => x.c);
  return { recommendation: b.recommendation, reasonCodes: ordered, scoredAt: typeof b.scoredAt === "string" ? b.scoredAt : null };
}

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
        JSON.stringify({ at: Date.now(), answer: { recommendation: b.recommendation, reason_codes: b.reason_codes, scoredAt: b.scoredAt } }),
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
  const shown = a.reasonCodes.slice(0, DECISION_CODES_SHOWN);
  const more = a.reasonCodes.length - shown.length;
  const at = fmtUtc(a.scoredAt);
  return (
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
      {at && <>, computed {at}</>} · {full}.
      {a.recommendation !== "ALLOW" && !sellerSide && (
        <>
          {" "}
          The decision API is cautious for the payer and counts attempts differently from this page: it also counts
          attempts this page leaves not sorted, so it can answer WARN or BLOCK while this page does not put a failure
          on the seller&apos;s side (
          <Link href="/docs/api#verdicts" className={TAP}>
            how the decision counts
          </Link>
          ).
        </>
      )}
    </span>
  );
}
