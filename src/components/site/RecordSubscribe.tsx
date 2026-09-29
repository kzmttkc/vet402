"use client";

import { useId, useRef, useState } from "react";
import { buttonClass } from "@/components/ui/Button";
import { track } from "@/lib/analytics";

/**
 * RecordSubscribe — 段 2「名前を取る」の欄（2026-09-02 敵対的監査 F6 / F7）。
 *
 * endpoint 記録頁の、価値を受け取った直後の位置に置く。対価はページごと:
 *   notify  — この記録の公開判定が変わったら 1 通
 *   dispute — この記録への異議（理由つき）。人が読む
 * RFC の紙の文法（doc-caption / doc-input / buttonClass）。装飾なし、枠なし。
 * 送信は fetch。成功時は受付番号を残す（人が support へ問い合わせる時の鍵）。
 * 2026-09-28 監査: notify はダブルオプトイン。成功表示は「確認メールを見て」。
 * Plausible: record_subscribe{kind}（送信成功）と dispute_start（異議欄に初めて触れた時・1 回だけ）。
 * email も理由の本文も送らない。
 */
export default function RecordSubscribe({
  endpointId,
  kind,
  initialReason,
}: {
  endpointId: string;
  kind: "notify" | "dispute";
  /** 異議欄の書き出し（2026-09-29 第4巡: 売り手頁の行の「Dispute this purchase」が購入の時刻を渡す）。 */
  initialReason?: string;
}) {
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState(kind === "dispute" ? (initialReason ?? "") : "");
  const [website, setWebsite] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [receipt, setReceipt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mailDown, setMailDown] = useState(false);
  const uid = useId();
  const disputeStarted = useRef(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  // 2026-09-29 監査 5 周目（WCAG 2.2・3.3.1）: 誤りは欄を離れたとき・送信を押したときに、その欄の下へ出す。
  const [touched, setTouched] = useState<{ email?: boolean; reason?: boolean }>({});
  // 2026-09-28 PMF 計測: 異議の「開始」（欄に初めて触れた）を送信成功と分けて数える。
  function markDisputeStart() {
    if (kind !== "dispute" || disputeStarted.current) return;
    disputeStarted.current = true;
    track("dispute_start");
  }

  const reasonLength = reason.trim().length;
  // 書き出し（initialReason）だけでは送れない: 最低 20 字は書き出しの後に本人が書いた分で数える。
  const prefill = kind === "dispute" && initialReason && reason.startsWith(initialReason) ? initialReason.trim().length : 0;
  const ownLength = Math.max(0, reasonLength - prefill);
  const emailError = emailProblem(email);
  const reasonError = kind === "dispute" ? reasonProblem(ownLength, reasonLength, prefill > 0) : null;
  const showEmailError = touched.email ? emailError : null;
  const showReasonError = touched.reason ? reasonError : null;
  const emailErrorId = `${uid}-email-error`;
  const reasonErrorId = `${uid}-reason-error`;
  const reasonCountId = `${uid}-reason-count`;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (state === "sending") return;
    // 2026-09-29 監査 5 周目: 送信ボタンは理由なく disabled にしない。押されたら誤りを出して最初の誤りの欄へ。
    if (emailError || reasonError) {
      setTouched({ email: true, reason: true });
      if (emailError) emailRef.current?.focus();
      else reasonRef.current?.focus();
      return;
    }
    setState("sending");
    setError(null);
    try {
      const res = await fetch(`/api/v1/observatory/endpoints/${endpointId}/subscribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(kind === "dispute" ? { email, kind, reason, website } : { email, kind, website }),
      });
      const json = (await res.json().catch(() => ({}))) as { receipt?: string; error?: string; confirmation?: string };
      if (res.ok && json.receipt) {
        setReceipt(json.receipt);
        setMailDown(json.confirmation === "not_sent");
        setState("done");
        track("record_subscribe", { kind });
        return;
      }
      setError(explain(res.status, json.error));
      setState("error");
    } catch {
      setError("The request did not reach the server. Check the connection and retry.");
      setState("error");
    }
  }

  if (state === "done" && receipt) {
    return (
      <p className="doc-p max-w-[62ch]" aria-live="polite">
        <strong className="text-brand-deep">Recorded.</strong> Receipt no.{" "}
        <code className="text-brand-deep">{receipt}</code>.{" "}
        {kind === "notify"
          ? mailDown
            ? "The confirmation email could not be sent right now. Nothing is sent to this address until it is confirmed; try again later."
            : "Check your inbox: one confirmation email. Nothing is sent until you press Confirm on the page it links to; after that, one email per verdict change, each with an unsubscribe link."
          : "A person reads this and replies to the address you gave. The record stays published while it is examined."}
      </p>
    );
  }

  return (
    <form onSubmit={submit} onFocus={markDisputeStart} className="mt-4 flex max-w-[62ch] flex-col gap-3" noValidate>
      {kind === "notify" ? (
        <p className="doc-p max-w-[62ch]">
          Get one email when this record&apos;s verdict changes. No digest, no marketing — one
          message per change, and only for this endpoint. We first send one confirmation email;
          nothing else goes out until you confirm.
        </p>
      ) : null}
      <div className="text-[0.8125rem]">
        <label htmlFor={`${uid}-email`} className="block">
          <span className="doc-caption block">Email</span>
        </label>
        <input
          ref={emailRef}
          id={`${uid}-email`}
          type="email"
          name="email"
          autoComplete="email"
          required
          aria-invalid={showEmailError ? true : undefined}
          aria-describedby={showEmailError ? emailErrorId : undefined}
          className="doc-input mt-1"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onBlur={() => email.trim() !== "" && setTouched((t) => ({ ...t, email: true }))}
          placeholder="you@project.xyz"
        />
        {showEmailError ? (
          <span id={emailErrorId} className="mt-1 block font-semibold text-block-ink">
            {showEmailError}
          </span>
        ) : null}
      </div>
      {kind === "dispute" ? (
        <div className="text-[0.8125rem]">
          <label htmlFor={`${uid}-reason`} className="block">
            <span className="doc-caption block">What is wrong with this record</span>
          </label>
          <textarea
            ref={reasonRef}
            id={`${uid}-reason`}
            name="reason"
            required
            minLength={20}
            maxLength={2000}
            rows={5}
            aria-invalid={showReasonError ? true : undefined}
            aria-describedby={showReasonError ? `${reasonErrorId} ${reasonCountId}` : reasonCountId}
            className="doc-input mt-1 resize-y"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onBlur={() => ownLength > 0 && setTouched((t) => ({ ...t, reason: true }))}
            placeholder="Which probe or purchase, what you observed instead, and when (UTC)."
          />
          {showReasonError ? (
            <span id={reasonErrorId} className="mt-1 block font-semibold text-block-ink">
              {showReasonError}
            </span>
          ) : null}
          {/* 文字数カウンタは label の外（名前に数が混ざらないように）。欄の説明として aria-describedby で結ぶ。 */}
          <span id={reasonCountId} className="doc-note mt-1 block">
            20–2,000 characters · {reasonLength.toLocaleString()} so far
          </span>
        </div>
      ) : null}
      {/* honeypot: 人には見えない。埋まっていれば bot。 */}
      <div hidden aria-hidden="true">
        <label>
          Website
          <input
            type="text"
            name="website"
            tabIndex={-1}
            autoComplete="off"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
          />
        </label>
      </div>
      <div>
        <button
          type="submit"
          aria-busy={state === "sending" || undefined}
          className={buttonClass({ variant: "secondary", size: "sm", className: "min-h-11" })}
        >
          {state === "sending"
            ? "Recording…"
            : kind === "notify"
              ? "Email me on change"
              : "Submit the dispute"}
        </button>
      </div>
      {/* live 領域は常に置き、中身だけ替える（出てから live になるのでは読まれない）。 */}
      <p className="text-[0.8125rem] font-semibold text-brand-deep empty:sr-only" role="status">
        {state === "error" && error ? error : null}
      </p>
    </form>
  );
}

/** email 欄の誤り（無ければ null）。サーバと同じく形だけを見る。 */
export function emailProblem(email: string): string | null {
  const v = email.trim();
  if (v === "") return "Enter an email address.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return "That does not look like an email address, for example you@project.xyz.";
  return null;
}

/** 異議の理由の誤り（無ければ null）。最低 20 字は書き出しの後に本人が書いた分で数える。 */
export function reasonProblem(ownLength: number, totalLength: number, hasPrefill: boolean): string | null {
  if (totalLength > 2000) return `The reason is ${totalLength.toLocaleString()} characters; the limit is 2,000.`;
  if (ownLength < 20)
    return hasPrefill
      ? `Add at least 20 characters of your own after the prefilled line (${ownLength} so far).`
      : `Write at least 20 characters (${ownLength} so far).`;
  return null;
}

function explain(status: number, code: string | undefined): string {
  switch (code) {
    case "invalid_email":
      return "That does not look like an email address. Check it and retry.";
    case "reason_required":
    case "reason_length":
      return "The reason must be 20 to 2,000 characters.";
    case "rate_limited":
      return "Too many requests from this network in the last hour. Try again later.";
    case "endpoint_not_found":
      return "This record no longer exists.";
    case "honeypot":
      return "The form was filled in a way a person would not. Reload the page and retry.";
    default:
      return status >= 500
        ? "Could not record that right now. Retry in a minute, or write to support@vet402.com."
        : "Could not record that. Check the fields and retry.";
  }
}
