"use client";

import { useId, useState } from "react";
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
 * Plausible: record_subscribe{kind}。email は送らない。
 */
export default function RecordSubscribe({
  endpointId,
  kind,
}: {
  endpointId: string;
  kind: "notify" | "dispute";
}) {
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const [website, setWebsite] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [receipt, setReceipt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const uid = useId();

  const reasonLength = reason.trim().length;
  const canSend =
    state !== "sending" && email.trim() !== "" && (kind === "notify" || (reasonLength >= 20 && reasonLength <= 2000));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSend) return;
    setState("sending");
    setError(null);
    try {
      const res = await fetch(`/api/v1/observatory/endpoints/${endpointId}/subscribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(kind === "dispute" ? { email, kind, reason, website } : { email, kind, website }),
      });
      const json = (await res.json().catch(() => ({}))) as { receipt?: string; error?: string };
      if (res.ok && json.receipt) {
        setReceipt(json.receipt);
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
          ? "One email when this record's public verdict changes. Nothing else is sent."
          : "A person reads this and replies to the address you gave. The record stays published while it is examined."}
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="mt-4 flex max-w-[62ch] flex-col gap-3" noValidate>
      {kind === "notify" ? (
        <p className="doc-p max-w-[62ch]">
          Get one email when this record&apos;s verdict changes. No digest, no marketing — one
          message per change, and only for this endpoint.
        </p>
      ) : null}
      <label htmlFor={`${uid}-email`} className="block text-[0.8125rem]">
        <span className="doc-caption block">Email</span>
        <input
          id={`${uid}-email`}
          type="email"
          name="email"
          autoComplete="email"
          required
          className="doc-input mt-1"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@project.xyz"
        />
      </label>
      {kind === "dispute" ? (
        <label htmlFor={`${uid}-reason`} className="block text-[0.8125rem]">
          <span className="doc-caption block">What is wrong with this record</span>
          <textarea
            id={`${uid}-reason`}
            name="reason"
            required
            minLength={20}
            maxLength={2000}
            rows={5}
            className="doc-input mt-1 resize-y"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Which probe or purchase, what you observed instead, and when (UTC)."
          />
          <span className="doc-note mt-1 block">
            20–2,000 characters · {reasonLength.toLocaleString()} so far
          </span>
        </label>
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
          disabled={!canSend}
          className={buttonClass({ variant: "secondary", size: "sm", className: "min-h-11" })}
        >
          {state === "sending"
            ? "Recording…"
            : kind === "notify"
              ? "Email me on change"
              : "Submit the dispute"}
        </button>
      </div>
      {state === "error" && error ? (
        <p className="text-[0.8125rem] font-semibold text-brand-deep" aria-live="polite">
          {error}
        </p>
      ) : null}
    </form>
  );
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
