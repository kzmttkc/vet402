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

export const TWITTER_SITE = "@vet402_com";

/**
 * src/app/opengraph-image.png（1200×630）。
 * ファイル規約の opengraph-image.alt.txt は、openGraph を自分で持たない
 * /rwa と /tokyo が受け継ぐ。そのファイルは変えない。
 * /ethonline は pageMetadata を通る凍結面なので、alt は origin/main の文のまま。
 */
export const OG_IMAGE_PATH = "/opengraph-image.png";

/** /ethonline の og:image:alt。origin/main と同じ文。 */
export const ETHONLINE_OG_IMAGE_ALT =
  "vet402 — Independent Verification of the x402 Agent-Payment Economy. We buy. We settle. We publish the measurements.";

/** 凍結面以外の pageMetadata の og:image:alt。we・ダッシュを使わない。 */
export const OG_IMAGE_ALT =
  "vet402. Independent verification of x402 agent payments. Paid is on chain. Delivered is not.";

export const ORG_SAME_AS = [
  "https://x.com/vet402_com",
  "https://github.com/kzmttkc/vet402",
  "https://www.npmjs.com/package/@vet402/sdk",
  "https://www.npmjs.com/package/@vet402/middleware",
  "https://www.npmjs.com/package/@vet402/mcp-server",
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
  /**
   * 接尾辞 " | vet402" を含まない素のページ名。<title> は layout の template が付ける。
   * path が "/" のときは absolute にし、template で二重にしない。
   */
  title: string;
  description: string;
  /** 先頭スラッシュ付きの絶対パス（例 "/faq"）。ルートは "/"。 */
  path: string;
  /** この頁の og:image:alt。省くと、/ethonline は凍結の文、それ以外は OG_IMAGE_ALT。 */
  imageAlt?: string;
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
  imageAlt,
}: PageMetaInput): Metadata {
  const url = path === "/" ? SITE_URL : `${SITE_URL}${path}`;
  const alt = imageAlt ?? (path === "/ethonline" ? ETHONLINE_OG_IMAGE_ALT : OG_IMAGE_ALT);
  return {
    title: path === "/" ? { absolute: title } : title,
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
      images: [{ url: `${SITE_URL}${OG_IMAGE_PATH}`, width: 1200, height: 630, alt }],
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

// ============================================================
// Dataset JSON-LD（2026-09-05 AEO/LLMO）。
//
// WHY: 配布 KPI は訪問者数ではなく「外部からの引用 — このデータを出典として
// 挙げた文書・記事・ダッシュボード」で、現在 0 件。回答エンジンと Google
// Dataset Search が「引用できるデータセット」として拾うために要る情報は、
// 頁の散文には全部あるのに構造化データには無かった（本番実測 2026-09-05:
// /observatory/state の Dataset は distribution も license も持たず、
// /accuracy は distribution 1本のみで license 無し）。
//
// distribution（実際に落とせる URL）と license が無い Dataset は、
// Dataset Search では「データがどこにあるか分からない項目」として扱われ、
// LLM から見ても「引用先の実体が無い記述」になる。散文と同じ源泉から
// 機械可読側にも出す。
//
// 値は捏造しない: ここに書く URL は 2026-09-05 に本番で 200 を確認した
// 4 本だけで、license は LICENSE-DATA と方法論 §9 が既に宣言している
// CC BY 4.0。
// ============================================================

/** データの利用条件。LICENSE-DATA / 方法論 §9 / llms.txt と同じ。 */
export const DATA_LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/";

/**
 * 推奨引用文。第3引数を省いた形が public/llms.txt の "Cite as:" の型
 * （取得日の位置は YYYY-MM-DD）。頁が読んだ時刻を持つときはその時刻を渡して埋める。
 * 型と埋めた文を同一とは扱わない（tests/dataset-json-ld.test.ts）。
 */
export function citeAs(datasetName: string, contentUrl: string, retrievedAt = "YYYY-MM-DD"): string {
  return `KIZUNA Creation. vet402 ${datasetName}. Dataset, retrieved ${retrievedAt}. ${contentUrl}`;
}

export type DatasetDistribution = {
  /** "application/json" | "text/csv" など。 */
  encodingFormat: string;
  /** 鍵無しで実際に落とせる絶対 URL。 */
  contentUrl: string;
  /** 何が入っているかの 1 行。 */
  name: string;
};

type DatasetInput = {
  name: string;
  description: string;
  /** 頁の絶対パス（"/observatory/state"）。 */
  path: string;
  /** 引用文に使うデータ本体の URL（頁ではなく機械可読側）。 */
  citeUrl: string;
  /**
   * 引用文の中で名乗る名前。頁の表題（name）と違ってよい —— 観測所の正典の
   * 引用文は public/llms.txt と方法論 §9 が既に "vet402 observatory" で
   * 配っており、頁の表題 "State of x402" に差し替えると、同じデータに
   * 2 通りの引用文が出回る。既に配った方を勝たせる。
   */
  citeName?: string;
  distribution: DatasetDistribution[];
  /** どう測ったか。散文の方法論と矛盾しない 1〜2 文。 */
  measurementTechnique: string;
  variableMeasured: string[];
  keywords: string[];
  /** ISO 8601 の期間または日付。不明なら渡さない（推測で埋めない）。 */
  temporalCoverage?: string;
  dateModified?: string;
  /**
   * creditText の取得時刻。渡した値をそのまま埋める。
   * 省くと llms.txt の型（YYYY-MM-DD）のまま。
   */
  retrievedAt?: string;
};

export function webPageJsonLd(input: { name: string; description: string; path: string; isBasedOn?: string }) {
  const url = input.path === "/" ? SITE_URL : `${SITE_URL}${input.path}`;
  return {
    "@context": "https://schema.org",
    "@type": "WebPage" as const,
    name: input.name,
    description: input.description,
    url,
    isPartOf: { "@type": "WebSite" as const, name: "vet402", url: SITE_URL },
    inLanguage: "en",
    publisher: publisherOrg(),
    ...(input.isBasedOn ? { isBasedOn: input.isBasedOn } : {}),
  };
}

/**
 * 機械可読な API 記述。url は人間の参照頁、documentation は仕様。
 * 既定は docs/api と OpenAPI。2026-10-31: /docs/mcp も同じ型で path と documentation を渡す。
 */
export function webApiJsonLd(input: { name: string; description: string; path?: string; documentation?: string }) {
  return {
    "@context": "https://schema.org",
    "@type": "WebAPI" as const,
    name: input.name,
    description: input.description,
    url: `${SITE_URL}${input.path ?? "/docs/api"}`,
    documentation: `${SITE_URL}${input.documentation ?? "/openapi.yaml"}`,
    provider: publisherOrg(),
    termsOfService: `${SITE_URL}/legal/terms`,
    inLanguage: "en",
  };
}

export function articleJsonLd(input: {
  headline: string;
  description: string;
  path: string;
  datePublished: string;
  dateModified?: string;
}) {
  const url = `${SITE_URL}${input.path}`;
  return {
    "@context": "https://schema.org",
    "@type": "Article" as const,
    headline: input.headline,
    description: input.description,
    datePublished: input.datePublished,
    dateModified: input.dateModified ?? input.datePublished,
    author: publisherOrg(),
    publisher: publisherOrg(),
    image: `${SITE_URL}${OG_IMAGE_PATH}`,
    mainEntityOfPage: { "@type": "WebPage" as const, "@id": url },
    url,
    inLanguage: "en",
  };
}

export function datasetJsonLd(input: DatasetInput) {
  const url = `${SITE_URL}${input.path}`;
  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: input.name,
    description: input.description,
    url,
    identifier: url,
    creator: publisherOrg(),
    publisher: publisherOrg(),
    license: DATA_LICENSE_URL,
    isAccessibleForFree: true,
    creditText: citeAs(input.citeName ?? input.name, input.citeUrl, input.retrievedAt),
    measurementTechnique: input.measurementTechnique,
    variableMeasured: input.variableMeasured,
    keywords: input.keywords,
    ...(input.temporalCoverage ? { temporalCoverage: input.temporalCoverage } : {}),
    ...(input.dateModified ? { dateModified: input.dateModified } : {}),
    includedInDataCatalog: {
      "@type": "DataCatalog",
      name: "vet402 x402 Observatory",
      url: `${SITE_URL}/observatory`,
    },
    isBasedOn: `${SITE_URL}/observatory/methodology`,
    distribution: input.distribution.map((d) => ({
      "@type": "DataDownload",
      name: d.name,
      encodingFormat: d.encodingFormat,
      contentUrl: d.contentUrl,
    })),
  };
}
