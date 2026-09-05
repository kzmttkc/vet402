import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit, ipRateLimitHeaders } from "@/lib/api/ip-rate-limit";
import { endpointReceiptBadge, renderReceiptBadgeSvg } from "@/lib/badge/receipt-badge";
import { getEndpointPurchases } from "@/lib/observatory/reader";
import { logServerError } from "@/lib/util/log";
import { UUID_RE } from "@/lib/validation/uuid";

/**
 * Embeddable SVG receipt badge for one x402 endpoint (seller-outreach hook,
 * 2026-08-18). A seller vet402 has actually paid can paste this on their own
 * site: "vet402: 3/5 settled". Facts only — no trust judgment, no green/red
 * (that is the trust badge's job; this one states a measurement). Key-less,
 * IP-rate-limited, CDN-cached like the other badge routes — the 10-minute CDN
 * window is the hand-written Cache-Control (s-maxage=600) in svgResponse.
 * 2026-09-04 監査 D・P2: force-dynamic の下で効かない `revalidate = 600` を消した。
 */

const BADGE_LIMIT = 60;
const BADGE_WINDOW_MS = 60_000;

/**
 * バッジに焼き込む主体。ホスト名が読めればホスト名、読めなければ endpoint ID の先頭。
 * **空にしない**——第二行が空だと、落とした SVG が誰の数字か名乗らないまま通用する。
 */
function badgeSubject(resourceUrl: string | null, endpointId: string): string {
  if (resourceUrl) {
    try {
      return new URL(resourceUrl).host;
    } catch {
      // 落ちない。ID へ退く。
    }
  }
  return endpointId.slice(0, 8);
}

/** 最後に測った日（UTC の YYYY-MM-DD）。1 件も無ければ null。 */
function lastMeasuredOn(purchases: { attemptedAt: Date | null }[]): string | null {
  for (const p of purchases) {
    if (p.attemptedAt) return p.attemptedAt.toISOString().slice(0, 10);
  }
  return null;
}

function svgResponse(svg: string, cache: string): NextResponse {
  return new NextResponse(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": cache,
    },
  });
}

// 2026-09-02 監査: 静的化された route handler が prerender から古い判定を返すのを防ぐ（09c1fa0 と同じ欠陥）。
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`badge-endpoint:${ip}`, BADGE_LIMIT, BADGE_WINDOW_MS);
  if (!limited.allowed) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: ipRateLimitHeaders(limited) },
    );
  }

  const { id } = await params;
  const clean = id.replace(/\.svg$/, "");
  if (!UUID_RE.test(clean)) {
    return NextResponse.json({ error: "invalid_endpoint_id" }, { status: 400 });
  }

  try {
    const record = await getEndpointPurchases(clean);
    if (!record) {
      // Unknown endpoint: render the honest "not yet measured" badge rather
      // than a 404 image, so a stale embed degrades to a truthful state.
      const badge = endpointReceiptBadge({ attemptCount: 0, settledCount: 0 });
      return svgResponse(renderReceiptBadgeSvg(badge), "public, max-age=60");
    }
    const badge = endpointReceiptBadge({
      attemptCount: record.attemptCount,
      settledCount: record.settledCount,
      // 2026-09-04 監査 E・P0-3: settled だけを描くと「金は動いたが品は来ていない」
      // endpoint が満点のバッジを配れる。
      deliveredCount: record.deliveredCount,
      // 2026-09-05: 支払い後 4xx は判定保留。実名の売り手に対して
      // 「10/10 settled · 0 delivered」を配っていたのを止める。
      inconclusiveCount: record.inconclusiveCount,
      // 2026-09-05: 誰の・いつの数字かをバッジ自身に焼き込む（落として固定できないように）。
      subject: badgeSubject(record.resourceUrl, record.endpointId),
      measuredOn: lastMeasuredOn(record.purchases),
    });
    return svgResponse(
      renderReceiptBadgeSvg(badge),
      "public, s-maxage=600, stale-while-revalidate=1200",
    );
  } catch (error) {
    logServerError("badge_endpoint", error);
    const badge = endpointReceiptBadge({ attemptCount: 0, settledCount: 0 });
    return svgResponse(renderReceiptBadgeSvg(badge), "public, max-age=60");
  }
}
