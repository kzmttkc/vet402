import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { GUIDE_CHAINS } from "@/components/site/x402-guides";
import { articleJsonLd, breadcrumbJsonLd, citeAs, DATA_LICENSE_URL, pageMetadata } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";
import { SITE_URL } from "@/lib/site-url";
import { getObservatoryStatsCached } from "@/lib/observatory/cached-reads";
import { deliveredRates } from "@/lib/observatory/delivered-rates";
import { formatPct1 } from "@/lib/util/pct";
import { TableScroll } from "@/components/site/TableScroll";

const PAGE_DESCRIPTION =
  "x402 is an open HTTP 402 payment standard for AI agents. How a payment works, its payment schemes, who maintains it, and live data from real x402 purchases.";

export const metadata: Metadata = pageMetadata({
  title: "What is x402? How it works, with live payment data",
  description: PAGE_DESCRIPTION,
  path: "/x402",
});

export const revalidate = 600;

const FAQ = [
  {
    question: "What is x402?",
    answer:
      "x402 is an open standard for paying for HTTP requests. A server answers 402 Payment Required with payment terms, and the client pays and repeats the request with proof of payment.",
  },
  {
    question: "Is x402 a token?",
    answer:
      "No. x402 is a protocol. Payments use existing assets such as USDC. Tokens that use the x402 name are not part of the standard.",
  },
  {
    question: "Who created x402?",
    answer: "Coinbase created x402 and contributed it to the x402 Foundation, which operates under the Linux Foundation.",
  },
  {
    question: "Which networks does x402 support?",
    answer:
      "The exact scheme has specifications for EVM chains, Solana, Stellar, XRPL, Algorand, Aptos, Sui, NEAR, TON, Hedera, Starknet, Cardano and more. vet402 buys on the chains listed above.",
  },
  {
    question: "Can an x402 payment be refunded?",
    answer:
      "Under the exact scheme a settled payment is final. The auth-capture scheme adds capture, void and refund within deadlines that the payment sets.",
  },
  {
    question: "How can an agent know an x402 seller will deliver?",
    answer:
      "x402 proves that a payment happened. To see what a seller returned, an agent can read vet402's records of real purchases from that seller before it pays.",
  },
] as const;

const SCHEME_NOTE =
  "Under exact, the payment is final once it settles. vet402's purchases tell a buyer what came back from a seller before it signs, which matters most under exact.";

