import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit, ipRateLimitHeaders } from "@/lib/api/ip-rate-limit";
import { getEndpointPurchases } from "@/lib/observatory/reader";
import { SITE_URL } from "@/lib/site-url";
import { logServerErrorSafe } from "@/lib/util/log-safe";

/**
 * GET /api/frame/endpoint/{id} — Farcaster Frame（vNext）で1エンドポイントの
 * レシート実績を配る（Phase 2.4）。キャスト内でカードとして展開され、
 * ボタンはこのエンドポイントの観測所ページ（全レシート）へのリンク。
 * 表示は fc:frame meta + PNG（隣の /image ルート）。事実のみ・評価語なし。
 */

const RL_LIMIT = 60;
const RL_WINDOW_MS = 60_000;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`frame-endpoint:${ip}`, RL_LIMIT, RL_WINDOW_MS);
  if (!limited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: ipRateLimitHeaders(limited) });
  }

  const { id } = await ctx.params;
  try {
    const data = await getEndpointPurchases(id);
    if (!data) {
      return NextResponse.json({ error: "endpoint_not_found" }, { status: 404 });
    }
    const imageUrl = `${SITE_URL}/api/frame/endpoint/${data.endpointId}/image`;
    const targetUrl = `${SITE_URL}/observatory/e/${data.endpointId}`;
    const title = escapeHtml(`${data.resourceKey} — vet402 receipts`);
    const html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <meta property="og:title" content="${title}" />
    <meta property="og:image" content="${imageUrl}" />
    <meta name="fc:frame" content="vNext" />
    <meta name="fc:frame:image" content="${imageUrl}" />
    <meta name="fc:frame:image:aspect_ratio" content="1.91:1" />
    <meta name="fc:frame:button:1" content="Every receipt (tx hashes)" />
    <meta name="fc:frame:button:1:action" content="link" />
    <meta name="fc:frame:button:1:target" content="${targetUrl}" />
  </head>
  <body>
    <p>${title}. Real purchases: ${data.attemptCount}, settled: ${data.settledCount}.
    Full receipt series: <a href="${targetUrl}">${targetUrl}</a></p>
  </body>
</html>`;
    return new NextResponse(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "Cache-Control": "public, s-maxage=900, stale-while-revalidate=1800",
      },
    });
  } catch (error) {
    logServerErrorSafe("frame_endpoint", error);
    return NextResponse.json({ error: "frame_unavailable" }, { status: 503 });
  }
}
