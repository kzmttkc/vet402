import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { articleJsonLd, breadcrumbJsonLd, pageMetadata } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";
import { GUIDE_UPDATED } from "@/components/site/x402-answers";
import { TRUST_SCORE_PAGE } from "@/lib/x402/trust-score-sections";
import { getObservatoryStatsCached } from "@/lib/observatory/cached-reads";

const PAGE = TRUST_SCORE_PAGE;

export const metadata: Metadata = pageMetadata({
  title: PAGE.title,
  description: PAGE.description,
  path: PAGE.path,
  markdown: true,
});

export const revalidate = 300;

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

export default async function TrustScorePage() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const stats = await getObservatoryStatsCached().catch(() => null);
  const live = stats !== null && stats.l1.attempts > 0;
  const readAt = stats?.readAt;
  const article = articleJsonLd({
    headline: "x402 trust score",
    description: PAGE.description,
    path: PAGE.path,
    datePublished: GUIDE_UPDATED,
    dateModified: readAt?.slice(0, 10) ?? GUIDE_UPDATED,
  });
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "x402", path: "/x402" },
    { name: "Trust score", path: PAGE.path },
  ]);

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        <script type="application/ld+json" nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: safeJsonLd(article) }} />
        <script type="application/ld+json" nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }} />

        <div className="doc-head doc-head-compact">
          <div className="doc-head-col">
            <span>Independent Measurement</span>
            <span>Instead of 0 to 100</span>
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
            <span>x402 Economy</span>
            <span>{GUIDE_UPDATED}</span>
          </div>
        </div>

        <h1 className="doc-title mt-8">x402 trust score</h1>
        {PAGE.lead.map((sentence) => (
          <p key={sentence} className="doc-p">
            {sentence}
          </p>
        ))}
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />

        <h2 className="sec-head">
          <span className="sec-no">1.</span>
          <span>{PAGE.sections.discontinued.title}</span>
        </h2>
        <p className="doc-p">{PAGE.sections.discontinued.body}</p>
        <p className="doc-p">
          <Link href="/blog/why-agent-payments-need-a-trust-score" className="doc-link">
            Why agent payments need a trust score
          </Link>
          .
        </p>

        <h2 className="sec-head">
          <span className="sec-no">2.</span>
          <span>{PAGE.sections.delivered.title}</span>
        </h2>
        <p className="doc-p">{PAGE.sections.delivered.body}</p>

        <h2 className="sec-head">
          <span className="sec-no">3.</span>
          <span>{PAGE.sections.counts.title}</span>
        </h2>
        <p className="doc-p">{PAGE.sections.counts.body}</p>
        {live && stats && readAt ? (
          <p className="doc-p">
            This ledger read: {fmt(stats.l1.settled)} settled L1 purchases, {fmt(stats.l1.delivered)} delivered, as of{" "}
            <time dateTime={readAt}>{readAt.slice(0, 10)}</time> (UTC).{" "}
            <Link href="/observatory/state" className="doc-link">
              State of x402
            </Link>
            .
          </p>
        ) : (
          <p className="doc-p">The ledger could not be read for this rendering, so no counts are shown.</p>
        )}

        <h2 className="sec-head">
          <span className="sec-no">4.</span>
          <span>{PAGE.sections.verify.title}</span>
        </h2>
        <p className="doc-p">{PAGE.sections.verify.body}</p>

        <h2 className="sec-head">
          <span className="sec-no">5.</span>
          <span>{PAGE.sections.window.title}</span>
        </h2>
        <p className="doc-p">{PAGE.sections.window.body}</p>

        <p className="doc-p mt-6">
          <Link href="/x402/seller-reputation-api" className="doc-link">
            x402 seller reputation API
          </Link>
          ,{" "}
          <Link href="/x402/check-a-seller" className="doc-link">
            How a seller check works
          </Link>
          ,{" "}
          <Link href="/docs/api" className="doc-link">
            Decision API
          </Link>
          .
        </p>
      </article>
    </main>
  );
}