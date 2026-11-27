import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { breadcrumbJsonLd, pageMetadata, publisherOrg } from "@/lib/seo";
import { SITE_URL } from "@/lib/site-url";
import { safeJsonLd } from "@/lib/util/json-ld";
import { paymentChainLabel } from "@/lib/observatory/chains";
import { formatDaysForText } from "@/lib/decision/reason-explain";
import {
  deliveredListings,
  getReputationHostsCached,
  latestDeliveredRecordId,
  listingPathFromResourceKey,
  newestDeliveredPurchase,
  reputationHeadline,
  reputationHostEvidence,
  reputationListingAges,
  reputationPageEligible,
  reputationSellerPath,
  reputationSummarySentence,
} from "@/lib/sellers/reputation";
import { getSellerDetailCached } from "@/lib/sellers/cached";
import { getIndexableSellerHostsCached } from "@/lib/sellers/seller-index";
import { parseSellerHostParam } from "@/lib/sellers/host";
import type { SellerDetail } from "@/lib/sellers/board";
import { sellerPath } from "@/components/site/sellers/SellersViews";
import { TableScroll } from "@/components/site/TableScroll";
import { WatchSellersInterest } from "@/components/site/sellers/WatchSellersInterest";

type Props = { params: Promise<{ host: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { host: raw } = await params;
  const host = parseSellerHostParam(raw);
  if (!host) notFound();
  const [allowed, indexHosts] = await Promise.all([
    getReputationHostsCached().catch(() => null),
    getIndexableSellerHostsCached().catch(() => [] as string[]),
  ]);
  if (!allowed?.includes(host)) redirect(sellerPath(host));
  const indexable = indexHosts.includes(host);
  const detail = await getSellerDetailCached(host).catch(() => null);
  // 2026-11-24 SEO: the stale headline ("... Latest delivery is older than 30 days") made titles of
  // 90+ characters that search engines cut. The H1 keeps the full sentence. The title keeps the
  // question and only the word "still" for the stale case.
  const stale = detail && reputationPageEligible(detail) ? reputationHostEvidence(detail).allListingsStale : false;
  const title = stale
    ? `Does ${host} still deliver? x402 purchase record | vet402`
    : `Does ${host} deliver? x402 purchase record | vet402`;
  return {
    ...pageMetadata({
      title,
      description: `vet402 purchase records for ${host}: each listing vet402 bought with a real x402 payment where the latest purchase delivered a response, with delivery age on each row.`,
      path: reputationSellerPath(host),
      noindex: !indexable,
    }),
    title: { absolute: title },
  };
}

export function ReputationSellerArticle({
  detail,
  nonce,
  indexable = true,
}: {
  detail: SellerDetail;
  nonce?: string;
  indexable?: boolean;
}) {
  const host = detail.host;
  const listings = deliveredListings(detail);
  const ageByEndpoint = new Map(reputationListingAges(detail).map((a) => [a.endpointId, a]));
  const latestRecordId = latestDeliveredRecordId(detail);
  const asOf = detail.fetchedAt.slice(0, 10);
  const path = reputationSellerPath(host);
  const headline = reputationHeadline(host, detail);
  const evidence = reputationHostEvidence(detail);
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "x402", path: "/x402" },
    { name: host, path },
  ]);
  // 2026-11-27 SEO: the page had only a BreadcrumbList. ItemPage names the seller host the record is
  // about and dates it with the read time, like the ERC-8004 agent pages.
  const itemPage = indexable
    ? {
        "@context": "https://schema.org",
        "@type": "ItemPage",
        name: headline,
        url: `${SITE_URL}${path}`,
        dateModified: detail.fetchedAt,
        isBasedOn: `${SITE_URL}/observatory/methodology`,
        publisher: publisherOrg(),
        about: { "@type": "Thing", name: host, identifier: host },
      }
    : null;

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        {(indexable ? [itemPage, breadcrumb] : [])
          .filter((doc): doc is NonNullable<typeof doc> => doc !== null)
          .map((doc, i) => (
            <script key={i} type="application/ld+json" nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: safeJsonLd(doc) }} />
          ))}

        <h1 className="doc-title mt-8">{headline}</h1>
        <p className="doc-p">
          <Link href={sellerPath(host)} className="underline">
            Full purchase record for {host}
          </Link>{" "}
          (per-listing results on Base).
        </p>
        <p className="doc-p">{reputationSummarySentence(detail)}</p>
        {evidence.tier === "stale" ? (
          <p className="doc-p text-brand-lift">
            vet402&apos;s check answer for this host is {evidence.max_recommendation}; the latest delivery is older than{" "}
            {evidence.stale_after_days} days.
          </p>
        ) : null}
        <p className="doc-p text-brand-lift">as of {asOf}</p>

        {listings.length > 0 ? (
          <TableScroll label={`Latest delivered purchases for ${host}`} className="mt-8">
            <table className="fact-table">
              <caption className="sr-only">Latest delivered purchase per listing</caption>
              <thead>
                <tr>
                  <th scope="col">Path</th>
                  <th scope="col">Date (UTC)</th>
                  <th scope="col">Chain</th>
                  <th scope="col">Delivery age</th>
                </tr>
              </thead>
              <tbody>
                {listings.map((l) => {
                  const row = newestDeliveredPurchase(l);
                  const at = (row?.attemptedAt ?? l.latest!.facts.attemptedAt).slice(0, 16).replace("T", " ");
                  const chain = row?.network ? paymentChainLabel(row.network) : "unknown";
                  const age = ageByEndpoint.get(l.endpointId);
                  const days = age?.daysSince;
                  return (
                    <tr key={l.endpointId}>
                      <td className="font-mono text-sm">{listingPathFromResourceKey(l.resourceKey, host)}</td>
                      <td className="whitespace-nowrap">{at}</td>
                      <td>{chain}</td>
                      <td className="whitespace-nowrap">
                        {days === null || days === undefined ? (
                          "unknown"
                        ) : (
                          <>
                            last delivered {formatDaysForText(days)} days ago
                            {age?.stale ? <span className="text-brand-lift"> (stale)</span> : null}
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroll>
        ) : null}

        {latestRecordId ? (
          <p className="doc-p mt-8">
            Get an email when this record changes:{" "}
            <Link href={`/observatory/e/${latestRecordId}`} className="underline">
              open the latest record and use the alert form
            </Link>
            .
          </p>
        ) : null}

        <WatchSellersInterest recordId={latestRecordId} />

        <p className="doc-p mt-8 text-brand-lift">Records are measurements. They are not a guarantee.</p>
      </article>
    </main>
  );
}

export default async function ReputationSellerPage({ params }: Props) {
  const { host: raw } = await params;
  const host = parseSellerHostParam(raw);
  if (!host) notFound();
  const allowed = await getReputationHostsCached().catch(() => null);
  if (!allowed?.includes(host)) redirect(sellerPath(host));

  const detail = await getSellerDetailCached(host).catch(() => null);
  if (!detail || !reputationPageEligible(detail)) redirect(sellerPath(host));

  const [nonce, indexHosts] = await Promise.all([
    headers().then((h) => h.get("x-nonce") ?? undefined),
    getIndexableSellerHostsCached().catch(() => [] as string[]),
  ]);
  const indexable = indexHosts.includes(host);
  return <ReputationSellerArticle detail={detail} nonce={nonce} indexable={indexable} />;
}