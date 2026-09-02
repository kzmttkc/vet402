// Per-page metadata の共通ビルダ（2026-08-14 SEO/AEO/LLMO 是正）。
//
// WHY: ルート layout は openGraph / twitter を1度だけ定義しており、各ページは
// title / description だけを上書きしていた。Next.js は openGraph オブジェクトを
// ページ側で「置換」する（深いマージはしない）ため、ページが openGraph を
// 持たない限り og:title / og:url は layout の既定 —— つまり LP の長い表題と
// トップの URL —— のまま出る。実測（curl https://vet402.com/faq）でも全公開
// ページの og:title が LP のもの・og:url が https://vet402.com になっていた。
// X / Slack / 各回答エンジンが個々のページをすべて「トップページ」として
// 扱ってしまう状態だったので、経路（=このビルダ1本）で個別化する。
//
// og:image は **ここで明示する**（2026-09-02 敵対的監査 P2 で方針転換）。
// 以前は「src/app/opengraph-image.png のファイル規約が全ルートに自動配線するので
// ここで images を書かない」としていたが、本番実測（curl / と /faq と /demo）で
// og:image が付いていたのは openGraph を自分で持たない / と /demo だけだった。
// ページが openGraph を持つとファイル規約の images はページ側の openGraph に
// 置換されて消える——つまり pageMetadata を通る 24 頁すべてで欠けていた。
// 同じ画像を同じ寸法で明示すれば、ファイル規約と同じ URL に解決し重複もしない。
//
// og:title は接尾辞なしの素のページ名にする。ブランドは og:site_name = "vet402"
// が担う。既存の blog/[slug] も同じ流儀（<title> の "%s | vet402" と二重に
// ならないよう素のタイトルを OG に入れている）。
import type { Metadata } from "next";
import { SITE_URL } from "@/lib/site-url";
import { SUPPORT_EMAIL } from "@/lib/support";

export const TWITTER_SITE = "@vet_402";

/** src/app/opengraph-image.png（1200×630）。alt は opengraph-image.alt.txt と同文。 */
export const OG_IMAGE_PATH = "/opengraph-image.png";
export const OG_IMAGE_ALT =
  "vet402 — Independent Verification of the x402 Agent-Payment Economy. We buy. We settle. We publish the measurements.";

export const ORG_SAME_AS = [
  "https://x.com/vet_402",
  "https://github.com/kzmttkc/vet402",
  "https://www.npmjs.com/package/@vet402/sdk",
] as const;

export function publisherOrg() {
  return {
    "@type": "Organization" as const,
    name: "vet402",
    url: SITE_URL,
    logo: { "@type": "ImageObject" as const, url: `${SITE_URL}/brand/icon-512.png` },
  };
}

export function organizationJsonLd(description: string) {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "vet402",
    url: SITE_URL,
    description,
    email: SUPPORT_EMAIL,
    logo: `${SITE_URL}/brand/icon-512.png`,
    sameAs: [...ORG_SAME_AS],
  };
}

type PageMetaInput = {
  /** 接尾辞 " | vet402" を含まない素のページ名。<title> は layout の template が付ける。 */
  title: string;
  description: string;
  /** 先頭スラッシュ付きの絶対パス（例 "/faq"）。ルートは "/"。 */
  path: string;
  /** OpenGraph の type。既定は "website"、記事は "article"。 */
  ogType?: "website" | "article";
  publishedTime?: string;
  modifiedTime?: string;
  /**
   * true でこのページを検索インデックスから外す（robots noindex,follow）。
   * 形式は妥当だが実体が無い動的ページ（未登録エージェント等）に付け、
   * 無限のソフト404がクロールバジェットを食うのを防ぐ。既定 false。
   */
  noindex?: boolean;
};

// BreadcrumbList の JSON-LD を組む（2026-08-14 AEO）。回答エンジン・検索が
// ページの階層を把握しやすくなり、パンくずリッチリザルトの対象にもなる。
// items は Home を含めた順路（末尾が現在ページ）。position は 1 始まり。
export function breadcrumbJsonLd(items: { name: string; path: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: item.path === "/" ? SITE_URL : `${SITE_URL}${item.path}`,
    })),
  };
}

export function pageMetadata({
  title,
  description,
  path,
  ogType = "website",
  publishedTime,
  modifiedTime,
  noindex = false,
}: PageMetaInput): Metadata {
  const url = path === "/" ? SITE_URL : `${SITE_URL}${path}`;
  return {
    title,
    description,
    ...(noindex ? { robots: { index: false, follow: true } } : {}),
    alternates: {
      canonical: url,
      types: {
        "application/rss+xml": `${SITE_URL}/blog/rss.xml`,
      },
    },
    openGraph: {
      title,
      description,
      url,
      type: ogType,
      siteName: "vet402",
      locale: "en_US",
      images: [{ url: `${SITE_URL}${OG_IMAGE_PATH}`, width: 1200, height: 630, alt: OG_IMAGE_ALT }],
      ...(ogType === "article" && publishedTime
        ? { publishedTime, modifiedTime: modifiedTime ?? publishedTime }
        : {}),
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      site: TWITTER_SITE,
      images: [`${SITE_URL}${OG_IMAGE_PATH}`],
    },
  };
}
