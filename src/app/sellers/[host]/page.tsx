import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { breadcrumbJsonLd, pageMetadata, publisherOrg } from "@/lib/seo";
import { SITE_URL } from "@/lib/site-url";
import { safeJsonLd } from "@/lib/util/json-ld";
import { PUBLIC_READ_REVALIDATE } from "@/lib/observatory/public-read-revalidate";
import { markRebuyEligible, type SellerDetail } from "@/lib/sellers/board";
import { getSellerBoardCached, getSellerDetailCached } from "@/lib/sellers/cached";
import { parseSellerHostParam } from "@/lib/sellers/host";
import { SellerDetailView, SellersNotice, sellerPageTitle, sellerPath } from "@/components/site/sellers/SellersViews";
import TrackView from "@/components/site/TrackView";

/**
 * /sellers/[host] — one seller's Base listings, each with its latest purchase, what vet402 saw,
 * what to fix and whose side the failure was on (2026-09-28).
 *
 * A host that is not on the cached board is a 404 before any per-host query runs, so random
 * hosts cost no database read. The per-host read is cached per host (cached.ts).
 */

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ host: string }>; searchParams: Promise<{ page?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { host: raw } = await params;
  const host = parseSellerHostParam(raw);
  if (!host) notFound();
  const meta = pageMetadata({
    title: `Is ${host} working? x402 purchase results on Base`,
    description: sellerDescription(host),
    path: `/sellers/${host}`,
  });
  // 2026-09-28 SEO 監査: layout の template（"%s | vet402"）を通さず、長さを見て接尾辞を
  // 付けるかどうかを sellerPageTitle が決める。OG/Twitter の表題は素のまま（site_name が担う）。
  return { ...meta, title: { absolute: sellerPageTitle(host) } };
}

function sellerDescription(host: string): string {
  return `What happened when vet402 paid ${host} over x402 on Base: each purchase result, what to fix, and whose side a failure was on.`;
}

export default async function SellerPage({ params, searchParams }: Props) {
  const { host: raw } = await params;
  const host = parseSellerHostParam(raw);
  if (!host) notFound();
  let detail: SellerDetail | null = null;
  try {
    const board = await getSellerBoardCached();
    if (!board.sellers.some((s) => s.host === host)) notFound();
    const fromBoard = board.sellers.find((s) => s.host === host);
    const read = await getSellerDetailCached(host);
    detail = read ? markRebuyEligible(read, fromBoard) : null;
  } catch (error) {
    // notFound() は例外で抜けるので、そのまま投げ直す（読み取りの失敗とだけ区別する）。
    if (error && typeof error === "object" && "digest" in error) throw error;
    return (
      <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
        <SellersNotice title={host}>Reading the ledger failed. Please reload in a minute.</SellersNotice>
      </main>
    );
  }
  if (!detail) notFound();
  const { page: rawPage } = await searchParams;
  const page = Math.max(1, Math.trunc(Number(rawPage ?? "1")) || 1);
  // 構造化データ（2026-09-28 SEO 監査）: WebPage と BreadcrumbList。出し方は他の公開頁と同じ
  // （CSP の nonce 付き・safeJsonLd で "<" を逃がす）。ホスト名は DB 由来なので関門を必ず通す。
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const path = sellerPath(detail.host);
  const webPage = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: `Is ${detail.host} working? x402 purchase results on Base`,
    description: sellerDescription(detail.host),
    url: `${SITE_URL}${path}`,
    inLanguage: "en",
    isPartOf: { "@type": "WebSite", name: "vet402", url: SITE_URL },
    publisher: publisherOrg(),
    about: { "@type": "Thing", name: detail.host },
    ...(detail.summary.lastAttemptAt ? { dateModified: detail.summary.lastAttemptAt } : {}),
  };
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "Sellers", path: "/sellers" },
    { name: detail.host, path },
  ]);
  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <script
        type="application/ld+json"
        nonce={nonce}
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: safeJsonLd(webPage) }}
      />
      <script
        type="application/ld+json"
        nonce={nonce}
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }}
      />
      <SellerDetailView detail={detail} page={page} now={Date.parse(detail.fetchedAt)} revalidateSec={PUBLIC_READ_REVALIDATE} />
      <TrackView event="seller_page_view" props={{ host }} />
    </main>
  );
}
