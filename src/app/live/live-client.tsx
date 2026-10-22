"use client";

import { useEffect, useRef, useState } from "react";

/**
 * /live の対話部（C10）。SSE を購読して台帳の新着行をそのまま並べる。
 * 演出はしない——接続状態と、届いた行の事実のみ。切断は EventSource が
 * 自動再接続する（サーバは55秒毎に窓を閉じる設計）。
 */

type LiveRow = {
  key: string;
  at: string;
  kind: "probe" | "purchase";
  resourceKey: string;
  detail: string;
};

export default function LiveClient() {
  const [rows, setRows] = useState<LiveRow[]>([]);
  const [status, setStatus] = useState<"connecting" | "open" | "retrying">("connecting");
  const counter = useRef(0);

  useEffect(() => {
    const es = new EventSource("/api/v1/observatory/live");
    es.onopen = () => setStatus("open");
    es.onerror = () => setStatus("retrying");
    const push = (kind: "probe" | "purchase") => (e: MessageEvent) => {
      try {
        const d = JSON.parse(e.data as string) as {
          at: string;
          resourceKey: string;
          verdict?: string;
          failReason?: string | null;
          status?: string;
          txHash?: string | null;
        };
        const detail =
          kind === "probe"
            ? `L0 ${d.verdict}${d.failReason ? ` (${d.failReason})` : ""}`
            : `L1 ${d.status}${d.txHash ? ` · tx ${d.txHash.slice(0, 10)}…` : ""}`;
        counter.current += 1;
        setRows((prev) =>
          [{ key: `${e.lastEventId}-${counter.current}`, at: d.at, kind, resourceKey: d.resourceKey, detail }, ...prev].slice(0, 50),
        );
      } catch {
        /* skip malformed */
      }
    };
    es.addEventListener("probe", push("probe"));
    es.addEventListener("purchase", push("purchase"));
    return () => es.close();
  }, []);

  return (
    <div className="mt-6">
      <p className="doc-caption" aria-live="polite">
        feed: {status === "open" ? "connected" : status} · rows arrive as they are written to the
        ledger (probes daily batch + on request; purchases on the daily budget)
      </p>
      {rows.length === 0 ? (
        <p className="mt-3 max-w-[62ch] text-brand">
          Quiet right now. The Observatory measures on a daily cadence, so this feed bursts when
          the probe or purchase runs fire — it does not simulate activity in between.
        </p>
      ) : (
        <table className="mt-3 w-full max-w-[72ch] border-t border-brand-deep text-[0.84375rem]">
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-b border-brand-lift/40">
                <td className="py-1 pr-3 text-brand-lift whitespace-nowrap">{r.at.slice(11, 19)}Z</td>
                <td className="py-1 pr-3 text-brand break-all">{r.resourceKey}</td>
                <td className="py-1 font-semibold text-brand-deep whitespace-nowrap">{r.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
