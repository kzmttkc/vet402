"use client";

import { useState } from "react";
import Link from "next/link";

/**
 * /playground の対話部（Phase 0.1）。候補は server 側（page.tsx）が
 * 観測所リーダーから渡す。ここは「選ぶ → 撃つ → 見る」だけ:
 * 判定の語彙は観測所と同じ閉集合（pass / fail / unverified）で、
 * 評価語・合成スコアは出さない（法務ゲート・design §11 と同じ規律）。
 */

export type PlaygroundCandidate = {
  id: string;
  resourceKey: string;
  network: string | null;
  method: string | null;
};

type ProbeView = {
  method: string;
  verdict: "pass" | "fail" | "unverified";
  httpStatus: number | null;
  has402Challenge: boolean | null;
  acceptsValid: boolean | null;
  priceConsistent: boolean | null;
  metadataConsistent: boolean | null;
  latencyMs: number | null;
  failReason: string | null;
};

type DemoResponse =
  | { ok: true; endpoint: { id: string; resourceKey: string }; probe: ProbeView }
  | { error: string };

function Cell({ value }: { value: boolean | null }) {
  if (value === null) return <span className="text-brand-lift">not checkable</span>;
  return value ? <span className="text-brand-deep">yes</span> : <span className="font-semibold text-brand-deep">no</span>;
}

