import {
  SUPPORTED_CHAINS,
  laneBody,
  markerOf,
  settledCountOf,
  type SupportedChain,
} from "@/components/site/supported-chains-data";

/**
 * LP §5 — one row per chain, in the same grammar as the §4 / §6 rows of the front
 * page (marker column, display-face title, body): no new tokens, no new parts.
 *
 * `settledByChain` comes from `settledByChainOf(stats.l1.byChain)`: null when the L1
 * ledger was not read, and then the rows print their static state and no count.
 */
export function SupportedChains({ settledByChain }: { settledByChain: Map<string, number> | null }) {
  return (
    <div className="mt-6 divide-y divide-hair border-t border-brand-deep">
      {SUPPORTED_CHAINS.map((row) => (
        <ChainRow
          key={row.chain}
          row={row}
          settled={settledCountOf(row, settledByChain)}
        />
      ))}
    </div>
  );
}

function ChainRow({ row, settled }: { row: SupportedChain; settled: number | null }) {
  const marker = markerOf(row, settled);
  return (
    <div className="flex flex-col gap-2 py-5 sm:flex-row sm:gap-6">
      <div className="shrink-0 sm:w-[14ch] sm:pt-0.5">
        <span className={marker.live ? "marker marker-live" : "marker marker-plan"}>
          {marker.label}
        </span>
      </div>
      <div className="min-w-0 max-w-[58ch]">
        <p className="font-[family-name:var(--font-display)] font-semibold text-brand-deep">
          {row.chain}
        </p>
        <p className="mt-2 text-brand">
          {row.kind === "lane"
            ? laneBody(row, settled)
            : row.body.map((part, i) =>
                typeof part === "string" ? (
                  <span key={i}>{part}</span>
                ) : (
                  <code key={i} className="text-brand-deep">
                    {part.code}
                  </code>
                ),
              )}
        </p>
        {row.kind === "lane" && settled !== null ? (
          <p className="mt-2 text-[0.8125rem] text-brand-lift">
            Settled purchases on record: {settled.toLocaleString()}
          </p>
        ) : null}
      </div>
    </div>
  );
}
