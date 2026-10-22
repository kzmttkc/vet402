"use client";

import { useEffect, useState } from "react";
import { dashboardFetch } from "@/lib/dashboard/client";
import { dashboardErrorMessage } from "@/lib/dashboard/errors";

type Settlement = {
  id: string;
  wallet: string;
  amount: string | null;
  txHash: string;
  network: string;
  resource: string | null;
  createdAt: string | null;
};

export default function DashboardSettlementsPage() {
  const [data, setData] = useState<{ settlements: Settlement[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    dashboardFetch<{ settlements: Settlement[] }>("/api/dashboard/settlements")
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
    return <p className="text-[0.84375rem] text-zinc-600">Loading settlements...</p>;
  }

  const { settlements } = data;

  return (
    <div className="space-y-8">
      <div>
        <h2 className="dash-title">x402 settlements</h2>
        <p className="dash-lede">
          Payment attestations written back by your gateways via{" "}
          <code className="rounded bg-zinc-100 px-1 text-zinc-700">POST /v1/payments/x402</code>. These feed
          the 10% settlement weight in trust scores.
        </p>
      </div>

      <div className="dash-card-flush">
        <table className="dash-table">
          <thead>
            <tr>
              <th className="dash-th">Time</th>
              <th className="dash-th">Wallet</th>
              <th className="dash-th">Tx</th>
              <th className="dash-th">Amount</th>
              <th className="dash-th">Resource</th>
            </tr>
          </thead>
          <tbody>
            {settlements.map((row) => (
              <tr key={row.id}>
                <td className="dash-td text-xs text-zinc-600">
                  {row.createdAt ? new Date(row.createdAt).toLocaleString() : "—"}
                </td>
                <td className="dash-td font-mono text-xs">{shorten(row.wallet)}</td>
                <td className="dash-td font-mono text-xs" title={row.txHash}>
                  {shorten(row.txHash)}
                </td>
                <td className="dash-td font-mono text-xs">{row.amount ?? "—"}</td>
                <td className="dash-td text-xs text-zinc-700">{row.resource ?? "—"}</td>
              </tr>
            ))}
            {settlements.length === 0 && (
              <tr>
                <td colSpan={5} className="dash-td py-8 text-center text-zinc-600">
                  No settlements attested yet. Use the x402 trust gate with{" "}
                  <code>getPaymentTxHash</code> or call the payments API directly.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function shorten(value: string): string {
  if (value.length <= 14) return value;
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}
