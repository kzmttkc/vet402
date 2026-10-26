import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { STABLECOIN_PAYMENTS, GUIDE_UPDATED, stablecoinAssetSentence } from "@/components/site/x402-answers";
import { GUIDE_CHAINS } from "@/components/site/x402-guides";
import { articleJsonLd, breadcrumbJsonLd, pageMetadata } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";

const PAGE = STABLECOIN_PAYMENTS;

export const metadata: Metadata = pageMetadata({
  title: PAGE.title,
  description: PAGE.description,
  path: PAGE.path,
});

export default async function StablecoinPaymentsPage() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const article = articleJsonLd({
    headline: PAGE.h1,
    description: PAGE.description,
    path: PAGE.path,
    datePublished: GUIDE_UPDATED,
  });
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "Stablecoin payments", path: PAGE.path },
  ]);

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        <script type="application/ld+json" nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: safeJsonLd(article) }} />
        <script type="application/ld+json" nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }} />

        <div className="doc-head doc-head-compact">
          <div className="doc-head-col">
            <span>Independent Measurement</span>
            <span>x402 and stablecoins</span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>x402 Economy</span>
            <span>{GUIDE_UPDATED}</span>
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
          <span>What the caller signs</span>
        </h2>
        <p className="doc-p">
          The payment terms travel with the 402. For the common scheme the caller signs an authorization, and a
          facilitator submits it on chain. vet402 records the asset it paid on each purchase.
        </p>
        <p className="doc-p">
          {stablecoinAssetSentence()} The same list is in the{" "}
          <Link href="/faq" className="doc-link">
            FAQ
          </Link>{" "}
          and in the{" "}
          <Link href="/observatory/methodology" className="doc-link">
            methodology
          </Link>
          .
        </p>

        <h2 className="sec-head">
          <span className="sec-no">2.</span>
          <span>What vet402 measures</span>
        </h2>
        <p className="doc-p">
          vet402 sends an unpaid request, reads the 402, and buys when the scheme, the network, the asset, and the price
          match the catalog. A longer note on the protocol is{" "}
          <Link href="/blog/what-is-x402" className="doc-link">
            What is x402
          </Link>
          . How to read a seller before paying is{" "}
          <Link href="/x402/check-a-seller" className="doc-link">
            on its own page
          </Link>
          .
        </p>
        <p className="doc-p">
          Live counts are the{" "}
          <Link href="/x402/chains" className="doc-link">
            chain pages
          </Link>{" "}
          and{" "}
          <Link href="/api/v1/observatory/state" className="doc-link">
            /api/v1/observatory/state
          </Link>
          . Purchase lanes with a page:{" "}
          {GUIDE_CHAINS.map((c, i) => (
            <span key={c.slug}>
              {i > 0 ? ", " : ""}
              <Link href={`/x402/chains/${c.slug}`} className="doc-link">
                {c.publicName}
              </Link>
            </span>
          ))}
          .
        </p>
      </article>
    </main>
  );
}
