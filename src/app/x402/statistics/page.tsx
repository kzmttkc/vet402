import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import {
  breadcrumbJsonLd,
  citeAs,
  DATA_LICENSE_URL,
  datasetJsonLd,
  pageMetadata,
  webPageJsonLd,
} from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";
import { SITE_URL } from "@/lib/site-url";
import { getObservatoryStatsCached } from "@/lib/observatory/cached-reads";
import { publicChainLabel } from "@/lib/observatory/chains";
import { TableScroll } from "@/components/site/TableScroll";
import { GUIDE_UPDATED } from "@/components/site/x402-answers";
import { PINNED_ASSETS_WITH_ISSUER_TEXT } from "@/lib/observatory/settlement-assets";

const PATH = "/x402/statistics";

const PAGE_TITLE = "x402 statistics: paid purchases, settlement, and delivery";
const PAGE_DESCRIPTION =
  "Counts from vet402's real x402 purchases: attempts, on-chain settlement, delivery, and purchase results by chain, from the public observatory state.";

/** Verbatim from GET /api/v1/observatory/state disclaimer and /observatory/state prose. */
const DEFINITIONS = {
  attempts: "an attempt is a paid request whose payment was signed and sent, whatever the seller answered.",
  settled: "l1.settled is the transfer vet402 re-read on-chain.",
  delivered:
    "l1.delivered is a settled attempt whose paid request also answered HTTP 2xx other than 202 Accepted, with a non-empty body.",
  settledNotDelivered:
    "Settled minus delivered minus inconclusiveSettled counts settled rows that are not delivered and not inconclusive (5xx, 202 Accepted, an empty 2xx body, or no HTTP status on record), not a 4xx vet402 could have malformed. l1.settledNotDelivered publishes that count directly.",
  endpointsAttempted: "Distinct endpoints purchased from",
  endpointsDelivered:
    "l1.endpointsDelivered counts endpoints, active or not, with at least one delivered row.",
  byChain: "l1.byChain covers every chain an L1 attempt ran on and sums to the l1 totals.",
} as const;

export const metadata: Metadata = pageMetadata({
  title: PAGE_TITLE,
  description: PAGE_DESCRIPTION,
  path: PATH,
  markdown: true,
});

export const revalidate = 300;

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function formatReadDate(iso: string): string {
  return iso.slice(0, 10);
}

