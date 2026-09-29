"use client";

import { useId, useState } from "react";

/**
 * TryItPanel — an executable counterpart to a curl example (B4, 2026-08-15).
 *
 * Scope: GET only, and only for endpoints that are already documented as
 * needing no key and writing nothing (the panel does not change that — it
 * just fires the same request the curl block shows, from the reader's own
 * browser, same-origin). Endpoints that require a key or a signature are not
 * given a button: pasting a secret into a public docs page, even one this
 * page renders client-side, is a habit worth not teaching.
 */
export function TryItPanel({ path, label }: { path: string; label: string }) {
  const [state, setState] = useState<
    | { status: "idle" }
    | { status: "loading" }
    | { status: "done"; httpStatus: number; latencyMs: number; body: string }
    | { status: "error"; message: string }
  >({ status: "idle" });

  const resultId = useId();
  const loading = state.status === "loading";

  async function run() {
    // 2026-09-29 監査 5 周目（WCAG 2.2）: disabled にするとフォーカスが body に落ちるので、
    // 押せる見た目のまま aria-busy にし、実行中の再クリックはここで無視する。
    if (loading) return;
    setState({ status: "loading" });
    const startedAt = performance.now();
    try {
      const res = await fetch(path, { headers: { accept: "application/json" } });
      const text = await res.text();
      let body = text;
      try {
        body = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // Not JSON (e.g. a 404 HTML page from a misconfigured proxy) — show raw text as-is.
      }
      setState({
        status: "done",
        httpStatus: res.status,
        latencyMs: Math.round(performance.now() - startedAt),
        body,
      });
    } catch {
      setState({ status: "error", message: "Request failed — check your connection and retry." });
    }
  }

  return (
    <div className="mt-2 border border-hair">
      <div className="flex items-center justify-between gap-3 bg-ground px-3 py-2">
        <span className="text-[0.75rem] uppercase tracking-wide text-brand-lift">Try it</span>
        <button
          type="button"
          onClick={run}
          aria-busy={loading}
          aria-controls={resultId}
          className="border border-brand-deep px-3 py-1 text-[0.75rem] font-semibold uppercase tracking-wide text-brand-deep hover:bg-white aria-busy:opacity-50"
        >
          {loading ? "Running…" : "Run this request"}
        </button>
      </div>
      {/* 結果の行は常に DOM にある role="status" の中（出てから live 領域になるのでは読まれない）。 */}
      <div id={resultId}>
        <p role="status" className={state.status === "idle" ? "sr-only" : "border-t border-hair px-3 pt-3 font-mono text-xs text-brand-lift"}>
          {state.status === "loading" && <span className="sr-only">Running {label}…</span>}
          {state.status === "done" && (
            <>
              {state.httpStatus} &middot; {state.latencyMs}ms &middot; {label}
            </>
          )}
        </p>
        {state.status === "done" && (
          <div className="px-3 pb-3">
            {/* はみ出してスクロールする領域はキーボードで届くように tabindex=0・名前付きの region。 */}
            <pre
              tabIndex={0}
              role="region"
              aria-label={`Response body of ${label}`}
              className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-brand-deep focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-deep"
            >
              {state.body}
            </pre>
          </div>
        )}
        {state.status === "error" && (
          <p role="alert" className="border-t border-hair p-3 text-xs text-block-ink">
            {state.message}
          </p>
        )}
      </div>
    </div>
  );
}
