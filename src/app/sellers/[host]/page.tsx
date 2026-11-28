import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { breadcrumbJsonLd, pageMetadata } from "@/lib/seo";
import { sellerItemPageJsonLd, sellerPurchaseRecordDatasetJsonLd } from "@/lib/sellers/seller-json-ld";
import { safeJsonLd } from "@/lib/util/json-ld";
import { PUBLIC_READ_REVALIDATE } from "@/lib/observatory/public-read-revalidate";
import { resolveSellerPage, sellerHeadline, type SellerPageData } from "@/lib/sellers/board";
import {
  getPurchasedHostsCached,
  getSellerBoardCached,
  getSellerDetailCached,
  getSellerOtherChainsCached,
} from "@/lib/sellers/cached";
import { parseSellerHostParam } from "@/lib/sellers/host";
import {
  getReputationHostsCached,
  reputationPageEligible,
  reputationSellerPath,
} from "@/lib/sellers/reputation";
import { getIndexableSellerHostsCached } from "@/lib/sellers/seller-index";
import {
  SellerDetailView,
  SellerOtherChainsView,
  SellersNotice,
  sellerHeading,
  sellerOtherChainsTitle,
  sellerDescription,
  sellerPageTitle,
  sellerPath,
  UNDER_RECHECK,
} from "@/components/site/sellers/SellersViews";
import TrackView from "@/components/site/TrackView";
import SellerCalledVsDeliveredSection from "@/components/site/sellers/SellerCalledVsDeliveredSection";
import SellerDeliveryCalendar from "@/components/site/sellers/SellerDeliveryCalendar";
import SellerHostBadgeSection from "@/components/site/sellers/SellerHostBadgeSection";
import SellerRefundSection from "@/components/site/sellers/SellerRefundSection";
import SellerErc8004Section from "@/components/site/sellers/SellerErc8004Section";

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

async function sellerIndexGateForHost(host: string): Promise<boolean> {
  const allowed = await getIndexableSellerHostsCached().catch(() => [] as string[]);
  return allowed.includes(host);
}

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
  // 2026-11-27 I4: index only when delivered in the last 30 days or the payee wallet claimed.
  const indexable = await sellerIndexGateForHost(host);
  // 表題の日付は Base 行と otherChain の新しい方（sellerHeadline）。詳細の読み取りに失敗したときは一覧の lastAttemptAt に戻す。
  const detailForTitle = await getSellerDetailCached(host).catch(() => null);
  const head = detailForTitle
    ? sellerHeadline(detailForTitle)
    : {
        at: await getSellerBoardCached()
          .then((b) => b.sellers.find((x) => x.host === host)?.lastAttemptAt ?? null)
          .catch(() => null),
        chain: null,
      };
  const meta = pageMetadata({
    title: sellerHeading(host, head.at, head.chain),
    description: sellerDescription(host, head.chain),
    path: `/sellers/${host}`,
    noindex: !indexable,
  });
  // 2026-09-28 SEO 監査: layout の template（"%s | vet402"）を通さず、長さを見て接尾辞を
  // 付けるかどうかを sellerPageTitle が決める。OG/Twitter の表題は素のまま（site_name が担う）。
  return { ...meta, title: { absolute: sellerPageTitle(host, head.at, head.chain) } };
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
        <SellerOtherChainsView other={data.other} />
        <TrackView event="seller_page_view" props={{ host, kind: "other_chains" }} />
      </main>
    );
  }
  const detail = data.detail;
  const indexable = await sellerIndexGateForHost(detail.host);
  const reputationSummaryHref = await getReputationHostsCached()
    .then((allowed) =>
      allowed?.includes(detail.host) && reputationPageEligible(detail)
        ? reputationSellerPath(detail.host)
        : null,
    )
    .catch(() => null);
  const { page: rawPage } = await searchParams;
  const page = Math.max(1, Math.trunc(Number(rawPage ?? "1")) || 1);
  // 構造化データ: I4 で索引対象のときだけ ItemPage + Dataset + BreadcrumbList（2026-11-28）。
  // （CSP の nonce 付き・safeJsonLd で "<" を逃がす）。ホスト名は DB 由来なので関門を必ず通す。
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const path = sellerPath(detail.host);
  const head = sellerHeadline(detail);
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "Sellers", path: "/sellers" },
    { name: detail.host, path },
  ]);
  const pageName = sellerHeading(detail.host, head.at, head.chain);
  const pageDescription = sellerDescription(detail.host, head.chain);
  const structuredData = indexable
    ? [
        sellerItemPageJsonLd(detail, path, pageName, pageDescription),
        sellerPurchaseRecordDatasetJsonLd(detail),
        breadcrumb,
      ]
    : [];
  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      {structuredData.map((doc, i) => (
        <script
          key={i}
          type="application/ld+json"
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: safeJsonLd(doc) }}
        />
      ))}
      {/* 2026-09-29 第4巡: 帯は seller の側（確定）の行がある頁だけ。該当の行には同じ語（UNDER_RECHECK）の印が付く。
          2026-10-21 A-16: 見直しに期限は無い（コードに日付が無い）。期限を作らず、無いと書く。時期はカードごとの次の購入の目安だけ。 */}
      {detail.hasConfirmedSeller && (
        <p className="doc-note mx-auto mb-4 max-w-[70ch]">
          Which side a failure is on is still under review, and the review has no set date. Rows on the seller&apos;s
          side are marked &ldquo;{UNDER_RECHECK}&rdquo; below. A card with a computed time gives the earliest time
          vet402 can buy that listing again. If an attribution turns out wrong, the correction is published on{" "}
          <a className="underline" href="/corrections">
            /corrections
          </a>
          .
        </p>
      )}
      <SellerDetailView
        detail={detail}
        page={page}
        now={Date.parse(detail.fetchedAt)}
        revalidateSec={PUBLIC_READ_REVALIDATE}
        afterSummary={
          <>
            {reputationSummaryHref ? (
              <p className="doc-p">
                A shorter delivery summary for this host is on the{" "}
                <Link href={reputationSummaryHref} className="underline">
                  indexed reputation page
                </Link>
                .
              </p>
            ) : null}
            <SellerCalledVsDeliveredSection host={detail.host} />
            <SellerRefundSection host={detail.host} />
            <SellerErc8004Section host={detail.host} />
            <SellerHostBadgeSection host={detail.host} />
            <SellerDeliveryCalendar detail={detail} />
          </>
        }
      />
      <TrackView event="seller_page_view" props={{ host }} />
    </main>
  );
}
