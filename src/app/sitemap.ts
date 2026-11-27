import type { MetadataRoute } from "next";
import { getAllPosts } from "@/lib/blog";
import { GUIDE_CHAINS } from "@/components/site/x402-guides";
import { CREDENTIALS } from "@/lib/about/credentials";
import { LEGAL_PRIVACY_LAST_MODIFIED, LEGAL_TERMS_PRIVACY_LAST_MODIFIED } from "@/lib/legal/document-dates";
import { fetchLeaderboard } from "@/lib/db/leaderboard";
import { SITE_URL } from "@/lib/site-url";

// 2026-11-27 I4: without this the sitemap was rendered once at build and kept until the next deploy
// (production showed last-modified = build time). The /sellers/{host} and /x402/sellers/{host} entries
// follow the I4 gate, so a host that stops qualifying must leave sitemap.xml without waiting for a deploy.
// Same hour as /sitemap-sellers.xml (Cache-Control max-age=3600).
export const revalidate = 3600;

function sitemapDay(iso: string | undefined, fallback: string): string {
  if (iso && /^\d{4}-\d{2}-\d{2}/.test(iso)) return iso.slice(0, 10);
  return fallback;
}

/** Pages whose lastmod follows live data (not read time, not deploy date). */
async function dataBackedLastMods(): Promise<Record<string, string>> {
  const mods: Record<string, string> = {};

  // 2026-11-26 点検: reputationSitemapEntries と同じく待ち時間の上限を付ける。取れなければ SITE_REVISION のまま。
  let timer: ReturnType<typeof setTimeout> | undefined;
  const leaderboard = await Promise.race([
    fetchLeaderboard(500),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("leaderboard sitemap read timeout")), REPUTATION_SITEMAP_READ_MS);
    }),
  ])
    .catch(() => [] as Awaited<ReturnType<typeof fetchLeaderboard>>)
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
  if (leaderboard.length > 0) {
    const latest = leaderboard.reduce(
      (max, row) => (row.scoredAt > max ? row.scoredAt : max),
      leaderboard[0]!.scoredAt,
    );
    mods["/leaderboard"] = sitemapDay(latest, SITE_REVISION);
  }

  return mods;
}

// 静的頁の lastmod（2026-08-14）。`new Date()` を使うとデプロイのたびに全頁が
// 「今日更新」に化けて偽の鮮度信号になるので使わない。ここは公開面の最後の
// 実改訂日を手で持つ定数にし、公開面に実質的な変更を入れたときだけ上げる。
// 個々のブログ記事は post.updatedAt という本物の信号を各自持っている。
const SITE_REVISION = "2026-08-15";

// 2026-09-05 SEO/AEO 改修で実際に本文が変わった頁だけ、その日付を持つ。
// SITE_REVISION を丸ごと上げると /legal/* まで「今日更新」に化ける
// （それがまさに `new Date()` を使わない理由なので、同じ嘘を定数でやらない）。
const REV_2026_09_05 = "2026-09-05";

// 2026-10-26 SEO/GEO: 本文・表題・回答頁を足した頁だけ。legal / ethonline / rwa / tokyo は上げない。
const REV_2026_10_26 = "2026-10-26";

// 2026-10-31 SEO/AEO: / (a dated sentence) and /docs/api (the opening answer, the key-prefix sentence).
const REV_2026_10_31 = "2026-10-31";

// 2026-11-08: the front page was rewritten (commit cd478c41).
const REV_2026_11_08 = "2026-11-08";

// 2026-11-10: /x402 pillar page with live observatory numbers.
const REV_2026_11_10 = "2026-11-10";
/** 2026-11-12: /x402/refunds（返金の答えの頁）を足した。 */
const REV_2026_11_12 = "2026-11-12";

/** 2026-11-16: /pricing、/x402/ways-to-check-a-seller、/x402/sellers/* 評判ページ。 */
const REV_2026_11_16 = "2026-11-16";

