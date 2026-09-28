"use client";

import { useState, useSyncExternalStore } from "react";
import { buttonClass } from "@/components/ui/Button";

/**
 * SubscriptionAction — 確認メール・通知メールのリンク先の「押すまで何も起きない」ボタン
 * （2026-09-28 監査: ダブルオプトインと配信停止）。
 *
 * トークンは URL の # の後ろ（#t=… / #id=…&t=…）で受け取る。# 以降はサーバへも
 * 解析のビーコンへも送られない。頁を開いただけでは何もしない——メールのリンク
 * スキャナが開いても確定・停止しない。POST はボタンを押した時の 1 回だけ。
 * 成功したら # を消し、トークンを履歴に残さない。
 */
export default function SubscriptionAction({ mode }: { mode: "confirm" | "unsubscribe" }) {
  // # はサーバ描画に届かないので、サーバ側のスナップショットは null（＝まだ読んでいない）。
  const hash = useSyncExternalStore(subscribeHash, readHash, () => null);
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const params = parseParams(hash, mode);

  async function submit() {
    if (!params || state === "sending") return;
    setState("sending");
    setError(null);
    try {
      const res = await fetch(`/api/v1/observatory/subscriptions/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mode === "confirm" ? { token: params.token } : { id: params.id, token: params.token }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) {
        setState("done");
        window.history.replaceState(null, "", window.location.pathname);
        return;
      }
      setError(explain(mode, json.error));
      setState("error");
    } catch {
      setError("The request did not reach the server. Check the connection and retry.");
      setState("error");
    }
  }

  if (hash === null) return null;

  if (state === "done") {
    return (
      <p className="doc-p max-w-[62ch]" aria-live="polite">
        <strong className="text-brand-deep">{mode === "confirm" ? "Confirmed." : "Unsubscribed."}</strong>{" "}
        {mode === "confirm"
          ? "You will get one email each time this record's public verdict changes. Those emails include an unsubscribe link."
          : "No more emails about this record will be sent to this address."}
      </p>
    );
  }

  if (!params) {
    return (
      <p className="doc-p max-w-[62ch]">
        This page needs the full link from the email. Open the link again from the message itself; if it
        still fails, write to support@vet402.com.
      </p>
    );
  }

  return (
    <div className="mt-4 flex max-w-[62ch] flex-col gap-3">
      <p className="doc-p max-w-[62ch]">
        {mode === "confirm"
          ? "Press the button to start receiving one email each time this endpoint record's public verdict changes. Nothing has changed yet."
          : "Press the button to stop emails about this endpoint record. Nothing has changed yet."}
      </p>
      <div>
        <button
          type="button"
          onClick={submit}
          disabled={state === "sending"}
          className={buttonClass({ variant: "secondary", size: "sm", className: "min-h-11" })}
        >
          {state === "sending" ? "Working…" : mode === "confirm" ? "Confirm" : "Unsubscribe"}
        </button>
      </div>
      {state === "error" && error ? (
        <p className="text-[0.8125rem] font-semibold text-brand-deep" aria-live="polite">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function subscribeHash(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

function readHash(): string {
  return window.location.hash;
}

function parseParams(hash: string | null, mode: "confirm" | "unsubscribe"): { id: string; token: string } | null {
  if (!hash) return null;
  const q = new URLSearchParams(hash.replace(/^#/, ""));
  const token = q.get("t") ?? "";
  const id = q.get("id") ?? "";
  return token && (mode === "confirm" || id) ? { id, token } : null;
}

function explain(mode: "confirm" | "unsubscribe", code: string | undefined): string {
  switch (code) {
    case "invalid_token":
      return mode === "confirm"
        ? "This link has expired or was already used. Submit the form on the record page again for a fresh link."
        : "This link is not valid. Write to support@vet402.com and one person will remove the address by hand.";
    case "rate_limited":
      return "Too many requests from this network in the last hour. Try again later.";
    default:
      return "Could not do that right now. Retry in a minute, or write to support@vet402.com.";
  }
}