export default async function X402PillarPage() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const stats = await getObservatoryStatsCached().catch(() => null);
  const live = stats !== null;
  const awaiting = stats?.l1.awaitingReread ?? 0;
  const rates = stats
    ? deliveredRates({
        attempts: stats.l1.attempts,
        delivered: stats.l1.delivered,
        inconclusive: stats.l1.inconclusive,
        awaitingReread: awaiting,
      })
    : null;

  const headline = "x402: the HTTP 402 payment standard, explained with live data";
  const article = {
    ...articleJsonLd({
      headline,
      description: PAGE_DESCRIPTION,
      path: "/x402",
      datePublished: "2026-11-10",
      dateModified: stats?.readAt?.slice(0, 10) ?? "2026-11-10",
    }),
    about: { "@type": "Thing" as const, name: "x402" },
  };
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "x402", path: "/x402" },
  ]);
  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQ.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: { "@type": "Answer", text: item.answer },
    })),
  };

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        <script type="application/ld+json" nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: safeJsonLd(article) }} />
        <script type="application/ld+json" nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }} />
        <script type="application/ld+json" nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: safeJsonLd(faqJsonLd) }} />

        <div className="doc-head doc-head-compact">
          <div className="doc-head-col">
            <span>Independent Measurement</span>
            <span>x402 reference</span>
            {live && stats ? (
              <span>
                Ledger read <time dateTime={stats.readAt}>{stats.readAt.slice(0, 16).replace("T", " ")} UTC</time>
              </span>
            ) : (
              <span>Ledger unread</span>
            )}
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>x402 Economy</span>
            <span>2026-11-10</span>
          </div>
        </div>

        <h1 className="doc-title mt-8">{headline}</h1>
        <p className="doc-p">
          x402 is an open payment standard that lets a client, often an AI agent, pay for an HTTP request. The server
          answers 402 Payment Required with its terms, the client signs a payment, often in USDC, and sends the same
          request again with the payment attached. vet402 buys from x402 sellers and publishes what each purchase
          delivered, so this page pairs the explanation with live numbers from those purchases.
        </p>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />

        <h2 className="sec-head mt-8">
          <span>How an x402 payment works</span>
        </h2>
        <ol className="doc-p list-decimal pl-6 space-y-2">
          <li>The client requests a paid resource, for example an API endpoint.</li>
          <li>
            The server answers HTTP 402 with a PAYMENT-REQUIRED header. It carries base64 JSON with one or more accepted
            options: a scheme, a network, an asset, an amount and a recipient (payTo).
          </li>
          <li>The client picks an option, signs a payment payload and repeats the request with a PAYMENT-SIGNATURE header.</li>
          <li>
            The server, usually through a facilitator, verifies and settles the payment, then returns the resource with a
            PAYMENT-RESPONSE header that describes the settlement.
          </li>
        </ol>
        <p className="doc-p">
          A facilitator is a service that verifies and submits payments for one or more networks, so a resource server
          can accept x402 without running its own node. Header names are from x402 v2. Version 1 used X-PAYMENT and
          carried the terms in the response body.{" "}
          <Link href="https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md" className="doc-link">
            x402 v2 specification
          </Link>
        </p>

        <h2 className="sec-head mt-8">
          <span>Payment schemes</span>
        </h2>
        <TableScroll label="x402 payment schemes">
          <table className="fact-table">
            <caption className="sr-only">x402 payment schemes</caption>
            <thead>
              <tr>
                <th scope="col">Scheme</th>
                <th scope="col">What it does</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>exact</td>
                <td>
                  Transfers a fixed amount that the server knows in advance. It moves once and the scheme has no refund
                  step.
                </td>
              </tr>
              <tr>
                <td>upto</td>
                <td>
                  Authorizes up to a maximum amount. The server charges the actual amount at settlement, for usage based
                  pricing.
                </td>
              </tr>
              <tr>
                <td>batch-settlement</td>
                <td>
                  The client gives a signed payment commitment, access is granted at once, and the transfer settles later
                  in a batch defined by the network.
                </td>
              </tr>
              <tr>
                <td>auth-capture</td>
                <td>
                  The client authorizes a maximum. The server can hold, capture, void or refund the payment within
                  deadlines, and the client can reclaim a hold the server never captured.
                </td>
              </tr>
            </tbody>
          </table>
        </TableScroll>
        <p className="doc-p">
          {SCHEME_NOTE}{" "}
          <Link href="https://github.com/x402-foundation/x402/tree/main/specs/schemes" className="doc-link">
            Scheme specifications
          </Link>
        </p>

        <h2 className="sec-head mt-8">
          <span>Who maintains x402</span>
        </h2>
        <p className="doc-p">
          Coinbase contributed the x402 protocol to the x402 Foundation, which the Linux Foundation announced as
          operational on July 14, 2026. The Foundation runs the protocol under open governance. The specification and
          reference SDKs live in the x402-foundation/x402 repository on GitHub.{" "}
          <Link
            href="https://x402.org/linux-foundation-announces-operational-launch-of-x402-foundation-to-standardize-internet-native-payments-for-ai-agents-and-applications/"
            className="doc-link"
          >
            x402.org announcement
          </Link>
          ,{" "}
          <Link href="https://github.com/x402-foundation/x402" className="doc-link">
            GitHub repository
          </Link>
          ,{" "}
          <Link href="https://docs.x402.org" className="doc-link">
            docs.x402.org
          </Link>
          . vet402 is an independent measurement service and is not part of the x402 Foundation.
        </p>

        <h2 className="sec-head mt-8">
          <span>Live data: what x402 sellers delivered</span>
        </h2>
        {live && stats && rates ? (
          <>
            <p className="doc-caption">
              As of{" "}
              <time dateTime={stats.readAt}>{stats.readAt.slice(0, 16).replace("T", " ")} UTC</time>
            </p>
            <p className="doc-p">
              Settled means vet402 re-read the transfer on chain. Delivered means the payment settled and the paid
              request answered 2xx, other than 202 Accepted, with a non-empty body.
            </p>
            <ul className="doc-p list-none space-y-1">
              <li>Purchase attempts: {stats.l1.attempts.toLocaleString()}</li>
              <li>Settled: {stats.l1.settled.toLocaleString()}</li>
              <li>Delivered: {stats.l1.delivered.toLocaleString()}</li>
              <li>
                {rates.denominators.finalOutcome > 0 ? (
                  <>
                    Delivered share: {formatPct1(stats.l1.delivered, rates.denominators.finalOutcome)} of{" "}
                    {rates.denominators.finalOutcome.toLocaleString()} purchases with a final outcome
                  </>
                ) : (
                  <>Delivered share: not available until a purchase has a final outcome</>
                )}
              </li>
              <li>Endpoints with at least one delivery: {stats.l1.endpointsDelivered.toLocaleString()}</li>
            </ul>
            {stats.l1.byChain.length > 0 ? (
              <TableScroll label="L1 purchases by chain">
                <table className="fact-table">
                  <caption className="sr-only">L1 purchases by chain</caption>
                  <thead>
                    <tr>
                      <th scope="col">Chain</th>
                      <th scope="col" className="num">
                        Purchases
                      </th>
                      <th scope="col" className="num">
                        Delivered
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.l1.byChain.map((c) => (
                      <tr key={c.chain}>
                        <td>
                          {c.label === "Tempo" ? `${c.label} (MPP)` : c.label || c.chain}
                        </td>
                        <td className="num">{c.attempts.toLocaleString()}</td>
                        <td className="num">{c.delivered.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            ) : null}
            <p className="doc-p">
              <Link href="/observatory/state" className="doc-link">
                Full state of x402
              </Link>
              ,{" "}
              <Link href="/api/v1/observatory/state" className="doc-link">
                State API (JSON)
              </Link>
              ,{" "}
              <Link href="/api/v1/observatory/export.csv" className="doc-link">
                Purchases as CSV
              </Link>
              ,{" "}
              <Link href="/x402/report/2026-11" className="doc-link">
                State of x402: November 2026
              </Link>
              .{" "}
              <Link href={DATA_LICENSE_URL} className="doc-link">
                Data under CC BY 4.0.
              </Link>
            </p>
            <p className="doc-p doc-caption">
              Cite as: {citeAs("observatory", `${SITE_URL}/api/v1/observatory/state`, stats.readAt.slice(0, 10))}
            </p>
          </>
        ) : (
          <p className="doc-p">
            Live figures are unavailable right now. The state API is at{" "}
            <Link href="/api/v1/observatory/state" className="doc-link">
              /api/v1/observatory/state
            </Link>
            .
          </p>
        )}

        <h2 className="sec-head mt-8">
          <span>Check an x402 seller before paying</span>
        </h2>
        <p className="doc-p">
          A 402 tells a buyer the price and the recipient. It does not say what will come back. Before an agent signs,
          it can read what vet402 received when it paid the same seller, and compare the 402 in hand with the terms of
          the last purchase that delivered.{" "}
          <Link href="/x402/check-a-seller" className="doc-link">
            How to check a seller
          </Link>
          ,{" "}
          <Link href="/docs/mcp" className="doc-link">
            Hosted MCP server
          </Link>
          ,{" "}
          <Link href="/docs/api" className="doc-link">
            Decision API
          </Link>
        </p>

        <h2 className="sec-head mt-8">
          <span>x402 by chain</span>
        </h2>
        <p className="doc-p">Assets, networks and live counts for each chain vet402 buys on.</p>
        <p className="doc-p">
          {GUIDE_CHAINS.map((c, i) => (
            <span key={c.slug}>
              {i > 0 ? ", " : ""}
              <Link href={`/x402/chains/${c.slug}`} className="doc-link">
                {c.publicName}
              </Link>
            </span>
          ))}
          ,{" "}
          <Link href="/x402/chains" className="doc-link">
            All chains
          </Link>
          ,{" "}
          <Link href="/x402/stablecoin-payments" className="doc-link">
            Stablecoin payments over x402
          </Link>
        </p>

        <h2 className="sec-head mt-8">
          <span>Questions about x402</span>
        </h2>
        <dl className="space-y-6">
          {FAQ.map((item) => (
            <div key={item.question}>
              <dt className="font-medium text-brand-deep">{item.question}</dt>
              <dd className="doc-p mt-1">{item.answer}</dd>
            </div>
          ))}
        </dl>
      </article>
    </main>
  );
}
