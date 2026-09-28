// ============================================================
// 売り手の個別頁 /sellers/{host} の sitemap（2026-09-28 SEO 監査）。
//
// WHY: 売り手が自分のドメインで検索したとき（"is api.example.com working"）に
// 着くべき頁は /sellers/{host} なのに、sitemap.ts は「数が動く」ことを理由に
// 1 件も列挙していなかった。sitemap-observatory.xml と同じ考え方で、URL の数が
// 我々の台帳の数を超えない部分集合だけを出す —— ここでは /sellers の一覧と
// 同じデータ源（getSellerBoardCached）の全ホスト。一覧と同じ 1 つの読みから
// 出すので、件数は /sellers の売り手数と一致する（別の SQL を書くと食い違う）。
//
// lastmod はその売り手の最新の購入時刻（lastAttemptAt）。まだ買っていない
// 売り手は lastmod を書かない —— デプロイ日や「今」で埋めると偽の鮮度信号になる
// （sitemap.ts が new Date() を使わないのと同じ理由）。
//
// URL の [host] として頁が受け付けない形（parseSellerHostParam が落とすもの）は
// 載せない。載せると sitemap が 404 を指す。落とした数は黙らせずヘッダに出す。
// ============================================================
import { getSellerBoardCached } from "@/lib/sellers/cached";
import { parseSellerHostParam } from "@/lib/sellers/host";
import { sellerPath } from "@/components/site/sellers/SellersViews";
import { SITE_URL } from "@/lib/site-url";

export const dynamic = "force-dynamic";

/** sitemap 規格の上限（1 ファイル 50,000 URL）。 */
const SITEMAP_URL_LIMIT = 50_000;

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export async function GET() {
  let sellers;
  try {
    sellers = (await getSellerBoardCached()).sellers;
  } catch {
    // 読めなかったときに空の urlset を 200 で返すと、クローラは「売り手頁は 0 件」と
    // 受け取って索引から落とす。503 で「後で来い」と言う。
    return new Response("sellers board unavailable\n", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "3600" },
    });
  }
  const listable = sellers.filter((s) => parseSellerHostParam(s.host) === s.host);
  const shown = listable.slice(0, SITEMAP_URL_LIMIT);
  const urls = shown
    .map((s) => {
      const lastmod = s.lastAttemptAt ? `\n    <lastmod>${new Date(s.lastAttemptAt).toISOString()}</lastmod>` : "";
      return `  <url>\n    <loc>${xmlEscape(`${SITE_URL}${sellerPath(s.host)}`)}</loc>${lastmod}\n    <changefreq>daily</changefreq>\n    <priority>0.5</priority>\n  </url>`;
    })
    .join("\n");
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;

  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      // 一覧は PUBLIC_READ_REVALIDATE 秒のキャッシュから来る。クローラが何度引いても DB は叩かない。
      "Cache-Control": "public, max-age=3600",
      "x-vet402-rows": String(shown.length),
      // 一覧（/sellers）の売り手数と、頁が受け付けない形で落とした数。突き合わせの手掛かり。
      "x-vet402-sellers": String(sellers.length),
      "x-vet402-skipped": String(sellers.length - listable.length),
      "x-vet402-truncated": String(listable.length > SITEMAP_URL_LIMIT),
    },
  });
}
