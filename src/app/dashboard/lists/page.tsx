"use client";

import { useEffect, useState } from "react";
import { dashboardFetch } from "@/lib/dashboard/client";
import { dashboardErrorMessage } from "@/lib/dashboard/errors";
import { buttonClass } from "@/components/ui/Button";

type Entry = {
  id: string;
  apiKeyId: string | null;
  wallet: string;
  listType: "whitelist" | "blacklist";
  createdAt: string | null;
};

export default function DashboardListsPage() {
  const [data, setData] = useState<{ entries: Entry[] } | null>(null);
  const [wallet, setWallet] = useState("");
  const [listType, setListType] = useState<"whitelist" | "blacklist">("whitelist");
  const [csv, setCsv] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [importMessage, setImportMessage] = useState<string | null>(null);

  async function load() {
    const result = await dashboardFetch<{ entries: Entry[] }>("/api/dashboard/lists");
    setData(result);
  }

  useEffect(() => {
    let cancelled = false;

    dashboardFetch<{ entries: Entry[] }>("/api/dashboard/lists")
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "load_failed");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function addEntry(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    try {
      await dashboardFetch("/api/dashboard/lists", {
        method: "POST",
        body: JSON.stringify({ wallet, listType }),
      });
      setWallet("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "add_failed");
    }
  }

  async function importCsv(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setImportMessage(null);

    try {
      const result = await dashboardFetch<{ imported: number; skipped: number }>(
        "/api/dashboard/lists",
        {
          method: "PUT",
          body: JSON.stringify({ csv }),
        },
      );
      setCsv("");
      await load();
      setImportMessage(
        result.skipped > 0
          ? `Imported ${result.imported}. Skipped ${result.skipped} (already listed or invalid).`
          : `Imported ${result.imported}.`,
      );
      setTimeout(() => setImportMessage(null), 6000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "import_failed");
    }
  }

  async function removeEntry(id: string) {
    setError(null);
    try {
      await dashboardFetch(`/api/dashboard/lists/${id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete_failed");
    }
  }

  if (error && !data) {
    return (
      <p role="alert" aria-live="assertive" className="text-[0.84375rem] text-red-700">
        {dashboardErrorMessage(error)}
      </p>
    );
  }

  if (!data) {
    return <p className="text-[0.84375rem] text-zinc-600">Loading lists...</p>;
  }

  const { entries } = data;

  return (
    <div className="space-y-8">
      <div>
        <h2 className="dash-title">Allow and block lists</h2>
        <p className="dash-lede">
          Wallets on your allow list skip extra caution. Wallets on your block list always return
          BLOCK for this key.
        </p>
      </div>

      {error && (
        <p role="alert" aria-live="assertive" className="dash-alert dash-alert-error">
          {dashboardErrorMessage(error)}
        </p>
      )}

      <form onSubmit={addEntry} className="dash-card grid gap-3 sm:grid-cols-[1fr_auto_auto]">
        <input
          value={wallet}
          onChange={(event) => setWallet(event.target.value)}
          placeholder="0x..."
          className="dash-input"
          required
        />
        <select
          value={listType}
          onChange={(event) => setListType(event.target.value as "whitelist" | "blacklist")}
          className="dash-select"
        >
          <option value="whitelist">Allow</option>
          <option value="blacklist">Block</option>
        </select>
        <button type="submit" className={buttonClass()}>
          Add
        </button>
      </form>

      <form onSubmit={importCsv} className="dash-card space-y-3">
        <h3 className="text-[0.84375rem] font-medium text-zinc-800">CSV import</h3>
        <textarea
          value={csv}
          onChange={(event) => setCsv(event.target.value)}
          placeholder={"wallet,list_type\n0x...,whitelist"}
          rows={4}
          className="dash-textarea font-mono"
        />
        <button type="submit" className={buttonClass({ variant: "secondary" })}>
          Import CSV
        </button>
        {importMessage && <p className="text-[0.84375rem] text-emerald-700">{importMessage}</p>}
      </form>

      <div className="dash-card-flush">
        <table className="dash-table">
          <thead>
            <tr>
              <th className="dash-th">Wallet</th>
              <th className="dash-th">Type</th>
              <th className="dash-th" />
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td className="dash-td font-mono text-xs">{entry.wallet}</td>
                <td className="dash-td">{entry.listType === "blacklist" ? "Block" : "Allow"}</td>
                <td className="dash-td text-right">
                  <button
                    type="button"
                    onClick={() => removeEntry(entry.id)}
                    className="text-xs text-red-600 hover:underline"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr>
                <td colSpan={3} className="dash-td py-8 text-center text-zinc-600">
                  No list entries yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