export default async function X402StatisticsPage() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const stats = await getObservatoryStatsCached().catch(() => null);
  const live = stats !== null;
  const readAt = stats?.readAt ?? null;
  const rows = stats?.l1.byChain ?? [];

  const answerLead =
    live && stats
      ? `vet402 has attempted ${fmt(stats.l1.attempts)} paid x402 purchases; ${fmt(stats.l1.settled)} settled on-chain and ${fmt(stats.l1.delivered)} came back delivered, as of ${formatReadDate(stats.readAt)}.`
      : null;

  const dataset = live && readAt
    ? datasetJsonLd({
        name: "x402 purchase statistics",
        citeName: "observatory",
        description: PAGE_DESCRIPTION,
        path: PATH,
        citeUrl: `${SITE_URL}/api/v1/observatory/state`,
        retrievedAt: readAt,
        // Verbatim L1 clause of the /observatory/state Dataset measurementTechnique.
        measurementTechnique:
          "L1: a real-money purchase of that chain's pinned asset (" +
          PINNED_ASSETS_WITH_ISSUER_TEXT +
          ") made under vet402's own User-Agent, with the settlement transaction re-read on-chain before it is called settled.",
        variableMeasured: [
          "L1 paid purchase attempts",
          "L1 settled with on-chain receipt",
          "L1 delivered",
          "L1 settled but not delivered",
          "endpoints purchased from",
          "endpoints with at least one delivery",
        ],
        keywords: ["x402", "x402 statistics", "delivery rate", "L1", "settled", "delivered"],
        distribution: [
          {
            name: "Observatory state JSON",
            encodingFormat: "application/json",
            contentUrl: `${SITE_URL}/api/v1/observatory/state`,
          },
        ],
      })
    : null;

  const webPage = webPageJsonLd({
    name: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
    path: PATH,
    isBasedOn: `${SITE_URL}/api/v1/observatory/state`,
  });

  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "x402", path: "/x402" },
    { name: "Statistics", path: PATH },
  ]);

  const measures = live && stats
    ? [
        { key: "l1.attempts", label: "Paid purchase attempts", value: stats.l1.attempts, definition: DEFINITIONS.attempts },
        { key: "l1.settled", label: "Settled", value: stats.l1.settled, definition: DEFINITIONS.settled },
        { key: "l1.delivered", label: "Delivered", value: stats.l1.delivered, definition: DEFINITIONS.delivered },
        {
          key: "l1.settledNotDelivered",
          label: "Settled but not delivered",
          value: stats.l1.settledNotDelivered,
          definition: DEFINITIONS.settledNotDelivered,
        },
        {
          key: "l1.endpointsAttempted",
          label: "Endpoints purchased from",
          value: stats.l1.endpointsAttempted,
          definition: DEFINITIONS.endpointsAttempted,
        },
        {
          key: "l1.endpointsDelivered",
          label: "Endpoints with at least one delivery",
          value: stats.l1.endpointsDelivered,
          definition: DEFINITIONS.endpointsDelivered,
        },
      ]
    : [];

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        <script type="application/ld+json" nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: safeJsonLd(webPage) }} />
        {dataset ? (
          <script type="application/ld+json" nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: safeJsonLd(dataset) }} />
        ) : null}
        <script type="application/ld+json" nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }} />

        <div className="doc-head doc-head-compact">
          <div className="doc-head-col">
            <span>Independent Measurement</span>
            <span>L1 ledger</span>
            {live && readAt ? (
              <span>
                Ledger read <time dateTime={readAt}>{readAt.slice(0, 16).replace("T", " ")} UTC</time>
              </span>
            ) : (
              <span>Ledger unread</span>
            )}
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>
              <Link href="/observatory/state" className="underline">
                State of x402
              </Link>
            </span>
            <span>{GUIDE_UPDATED}</span>
          </div>
        </div>

        <h1 className="doc-title mt-8">x402 purchase statistics</h1>
        {answerLead ? (
          <p className="doc-p text-brand-deep font-medium">{answerLead}</p>
        ) : (
          <p className="doc-p">The ledger could not be read for this rendering, so no counts are shown.</p>
        )}
        <p className="doc-p">
          vet402 buys from public x402 sellers with real money. For each paid request it records whether the transfer
          settled on-chain and whether the response counted as delivered. The same figures appear on{" "}
          <Link href="/observatory/state" className="doc-link">
            State of x402
          </Link>
          .
        </p>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />

        <h2 className="sec-head">
          <span className="sec-no">1.</span>
          <span>Headline counts</span>
        </h2>
        {!live ? (
          <p className="doc-p">The ledger could not be read for this rendering, so no counts are shown.</p>
        ) : (
          <TableScroll label="x402 L1 purchase statistics">
            <table className="fact-table">
              <caption className="sr-only">x402 L1 purchase statistics from the observatory state</caption>
              <thead>
                <tr>
                  <th scope="col">Field</th>
                  <th scope="col" className="num">
                    Count
                  </th>
                  <th scope="col">Definition</th>
                </tr>
              </thead>
              <tbody>
                {measures.map((m) => (
                  <tr key={m.key}>
                    <td className="text-brand">
                      <code>{m.key}</code>
                      <div className="mt-1 text-brand-lift">{m.label}</div>
                    </td>
                    <td className="num">{fmt(m.value)}</td>
                    <td className="text-brand-lift text-[0.9375rem]">{m.definition}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}

        {live && readAt ? (
          <p className="doc-p mt-4 text-[0.84375rem] text-brand-lift">
            This page read the ledger at <time dateTime={readAt}>{readAt}</time>. The JSON at{" "}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/api/v1/observatory/state" className="doc-link">
              /api/v1/observatory/state
            </a>{" "}
            names the same figures and carries <code>retrievedAt</code> for when that response was assembled.
          </p>
        ) : null}

        <h2 className="sec-head">
          <span className="sec-no">2.</span>
          <span>By chain</span>
        </h2>
        <p className="doc-p">{DEFINITIONS.byChain}</p>
        {!live || rows.length === 0 ? (
          <p className="doc-p">No chain rows in this read.</p>
        ) : (
          <TableScroll label="L1 purchases by chain">
            <table className="fact-table">
              <caption className="sr-only">L1 purchases by chain</caption>
              <thead>
                <tr>
                  <th scope="col">Chain</th>
                  <th scope="col" className="num">
                    attempts
                  </th>
                  <th scope="col" className="num">
                    settled
                  </th>
                  <th scope="col" className="num">
                    delivered
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.chain}>
                    <td className="text-brand">
                      <span className="block max-w-[9rem] truncate sm:max-w-none" title={c.network || c.chain}>
                        {c.label || publicChainLabel(c.chain)}
                      </span>
                    </td>
                    <td className="num">{fmt(c.attempts)}</td>
                    <td className="num">{fmt(c.settled)}</td>
                    <td className="num">{fmt(c.delivered)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}

        <p className="doc-p mt-8">
          Source:{" "}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/api/v1/observatory/state" className="doc-link">
            /api/v1/observatory/state
          </a>{" "}
          ({DATA_LICENSE_URL}). Methodology:{" "}
          <Link href="/observatory/methodology" className="doc-link">
            observatory methodology
          </Link>
          . Chain guides:{" "}
          <Link href="/x402/chains" className="doc-link">
            x402 and MPP payments by chain
          </Link>
          .{" "}
          {live && readAt
            ? citeAs("observatory", `${SITE_URL}/api/v1/observatory/state`, readAt)
            : citeAs("observatory", `${SITE_URL}/api/v1/observatory/state`)}
        </p>
      </article>
    </main>
  );
}
