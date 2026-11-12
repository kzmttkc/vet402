import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { ReportMarkdownBody } from "@/components/site/reports/ReportMarkdownBody";
import { parseReportMarkdown } from "@/lib/reports/markdown";
import { articleJsonLd, breadcrumbJsonLd, datasetJsonLd, pageMetadata } from "@/lib/seo";
import { SITE_URL } from "@/lib/site-url";
import { safeJsonLd } from "@/lib/util/json-ld";

const REPORT_PATH = "/x402/report/2026-11";
const SNAPSHOT_DATE = "2026-11-09";
const PUBLISHED = "2026-11-10";

const DESCRIPTION =
  "87.9 percent of vet402's paid call attempts with a final outcome came back with content, as of 2026-11-09 (UTC). By chain, and why paid x402 calls fail.";

export const metadata: Metadata = pageMetadata({
  title: "State of x402: November 2026",
  description: DESCRIPTION,
  path: REPORT_PATH,
  ogType: "article",
  publishedTime: PUBLISHED,
  modifiedTime: PUBLISHED,
});

function loadReportMarkdown(): string {
  return readFileSync(join(process.cwd(), "content", "reports", "state-of-x402-2026-11.md"), "utf8");
}

export default async function StateOfX402ReportPage() {
  const markdown = loadReportMarkdown();
  const doc = parseReportMarkdown(markdown);
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  const article = articleJsonLd({
    headline: doc.title,
    description: DESCRIPTION,
    path: REPORT_PATH,
    datePublished: PUBLISHED,
    dateModified: PUBLISHED,
  });

  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "x402", path: "/x402" },
    { name: "State of x402: November 2026", path: REPORT_PATH },
  ]);

  const dataset = datasetJsonLd({
    name: "State of x402: November 2026",
    citeName: "observatory",
    description:
      "Dated snapshot of vet402 L1 delivery outcomes across the public x402 catalog, aligned with the observatory state API as of the snapshot date.",
    path: REPORT_PATH,
    citeUrl: `${SITE_URL}/api/v1/observatory/state`,
    temporalCoverage: SNAPSHOT_DATE,
    dateModified: PUBLISHED,
    measurementTechnique:
      "vet402 buys from public x402 catalogs and the MPP directory with its own wallets, records what came back over HTTP, then re-reads the settlement on chain. Counts in the report match the public observatory API on the snapshot date.",
    variableMeasured: [
      "paid call attempts",
      "settled on chain",
      "delivered (content returned)",
      "calls with a final outcome",
      "settled with no usable content",
      "settled then 4xx",
      "endpoints attempted",
      "settled and delivered counts by chain",
    ],
    keywords: ["x402", "agent payments", "HTTP 402", "settlement", "delivery rate"],
    retrievedAt: SNAPSHOT_DATE,
    distribution: [
      {
        name: "Aggregate snapshot (JSON)",
        encodingFormat: "application/json",
        contentUrl: `${SITE_URL}/api/v1/observatory/state`,
      },
    ],
  });

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        <script
          type="application/ld+json"
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: safeJsonLd(article) }}
        />
        <script
          type="application/ld+json"
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }}
        />
        <script
          type="application/ld+json"
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: safeJsonLd(dataset) }}
        />

        <div className="doc-head doc-head-compact">
          <div className="doc-head-col">
            <span>x402 Economy</span>
            <span>Dated snapshot</span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>Observatory</span>
            <span>{PUBLISHED}</span>
          </div>
        </div>

        <h1 className="doc-title mt-8">{doc.title}</h1>
        <p className="doc-caption mt-2">
          Snapshot as of {SNAPSHOT_DATE} (UTC). Live figures:{" "}
          <Link href="/x402" className="doc-link">
            /x402
          </Link>
        </p>

        <ReportMarkdownBody doc={doc} />
      </article>
    </main>
  );
}
