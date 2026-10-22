"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { dashboardFetch } from "@/lib/dashboard/client";
import { dashboardErrorMessage } from "@/lib/dashboard/errors";
import { SITE_URL } from "@/lib/site-url";

type Overview = {
  apiKey: { id: string; name: string | null; plan: string } | null;
  plan: string;
  usage: { period: string; count: number; limit: number; remaining: number };
  usageHistory: { period: string; count: number }[];
  totalQueries: number;
  settlementAttestations: number;
};

export default function DashboardOverviewPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    dashboardFetch<Overview>("/api/dashboard/overview")
      .then((overview) => {
        if (!cancelled) setData(overview);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "request_failed");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <p role="alert" aria-live="assertive" className="dash-alert dash-alert-error">
        {dashboardErrorMessage(error)}
      </p>
    );
  }

  if (!data) {
    return (
      <div className="space-y-3">
        <div className="dash-skel w-40" />
        <div className="dash-skel w-64" />
        <div className="dash-card h-28" />
      </div>
    );
  }

  const usagePct = Math.min(100, Math.round((data.usage.count / data.usage.limit) * 100));
  // 2026-08-06 (UX audit items 9 & 10): a brand-new key has zero lookups and
  // the overview was all zeroes with no path forward. Show a first-call guide
  // until the first lookup lands, then it disappears on its own.
  const noLookupsYet = data.totalQueries === 0;

  return (
    <div className="space-y-8">
      <div>
        <h2 className="dash-title">Overview</h2>
        <p className="dash-lede">This month&apos;s quota, and what to do next.</p>
      </div>

      {noLookupsYet && <FirstCallGuide hasKey={Boolean(data.apiKey)} />}

      <div className="dash-card">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="dash-caption">Monthly quota</p>
            <p className="mt-2 font-[family-name:var(--font-display)] text-[1.75rem] font-semibold tracking-tight text-zinc-900">
              {data.usage.count.toLocaleString()}
              <span className="text-[1.0625rem] font-normal text-zinc-500">
                {" "}
                / {data.usage.limit.toLocaleString()}
              </span>
            </p>
          </div>
          <p className="text-[0.84375rem] tabular-nums text-zinc-600">{usagePct}%</p>
        </div>
        <div className="mt-4 h-1.5 overflow-hidden rounded-[2px] bg-zinc-100">
          <div className="h-full bg-brand-deep" style={{ width: `${usagePct}%` }} />
        </div>
        <p className="mt-3 text-xs text-zinc-600">Period: {data.usage.period}</p>
        {data.usage.remaining <= Math.max(50, Math.floor(data.usage.limit * 0.1)) && (
          <p className="mt-3 text-[0.84375rem] text-zinc-700">
            Quota is running low.{" "}
            <Link href="/dashboard/billing" className="font-medium text-zinc-900 underline">
              Upgrade on Billing
            </Link>
            .
          </p>
        )}
      </div>

      {data.usageHistory.length > 1 && <UsageHistoryChart history={data.usageHistory} />}

      <dl className="dash-card grid gap-6 sm:grid-cols-3">
        <div>
          <dt className="dash-caption">Plan</dt>
          <dd className="mt-2 text-[1.0625rem] font-semibold capitalize text-zinc-900">{data.plan}</dd>
          <p className="mt-1 text-[0.84375rem] text-zinc-600">{data.apiKey?.name ?? "Unnamed key"}</p>
        </div>
        <div>
          <dt className="dash-caption">Total lookups</dt>
          <dd className="mt-2 text-[1.0625rem] font-semibold tabular-nums text-zinc-900">
            {data.totalQueries.toLocaleString()}
          </dd>
          <p className="mt-1 text-[0.84375rem] text-zinc-600">All-time API queries</p>
        </div>
        <div>
          <dt className="dash-caption">x402 settlements</dt>
          <dd className="mt-2 text-[1.0625rem] font-semibold tabular-nums text-zinc-900">
            {data.settlementAttestations.toLocaleString()}
          </dd>
          <p className="mt-1 text-[0.84375rem] text-zinc-600">Attestations from this key</p>
        </div>
      </dl>

      <nav className="dash-card" aria-label="Next">
        <p className="dash-caption">Next</p>
        <ul className="mt-4 divide-y divide-zinc-100">
          <li className="py-2.5 first:pt-0 last:pb-0">
            <a className="text-[0.84375rem] text-zinc-900 underline" href="/dashboard/lookup">
              Lookup
            </a>
            <span className="text-[0.84375rem] text-zinc-600"> — score a wallet from this session</span>
          </li>
          <li className="py-2.5 first:pt-0 last:pb-0">
            <a className="text-[0.84375rem] text-zinc-900 underline" href="/dashboard/billing">
              Billing
            </a>
            <span className="text-[0.84375rem] text-zinc-600"> — raise the monthly quota</span>
          </li>
          <li className="py-2.5 first:pt-0 last:pb-0">
            <a className="text-[0.84375rem] text-zinc-900 underline" href="/dashboard/integrations">
              Integrations
            </a>
            <span className="text-[0.84375rem] text-zinc-600"> — REST, MCP, x402 middleware</span>
          </li>
          <li className="py-2.5 first:pt-0 last:pb-0">
            <a className="text-[0.84375rem] text-zinc-900 underline" href="/docs/api">
              API reference
            </a>
          </li>
        </ul>
      </nav>
    </div>
  );
}