/** 2026-11-24: /erc-8004 pillar and /x402/glossary (SEO/AEO/LLMO proposal). */
const REV_2026_11_24 = "2026-11-24";

async function coreStaticSitemap(): Promise<MetadataRoute.Sitemap> {
  const dataMods = await dataBackedLastMods();
  const last = (path: string, fallback: string) => dataMods[path] ?? fallback;

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${SITE_URL}/`, lastModified: REV_2026_11_16, changeFrequency: "weekly", priority: 1 },
    // /memo is the long document the front page used to be, linked from /, indexable with a self canonical.
    { url: `${SITE_URL}/memo`, lastModified: REV_2026_11_08, changeFrequency: "monthly", priority: 0.6 },
    { url: `${SITE_URL}/docs/api`, lastModified: REV_2026_10_31, changeFrequency: "monthly", priority: 0.9 },
    { url: `${SITE_URL}/docs/mcp`, lastModified: "2026-10-28", changeFrequency: "monthly", priority: 0.9 },
    { url: `${SITE_URL}/connect`, lastModified: "2026-11-08", changeFrequency: "monthly", priority: 0.9 },
    { url: `${SITE_URL}/accuracy`, lastModified: REV_2026_09_05, changeFrequency: "weekly", priority: 0.8 },
    { url: `${SITE_URL}/leaderboard`, lastModified: last("/leaderboard", SITE_REVISION), changeFrequency: "daily", priority: 0.7 },
    { url: `${SITE_URL}/status`, lastModified: SITE_REVISION, changeFrequency: "daily", priority: 0.6 },
    // 2026-08-15: 観測所（L0/L1/L2）は本番稼働中だが sitemap から漏れていた。
    // 動的な /observatory/e/:id は /payee/:address と同じ理由（無限に生成できる）
    // で列挙しない — 各頁は自己参照 canonical を持ち、robots も許可済み。
    { url: `${SITE_URL}/observatory`, lastModified: REV_2026_10_26, changeFrequency: "daily", priority: 0.8 },
    {
      url: `${SITE_URL}/observatory/state`,
      lastModified: REV_2026_10_26,
      changeFrequency: "daily",
      priority: 0.7,
    },
    {
      url: `${SITE_URL}/observatory/methodology`,
      lastModified: REV_2026_10_26,
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${SITE_URL}/observatory/erc8004`,
      lastModified: REV_2026_10_26,
      changeFrequency: "daily",
      priority: 0.7,
    },
    // 2026-08-13 UX監査R1 [C5]: /payee は LP の主 CTA（"Verify a payee now"）の
    // 行き先で、鍵もアカウントも要らない唯一の公開デモなのに sitemap に
    // 載っていなかった。個々の /payee/:address は無限に生成できるので
    // 列挙しない（robots は許可済み・各頁は自己参照 canonical を持つ）が、
    // 入口だけは必ず載せる。
    { url: `${SITE_URL}/payee`, lastModified: SITE_REVISION, changeFrequency: "monthly", priority: 0.9 },
    // [C8] 訂正ログ。件数が0でも索引に載せる — 「公開している」ことが
    // この頁の内容そのものなので。
    { url: `${SITE_URL}/corrections`, lastModified: SITE_REVISION, changeFrequency: "weekly", priority: 0.5 },
    // 2026-08-14: operator-log は公開頁（200）で robots も許可済みだが sitemap に
    // 抜けていた。corrections と同じ「公開していること自体が内容」の帳簿。
    { url: `${SITE_URL}/operator-log`, lastModified: SITE_REVISION, changeFrequency: "weekly", priority: 0.5 },
    // 2026-09-28: 売り手がドメインで自分の購入結果を探す入口。2026-09-29 敵対的監査で帰属の誤りが見つかり、
    // /sellers と /sellers/fix-first は noindex の入口のまま。index 対象の /sellers/:host は
    // sellerIndexSitemapEntries() が I4 の条件で毎回読み直して足す（2026-11-27）。
    // 2026-09-28: RWA の公開頁。
    { url: `${SITE_URL}/rwa`, lastModified: "2026-09-28", changeFrequency: "weekly", priority: 0.6 },
    { url: `${SITE_URL}/faq`, lastModified: REV_2026_10_26, changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE_URL}/x402`, lastModified: REV_2026_11_10, changeFrequency: "daily", priority: 0.9 },
    {
      url: `${SITE_URL}/x402/report/2026-11`,
      lastModified: REV_2026_11_10,
      changeFrequency: "yearly",
      priority: 0.7,
    },
    { url: `${SITE_URL}/x402/stablecoin-payments`, lastModified: REV_2026_10_26, changeFrequency: "monthly", priority: 0.8 },
    { url: `${SITE_URL}/x402/check-a-seller`, lastModified: REV_2026_10_26, changeFrequency: "monthly", priority: 0.8 },
    { url: `${SITE_URL}/x402/refunds`, lastModified: REV_2026_11_12, changeFrequency: "monthly", priority: 0.8 },
    { url: `${SITE_URL}/x402/glossary`, lastModified: REV_2026_11_24, changeFrequency: "monthly", priority: 0.7 },
    // 2026-11-27 F9: Integrity Terms と失敗の帰属の一覧。
    { url: `${SITE_URL}/integrity`, lastModified: "2026-11-27", changeFrequency: "monthly", priority: 0.6 },
    { url: `${SITE_URL}/erc-8004`, lastModified: REV_2026_11_24, changeFrequency: "daily", priority: 0.9 },
    { url: `${SITE_URL}/x402/ways-to-check-a-seller`, lastModified: REV_2026_11_16, changeFrequency: "monthly", priority: 0.8 },
    { url: `${SITE_URL}/pricing`, lastModified: REV_2026_11_16, changeFrequency: "monthly", priority: 0.8 },
    { url: `${SITE_URL}/x402/chains`, lastModified: REV_2026_10_26, changeFrequency: "weekly", priority: 0.8 },
    { url: `${SITE_URL}/x402/statistics`, lastModified: "2026-11-27", changeFrequency: "daily", priority: 0.85 },
    ...GUIDE_CHAINS.map((chain) => ({
      url: `${SITE_URL}/x402/chains/${chain.slug}`,
      lastModified: REV_2026_10_26,
      changeFrequency: "weekly" as const,
      priority: 0.7,
    })),
    // 2026-09-02 敵対的監査: 公開・robots 許可・内部リンクありの 4 頁が sitemap に無かった。
    // /demo /live /partners は入れない —— 内部リンクが 0 本の孤立頁で、sitemap に載せると
    // 「サイトの一部」だと索引に言うことになる。導線を付けた時点で足す。
    { url: `${SITE_URL}/impact`, lastModified: REV_2026_10_26, changeFrequency: "weekly", priority: 0.6 },
    { url: `${SITE_URL}/decisions`, lastModified: "2026-09-02", changeFrequency: "daily", priority: 0.6 },
    { url: `${SITE_URL}/operations`, lastModified: "2026-09-02", changeFrequency: "weekly", priority: 0.5 },
    { url: `${SITE_URL}/playground`, lastModified: "2026-09-02", changeFrequency: "monthly", priority: 0.6 },
    // 2026-09-09: /ethonline（ETHOnline 2026 の判定者向け頁）。同日朝の公開時は内部リンク 0 で
    // 上の規則どおり載せなかった。/ の doc-head から導線を付けたので、同じ規則で足す。
    { url: `${SITE_URL}/ethonline`, lastModified: "2026-09-09", changeFrequency: "weekly", priority: 0.6 },
    { url: `${SITE_URL}/blog`, lastModified: REV_2026_10_26, changeFrequency: "weekly", priority: 0.8 },
    // 2026-10-31: /blog/rss.xml was listed here. It is a feed, not a page (no description, canonical or OG),
    // so it left the page sitemap. Every page still links it as <link rel="alternate" type="application/rss+xml">
    // (pageMetadata) and the footer links it.
    { url: `${SITE_URL}/signup`, lastModified: SITE_REVISION, changeFrequency: "monthly", priority: 0.7 },
    {
      url: `${SITE_URL}/legal/terms`,
      lastModified: LEGAL_TERMS_PRIVACY_LAST_MODIFIED,
      changeFrequency: "yearly",
      priority: 0.3,
    },
    {
      url: `${SITE_URL}/legal/privacy`,
      lastModified: LEGAL_PRIVACY_LAST_MODIFIED,
      changeFrequency: "yearly",
      priority: 0.3,
    },
    { url: `${SITE_URL}/legal/notice`, lastModified: SITE_REVISION, changeFrequency: "yearly", priority: 0.3 },
    { url: `${SITE_URL}/about`, lastModified: CREDENTIALS.revision, changeFrequency: "monthly", priority: 0.5 },
  ];

  const postRoutes: MetadataRoute.Sitemap = getAllPosts().map((post) => ({
    url: `${SITE_URL}/blog/${post.slug}`,
    lastModified: post.updatedAt,
    changeFrequency: "monthly",
    priority: 0.6,
  }));

  return [...staticRoutes, ...postRoutes];
}

const REPUTATION_SITEMAP_READ_MS = 5000;

async function reputationSitemapEntries(): Promise<MetadataRoute.Sitemap> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { getReputationHostsCached } = await import("@/lib/sellers/reputation");
    const { getIndexableSellerHostsCached } = await import("@/lib/sellers/seller-index");
    // 2026-11-27 I4: /x402/sellers/{host} is noindex unless the host passes the I4 gate, so list only those.
    // If either read fails, list none (a sitemap must not point at noindex pages or name undelivered sellers).
    const [reputationHosts, indexable] = await Promise.race([
      Promise.all([getReputationHostsCached(), getIndexableSellerHostsCached()]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("reputation hosts read timeout")), REPUTATION_SITEMAP_READ_MS);
      }),
    ]);
    const indexableSet = new Set(indexable);
    const hosts = reputationHosts.filter((h) => indexableSet.has(h));
    return hosts.map((host) => ({
      url: `${SITE_URL}/x402/sellers/${encodeURIComponent(host)}`,
      lastModified: REV_2026_11_16,
      changeFrequency: "daily" as const,
      priority: 0.5,
    }));
  } catch {
    return [];
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 2026-11-27 I4: /sellers/{host} for hosts that pass the index gate (re-read every sitemap build). */
async function sellerIndexSitemapEntries(): Promise<MetadataRoute.Sitemap> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { getIndexableSellerHostsCached } = await import("@/lib/sellers/seller-index");
    const { getSellerBoardCached } = await import("@/lib/sellers/cached");
    const hosts = await Promise.race([
      getIndexableSellerHostsCached(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("seller index hosts read timeout")), REPUTATION_SITEMAP_READ_MS);
      }),
    ]);
    const board = await getSellerBoardCached().catch(() => null);
    const lastByHost = new Map(board?.sellers.map((s) => [s.host, s.lastAttemptAt]) ?? []);
    return hosts.map((host) => {
      const lastAttemptAt = lastByHost.get(host);
      const lastModified = lastAttemptAt ? sitemapDay(lastAttemptAt, REV_2026_11_27) : REV_2026_11_27;
      return {
        url: `${SITE_URL}/sellers/${encodeURIComponent(host)}`,
        lastModified,
        changeFrequency: "daily" as const,
        priority: 0.45,
      };
    });
  } catch {
    return [];
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const REV_2026_11_27 = "2026-11-27";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return [...(await coreStaticSitemap()), ...(await reputationSitemapEntries()), ...(await sellerIndexSitemapEntries())];
}
