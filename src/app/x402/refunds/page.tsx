// ============================================================
// /x402/refunds（2026-11-12 SEO）。「x402 refund」の問いに、方式ごとの答えと vet402 の実購買の数で答える。
//
// WHY: 検索の上位は IETF の個人草案と解説記事で、払った後に何が返ってきたかの数は無い。
// 数は 11 月の月報（/x402/report/2026-11、2026-11-09 UTC の固定値）と同じ値だけを使い、
// 日付を添える（読まれる日に古くならないよう、動く値を書かない）。
// 方式の説明は x402 の仕様（specs/schemes/exact と auth-capture）に合わせる。
// 公開文: we/our/us・セミコロン・ダッシュを使わない。vet402 は資金を預からず、返金もしない。
// ============================================================
import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { articleJsonLd, breadcrumbJsonLd, pageMetadata } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";

const REFUNDS_PATH = "/x402/refunds";
const REFUNDS_UPDATED = "2026-11-12";
/** 数の出どころ。11 月の月報と同じ固定値（2026-11-09 UTC）。 */
const REFUNDS_SNAPSHOT = { date: "2026-11-09", settled: 14427, noUsableContent: 504, settled4xx: 746 } as const;

const REFUNDS_TITLE = "x402 refunds: what a buyer can do after paying";
const REFUNDS_DESCRIPTION =
  "Whether an x402 payment can be refunded depends on the scheme and its payment flow. How exact and auth-capture differ, and how to check a seller first.";

const SPEC_EXACT = "https://github.com/x402-foundation/x402/tree/main/specs/schemes/exact";
const SPEC_AUTH_CAPTURE = "https://github.com/x402-foundation/x402/tree/main/specs/schemes/auth-capture";
const IETF_DRAFT = "https://datatracker.ietf.org/doc/draft-hopley-x402-refund-receipt/";

const FAQ = [
  {
    question: "Can an x402 payment be refunded?",
    answer:
      "It depends on the scheme and the payment flow in the 402. By default the exact scheme settles only after the seller's handler succeeds, so a failed call is not charged. Under the exact scheme's upfront flow a settled transfer is final. The auth-capture scheme adds void and refund for the seller, and reclaim for the buyer once the capture deadline passes.",
  },
  {
    question: "Who can issue a refund under auth-capture?",
    answer:
      "The seller side. Capture, void and refund need the resource server's consent, and a refund returns up to the amount captured and not yet refunded. The buyer's own recovery path is reclaim, which opens once the capture deadline passes on a hold that was never captured.",
  },
  {
    question: "How often does a paid x402 call come back with nothing?",
    answer: `As of ${REFUNDS_SNAPSHOT.date} (UTC), vet402 had ${REFUNDS_SNAPSHOT.settled} settled payments. ${REFUNDS_SNAPSHOT.noUsableContent} of them came back with no usable content, and ${REFUNDS_SNAPSHOT.settled4xx} came back with a 4xx. vet402 holds those 4xx calls out of its delivered rates, because its request may differ from what the seller expects. On /sellers, a settled 400 or 422 on Base that returns a structured input validation error for input vet402 sent as declared goes on the seller's side once that listing shows seller-side failures on two different UTC days.`,
  },
  {
    question: "How can a buyer avoid needing a refund?",
    answer:
      "Before paying, read what came back when vet402 last paid that seller. vet402 publishes the purchases it made from each listing it bought from, with the settlement it re-read on chain and whether content came back.",
  },
] as const;

export const metadata: Metadata = pageMetadata({
  title: REFUNDS_TITLE,
  description: REFUNDS_DESCRIPTION,
  path: REFUNDS_PATH,
  ogType: "article",
  publishedTime: REFUNDS_UPDATED,
  modifiedTime: REFUNDS_UPDATED,
});

