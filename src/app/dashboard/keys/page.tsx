"use client";

import { useEffect, useState } from "react";
import { dashboardFetch } from "@/lib/dashboard/client";
import { dashboardErrorMessage } from "@/lib/dashboard/errors";
import { track } from "@/lib/analytics";
import { buttonClass } from "@/components/ui/Button";

type KeyInfo = {
  id: string;
  name: string | null;
  plan: string;
  createdAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

type KeysData = { keys: KeyInfo[]; currentKeyId: string };

export default function DashboardKeysPage() {
  const [data, setData] = useState<KeysData | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    const result = await dashboardFetch<KeysData>("/api/dashboard/keys");
    setData(result);
  }

  useEffect(() => {
    let cancelled = false;

    dashboardFetch<KeysData>("/api/dashboard/keys")
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

  async function createKey() {
    setError(null);
    try {
      const created = await dashboardFetch<{ id: string; key: string; plan: string }>(
        "/api/dashboard/keys",
        {
          method: "POST",
          body: JSON.stringify({ name: "Dashboard created key" }),
        },
      );
      setNewKey(created.key);
      // 2026-08-06 growth: api_key_created = the dashboard activation event
      // (a user minting an extra key is past "signed up and left"). The key
      // value itself is never sent — no props on purpose.
      track("api_key_created");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "create_failed");
    }
  }

  async function revokeKey(id: string) {
    if (!confirm("Revoke this API key? This cannot be undone.")) return;

    setError(null);
    try {
      await dashboardFetch(`/api/dashboard/keys/${id}`, { method: "DELETE" });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "revoke_failed");
    }
  }

  if (error && !data) {
    return <p className="text-[0.84375rem] text-red-600">{dashboardErrorMessage(error)}</p>;
  }

  if (!data) {
    return <p className="text-[0.84375rem] text-zinc-600">Loading API keys...</p>;
  }

  const { keys, currentKeyId } = data;

  return (
    <div className="space-y-8">
      <div>
        <h2 className="dash-title">API keys</h2>
        <p className="dash-lede">
          Create a spare key while you are signed in. The secret is shown once and cannot be
          retrieved later. The key used for this session cannot be revoked here.
        </p>
      </div>

      {error && (
        <p role="alert" aria-live="assertive" className="dash-alert dash-alert-error">
          {dashboardErrorMessage(error)}
        </p>
      )}

      <div className="dash-card-flush">
        <table className="dash-table">
          <thead>
            <tr>
              <th className="dash-th">Name</th>
              <th className="dash-th">Plan</th>
              <th className="dash-th">Status</th>
              <th className="dash-th">Last used</th>
              <th className="dash-th" />
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key.id}>
                <td className="dash-td">
                  <div className="font-medium text-zinc-900">{key.name ?? "Unnamed"}</div>
                  <div className="font-mono text-xs text-zinc-600">{key.id}</div>
                </td>
                <td className="dash-td capitalize">{key.plan}</td>
                <td className="dash-td">
                  {key.revokedAt ? (
                    <span className="text-red-600">Revoked</span>
                  ) : key.id === currentKeyId ? (
                    <span className="text-emerald-700">Active session</span>
                  ) : (
                    <span className="text-zinc-600">Active</span>
                  )}
                </td>
                <td className="dash-td text-zinc-600">
                  {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : "—"}
                </td>
                <td className="dash-td text-right">
                  {!key.revokedAt && key.id !== currentKeyId && (
                    <button
                      type="button"
                      onClick={() => revokeKey(key.id)}
                      className="text-xs text-red-600 hover:underline"
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {keys.length === 0 && (
              <tr>
                <td colSpan={5} className="dash-td py-8 text-center text-zinc-600">
                  No keys on this account yet. Create one below — the secret is shown once.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <button
        type="button"
        onClick={createKey}
        className={buttonClass()}
      >
        Create new key
      </button>

      {newKey && (
        <div className="dash-card border-amber-200 bg-amber-50 text-[0.84375rem] text-amber-900">
          <p className="font-medium">New API key (copy now — shown once):</p>
          <code className="mt-2 block break-all font-mono text-xs">{newKey}</code>
        </div>
      )}
    </div>
  );
}
