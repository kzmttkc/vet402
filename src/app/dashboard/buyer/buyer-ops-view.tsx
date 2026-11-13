import {
  OPS_NOT_DELIVERED_RATE_NOTE,
  OPS_VET402_L1_MEASUREMENT_LEDE,
  type BuyerCard,
  opsDeliveredRateUnavailableMessage,
} from "@/lib/dashboard/ops-card";
import Link from "next/link";

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

export function BuyerOpsView({ card }: { card: BuyerCard }) {
  const emptyKey = card.yourKey.state === "empty";
  const emptyPay = card.paymentsReported.state === "empty";

  return (
    <div className="space-y-8">
      <div>
        <h2 className="dash-title">Buyer operations</h2>
        <p className="dash-lede">Decision usage, reported payments, and vet402 measurement in separate sections.</p>
      </div>

      {emptyKey && emptyPay && (
        <div className="dash-card bg-zinc-900 p-6 text-zinc-100">
          <p className="font-[family-name:var(--font-display)] text-[0.84375rem] font-semibold">Next steps</p>
          <p className="mt-1 text-[0.84375rem] text-zinc-300">
            This key has no decision calls and no reported payments yet. Run a lookup or report a settlement to populate
            these sections.
          </p>
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-[0.84375rem]">
            <Link href="/dashboard/lookup" className="text-white underline">
              Lookup
            </Link>
            <Link href="/dashboard/settlements" className="text-white underline">
              Report a payment
            </Link>
            <Link href="/docs/api" className="text-white underline">
              API reference
            </Link>
          </div>
        </div>
      )}

      <section className="dash-card space-y-4" aria-labelledby="buyer-key-heading">
        <h3 id="buyer-key-heading" className="text-[1.0625rem] font-semibold text-zinc-900">
          Your key
        </h3>
        <p className="text-[0.84375rem] text-zinc-600">
          Decision API calls attributed to this dashboard key in the last {card.yourKey.days} days.
        </p>
        {card.yourKey.state === "empty" ? (
          <p className="text-[0.84375rem] text-zinc-600">No decision calls on record yet for this key.</p>
        ) : (
          <>
            <p className="text-[1.0625rem] font-semibold tabular-nums text-zinc-900">
              {card.yourKey.total.toLocaleString()} calls
            </p>
            <ul className="divide-y divide-zinc-100 text-[0.84375rem]">
              {card.yourKey.byChain.map((row) => (
                <li key={row.chain} className="flex justify-between py-2">
                  <span className="text-zinc-700">{row.chain}</span>
                  <span className="tabular-nums text-zinc-900">{row.count.toLocaleString()}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="dash-card space-y-4" aria-labelledby="buyer-payments-heading">
        <h3 id="buyer-payments-heading" className="text-[1.0625rem] font-semibold text-zinc-900">
          Payments you reported
        </h3>
        <p className="text-[0.84375rem] text-zinc-600">x402 payment rows posted with this API key.</p>
        {card.paymentsReported.state === "empty" ? (
          <p className="text-[0.84375rem] text-zinc-600">No reported payments yet.</p>
        ) : (
          <dl className="grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="dash-caption">Rows</dt>
              <dd className="mt-1 text-[1.0625rem] font-semibold tabular-nums">{card.paymentsReported.paymentCount}</dd>
            </div>
            <div>
              <dt className="dash-caption">Verified on chain (USDC)</dt>
              <dd className="mt-1 text-[1.0625rem] font-semibold tabular-nums">
                {card.paymentsReported.verifiedUsdcTotal}
              </dd>
            </div>
            {card.paymentsReported.unverifiedOnChainCount > 0 && (
              <div className="sm:col-span-2">
                <dt className="dash-caption">Could not verify on chain</dt>
                <dd className="mt-1 text-[0.84375rem] text-zinc-700">
                  {card.paymentsReported.unverifiedOnChainCount} rows (not included in the verified total)
                </dd>
              </div>
            )}
          </dl>
        )}
      </section>

      <section className="dash-card space-y-4" aria-labelledby="buyer-measurement-heading">
        <h3 id="buyer-measurement-heading" className="text-[1.0625rem] font-semibold text-zinc-900">
          vet402&apos;s own purchases
        </h3>
        <p className="text-[0.84375rem] text-zinc-600">{OPS_VET402_L1_MEASUREMENT_LEDE}</p>
        {card.vet402Measurement.state === "empty" ? (
          <p className="text-[0.84375rem] text-zinc-600">No purchases on record yet.</p>
        ) : (
          <>
            <dl className="grid gap-4 sm:grid-cols-3">
              <div>
                <dt className="dash-caption">Attempts</dt>
                <dd className="mt-1 font-semibold tabular-nums">{card.vet402Measurement.attempts}</dd>
              </div>
              <div>
                <dt className="dash-caption">Delivered</dt>
                <dd className="mt-1 font-semibold tabular-nums">{card.vet402Measurement.delivered}</dd>
              </div>
              <div>
                <dt className="dash-caption">Not delivered (final outcome)</dt>
                <dd className="mt-1 font-semibold tabular-nums">{card.vet402Measurement.failed}</dd>
              </div>
              <div>
                <dt className="dash-caption">Held (inconclusive)</dt>
                <dd className="mt-1 font-semibold tabular-nums">{card.vet402Measurement.held}</dd>
              </div>
              <div>
                <dt className="dash-caption">Awaiting a second read</dt>
                <dd className="mt-1 font-semibold tabular-nums">{card.vet402Measurement.awaitingReread}</dd>
              </div>
            </dl>
            <div className="space-y-2 border-t border-zinc-100 pt-4">
              <RateTriplet
                label="Delivered of attempts"
                attempts={card.vet402Measurement.attempts}
                denominator={card.vet402Measurement.rates.denominators.attempts}
                delivered={card.vet402Measurement.rates.deliveredOfAttemptsPct}
                notDelivered={card.vet402Measurement.rates.notDeliveredOfAttemptsPct}
              />
              <RateTriplet
                label="Delivered excluding held"
                attempts={card.vet402Measurement.attempts}
                denominator={card.vet402Measurement.rates.denominators.notHeld}
                delivered={card.vet402Measurement.rates.deliveredOfNotHeldPct}
                notDelivered={card.vet402Measurement.rates.notDeliveredOfNotHeldPct}
              />
              <RateTriplet
                label="Delivered of final outcome"
                attempts={card.vet402Measurement.attempts}
                denominator={card.vet402Measurement.rates.denominators.finalOutcome}
                delivered={card.vet402Measurement.rates.deliveredOfFinalOutcomePct}
                notDelivered={card.vet402Measurement.rates.notDeliveredOfFinalOutcomePct}
              />
            </div>
            <p className="text-xs text-zinc-600">{OPS_NOT_DELIVERED_RATE_NOTE}</p>
          </>
        )}
      </section>
    </div>
  );
}
