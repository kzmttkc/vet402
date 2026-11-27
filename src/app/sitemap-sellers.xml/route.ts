// ============================================================
// Seller index sitemap (2026-11-27 I4).
// Lists /sellers/{host} for hosts that pass sellerPageIndexable (same data as sitemap.ts).
// /x402/sellers/{host} reputation pages stay on the main sitemap only.
// ============================================================
import { getSellerBoardCached } from "@/lib/sellers/cached";
import { parseSellerHostParam } from "@/lib/sellers/host";
import { getIndexableSellerHostsCached, sellerIndexCounts } from "@/lib/sellers/seller-index";
import { SITE_URL } from "@/lib/site-url";

export const dynamic = "force-dynamic";

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function sellerLoc(host: string): string {
  return `${SITE_URL}/sellers/${encodeURIComponent(host)}`;
}

export async function GET() {
  let hosts: string[];
  const sellersByHost = new Map<string, { lastAttemptAt: string | null }>();
  try {
    const [indexHosts, board] = await Promise.all([getIndexableSellerHostsCached(), getSellerBoardCached()]);
    hosts = indexHosts.filter((h) => parseSellerHostParam(h) === h);
    for (const s of board.sellers) sellersByHost.set(s.host, { lastAttemptAt: s.lastAttemptAt });
  } catch {
    return new Response("sellers board unavailable\n", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "3600" },
    });
  }
  // Counted from the same list written below, so the headers always match the body (no second read).
  const counts = sellerIndexCounts(hosts);
  const urls = hosts
    .map((host) => {
      const lastAttemptAt = sellersByHost.get(host)?.lastAttemptAt;
      const lastmod = lastAttemptAt ? `\n    <lastmod>${new Date(lastAttemptAt).toISOString()}</lastmod>` : "";
      return `  <url>\n    <loc>${xmlEscape(sellerLoc(host))}</loc>${lastmod}\n    <changefreq>daily</changefreq>\n    <priority>0.45</priority>\n  </url>`;
    })
    .join("\n");
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;

  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "x-vet402-rows": String(hosts.length),
      "x-vet402-indexable-pages": String(counts.indexablePages),
      "x-vet402-sitemap-urls": String(counts.sitemapUrls),
      "x-vet402-truncated": String(false),
    },
  });
}