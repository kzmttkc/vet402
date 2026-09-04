// ============================================================
// 測定済み endpoint 頁の sitemap（2026-09-05 SEO）。
//
// WHY: 出典として引かれることが配布 KPI（外部からの引用・現在 0 件）で、
// 引かれる対象は集計頁だけでなく 1 件ごとの証拠頁 /observatory/e/{id} でもある。
// その頁は robots で許可され、自己参照 canonical を持ち、存在しない id には
// 本物の 404 を返すのに、sitemap に 1 件も載っていなかった（本番実測
// 2026-09-05: /sitemap.xml は 24 URL、endpoint 頁は 0 件）。
//
// src/app/sitemap.ts がこれを列挙しない判断は「無限に生成できるから」だった。
// ここはその懸念が当たらない部分集合だけを出す —— カタログに現在も掲載され、
// 公開判定が pass で、直近 7 日に実測がある endpoint（getSitemapEndpoints）。
// 3 条件とも我々の測定結果で決まるので、URL 数は測定した数を超えない。
//
// /sitemap.xml と 2 本立てにして、robots.txt が両方を指す（sitemap index を
// 名乗るより、robots に 2 行書く方が実装も検証も単純で、対応も広い）。
// lastmod は最後に測った時刻そのもの —— デプロイ日ではない。
// ============================================================
import { getSitemapEndpoints, SITEMAP_ENDPOINT_LIMIT } from "@/lib/observatory/reader";
import { SITE_URL } from "@/lib/site-url";

export const dynamic = "force-dynamic";

export async function GET() {
  const endpoints = await getSitemapEndpoints();
  const urls = endpoints
    .map(
      (e) =>
        `  <url>\n    <loc>${SITE_URL}/observatory/e/${e.id}</loc>\n    <lastmod>${e.lastMeasuredAt.toISOString()}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.4</priority>\n  </url>`,
    )
    .join("\n");
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;

  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      // 一覧の中身は日次 cron でしか動かない。クローラが1日に何度も引いても
      // DB を何度も叩かせない。
      "Cache-Control": "public, max-age=3600",
      // 上限で切れたかどうかを黙らせない（規格上限は 50,000）。
      "x-vet402-rows": String(endpoints.length),
      "x-vet402-truncated": String(endpoints.length >= SITEMAP_ENDPOINT_LIMIT),
    },
  });
}
