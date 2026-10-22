import Link from "next/link";
import { Mark402 } from "@/components/site/Mark402";
import { fmt, utc, type HomeReceipt } from "@/lib/observatory/home-example";
import { SITE_URL } from "@/lib/site-url";

const DISPLAY = "font-[family-name:var(--font-display)]";

function Corner({ className }: { className: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 12 12" className={`absolute h-3 w-3 ${className}`}>
      <path d="M0 6H12M6 0V12" stroke="#233456" strokeWidth="1.25" />
    </svg>
  );
}

/** A 202 or an empty 2xx body is a 2xx that isDelivered does not count, so "no 2xx" would be false there. */
function notDeliveredWord(http: number | null): string {
  if (http === 202) return "no, 202 accepted only";
  if (http !== null && http >= 200 && http < 300) return "no, empty body";
  return "no 2xx";
}

export function ReceiptSlip({ receipt }: { receipt: HomeReceipt }) {
  const r = receipt;
  const rows: { k: string; v: React.ReactNode; strong?: boolean }[] = [
    {
      k: "Endpoint",
      v: (
        <span className="break-all">
          {r.host}
          <span className="text-brand">{r.path}</span>
        </span>
      ),
    },
    { k: "Price", v: `${r.amount} ${r.asset}` },
    { k: "Chain", v: <span title={r.network}>{r.chain}</span> },
    {
      k: "Payment",
      v: `settled, re-read on chain${r.settlementSource === "vet402_index" ? ", found by vet402's index" : ""}`,
    },
    { k: "HTTP after payment", v: r.httpStatus ?? "none" },
    {
      k: "Delivered",
      v: r.held ? "held, inconclusive" : r.delivered ? "yes, 2xx" : notDeliveredWord(r.httpStatus),
      strong: !r.held,
    },
    { k: "Against declaration", v: r.l2 },
    {
      k: "Transaction",
      v: r.txUrl ? (
        <a href={r.txUrl} className="doc-link" rel="noopener noreferrer" target="_blank" title={r.tx}>
          {r.txShort}
        </a>
      ) : (
        <span title={r.tx}>{r.txShort}</span>
      ),
    },
  ];
  const reproduce = `curl -sL "${SITE_URL}/api/v1/observatory/export.csv?days=1" | grep ${r.purchaseId.slice(0, 8)}`;
  return (
    <figure aria-labelledby="receipt-title" className="relative mt-16 min-w-0 border-y border-dashed border-brand-deep px-1 py-6 sm:mt-20 sm:px-5">
      <Corner className="-left-1.5 -top-1.5" />
      <Corner className="-right-1.5 -top-1.5" />
      <Corner className="-bottom-1.5 -left-1.5" />
      <Corner className="-bottom-1.5 -right-1.5" />
      <div className="flex items-start justify-between gap-4">
        <div>
          <p id="receipt-title" className={`${DISPLAY} text-[1.0625rem] font-semibold text-brand-deep`}>
            One purchase
          </p>
          <p className="mt-1 text-[0.8125rem] text-brand-lift">
            <time dateTime={r.attemptedAt}>
              {r.date} {r.time} UTC
            </time>
          </p>
        </div>
        <Mark402 className="h-auto w-11 shrink-0" />
      </div>
      <dl className="mt-5 border-t border-dashed border-brand-mist text-[0.8125rem] leading-[1.55] sm:text-[0.875rem]">
        {rows.map((row) => (
          <div key={row.k} className="grid grid-cols-[9.5rem_minmax(0,1fr)] gap-3 border-b border-hair py-2 max-sm:grid-cols-[7.5rem_minmax(0,1fr)]">
            <dt className="text-brand-lift">{row.k}</dt>
            <dd className={row.strong ? `${DISPLAY} font-semibold text-brand-deep` : "text-brand-deep"}>{row.v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-5 text-[0.75rem] uppercase tracking-[0.18em] text-brand-lift">Reproduce this line</p>
      <pre
        tabIndex={0}
        aria-label="Command that prints this purchase from the public export"
        className="mt-2 overflow-x-auto whitespace-pre-wrap break-all border-l border-brand-deep pl-3 text-[0.75rem] leading-[1.6] text-brand-deep"
      >
        <code>{reproduce}</code>
      </pre>
      <figcaption className="doc-note mt-5 border-t border-dashed border-brand-mist pt-4">
        Rule: the settled purchase with the latest time in the public export of the last day. It is 1 of{" "}
        {fmt(r.windowSettled)} settled in {fmt(r.windowRows)} rows from {utc(r.windowFrom, false)} to {utc(r.windowTo, false)} UTC.
        {r.chain === "Base" ? (
          <>
            {" "}
            <Link href={`/sellers/${encodeURIComponent(r.host)}`} className="doc-link">
              Everything vet402 bought from {r.host}
            </Link>
            .
          </>
        ) : null}
      </figcaption>
    </figure>
  );
}
