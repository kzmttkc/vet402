// Legal Notice — vet402's operator-disclosure page (2026-07-20; the product
// was renamed from Vouch in August 2026).
// vet402 is a pseudonymous, individually-operated Web3 product (mode B
// minimal disclosure, see legal_requirements.md). It is offered as a B2B
// API product (agent/service operators integrating trust scores), which is
// the primary reason full communication-sales disclosure (e.g. Japan's
// Act on Specified Commercial Transactions) does not currently apply — that
// statute governs consumer mail-order sales, not B2B API subscriptions.
// No live consumer billing exists yet either way. B2B API subscriptions, when
// enabled, are billed from the dashboard after a key exists. If/when consumer
// billing starts, a full disclosure block (entity name, address, phone) will be
// added here first, mirroring KoeWall's billing-flag-linked tokushoho pattern.
import type { Metadata } from "next";
import { headers } from "next/headers";
import { SUPPORT_EMAIL, SUPPORT_MAILTO } from "@/lib/support";
import { pageMetadata, breadcrumbJsonLd } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";

export const metadata: Metadata = pageMetadata({
  // 2026-08-13 [m2]: 二重サフィックス解消（template が " | vet402" を付ける）。
  title: "Legal Notice",
  description: "Operator disclosure and contact information for vet402.",
  path: "/legal/notice",
});

export default async function LegalNoticePage() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "Legal Notice", path: "/legal/notice" },
  ]);

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet space-y-8 text-sm text-brand">
        <script
          type="application/ld+json"
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }}
        />
        <div className="doc-head">
          <div className="doc-head-col">
            <span>Independent Measurement</span>
            <span>Instrument: legal notice</span>
            <span>
              {/* この頁のシアン1点。改訂日という事実。 */}
              Revision: <span className="text-signal">August 2026</span>
            </span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>x402 Economy</span>
            <span>August 2026</span>
          </div>
        </div>
        <div>
          <h1 className="doc-title mt-10">Legal Notice</h1>
          <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />
          <p className="doc-note mt-3 text-center">Last updated: August 2026</p>
        </div>

        <section className="space-y-2">
          <h2 className="sec-head">How vet402 is operated</h2>
          <p>
            vet402 (formerly known as Vouch) is developed and operated by Takeshi Kazumoto, an
            individual proprietor trading as KIZUNA Creation. The product was renamed in August 2026; the
            operator, the service, and these pages are otherwise unchanged. It is offered as a business-to-business (B2B) API product for agent
            developers who need to verify an x402 endpoint before paying it, and for the service
            operators who accept those payments — it is not marketed or sold as a consumer
            product.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="sec-head">Why disclosure is minimal today</h2>
          <p>
            The operator&apos;s name is disclosed above. Because vet402 is a B2B API — not consumer
            mail-order — statutes that require full public disclosure of the operator&apos;s home
            address and phone number (such as Japan&apos;s Act on Specified Commercial Transactions)
            do not currently apply. Paid API subscriptions, when enabled, are billed from the
            dashboard after a key exists; that is not consumer-facing billing. We keep the home
            address and phone number off this public page for the same reason many independent
            developers do — but we will disclose them without delay to anyone who requests it in
            good faith, and we will add a full disclosure block here before any consumer-facing
            billing goes live.
          </p>
        </section>

        <section id="contact" className="space-y-2">
          <h2 className="sec-head">Contact / disclosure requests</h2>
          <p>
            For support, billing questions, or to request operator disclosure details, email{" "}
            <a className="doc-link" href={SUPPORT_MAILTO}>
              {SUPPORT_EMAIL}
            </a>
            . We aim to respond within a few business days.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="sec-head">Data handling</h2>
          <p>
            See the{" "}
            <a className="doc-link" href="/legal/privacy">
              Privacy Policy
            </a>{" "}
            for what we collect and how it is used, and the{" "}
            <a className="doc-link" href="/legal/terms">
              Terms of Service
            </a>{" "}
            for the terms of use.
          </p>
        </section>
      </article>
    </main>
  );
}
