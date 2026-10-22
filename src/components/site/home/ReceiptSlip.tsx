import Link from "next/link";
import { Mark402 } from "@/components/site/Mark402";
import { deliveredLine, fmt, utc, type HomeReceipt } from "@/lib/observatory/home-example";
import { SITE_URL } from "@/lib/site-url";

const DISPLAY = "font-[family-name:var(--font-display)]";

function Corner({ className }: { className: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 12 12" className={`absolute h-3 w-3 ${className}`}>
      <path d="M0 6H12M6 0V12" stroke="#233456" strokeWidth="1.25" />
    </svg>
  );
}

export function ReceiptSlip({ receipt }: { receipt: HomeReceipt }) {
  const r = receipt;
  const delivered = deliveredLine(r);
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
      v: delivered.text,
      strong: delivered.strong,
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
    <figure aria-labelledby="receipt-title" className="slip relative mt-16 min-w-0 border-y border-dashed border-brand-deep px-4 py-6 sm:px-6">
      <Corner className="-left-1.5 -top-1.5" />
      <Corner className="-right-1.5 -top-1.5" />
      <Corner className="-bottom-1.5 -left-1.5" />
      <Corner className="-bottom-1.5 -right-1.5" />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <p id="receipt-title" className={`${DISPLAY} whitespace-nowrap text-[1.0625rem] font-semibold text-brand-deep`}>
            One purchase
          </p>
          <p className="mt-1 whitespace-nowrap text-[0.84375rem] text-brand-lift">
            <time dateTime={r.attemptedAt}>
              {r.date} {r.time} UTC
            </time>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <svg aria-hidden="true" viewBox="0 0 88 32" className="h-8 w-auto -rotate-[4deg] text-brand-deep">
            <rect x="1" y="1" width="86" height="30" fill="none" stroke="currentColor" strokeWidth="1.25" />
            <rect x="3.5" y="3.5" width="81" height="25" fill="none" stroke="currentColor" strokeWidth="0.6" />
            <text
              x="44"
              y="21"
              textAnchor="middle"
              fill="currentColor"
              fontSize="12"
              letterSpacing="1.4"
              style={{ fontFamily: "var(--font-display), ui-monospace, monospace" }}
            >
              SETTLED
            </text>
          </svg>
          <Mark402 className="h-auto w-11 shrink-0" />
        </div>
      </div>
      <dl className="mt-6 border-t border-dashed border-brand-mist text-[0.84375rem] leading-[1.45]">
        {rows.map((row) => (
          <div key={row.k} className="grid grid-cols-[9.5rem_minmax(0,1fr)] gap-3 border-b border-hair py-2 max-sm:grid-cols-[7.5rem_minmax(0,1fr)]">
            <dt className="text-brand-lift">{row.k}</dt>
            <dd className={row.strong ? `${DISPLAY} font-semibold text-brand-deep` : "text-brand-deep"}>{row.v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-6 text-[0.75rem] uppercase tracking-[0.18em] text-brand-lift">Reproduce this line</p>
      <pre
        tabIndex={0}
        aria-label="Command that prints this purchase from the public export"
        className="mt-2 overflow-x-auto whitespace-pre-wrap break-all border-l border-brand-deep pl-3 text-[0.75rem] leading-[1.6] text-brand-deep"
      >
        <code>{reproduce}</code>
      </pre>
      <figcaption className="doc-note mt-6 border-t border-dashed border-brand-mist pt-4">
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
