"use client";

import { useState } from "react";

/** /partners の申込フォーム（保存のみ・メール送信なし——API側コメント参照）。 */
export default function PartnersClient() {
  const [email, setEmail] = useState("");
  const [interest, setInterest] = useState("design_partner");
  const [note, setNote] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");

  async function submit() {
    setState("sending");
    try {
      const res = await fetch("/api/v1/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, interest, note }),
      });
      setState(res.ok ? "done" : "error");
    } catch {
      setState("error");
    }
  }

  if (state === "done") {
    return (
      <p className="mt-6 max-w-[62ch] font-semibold text-brand-deep" aria-live="polite">
        Recorded. No automated emails follow — a human reads this list.
      </p>
    );
  }
  return (
    <div className="mt-6 flex max-w-[62ch] flex-col gap-3">
      <label className="block text-[0.84375rem]">
        <span className="doc-caption block">Email</span>
        <input
          type="email"
          className="doc-input mt-1 w-full"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@project.xyz"
        />
      </label>
      <label className="block text-[0.84375rem]">
        <span className="doc-caption block">Interest</span>
        <select className="doc-input mt-1" value={interest} onChange={(e) => setInterest(e.target.value)}>
          <option value="design_partner">Design partner (agent builder / endpoint operator)</option>
          <option value="premium_data">Premium data access (when it exists)</option>
          <option value="other">Other</option>
        </select>
      </label>
      <label className="block text-[0.84375rem]">
        <span className="doc-caption block">What are you building? (optional)</span>
        <input
          type="text"
          className="doc-input mt-1 w-full"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
        />
      </label>
      <button
        type="button"
        onClick={submit}
        disabled={state === "sending" || email.length === 0}
        className="doc-input w-fit cursor-pointer font-semibold disabled:cursor-wait disabled:opacity-60"
      >
        {state === "sending" ? "Recording…" : "Join the list"}
      </button>
      {state === "error" && (
        <p className="text-[0.84375rem] font-semibold text-brand-deep" aria-live="polite">
          Could not record that — check the email format and retry.
        </p>
      )}
    </div>
  );
}
