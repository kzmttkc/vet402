import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import CodeBlock from "@/components/docs/CodeBlock";
import { TableScroll } from "@/components/site/TableScroll";
import { articleJsonLd, breadcrumbJsonLd, pageMetadata } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";
import { SITE_URL } from "@/lib/site-url";
import {
  SELLER_REPUTATION_API,
  SELLER_REPUTATION_CHECK_FIELDS,
  SELLER_REPUTATION_API_PUBLISHED,
} from "@/lib/x402/seller-reputation-sections";

const PAGE = SELLER_REPUTATION_API;
const EXAMPLE_URL = `${SITE_URL}/api/v1/check?url=https%3A%2F%2Fexample.com%2Fpaid`;
const CURL = `curl -sS "${EXAMPLE_URL}"`;

export const metadata: Metadata = pageMetadata({
  title: PAGE.title,
  description: PAGE.description,
  path: PAGE.path,
  markdown: true,
});

export default async function SellerReputationApiPage() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const article = articleJsonLd({
    headline: PAGE.h1,
    description: PAGE.description,
    path: PAGE.path,
    datePublished: SELLER_REPUTATION_API_PUBLISHED,
  });
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "x402", path: "/x402" },
    { name: "Seller reputation API", path: PAGE.path },
  ]);

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        <script type="application/ld+json" nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: safeJsonLd(article) }} />
        <script type="application/ld+json" nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }} />

        <div className="doc-head doc-head-compact">
          <div className="doc-head-col">
            <span>Independent Measurement</span>
            <span>Before an agent pays</span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>x402 Economy</span>
            <span>{SELLER_REPUTATION_API_PUBLISHED}</span>
          </div>
        </div>

        <h1 className="doc-title mt-8">{PAGE.h1}</h1>
        {PAGE.lead.map((sentence) => (
          <p key={sentence} className="doc-p">
            {sentence}
          </p>
        ))}
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />

        <h2 className="sec-head">
          <span className="sec-no">1.</span>
          <span>{PAGE.sections.curl.title}</span>
        </h2>
        <p className="doc-p">{PAGE.sections.curl.body}</p>
        <CodeBlock label="GET /api/v1/check" code={CURL} />

        <h2 className="sec-head">
          <span className="sec-no">2.</span>
          <span>{PAGE.sections.fields.title}</span>
        </h2>
        <p className="doc-p">{PAGE.sections.fields.body}</p>
        <TableScroll label="Check response fields" className="mt-4">
          <table className="fact-table">
            <caption className="sr-only">Fields returned by GET /api/v1/check</caption>
            <thead>
              <tr>
                <th scope="col">Field</th>
                <th scope="col">Meaning</th>
              </tr>
            </thead>
            <tbody>
              {SELLER_REPUTATION_CHECK_FIELDS.map((row) => (
                <tr key={row.field}>
                  <td>
                    <code>{row.field}</code>
                  </td>
                  <td>{row.meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>

        <h2 className="sec-head">
          <span className="sec-no">3.</span>
          <span>{PAGE.sections.decision.title}</span>
        </h2>
        <p className="doc-p">{PAGE.sections.decision.body}</p>

        <h2 className="sec-head">
          <span className="sec-no">4.</span>
          <span>{PAGE.sections.verdicts.title}</span>
        </h2>
        <ul className="doc-p list-disc pl-6 space-y-2">
          <li>
            <strong>ALLOW.</strong> {PAGE.sections.verdicts.allow}
          </li>
          <li>
            <strong>WARN.</strong> {PAGE.sections.verdicts.warn}
          </li>
          <li>
            <strong>BLOCK.</strong> {PAGE.sections.verdicts.block}
          </li>
        </ul>

        <p className="doc-p mt-6">
          Full endpoint list and rate limits:{" "}
          <Link href="/docs/api" className="doc-link">
            Decision API reference
          </Link>
          . Step-by-step buyer guide:{" "}
          <Link href="/x402/check-a-seller" className="doc-link">
            How a seller check works
          </Link>
          . Hosted MCP:{" "}
          <Link href="/docs/mcp" className="doc-link">
            x402 MCP server
          </Link>{" "}
          (tool <code>check_x402_seller</code>).
        </p>
      </article>
    </main>
  );
}