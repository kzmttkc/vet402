"use client";

import { useState } from "react";
import { buttonClass } from "@/components/ui/Button";
import { loadSellerCardAction } from "./actions";
import {
  OPS_NOT_DELIVERED_RATE_NOTE,
  type SellerCard,
  type SellerCardResult,
  opsDeliveredRateUnavailableMessage,
} from "@/lib/dashboard/ops-card";
import { withdrawnStateLabel } from "@/lib/observatory/l0-verdict";
import { sellerDashboardAccessMessage } from "@/lib/dashboard/seller-access";

function RateTriplet({
  label,
  attempts,
  denominator,
  delivered,
  notDelivered,
}: {
  label: string;
  attempts: number;
  denominator: number;
  delivered: number | null;
  notDelivered: number | null;
}) {
  if (delivered === null) {
    return (
      <p className="text-[0.84375rem] text-zinc-600">
        {label}: {opsDeliveredRateUnavailableMessage(attempts, denominator)}
      </p>
    );
  }
  return (
    <p className="text-[0.84375rem] text-zinc-700">
      {label}: delivered {delivered.toFixed(1)}%, not delivered {notDelivered?.toFixed(1) ?? "n/a"}%
    </p>
  );
}

function SellerCardView({ card }: { card: SellerCard }) {
  return (
    <div className="space-y-8">
      <section className="dash-card space-y-4">
        <h3 className="text-[1.0625rem] font-semibold text-zinc-900">Revenue</h3>
        <p className="text-[0.84375rem] text-zinc-600">payTo {card.wallet}</p>
        <div className="grid gap-6 sm:grid-cols-2">
          <div>
            <p className="dash-caption">vet402 measurement purchases (settled)</p>
            {card.revenue.measurementSettledCount === 0 ? (
              <p className="mt-2 text-[0.84375rem] text-zinc-600">No settled measurement purchases yet.</p>
            ) : (
              <p className="mt-2 text-[1.0625rem] font-semibold tabular-nums">
                {card.revenue.measurementSettledUsdc}{" "}
                <span className="text-[0.84375rem] font-normal text-zinc-600">
                  ({card.revenue.measurementSettledCount} purchases)
                </span>
              </p>
            )}
          </div>
          <div>
            <p className="dash-caption">Reported by API key holders (verified on chain)</p>
            {card.revenue.reportedVerifiedCount === 0 ? (
              <p className="mt-2 text-[0.84375rem] text-zinc-600">No verified reported payments yet.</p>
            ) : (
              <p className="mt-2 text-[1.0625rem] font-semibold tabular-nums">
                {card.revenue.reportedVerifiedUsdc}{" "}
                <span className="text-[0.84375rem] font-normal text-zinc-600">
                  ({card.revenue.reportedVerifiedCount} rows)
                </span>
              </p>
            )}
          </div>
        </div>
      </section>

      <section className="dash-card space-y-4">
        <h3 className="text-[1.0625rem] font-semibold text-zinc-900">Delivered rate</h3>
        {card.delivered.state === "empty" ? (
          <p className="text-[0.84375rem] text-zinc-600">No purchases on record yet.</p>
        ) : (
          <>
            <dl className="grid gap-4 sm:grid-cols-4">
              <div>
                <dt className="dash-caption">Attempts</dt>
                <dd className="mt-1 font-semibold tabular-nums">{card.delivered.attempts}</dd>
              </div>
              <div>
                <dt className="dash-caption">Delivered</dt>
                <dd className="mt-1 font-semibold tabular-nums">{card.delivered.delivered}</dd>
              </div>
              <div>
                <dt className="dash-caption">Held</dt>
                <dd className="mt-1 font-semibold tabular-nums">{card.delivered.held}</dd>
              </div>
              <div>
                <dt className="dash-caption">Awaiting a second read</dt>
                <dd className="mt-1 font-semibold tabular-nums">{card.delivered.awaitingReread}</dd>
              </div>
            </dl>
            <div className="space-y-2 border-t border-zinc-100 pt-4">
              <RateTriplet
                label="Delivered of attempts"
                attempts={card.delivered.attempts}
                denominator={card.delivered.rates.denominators.attempts}
                delivered={card.delivered.rates.deliveredOfAttemptsPct}
                notDelivered={card.delivered.rates.notDeliveredOfAttemptsPct}
              />
              <RateTriplet
                label="Delivered excluding held"
                attempts={card.delivered.attempts}
                denominator={card.delivered.rates.denominators.notHeld}
                delivered={card.delivered.rates.deliveredOfNotHeldPct}
                notDelivered={card.delivered.rates.notDeliveredOfNotHeldPct}
              />
              <RateTriplet
                label="Delivered of final outcome"
                attempts={card.delivered.attempts}
                denominator={card.delivered.rates.denominators.finalOutcome}
                delivered={card.delivered.rates.deliveredOfFinalOutcomePct}
                notDelivered={card.delivered.rates.notDeliveredOfFinalOutcomePct}
              />
            </div>
            <p className="text-xs text-zinc-600">{OPS_NOT_DELIVERED_RATE_NOTE}</p>
          </>
        )}
      </section>

      <section className="dash-card space-y-4">
        <h3 className="text-[1.0625rem] font-semibold text-zinc-900">Trade disputes</h3>
        <p className="text-[0.84375rem] text-zinc-600">{card.disputes.checkedLine}</p>
        {card.disputes.state === "empty" ? (
          card.disputes.noRecordsMessage && (
            <p className="text-[0.84375rem] text-zinc-600">{card.disputes.noRecordsMessage}</p>
          )
        ) : (
          <dl className="grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="dash-caption">Disputes</dt>
              <dd className="mt-1 font-semibold tabular-nums">{card.disputes.disputeCount}</dd>
            </div>
            <div>
              <dt className="dash-caption">Trade records on file</dt>
              <dd className="mt-1 font-semibold tabular-nums">{card.disputes.recordsPresent}</dd>
            </div>
          </dl>
        )}
        {card.disputes.truncatedNote && (
          <p className="text-xs text-zinc-600">{card.disputes.truncatedNote}</p>
        )}
        {card.disputes.note && (
          <p className="text-xs text-zinc-600">{card.disputes.note}</p>
        )}
      </section>

      <section className="dash-card space-y-4">
        <h3 className="text-[1.0625rem] font-semibold text-zinc-900">Reputation</h3>
        {card.reputation.state === "empty" ? (
          <p className="text-[0.84375rem] text-zinc-600">No L0 probes on record for this payTo yet.</p>
        ) : (
          <dl className="grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="dash-caption">Pass</dt>
              <dd className="mt-1 font-semibold tabular-nums">{card.reputation.pass}</dd>
            </div>
            <div>
              <dt className="dash-caption">Published fail</dt>
              <dd className="mt-1 font-semibold tabular-nums">{card.reputation.fail}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="dash-caption">{withdrawnStateLabel()}</dt>
              <dd className="mt-1 font-semibold tabular-nums">{card.reputation.withdrawn}</dd>
            </div>
            <div>
              <dt className="dash-caption">No verdict yet</dt>
              <dd className="mt-1 font-semibold tabular-nums">{card.reputation.unverified}</dd>
            </div>
          </dl>
        )}
      </section>
    </div>
  );
}

