import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { GUIDE_UPDATED } from "@/components/site/x402-answers";
import { GUIDE_CHAINS, guideChainBySlug } from "@/components/site/x402-guides";
import { articleJsonLd, breadcrumbJsonLd, pageMetadata } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";
import { getObservatoryStatsCached } from "@/lib/observatory/cached-reads";
import { publicChainLabel } from "@/lib/observatory/chains";

export function generateStaticParams() {
  return GUIDE_CHAINS.map((c) => ({ slug: c.slug }));
}

export const dynamicParams = false;
export const revalidate = 300;

type Params = { slug: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const chain = guideChainBySlug((await params).slug);
  if (!chain) return {};
  return pageMetadata({
    title: chain.title,
    description: chain.description,
    path: `/x402/chains/${chain.slug}`,
  });
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

export default async function ChainGuidePage({ params }: { params: Promise<Params> }) {
  const chain = guideChainBySlug((await params).slug);
  if (!chain) notFound();
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const stats = await getObservatoryStatsCached().catch(() => null);
  const rows = stats?.l1.byChain ?? [];
  const readable = rows.length > 0;
  const row = readable
    ? rows.find(
        (r) =>
          r.chain === chain.chain ||
          r.label === chain.chain ||
          r.label === chain.publicName ||
          publicChainLabel(r.chain) === chain.publicName,
      )
    : undefined;
  const path = `/x402/chains/${chain.slug}`;
  const article = articleJsonLd({
    headline: chain.headline,
    description: chain.description,
    path,
    datePublished: GUIDE_UPDATED,
    dateModified: stats?.readAt?.slice(0, 10) ?? GUIDE_UPDATED,
  });
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "By chain", path: "/x402/chains" },
    { name: chain.publicName, path },
  ]);

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        <script type="application/ld+json" nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: safeJsonLd(article) }} />
        <script type="application/ld+json" nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }} />

        <div className="doc-head doc-head-compact">
          <div className="doc-head-col">
            <span>Independent Measurement</span>
            <span>{chain.asset}</span>
            {readable && stats ? (
              <span>
                Ledger read <time dateTime={stats.readAt}>{stats.readAt.slice(0, 16).replace("T", " ")} UTC</time>
              </span>
            ) : (
              <span>Ledger unread</span>
            )}
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>
              <Link href="/x402/chains" className="underline">
                Measured chains
              </Link>
            </span>
            <span>{GUIDE_UPDATED}</span>
          </div>
        </div>

        <h1 className="doc-title mt-8">{chain.headline}</h1>
        <p className="doc-p">{chain.lead[0]}</p>
        <p className="doc-p">{chain.lead[1]}</p>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />

        <h2 className="sec-head">
          <span className="sec-no">1.</span>
          <span>This read</span>
        </h2>
        {!readable ? (
          <p className="doc-p">The ledger could not be read for this rendering, so no counts are shown.</p>
        ) : !row ? (
          <p className="doc-p">This read has no L1 row for {chain.publicName}.</p>
        ) : (
          <>
            <p className="doc-p">
              Delivered counts settled purchases whose paid request answered HTTP 2xx other than 202 Accepted with a
              non-empty body. The row is <code>l1.byChain</code> for{" "}
              {chain.publicName}. CAIP-2 {chain.caip2}.
            </p>
            <dl className="mt-4 grid gap-4 sm:grid-cols-3">
              <div className="border-t border-brand-deep pt-3">
                <dt className="doc-caption">Paid attempts</dt>
                <dd className="mt-1 text-[1.75rem] tabular-nums text-brand-deep">{fmt(row.attempts)}</dd>
              </div>
              <div className="border-t border-brand-deep pt-3">
                <dt className="doc-caption">Settled</dt>
                <dd className="mt-1 text-[1.75rem] tabular-nums text-brand-deep">{fmt(row.settled)}</dd>
              </div>
              <div className="border-t border-brand-deep pt-3">
                <dt className="doc-caption">Delivered</dt>
                <dd className="mt-1 text-[1.75rem] tabular-nums text-brand-deep">{fmt(row.delivered)}</dd>
              </div>
            </dl>
            {row.inconclusiveSettled > 0 ? (
              <p className="doc-note mt-4">
                {fmt(row.inconclusiveSettled)} settled purchases on this chain are held as inconclusive. The methodology
                says why a 4xx is held.
              </p>
            ) : null}
          </>
        )}

        <h2 className="sec-head">
          <span className="sec-no">2.</span>
          <span>How a purchase is tied to its settlement</span>
        </h2>
        <p className="doc-p">
          CAIP-2 <code>{chain.caip2}</code>. {chain.tie} {chain.reread}
        </p>

        <h2 className="sec-head">
          <span className="sec-no">3.</span>
          <span>Where to read on</span>
        </h2>
        <p className="doc-p">
          <Link href="/api/v1/observatory/state" className="doc-link">
            /api/v1/observatory/state
          </Link>{" "}
          (CC BY 4.0) is the source. Definitions are in the{" "}
          <Link href="/observatory/methodology" className="doc-link">
            methodology
          </Link>
          . How an agent pays, including {chain.asset}, is{" "}
          <Link href="/x402/stablecoin-payments" className="doc-link">
            How AI agents pay with stablecoins
          </Link>
          . How to check a seller before paying is{" "}
          <Link href="/x402/check-a-seller" className="doc-link">
            on its own page
          </Link>
          . A longer note on the protocol is{" "}
          <Link href="/blog/what-is-x402" className="doc-link">
            What is x402
          </Link>
          .
        </p>
      </article>
    </main>
  );
}