// Monthly quota trend (B6, 2026-08-15). Real billing-period totals from
// owner_usage — one bar per calendar month the account has an existing row
// for, never a synthesized flat line for months before the account existed.
// Only rendered when there are 2+ points (see caller): a single point has no
// trend to show and would just repeat the number already above it.
function UsageHistoryChart({ history }: { history: { period: string; count: number }[] }) {
  const max = Math.max(...history.map((h) => h.count), 1);
  return (
    <div className="dash-card">
      <p className="dash-caption">Monthly usage, last {history.length} months</p>
      <div className="mt-4 flex h-32 items-end gap-2">
        {history.map((h) => (
          <div key={h.period} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
            <span className="text-xs tabular-nums text-zinc-500">{h.count.toLocaleString()}</span>
            <div
              className="w-full rounded-t-[2px] bg-brand-deep"
              style={{ height: `${Math.max(4, Math.round((h.count / max) * 100))}%` }}
              title={`${h.period}: ${h.count.toLocaleString()} lookups`}
            />
            <span className="text-[0.75rem] text-zinc-500">{h.period.slice(5)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// First-run onboarding: the single next action for a new key is one scoring
// call. The raw key is shown exactly once at signup and never stored, so we
// cannot echo it here — the curl uses an env-var placeholder and points at
// /dashboard/keys to mint/copy one, plus a zero-setup browser alternative.
function FirstCallGuide({ hasKey }: { hasKey: boolean }) {
  const base =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/v1`
      : `${SITE_URL}/api/v1`;
  const curl = `curl -H "Authorization: Bearer $API_KEY" \\
  ${base}/payees/0xd8da6bf26964af9d7eed9e03e53415d37aa96045/score`;
  return (
    <div className="dash-card bg-zinc-900 p-6 text-zinc-100">
      <p className="font-[family-name:var(--font-display)] text-[0.84375rem] font-semibold">
        Make your first score lookup
      </p>
      <p className="mt-1 text-[0.84375rem] text-zinc-300">
        No lookups yet. Run one call and this panel is replaced by your live usage.
      </p>
      <pre className="mt-4 overflow-x-auto rounded-[2px] bg-black/50 p-4 text-xs text-zinc-100">
        <code>{curl}</code>
      </pre>
      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-[0.84375rem]">
        {!hasKey && (
          <Link href="/dashboard/keys" className="text-white underline">
            Create an API key
          </Link>
        )}
        <Link
          href="/payee/0xd8da6bf26964af9d7eed9e03e53415d37aa96045"
          className="text-white underline"
        >
          Or see a live score in the browser
        </Link>
        <Link href="/docs/api" className="text-white underline">
          API reference
        </Link>
        <Link href="/dashboard/billing" className="text-white underline">
          Billing
        </Link>
      </div>
    </div>
  );
}