export function SellerOpsClient() {
  const [wallet, setWallet] = useState("");
  const [issued, setIssued] = useState("");
  const [signature, setSignature] = useState("");
  const [messagePreview, setMessagePreview] = useState("");
  const [result, setResult] = useState<SellerCardResult | null>(null);
  const [busy, setBusy] = useState(false);

  function refreshMessage() {
    const w = wallet.trim();
    let i = issued.trim();
    if (!i) {
      i = new Date().toISOString();
      setIssued(i);
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(w)) {
      setMessagePreview("");
      return;
    }
    setMessagePreview(sellerDashboardAccessMessage({ wallet: w, issued: i }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const proof = {
        kind: "payto_signature" as const,
        wallet: wallet.trim(),
        issued: issued.trim(),
        signature: signature.trim(),
      };
      const out = await loadSellerCardAction(proof);
      setResult(out);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
        <form onSubmit={onSubmit} className="dash-card space-y-4">
          <h3 className="text-[1.0625rem] font-semibold text-zinc-900">PayTo proof</h3>
          <p className="text-[0.84375rem] text-zinc-600">
            Sign with the wallet that receives payments. Numbers appear only after verification succeeds.
          </p>
          <label className="block text-[0.84375rem]">
            <span className="dash-caption">Wallet</span>
            <input data-clarity-mask="true"
              className="mt-1 w-full rounded border border-zinc-500 px-3 py-2 text-sm"
              value={wallet}
              onChange={(e) => {
                setWallet(e.target.value);
              }}
              onBlur={refreshMessage}
              placeholder="0x…"
              autoComplete="off"
            />
          </label>
          <label className="block text-[0.84375rem]">
            <span className="dash-caption">Issued (ISO timestamp signed)</span>
            <input data-clarity-mask="true"
              className="mt-1 w-full rounded border border-zinc-500 px-3 py-2 text-sm font-mono"
              value={issued}
              onChange={(e) => setIssued(e.target.value)}
              onBlur={refreshMessage}
              placeholder="2026-11-13T00:00:00.000Z"
            />
          </label>
          {messagePreview && (
            <pre className="overflow-x-auto rounded bg-zinc-50 p-3 text-xs text-zinc-800">
              <code>{messagePreview}</code>
            </pre>
          )}
          <label className="block text-[0.84375rem]">
            <span className="dash-caption">Signature</span>
            <textarea data-clarity-mask="true"
              className="mt-1 w-full rounded border border-zinc-500 px-3 py-2 text-sm font-mono"
              value={signature}
              onChange={(e) => setSignature(e.target.value)}
              rows={3}
              placeholder="0x…"
            />
          </label>
          <button type="submit" className={buttonClass({ variant: "primary" })} disabled={busy}>
            {busy ? "Checking…" : "Show seller numbers"}
          </button>
        </form>

      {result && !result.ok && (
        <p role="alert" className="dash-alert dash-alert-error">
          Verification did not pass ({result.reason}). Revenue, delivery, disputes, and reputation stay hidden.
        </p>
      )}

      {result?.ok && <SellerCardView card={result.card} />}
    </div>
  );
}
