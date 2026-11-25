// ============================================================
// /sitemap-erc8004.xml (2026-11-24 SEO proposal): the indexable ERC-8004 agent pages.
// Same rule as the page: at least one settled purchase. lastmod is the read time of the
// match, the only time this data carries. 503 on an unreadable index, never an empty 200.
// ============================================================
import { getErc8004MatchCached } from "@/lib/observatory/erc8004-match";
import { agentPagePath } from "@/lib/erc8004-pages/agents";
import { SITE_URL } from "@/lib/site-url";

export const dynamic = "force-dynamic";

export async function GET() {
  const data = await getErc8004MatchCached();
  if (data.status !== "ok") {
    return new Response("erc8004 index unavailable\n", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "3600" },
    });
  }
  const settledBy = new Map<string, number>();
  for (const m of data.matches) {
    const p = agentPagePath(m);
    if (p) settledBy.set(p, (settledBy.get(p) ?? 0) + m.settled);
  }
  const paths = [...settledBy.entries()].filter(([, s]) => s > 0).map(([p]) => p).sort();
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    paths
      .map((p) => `  <url>\n    <loc>${SITE_URL}${p}</loc>\n    <lastmod>${data.readAt}</lastmod>\n  </url>`)
      .join("\n") +
    `\n</urlset>\n`;
  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "x-vet402-rows": String(paths.length),
    },
  });
}
