import Link from "next/link";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { safeJsonLd } from "@/lib/util/json-ld";
import { pageMetadata, breadcrumbJsonLd } from "@/lib/seo";
import { buildMonth } from "@/lib/build-month";
// 2026-08-13 UX監査R1 [C1]: 設問は src/components/site/faq-data.ts へ移した。
// LP が Q1（x402 の定義）を引用するので、同じ文が2箇所に転記された状態を
// 作らないため。中身は1文字も変えていない。
import { FAQS } from "@/components/site/faq-data";
import TrackView from "@/components/site/TrackView";

export const metadata: Metadata = pageMetadata({
  title: "Frequently asked questions",
  description:
    "Answers on x402 machine payments, ERC-8004 agent identity, and how vet402's verification and scores work on Base.",
  path: "/faq",
});

export default async function FaqPage() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQS.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
    })),
  };
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "FAQ", path: "/faq" },
  ]);

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <TrackView event="faq_view" />
      <article className="sheet">
        <script
          type="application/ld+json"
          nonce={nonce}
          // Browsers blank the reflected `nonce` attribute right after the
          // element is inserted (a CSP anti-exfiltration measure), which
          // otherwise trips a harmless React hydration-mismatch warning here.
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }}
        />
        <script
          type="application/ld+json"
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }}
        />

        <div className="doc-head">
          <div className="doc-head-col">
            <span>Independent Measurement</span>
            <span>Questions and answers</span>
            <span>
              {/* この頁のシアン1点。設問数という事実。 */}
              Entries: <span className="text-signal">{FAQS.length}</span>
            </span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>x402 Economy</span>
            <span>{buildMonth()}</span>
          </div>
        </div>

        <h1 className="doc-title mt-10">Frequently asked questions</h1>
        <p className="mx-auto mt-3 max-w-[56ch] text-center text-brand-lift">
          x402 payments, public measurements, and the score API.
        </p>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />

        {/* 2026-08-13: カードの積み重ねをやめ、番号付きの問答へ。同じ重さの箱を
            10個並べるのはこの分野の既定の型で、読む順序を何も伝えない。番号と
            ヘアラインなら、10件が1つの文書の中の連番として読める。 */}
        <section className="mt-10 border-t border-brand-deep">
          {FAQS.map((item, i) => (
            <div key={item.question} className="border-b border-hair py-6">
              <div className="flex gap-4">
                <span className="w-[4ch] shrink-0 text-brand-lift">Q{i + 1}</span>
                {/* 2026-08-06 a11y (screen-reader persona audit): the questions
                    were <p>, so the FAQ structure existed for search engines (the
                    FAQPage JSON-LD above) but not for humans using a screen
                    reader — the page exposed a single heading. */}
                <h2 className="min-w-0 max-w-[64ch] font-[family-name:var(--font-display)] font-semibold text-brand-deep">
                  {item.question}
                </h2>
              </div>
              <div className="mt-3 flex gap-4">
                <span className="w-[4ch] shrink-0" aria-hidden="true" />
                <p className="min-w-0 max-w-[64ch] text-brand">{item.answer}</p>
              </div>
            </div>
          ))}
        </section>

        {/* 2026-08-13 UX監査R1 [C7]: 異議申立の入口が ToS §8（全文の27%地点）に
            しか無く、UI のどこからも辿れなかった。文言は新しく書かず、ToS §8 の
            見出し（"If you think a score about you is wrong"）をそのまま導線名に
            使う。 */}
        <div className="dashbox mt-10 max-w-[64ch]">
          <p className="doc-caption">If you think a score about you is wrong</p>
          <p className="mt-3 text-brand">
            You do not need an account, an API key, a payment, or a lawyer to challenge a score.{" "}
            <Link href="/legal/terms#corrections" className="doc-link">
              Terms of Service, section 8
            </Link>{" "}
            has both free routes, and issued corrections are listed on the{" "}
            <Link href="/corrections" className="doc-link">
              corrections log
            </Link>
            .
          </p>
        </div>

        <p className="mt-8 text-[0.8125rem]">
          <Link href="/" className="doc-link">
            The memo
          </Link>
          <span aria-hidden="true" className="mx-2 text-brand-lift">·</span>
          <Link href="/docs/api" className="doc-link">
            API reference
          </Link>
          <span aria-hidden="true" className="mx-2 text-brand-lift">·</span>
          <Link href="/signup" className="doc-link">
            Get an API key
          </Link>
        </p>
      </article>
    </main>
  );
}
