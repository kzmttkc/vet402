"use client";

import { useEffect, useState } from "react";
import { dashboardFetch } from "@/lib/dashboard/client";
import { dashboardErrorMessage } from "@/lib/dashboard/errors";

type Log = {
  id: string;
  agentId: string | null;
  wallet: string | null;
  trustScore: number | null;
  recommendation: string | null;
  createdAt: string | null;
  kind: string | null;
};

export default function DashboardLogsPage() {
  const [data, setData] = useState<{ logs: Log[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    dashboardFetch<{ logs: Log[] }>("/api/dashboard/logs")
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "load_failed");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return <p className="text-[0.84375rem] text-red-600">{dashboardErrorMessage(error)}</p>;
  }

  if (!data) {
    return <p className="text-[0.84375rem] text-zinc-600">Loading query logs...</p>;
  }

  const { logs } = data;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-[1.75rem] font-semibold">Query logs</h2>
        <p className="text-[0.84375rem] text-zinc-600">Recent trust score lookups for your API key.</p>
      </div>

      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
        <table className="min-w-full text-left text-[0.84375rem]">
          <thead className="border-b border-zinc-200 bg-zinc-50 text-zinc-600">
            <tr>
              <th className="px-4 py-3 font-medium">Time</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Agent</th>
              <th className="px-4 py-3 font-medium">Wallet</th>
              <th className="px-4 py-3 font-medium">Score</th>
              <th className="px-4 py-3 font-medium">Decision</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.id} className="border-b border-zinc-100">
                <td className="px-4 py-3 text-xs text-zinc-600">
                  {log.createdAt ? new Date(log.createdAt).toLocaleString() : "—"}
                </td>
                <td className="px-4 py-3">
                  {log.kind === "payee_score" ? (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                      Payee
                    </span>
                  ) : (
                    <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700">
                      Wallet
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 font-mono text-xs">{log.agentId ?? "—"}</td>
                <td className="px-4 py-3 font-mono text-xs">{log.wallet ?? "—"}</td>
                <td className="px-4 py-3">{log.trustScore ?? "—"}</td>
                <td className="px-4 py-3">{log.recommendation ?? "—"}</td>
              </tr>
            ))}
            {logs.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-zinc-500">
                  No queries logged yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