export default async function RefundsPage() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const article = articleJsonLd({
    headline: REFUNDS_TITLE,
    description: REFUNDS_DESCRIPTION,
    path: REFUNDS_PATH,
    datePublished: REFUNDS_UPDATED,
  });
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "x402", path: "/x402" },
    { name: "Refunds", path: REFUNDS_PATH },
  ]);
  const faq = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQ.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: { "@type": "Answer", text: item.answer },
    })),
  };
  const s = REFUNDS_SNAPSHOT;

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        <script type="application/ld+json" nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: safeJsonLd(article) }} />
        <script type="application/ld+json" nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }} />
        <script type="application/ld+json" nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: safeJsonLd(faq) }} />

        <div className="doc-head doc-head-compact">
          <div className="doc-head-col">
            <span>Independent Measurement</span>
            <span>After an agent pays</span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>x402 Economy</span>
            <span>{REFUNDS_UPDATED}</span>
          </div>
        </div>

        <h1 className="doc-title mt-8">x402 refunds</h1>
        <p className="doc-p">Whether an x402 payment can be refunded depends on the payment scheme the seller offers in its 402.</p>
        <p className="doc-p">
          By default the exact scheme settles only after the seller&apos;s handler succeeds, so a failed call is not
          charged. The auth-capture scheme adds void and refund for the seller, and reclaim for the buyer once the
          capture deadline passes. Before paying, a buyer can read what vet402 recorded when it paid the same seller.
        </p>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />

        <h2 className="sec-head">
          <span className="sec-no">1.</span>
          <span>The exact scheme</span>
        </h2>
        <p className="doc-p">
          The exact scheme moves a fixed amount once. Its default payment flow, <code>authorization</code>, verifies
          the payment before the request runs and settles it afterwards, so a failed handler leaves the buyer
          uncharged. A seller can instead offer the <code>upfront</code> flow, which settles first. There a failed
          handler leaves the buyer charged, the scheme defines no refund, and any remedy is the seller&apos;s own
          arrangement, such as a new transfer back. The scheme is specified in the{" "}
          <a href={SPEC_EXACT} className="doc-link" rel="noopener">
            x402 repository
          </a>
          .
        </p>

        <h2 className="sec-head">
          <span className="sec-no">2.</span>
          <span>The auth-capture scheme</span>
        </h2>
        <p className="doc-p">
          The buyer authorizes a maximum amount. In the escrow flow the seller places a hold before serving the request,
          then captures what is owed or voids the hold afterwards. In the authorization flow the seller charges after
          serving the request, with no hold. In both flows a refund returns captured funds later, up to the amount
          captured and not yet refunded.
        </p>
        <p className="doc-p">
          Two timestamps in the payment set the limits. <code>captureDeadline</code> is the last moment held funds can
          be captured, and from then the buyer can <code>reclaim</code> a hold that was never captured.{" "}
          <code>refundDeadline</code> is the last moment a refund can be issued. Capture, void and refund need the
          seller side to consent. The full rules are in the{" "}
          <a href={SPEC_AUTH_CAPTURE} className="doc-link" rel="noopener">
            auth-capture specification
          </a>
          .
        </p>

        <h2 className="sec-head">
          <span className="sec-no">3.</span>
          <span>How often a paid call comes back with nothing</span>
        </h2>
        <p className="doc-p">
          vet402 buys from x402 sellers with its own wallets and records what came back. As of {s.date} (UTC), it had{" "}
          {s.settled} settled payments. {s.noUsableContent} of them came back with no usable content: a 5xx, a 202
          Accepted, an empty 2xx body, or no status on record. {s.settled4xx} came back with a 4xx answer. vet402 holds
          those 4xx calls out of its delivered rates, because the request it sent may differ from what the seller
          expects. On{" "}
          <Link href="/sellers" className="doc-link">
            /sellers
          </Link>
          , a settled 400 or 422 on Base that returns a structured input validation error for input vet402 sent as
          declared goes on the seller&apos;s side once that listing shows seller-side failures on two different UTC
          days. The breakdown by chain is in{" "}
          <Link href="/x402/report/2026-11" className="doc-link">
            State of x402: November 2026
          </Link>
          .
        </p>

        <h2 className="sec-head">
          <span className="sec-no">4.</span>
          <span>Refund receipts</span>
        </h2>
        <p className="doc-p">
          An individual Internet-Draft,{" "}
          <a href={IETF_DRAFT} className="doc-link" rel="noopener">
            draft-hopley-x402-refund-receipt
          </a>
          , proposes a receipt format that records a refund as full, partial or rejected and links it to the original
          payment. It is an individual draft with intended status Informational, open for comment, as of{" "}
          {REFUNDS_UPDATED}.
        </p>

        <h2 className="sec-head">
          <span className="sec-no">5.</span>
          <span>Check before paying</span>
        </h2>
        <p className="doc-p">
          Read the <code>scheme</code> and <code>extra.paymentFlow</code> of each entry in <code>accepts</code> to see
          which rules apply. Then read the purchases
          vet402 made from that seller: <code>GET /api/v1/check?url=</code> answers with no key, and the hosted MCP
          server answers the same question for an agent. The steps are in{" "}
          <Link href="/x402/check-a-seller" className="doc-link">
            How to check an x402 seller before paying
          </Link>
          , and the protocol is explained in{" "}
          <Link href="/x402" className="doc-link">
            What is x402
          </Link>
          .
        </p>
        <p className="doc-p">vet402 does not hold customer funds or refund payments. It records purchases and publishes them.</p>

        <h2 className="sec-head">
          <span className="sec-no">6.</span>
          <span>Questions</span>
        </h2>
        {FAQ.map((f) => (
          <div key={f.question}>
            <h3 className="doc-p font-semibold">{f.question}</h3>
            <p className="doc-p">{f.answer}</p>
          </div>
        ))}
      </article>
    </main>
  );
}
