"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { dashboardFetch } from "@/lib/dashboard/client";
import { dashboardErrorMessage } from "@/lib/dashboard/errors";
import { buttonClass } from "@/components/ui/Button";
import { track } from "@/lib/analytics";

type PayeeResult = {
  kind: "payee";
  payee: string;
  score: number;
  recommendation: "ALLOW" | "WARN" | "BLOCK";
  dataDepth: string;
  degraded: boolean;
  signalsUnavailable: string[];
  signals: {
    receiving: { paymentCount: number; uniqueDays: number; score: number };
    walletHealth: { ageDays: number; txCount: number; isBurner: boolean };
    drainPattern: { detected: boolean; drainRatio: number | null };
    outcomeHistory: { types: string[]; adjustment: number };
    flags: string[];
  };
};

type AgentResult = {
  kind?: "agent";
  agentId: string;
  wallet: string | null;
  trustScore: number;
  recommendation: "ALLOW" | "WARN" | "BLOCK";
  manualOverride?: boolean;
  blockReason?: string;
  signals: {
    identity: { registered: boolean; hasMetadataUri: boolean };
    reputation: { feedbackCount: number; avgScore: number; onChainAvgScore: number };
    wallet: { ageDays: number; txCount: number };
    x402?: { paymentCount: number; uniqueDays: number; score: number };
    sybil: { risk: string; flags: string[] };
    manual: { list: string };
  };
};

type ScoreResult = PayeeResult | AgentResult;

function isPayee(result: ScoreResult): result is PayeeResult {
  return result.kind === "payee";
}

export default function DashboardLookupPage() {
  const [agentId, setAgentId] = useState("");
  const [wallet, setWallet] = useState("");
  const [result, setResult] = useState<ScoreResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    track("lookup_view");
  }, []);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const data = await dashboardFetch<ScoreResult>("/api/dashboard/lookup", {
        method: "POST",
        body: JSON.stringify({
          agentId: agentId.trim() || undefined,
          wallet: wallet.trim() || undefined,
        }),
      });
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "lookup_failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="dash-title">Score a payee</h2>
        <p className="dash-lede">
          The address you are about to pay. Same engine as{" "}
          <Link className="underline" href="/payee">
            public payee lookup
          </Link>{" "}
          and <code>GET /api/v1/payees/…/score</code>. Agent ID scores a payer instead.
        </p>
      </div>

      <form onSubmit={onSubmit} className="dash-card space-y-4">
        <label className="block space-y-1.5 text-[0.84375rem]">
          <span className="font-medium text-zinc-800">Payee wallet</span>
          <input
            value={wallet}
            onChange={(event) => setWallet(event.target.value)}
            placeholder="0x..."
            className="dash-input"
          />
        </label>
        <label className="block space-y-1.5 text-[0.84375rem]">
          <span className="font-medium text-zinc-800">Payer agent ID (optional)</span>
          <input
            value={agentId}
            onChange={(event) => setAgentId(event.target.value)}
            placeholder="Leave blank to score the payee"
            className="dash-input"
          />
        </label>
        <button
          type="submit"
          disabled={loading}
          className={buttonClass()}
        >
          {loading ? "Scoring..." : "Score"}
        </button>
      </form>

      {error && (
        <p role="alert" aria-live="assertive" className="dash-alert dash-alert-error">
          {dashboardErrorMessage(error)}
        </p>
      )}

      {result && isPayee(result) && (
        <div className="dash-card space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-[1.0625rem] font-semibold">Payee score</h3>
            <Badge value={result.recommendation} />
          </div>
          <dl className="grid gap-3 text-[0.84375rem] sm:grid-cols-2">
            <Item label="Payee" value={result.payee} />
            <Item label="Score" value={String(result.score)} />
            <Item label="Data depth" value={result.dataDepth} />
            <Item label="Degraded" value={result.degraded ? "yes" : "no"} />
            <Item label="Receiving payments" value={String(result.signals.receiving.paymentCount)} />
            <Item label="Wallet age (days)" value={String(result.signals.walletHealth.ageDays)} />
            <Item
              label="Drain pattern"
              value={result.signals.drainPattern.detected ? "detected" : "none"}
            />
            <Item
              label="Outcome adjustment"
              value={String(result.signals.outcomeHistory.adjustment)}
            />
          </dl>
          {result.signalsUnavailable.length > 0 && (
            <p className="text-[0.84375rem] text-zinc-600">
              Unread inputs: {result.signalsUnavailable.join(", ")}
            </p>
          )}
          {result.signals.flags.length > 0 && (
            <p className="text-[0.84375rem] text-zinc-600">Flags: {result.signals.flags.join(", ")}</p>
          )}
        </div>
      )}

      {result && !isPayee(result) && (
        <div className="dash-card space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-[1.0625rem] font-semibold">Payer score</h3>
            <Badge value={result.recommendation} />
          </div>
          <dl className="grid gap-3 text-[0.84375rem] sm:grid-cols-2">
            <Item label="Agent ID" value={result.agentId} />
            <Item label="Trust score" value={String(result.trustScore)} />
            <Item label="Wallet" value={result.wallet ?? "—"} />
            <Item label="Manual list" value={result.signals.manual.list} />
            <Item label="Manual override" value={result.manualOverride ? "yes" : "no"} />
            <Item label="Block reason" value={result.blockReason ?? "—"} />
            <Item label="Registered" value={result.signals.identity.registered ? "yes" : "no"} />
            <Item label="Wallet age (days)" value={String(result.signals.wallet.ageDays)} />
            <Item
              label="x402 payments"
              value={String(result.signals.x402?.paymentCount ?? 0)}
            />
            <Item label="Sybil risk" value={result.signals.sybil.risk} />
          </dl>
          {result.signals.sybil.flags.length > 0 && (
            <p className="text-[0.84375rem] text-zinc-600">
              Flags: {result.signals.sybil.flags.join(", ")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Badge({ value }: { value: string }) {
  const styles =
    value === "ALLOW"
      ? "bg-emerald-100 text-emerald-800"
      : value === "WARN"
        ? "bg-amber-100 text-amber-800"
        : "bg-red-100 text-red-800";

  return (
    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${styles}`}>{value}</span>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="dash-caption">{label}</dt>
      <dd className="font-mono text-zinc-900">{value}</dd>
    </div>
  );
}
