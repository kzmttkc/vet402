import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit, ipRateLimitHeaders } from "@/lib/api/ip-rate-limit";
import { submitDispute } from "@/lib/observatory/disputes";
import { logServerError } from "@/lib/util/log";

/**
 * POST /api/v1/observatory/disputes — 売り手の署名付き異議（C8）。
 * payTo 保持者の EIP-191 署名を実検証し、受理と同時に本物の L0 を
 * 1回再測定して通常の公開ゲートへ流す。申し立てで記録は消えない——
 * 訂正も、訂正に至らない再測定も、同じ重みで公開される。
 *
 * 2026-08-22（監査残件）: 署名にリプレイ防止が無かったので `issued` を必須に
 * した。呼び手は署名時の `new Date().toISOString()` をそのまま送る。窓外は
 * 400 signature_expired、同一メッセージの再送は 409 replayed。
 */

const RL_LIMIT = 5;
const RL_WINDOW_MS = 60_000;

// 2026-09-02 監査: 静的化された route handler が prerender から古い判定を返すのを防ぐ（09c1fa0 と同じ欠陥）。
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`disputes:${ip}`, RL_LIMIT, RL_WINDOW_MS);
  const perCaller = ipRateLimitHeaders(limited);
  if (!limited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: perCaller });
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: perCaller });
  }
  try {
    const result = await submitDispute({
      endpointId: typeof body.endpointId === "string" ? body.endpointId : "",
      subject: typeof body.subject === "string" ? body.subject : "",
      reason: typeof body.reason === "string" ? body.reason : "",
      issued: typeof body.issued === "string" ? body.issued : "",
      address: typeof body.address === "string" ? body.address : "",
      signature: typeof body.signature === "string" ? body.signature : "",
    });
    if (!result.ok) {
      const status =
        result.reason === "endpoint_not_found"
          ? 404
          : result.reason === "not_payto_signer"
            ? 403
            : result.reason === "db_unavailable"
              ? 503
              : result.reason === "replayed"
                ? 409
                : 400;
      return NextResponse.json({ error: result.reason }, { status, headers: perCaller });
    }
    return NextResponse.json(
      {
        ok: true,
        id: result.id,
        remeasureVerdict: result.remeasureVerdict,
        note: "Re-measured through the normal publication gate. Records are never deleted on dispute — corrections publish with the same weight.",
      },
      { status: 201, headers: perCaller },
    );
  } catch (error) {
    logServerError("disputes", error);
    return NextResponse.json({ error: "disputes_unavailable" }, { status: 503, headers: perCaller });
  }
}