export default function PlaygroundClient({ candidates }: { candidates: PlaygroundCandidate[] }) {
  const [selected, setSelected] = useState<string>(candidates[0]?.id ?? "");
  const [state, setState] = useState<
    | { phase: "idle" }
    | { phase: "running" }
    | { phase: "done"; result: DemoResponse; elapsedMs: number }
    | { phase: "error"; message: string }
  >({ phase: "idle" });

  const chosen = candidates.find((c) => c.id === selected) ?? null;

  async function run() {
    if (!selected) return;
    setState({ phase: "running" });
    const started = Date.now();
    try {
      const res = await fetch("/api/v1/demo/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpointId: selected }),
      });
      if (res.status === 429) {
        setState({ phase: "error", message: "Rate limited — the demo allows 5 live probes per minute per caller. Wait a moment and retry." });
        return;
      }
      const body = (await res.json()) as DemoResponse;
      setState({ phase: "done", result: body, elapsedMs: Date.now() - started });
    } catch {
      setState({ phase: "error", message: "The demo endpoint did not answer. Reload and retry." });
    }
  }

  return (
    <div className="mt-8">
      <p className="doc-caption">1. Pick a listed endpoint</p>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="block min-w-0 flex-1 text-[0.8125rem]">
          <span className="doc-caption block">Endpoint (from the live catalog)</span>
          <select
            className="doc-input mt-1 w-full"
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              setState({ phase: "idle" });
            }}
          >
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.resourceKey}
                {c.network ? ` · ${c.network}` : ""}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={run}
          disabled={state.phase === "running" || !selected}
          className="doc-input shrink-0 cursor-pointer font-semibold disabled:cursor-wait disabled:opacity-60"
        >
          {state.phase === "running" ? "Probing…" : "Run L0 verification"}
        </button>
      </div>

      <p className="doc-caption mt-8">2. Read the measurement</p>
      {state.phase === "idle" && (
        <p className="mt-3 max-w-[62ch] text-brand">
          The probe runs the moment you press the button — this is a live HTTP request to the
          endpoint&apos;s payment wall, not a cached result.
        </p>
      )}
      {state.phase === "running" && (
        <p className="mt-3 text-brand" aria-live="polite">
          Approaching the payment wall with the catalog-declared method…
        </p>
      )}
      {state.phase === "error" && (
        <p className="mt-3 font-semibold text-brand-deep" aria-live="polite">
          {state.message}
        </p>
      )}
      {state.phase === "done" && "error" in state.result && (
        <p className="mt-3 font-semibold text-brand-deep" aria-live="polite">
          {state.result.error === "endpoint_inactive"
            ? "This endpoint left the catalog since the page loaded — pick another."
            : "The demo could not run for this endpoint. Pick another."}
        </p>
      )}
      {state.phase === "done" && "ok" in state.result && (
        <div className="mt-3" aria-live="polite">
          <table className="w-full max-w-[62ch] border-t border-brand-deep text-[0.8125rem]">
            <tbody>
              <tr className="border-b border-brand-lift/40">
                <td className="py-1.5 pr-4 text-brand-lift">Verdict (L0)</td>
                <td className="py-1.5 font-semibold text-brand-deep">{state.result.probe.verdict}</td>
              </tr>
              <tr className="border-b border-brand-lift/40">
                <td className="py-1.5 pr-4 text-brand-lift">HTTP status</td>
                <td className="py-1.5 text-brand">{state.result.probe.httpStatus ?? "—"}</td>
              </tr>
              <tr className="border-b border-brand-lift/40">
                <td className="py-1.5 pr-4 text-brand-lift">Answered a 402 challenge</td>
                <td className="py-1.5"><Cell value={state.result.probe.has402Challenge} /></td>
              </tr>
              <tr className="border-b border-brand-lift/40">
                <td className="py-1.5 pr-4 text-brand-lift">Challenge accepts[] well-formed</td>
                <td className="py-1.5"><Cell value={state.result.probe.acceptsValid} /></td>
              </tr>
              <tr className="border-b border-brand-lift/40">
                <td className="py-1.5 pr-4 text-brand-lift">Price matches catalog</td>
                <td className="py-1.5"><Cell value={state.result.probe.priceConsistent} /></td>
              </tr>
              <tr className="border-b border-brand-lift/40">
                <td className="py-1.5 pr-4 text-brand-lift">payTo / network match catalog</td>
                <td className="py-1.5"><Cell value={state.result.probe.metadataConsistent} /></td>
              </tr>
              <tr className="border-b border-brand-lift/40">
                <td className="py-1.5 pr-4 text-brand-lift">Latency</td>
                <td className="py-1.5 text-brand">
                  {state.result.probe.latencyMs !== null ? `${state.result.probe.latencyMs} ms` : "—"}
                </td>
              </tr>
              {state.result.probe.failReason && (
                <tr className="border-b border-brand-lift/40">
                  <td className="py-1.5 pr-4 text-brand-lift">Reason</td>
                  <td className="py-1.5 text-brand">
                    <code>{state.result.probe.failReason}</code>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <p className="mt-2 max-w-[62ch] text-[0.8125rem] text-brand-lift">
            Measured in {(state.elapsedMs / 1000).toFixed(1)}s against the live endpoint.{" "}
            <em>unverified</em> means the catalog entry does not declare enough for a machine to
            check — it is not a failure.
          </p>
        </div>
      )}

      <p className="doc-caption mt-8">3. The evidence trail</p>
      <p className="mt-3 max-w-[62ch] text-brand">
        L0 is the free layer: the 402 challenge itself is the observable. The layer above it,
        L1, is a <strong>real purchase</strong> — vet402 pays the listed price with its own funds
        and records whether the payment settles, receipt by receipt, transaction hash included.
        {chosen ? (
          <>
            {" "}Every receipt for this endpoint:{" "}
            <Link href={`/observatory/e/${chosen.id}`} className="underline">
              {chosen.resourceKey}
            </Link>
            .
          </>
        ) : null}{" "}
        The downstream decision surface reads the same ledger:
      </p>
      {chosen && (
        <p className="mt-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- live SVG badge, same-origin */}
          <img
            src={`/api/badge/endpoint/${chosen.id}.svg`}
            alt={`Live receipt badge for ${chosen.resourceKey} — states are defined by measured settle-through, not opinion`}
            className="h-6"
          />
        </p>
      )}
    </div>
  );
}
