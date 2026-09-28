import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { breadcrumbJsonLd, pageMetadata, publisherOrg } from "@/lib/seo";
import { SITE_URL } from "@/lib/site-url";
import { safeJsonLd } from "@/lib/util/json-ld";
import { PUBLIC_READ_REVALIDATE } from "@/lib/observatory/public-read-revalidate";
import { resolveSellerPage, type SellerPageData } from "@/lib/sellers/board";
import {
  getPurchasedHostsCached,
  getSellerBoardCached,
  getSellerDetailCached,
  getSellerOtherChainsCached,
} from "@/lib/sellers/cached";
import { parseSellerHostParam } from "@/lib/sellers/host";
import {
  SellerDetailView,
  SellerOtherChainsView,
  SellersNotice,
  sellerHeading,
  sellerOtherChainsTitle,
  sellerPageTitle,
  sellerPath,
} from "@/components/site/sellers/SellersViews";
import TrackView from "@/components/site/TrackView";

/**
 * /sellers/[host] — one seller's Base listings, each with its latest purchase, what vet402 saw,
 * what to fix and whose side the failure was on (2026-09-28).
 *
 * A host that is not on the cached board is a 404 before any per-host query runs, so random
 * hosts cost no database read. The per-host read is cached per host (cached.ts).
 *
 * 2026-09-29: a host with no active Base listing but with L1 purchase rows (e.g. bought on Arc)
 * gets a short page linking each listing's record instead of a 404. The gate is the cached set of
 * purchased hosts, so random hosts still cost no per-host read. That page is noindex: it repeats
 * the record pages and is thin on its own.
 */

const LOADERS = {
  board: getSellerBoardCached,
  detail: getSellerDetailCached,
  purchasedHosts: getPurchasedHostsCached,
  otherChains: getSellerOtherChainsCached,
};

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ host: string }>; searchParams: Promise<{ page?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { host: raw } = await params;
  const host = parseSellerHostParam(raw);
  if (!host) notFound();
  // Base の一覧に居ない host は簡易頁（か 404）。一覧はキャッシュ済みなので読み直しは安い。
  // 読めなければ従来の表題に倒す（頁本体が読み取り失敗を出す）。
  const onBoard = await getSellerBoardCached()
    .then((b) => b.sellers.some((x) => x.host === host))
    .catch(() => true);
  if (!onBoard) {
    // Base の一覧と重複し、記録頁へ案内するだけの薄い頁なので noindex（2026-09-29）。
    return pageMetadata({
      title: sellerOtherChainsTitle(host),
      description: `Listings of ${host} that vet402 bought over x402, each linked to its record page.`,
      path: `/sellers/${host}`,
      noindex: true,
    });
  }
  // 2026-09-29 敵対的監査: 売り手側とした失敗の一部が実は vet402 側・判定保留・宣言どおりの無料応答
  // だった。帰属の規則を直して再確認するまで、他社名の頁を検索に出さない（頁は売り手が見られるよう残す）。
  // 2026-09-29: 表題に最新の購入日を入れる（sellerHeading）。一覧（キャッシュ済み）の同じ host の値を使う。
  const lastAttemptAt = await getSellerBoardCached()
    .then((b) => b.sellers.find((x) => x.host === host)?.lastAttemptAt ?? null)
    .catch(() => null);
  const meta = pageMetadata({
    title: sellerHeading(host, lastAttemptAt),
    description: sellerDescription(host),
    path: `/sellers/${host}`,
    noindex: true,
  });
  // 2026-09-28 SEO 監査: layout の template（"%s | vet402"）を通さず、長さを見て接尾辞を
  // 付けるかどうかを sellerPageTitle が決める。OG/Twitter の表題は素のまま（site_name が担う）。
  return { ...meta, title: { absolute: sellerPageTitle(host, lastAttemptAt) } };
}

function sellerDescription(host: string): string {
  return `What happened when vet402 paid ${host} over x402 on Base: each purchase result, what to fix, and whose side a failure was on.`;
}

export default async function SellerPage({ params, searchParams }: Props) {
  const { host: raw } = await params;
  const host = parseSellerHostParam(raw);
  if (!host) notFound();
  let data: SellerPageData;
  try {
    data = await resolveSellerPage(host, LOADERS);
  } catch (error) {
    // notFound() は例外で抜けるので、そのまま投げ直す（読み取りの失敗とだけ区別する）。
    if (error && typeof error === "object" && "digest" in error) throw error;
    return (
      <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
        <SellersNotice title={host}>Reading the ledger failed. Please reload in a minute.</SellersNotice>
      </main>
    );
  }
  if (data.kind === "none") notFound();
  if (data.kind === "other_chains") {
    return (
      <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
        <SellerOtherChainsView other={data.other} revalidateSec={PUBLIC_READ_REVALIDATE} />
        <TrackView event="seller_page_view" props={{ host, kind: "other_chains" }} />
      </main>
    );
  }
  const detail = data.detail;
  const { page: rawPage } = await searchParams;
  const page = Math.max(1, Math.trunc(Number(rawPage ?? "1")) || 1);
  // 構造化データ（2026-09-28 SEO 監査）: WebPage と BreadcrumbList。出し方は他の公開頁と同じ
  // （CSP の nonce 付き・safeJsonLd で "<" を逃がす）。ホスト名は DB 由来なので関門を必ず通す。
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const path = sellerPath(detail.host);
  const webPage = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: sellerHeading(detail.host, detail.summary.lastAttemptAt),
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
      <p className="doc-note mx-auto mb-4 max-w-[70ch]">
        We are re-checking which failures on this page were on our side. Some rows marked
        seller&apos;s side may move to vet402&apos;s side or to not sorted.
      </p>
      <SellerDetailView detail={detail} page={page} now={Date.parse(detail.fetchedAt)} revalidateSec={PUBLIC_READ_REVALIDATE} />
      <TrackView event="seller_page_view" props={{ host }} />
    </main>
  );
}
