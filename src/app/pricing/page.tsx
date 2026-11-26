import type { Metadata } from "next";
import { headers } from "next/headers";
import { PricingSection } from "@/components/site/PricingSection";
import { breadcrumbJsonLd, pageMetadata, webPageJsonLd } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";

const TITLE = "vet402 pricing: free x402 seller checks, paid limits";
const DESCRIPTION =
  "vet402 access tiers: free x402 seller checks without a key, and paid plans with more score lookups per month on the score API.";

export const metadata: Metadata = {
  ...pageMetadata({
    title: TITLE,
    description: DESCRIPTION,
    path: "/pricing",
  }),
  title: { absolute: TITLE },
};

export default async function PricingPage() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "Pricing", path: "/pricing" },
  ]);
  const webPage = webPageJsonLd({ name: "vet402 pricing", description: DESCRIPTION, path: "/pricing" });

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
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
          dangerouslySetInnerHTML={{ __html: safeJsonLd(webPage) }}
        />
        <h1 className="doc-title mt-8">vet402 pricing</h1>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />
        <PricingSection className="mt-8" titleId="pricing-standalone-title" />
      </article>
    </main>
  );
}