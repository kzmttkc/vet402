import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { KEYLESS_READ_STOP, keylessDecisionPerMinute } from "@/lib/api/keyless-limits";
import { CHECK_SELLER, GUIDE_UPDATED } from "@/components/site/x402-answers";
import { CHECK_SELLER_SECTIONS } from "@/lib/x402/check-a-seller-sections";
import { PasteCheckEmbed } from "@/components/site/home/PasteCheckEmbed";
import { articleJsonLd, breadcrumbJsonLd, pageMetadata } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";

const PAGE = CHECK_SELLER;

export const metadata: Metadata = pageMetadata({
  title: PAGE.title,
  description: PAGE.description,
  path: PAGE.path,
  markdown: true,
});

export default async function CheckSellerPage() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const article = articleJsonLd({
    headline: PAGE.h1,
    description: PAGE.description,
    path: PAGE.path,
    datePublished: GUIDE_UPDATED,
  });
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "Check a seller", path: PAGE.path },
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

        <p className="doc-p text-brand">
          The URL check below uses the same monochrome paste form as the home page, not the navy RFC
          paper chrome on this page header.
        </p>

        <PasteCheckEmbed />

        <h2 className="sec-head">
          <span className="sec-no">1.</span>
          <span>{CHECK_SELLER_SECTIONS.checkByUrl.title}</span>
        </h2>
        <p className="doc-p">
          <code>GET /api/v1/check?url=</code> returns what vet402 recorded when it paid that x402 URL, including{" "}
          <code>recommendation</code>, <code>delivery</code>, <code>verified_terms</code>, and recent purchases. It
          needs no API key and shares the per-IP limit with <code>/api/v1/resolve</code>. {KEYLESS_READ_STOP} Shapes are
          in the{" "}
          <Link href="/docs/api" className="doc-link">
            API reference
          </Link>
          .
        </p>

        <h2 className="sec-head">
          <span className="sec-no">2.</span>
          <span>{CHECK_SELLER_SECTIONS.readDecision.title}</span>
        </h2>
        <p className="doc-p">
          When you already hold a <code>resource_id</code>,{" "}
          <code>GET /api/v1/resources/{"{resourceId}"}/decision</code> returns the L0, L1, and L2 facts for that
          resource, with an ALLOW, WARN, or BLOCK recommendation. While keyless reads are on, the route answers with no
          API key, at {keylessDecisionPerMinute()} requests a minute per IP. Reason codes and <code>verified_terms</code>{" "}
          travel in the same document.
        </p>

        <h2 className="sec-head">
          <span className="sec-no">3.</span>
          <span>{CHECK_SELLER_SECTIONS.purchaseRecord.title}</span>
        </h2>
        <p className="doc-p">
          An observatory endpoint page lists the purchases vet402 made, with the chain, the HTTP status, and the
          settlement vet402 re-read. Start from the{" "}
          <Link href="/observatory" className="doc-link">
            observatory
          </Link>{" "}
          or from{" "}
          <Link href="/observatory/state" className="doc-link">
            State of x402
          </Link>
          . Sellers on Base can open their own results at{" "}
          <Link href="/sellers" className="doc-link">
            /sellers
          </Link>
          .
        </p>

        <h2 className="sec-head">
          <span className="sec-no">4.</span>
          <span>{CHECK_SELLER_SECTIONS.compareTerms.title}</span>
        </h2>
        <p className="doc-p">
          <code>verified_terms</code> carries <code>pay_to</code>, <code>asset</code>, <code>amount</code>,{" "}
          <code>network</code>, and <code>scheme</code> from the last purchase whose delivery vet402 confirmed. Compare
          those fields with the 402 in hand. A higher amount, or a different recipient, asset, network, or scheme, is a
          different offer from the one that was delivered. On XRPL, verified_terms is null.
        </p>
        <p className="doc-p">
          The recommendation records past purchases. vet402 does not insure a payment, hold customer funds, or refund
          one. The 0 to 100 score is an older API. A score is a separate signal from an L0 to L2 result, as the{" "}
          <Link href="/faq" className="doc-link">
            FAQ
          </Link>{" "}
          states. How the payment itself moves, including USDC, is{" "}
          <Link href="/x402/stablecoin-payments" className="doc-link">
            How AI agents pay with stablecoins
          </Link>
          .
        </p>
      </article>
    </main>
  );
}
