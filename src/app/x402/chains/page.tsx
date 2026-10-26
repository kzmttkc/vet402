import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { CHAINS_HUB, GUIDE_UPDATED } from "@/components/site/x402-answers";
import { GUIDE_CHAINS } from "@/components/site/x402-guides";
import { articleJsonLd, breadcrumbJsonLd, pageMetadata } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";
import { getObservatoryStatsCached } from "@/lib/observatory/cached-reads";
import type { L1ChainStats } from "@/lib/observatory/reader";
import { publicChainLabel } from "@/lib/observatory/chains";

const PAGE = CHAINS_HUB;

export const metadata: Metadata = pageMetadata({
  title: PAGE.title,
  description: PAGE.description,
  path: PAGE.path,
});

export const revalidate = 300;

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function rowFor(chain: string, rows: L1ChainStats[]): L1ChainStats | undefined {
  return rows.find(
    (r) => r.chain === chain || r.label === chain || publicChainLabel(r.chain) === chain || publicChainLabel(r.chain) === publicChainLabel(chain),
  );
}

export default async function ChainsHubPage() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const stats = await getObservatoryStatsCached().catch(() => null);
  const rows = stats?.l1.byChain ?? [];
  const readable = rows.length > 0;
  const article = articleJsonLd({
    headline: PAGE.h1,
    description: PAGE.description,
    path: PAGE.path,
    datePublished: GUIDE_UPDATED,
    dateModified: stats?.readAt?.slice(0, 10) ?? GUIDE_UPDATED,
  });
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "By chain", path: PAGE.path },
  ]);
  const known = new Set(GUIDE_CHAINS.flatMap((c) => [c.chain, c.publicName]));
  const extra = readable
    ? rows.filter((r) => r.settled > 0 && !known.has(r.chain) && !known.has(r.label) && !known.has(publicChainLabel(r.chain)))
    : [];

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        <script type="application/ld+json" nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: safeJsonLd(article) }} />
        <script type="application/ld+json" nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }} />

        <div className="doc-head doc-head-compact">
          <div className="doc-head-col">
            <span>Independent Measurement</span>
            <span>Purchase lanes</span>
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
              <Link href="/observatory/state" className="underline">
                State of x402
              </Link>
            </span>
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
          <span>Purchase lanes</span>
        </h2>
        {!readable ? (
          <p className="doc-p">The ledger could not be read for this rendering, so no counts are shown.</p>
        ) : null}
        <ul className="mt-4 space-y-4">
          {GUIDE_CHAINS.map((c) => {
            const row = readable ? rowFor(c.chain, rows) : undefined;
            return (
              <li key={c.slug} className="border-t border-hair pt-3">
                <Link href={`/x402/chains/${c.slug}`} className="doc-link text-[1.0625rem]">
                  {c.headline}
                </Link>
                <p className="doc-p mt-1">
                  {c.lead[0]} {c.lead[1]}
                  {row
                    ? ` This read: ${fmt(row.attempts)} paid attempts, ${fmt(row.settled)} settled, ${fmt(row.delivered)} delivered.`
                    : readable
                      ? " This read has no L1 row for this chain."
                      : ""}
                </p>
              </li>
            );
          })}
        </ul>

        {extra.length > 0 ? (
          <>
            <h2 className="sec-head">
              <span className="sec-no">2.</span>
              <span>Other chains in this read</span>
            </h2>
            <p className="doc-p">
              These chains have a settled purchase in this read and no lane page. The count stays on{" "}
              <Link href="/observatory/state" className="doc-link">
                State of x402
              </Link>
              .
            </p>
            <ul className="mt-4 space-y-2">
              {extra.map((r) => (
                <li key={r.chain}>
                  {r.label}: {fmt(r.settled)} settled, {fmt(r.delivered)} delivered, of {fmt(r.attempts)} paid attempts.
                </li>
              ))}
            </ul>
          </>
        ) : null}

        <p className="doc-p mt-8">
          Source:{" "}
          <Link href="/api/v1/observatory/state" className="doc-link">
            /api/v1/observatory/state
          </Link>{" "}
          (CC BY 4.0). How an agent pays with a stablecoin:{" "}
          <Link href="/x402/stablecoin-payments" className="doc-link">
            stablecoin payments
          </Link>
          . How to check a seller first:{" "}
          <Link href="/x402/check-a-seller" className="doc-link">
            check a seller before paying
          </Link>
          .
        </p>
      </article>
    </main>
  );
}
