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
import { chainHeldLines } from "@/lib/observatory/chain-page-words";
import { getIndexableHostsOnChainCached, SELLER_INDEX_DELIVERY_WINDOW_DAYS } from "@/lib/sellers/seller-index";

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
  const indexableHosts = await getIndexableHostsOnChainCached(chain.caip2).catch(() => [] as string[]);
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
              Delivered counts settled purchases whose paid request answered HTTP 2xx other than 202 Accepted, with a
              non-empty body. Each count is vet402&apos;s own L1 purchase on {chain.publicName}, not ecosystem-wide
              settlement volume. The row is <code>l1.byChain</code> for {chain.publicName}. CAIP-2 {chain.caip2}.
            </p>
            <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="border-t border-brand-deep pt-3">
                <dt className="doc-caption">Paid attempts (vet402)</dt>
                <dd className="mt-1 text-[1.75rem] tabular-nums text-brand-deep">{fmt(row.attempts)}</dd>
              </div>
              <div className="border-t border-brand-deep pt-3">
                <dt className="doc-caption">Settled (vet402)</dt>
                <dd className="mt-1 text-[1.75rem] tabular-nums text-brand-deep">{fmt(row.settled)}</dd>
              </div>
              <div className="border-t border-brand-deep pt-3">
                <dt className="doc-caption">Delivered (vet402)</dt>
                <dd className="mt-1 text-[1.75rem] tabular-nums text-brand-deep">{fmt(row.delivered)}</dd>
              </div>
              <div className="border-t border-brand-deep pt-3">
                <dt className="doc-caption">Held, settled then 4xx (vet402)</dt>
                <dd className="mt-1 text-[1.75rem] tabular-nums text-brand-deep">{fmt(row.inconclusiveSettled)}</dd>
              </div>
            </dl>
            {chainHeldLines({
              settled: row.settled,
              delivered: row.delivered,
              inconclusiveSettled: row.inconclusiveSettled,
            }).map((line) => (
              <p key={line} className="doc-note mt-4">
                {line}
              </p>
            ))}
          </>
        )}

        <h2 className="sec-head">
          <span className="sec-no">2.</span>
          <span>Sellers with a delivered vet402 purchase on {chain.publicName}</span>
        </h2>
        {indexableHosts.length > 0 ? (
          <>
            <p className="doc-p">
              Hosts below delivered at least once on {chain.publicName} and pass the same index gate as{" "}
              <Link href="/sellers" className="doc-link">
                /sellers
              </Link>{" "}
              (delivery in the last {SELLER_INDEX_DELIVERY_WINDOW_DAYS} days or a signed payee claim). vet402 does not list hosts that failed to
              deliver or that do not pass that gate.
            </p>
            <ul className="mt-4 columns-1 gap-x-8 sm:columns-2 lg:columns-3">
              {indexableHosts.map((host) => (
                <li key={host} className="break-inside-avoid pb-2">
                  <Link href={`/x402/sellers/${encodeURIComponent(host)}`} className="doc-link font-mono text-sm">
                    {host}
                  </Link>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="doc-p">
            This read lists no sellers on {chain.publicName} that both delivered to vet402 and pass the index gate.
          </p>
        )}

        <h2 className="sec-head">
          <span className="sec-no">3.</span>
          <span>How a purchase is tied to its settlement</span>
        </h2>
        <p className="doc-p">
          CAIP-2 <code>{chain.caip2}</code>. {chain.tie} {chain.reread}
        </p>

        <h2 className="sec-head">
          <span className="sec-no">4.</span>
          <span>Where to read on</span>
        </h2>
        <p className="doc-p">
          {/* API route, not a page: a plain anchor avoids an RSC prefetch that answers 400. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/api/v1/observatory/state" className="doc-link">
            /api/v1/observatory/state
          </a>{" "}
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