import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { pageMetadata, breadcrumbJsonLd } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";
import { TableScroll } from "@/components/site/TableScroll";
import { getStatusHistory } from "@/lib/health/snapshot";

/**
 * /status — B5, 2026-08-15. The record of vet402's own uptime, published the
 * same way everything else on this site is: measured, not asserted.
 *
 * No fixed-interval monitor sits behind this. Vercel Hobby silently breaks
 * deploys past one cron run a day (measured 2026-07-29), so instead of a
 * schedule, GET /api/health opportunistically writes a row (at most one row
 * per 5 minutes unless the status changed). A quiet day
 * therefore has few or zero rows — this page says so rather than filling the
 * gap with an assumed 100%, the same discipline /observatory and /accuracy
 * already hold to.
 */

export const metadata: Metadata = pageMetadata({
  title: "Status",
  description:
    "vet402's own uptime, measured the same way everything else on this site is: real page-view samples, published as observed — no fixed-interval monitor, no assumed 100% on quiet days.",
  path: "/status",
});

export const revalidate = 300;

function VerdictWord({ ok, degraded, error }: { ok: number; degraded: number; error: number }) {
  if (error > 0) return <span className="text-block-ink font-semibold">error</span>;
  if (degraded > 0) return <span className="text-warn-ink">degraded</span>;
  if (ok > 0) return <span className="text-brand-deep">ok</span>;
  return <span className="text-brand-lift">no observations</span>;
}

function fmtDay(date: string): string {
  return date;
}

function fmtDateTime(d: Date): string {
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export default async function StatusPage() {
  const history = await getStatusHistory(30);
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "Status", path: "/status" },
  ]);

  // Sort newest first for the table; summarizeByDay returns oldest-first.
  const daysNewestFirst = [...history.days].reverse();

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        <script
          type="application/ld+json"
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }}
        />

        <div className="doc-head">
          <div className="doc-head-col">
            <span>Independent Measurement</span>
            <span>Instrument: own uptime</span>
            <span>
              Current:{" "}
              <span className="text-signal">{history.current?.status ?? "not yet observed"}</span>
            </span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>
              <Link href="/observatory/methodology" className="underline">
                Methodology
              </Link>
            </span>
            <span>Sampled from real traffic, not a fixed-interval monitor</span>
          </div>
        </div>

        <h1 className="doc-title mt-10">Status</h1>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />

        <div className="mt-8 flex flex-col gap-1 sm:flex-row sm:gap-0">
          <p className="shrink-0 text-brand-deep sm:w-[10ch]">Abstract</p>
          <p className="min-w-0 max-w-[62ch] text-brand">
            vet402&apos;s own uptime, measured the same way the rest of this site measures
            anything: no claim without a sample behind it. There is no fixed-interval external
            monitor here &mdash; a row is recorded from real page views, at most one every five
            minutes unless the status changed, so a quiet day carries fewer samples and a silent
            day carries none. <em>A missing observation is never reported as &quot;ok.&quot;</em>
          </p>
        </div>

        <h2 className="sec-head">
          <span className="sec-no">1.</span>
          <span>Current status</span>
        </h2>
        <p className="doc-p">
          {history.current ? (
            <>
              <strong>{history.current.status}</strong>, last sampled{" "}
              {fmtDateTime(history.current.checkedAt)}.
            </>
          ) : (
            <>No sample has been recorded yet.</>
          )}
        </p>

        <h2 className="sec-head">
          <span className="sec-no">2.</span>
          <span>Last 30 days, by day</span>
        </h2>
        <p className="doc-p">
          {history.monitoringSince ? (
            <>Monitoring since {fmtDateTime(history.monitoringSince)}.</>
          ) : (
            <>No monitoring history yet &mdash; this page went live 2026-08-15.</>
          )}{" "}
          A day with no row below was not observed, which is not the same claim as
          &quot;ok.&quot;
        </p>

        {daysNewestFirst.length === 0 ? (
          <p className="doc-p text-brand-lift">
            No samples in the last 30 days. Traffic drives the sampling, so a quiet window can be
            empty here even when nothing is wrong &mdash; see{" "}
            <Link href="/observatory/methodology" className="underline">
              the methodology
            </Link>{" "}
            for what this page can and cannot claim.
          </p>
        ) : (
          <TableScroll label="Daily status samples over the last 30 days">
            <table className="fact-table">
              <caption className="sr-only">Daily status samples over the last 30 days</caption>
              <thead>
                <tr>
                  <th scope="col">Day</th>
                  <th scope="col">Worst observed</th>
                  <th scope="col" className="num">
                    Samples
                  </th>
                  <th scope="col" className="num">
                    ok
                  </th>
                  <th scope="col" className="num">
                    degraded
                  </th>
                  <th scope="col" className="num">
                    error
                  </th>
                </tr>
              </thead>
              <tbody>
                {daysNewestFirst.map((d) => (
                  <tr key={d.date}>
                    <td className="whitespace-nowrap">{fmtDay(d.date)}</td>
                    <td>
                      <VerdictWord ok={d.ok} degraded={d.degraded} error={d.error} />
                    </td>
                    <td className="num">{d.total}</td>
                    <td className="num">{d.ok}</td>
                    <td className="num">{d.degraded}</td>
                    <td className="num">{d.error}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}

        <h2 className="sec-head">
          <span className="sec-no">3.</span>
          <span>What ok / degraded / error mean here</span>
        </h2>
        <p className="doc-p">
          The same three values{" "}
          <Link href="/observatory/methodology" className="underline">
            the observatory
          </Link>{" "}
          uses, computed by the same probe <code>/api/health</code> runs: <strong>ok</strong>{" "}
          &mdash; scoring and payee lookups both answered. <strong>degraded</strong> &mdash; the
          upstream indexer is behind, so a lookup may return &quot;not verifiable&quot; instead of
          a number. <strong>error</strong> &mdash; scoring is failing outright. A day is marked by
          its worst sample, not an average, so one bad five minutes is never hidden inside a
          mostly-good day.
        </p>
      </article>
    </main>
  );
}
