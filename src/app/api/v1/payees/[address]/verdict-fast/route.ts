import { NextRequest, NextResponse } from "next/server";
import { authorizeApiRequest, withRateLimitHeaders } from "@/lib/api/guard";
import { isValidAddress } from "@/lib/chain/client";
import { peekPayeeScoreCache } from "@/lib/scoring/payee-engine";
import { logServerError } from "@/lib/util/log";

/**
 * GET /api/v1/payees/{address}/verdict-fast — verify-at-settle 高速面（C6）。
 *
 * 契約は1行:「**絶対に計算しない**」。エンジンが自信を持って固定した
 * キャッシュ判定があればそれを、無ければ `cache_cold` を正直に返す。
 * facilitator / 決済ミドルウェアが決済フロー内で呼ぶ想定で、応答時間は
 * ハンドラ内でキャッシュ読み1回＋JSON化のみ（実測はテストが固定）。
 *
 * fail-closed の解釈は呼び手に属する: SpendGuard 系の呼び手は
 * 非 ALLOW（cache_cold 含む）を「支払わない」と読む。ウォームは通常の
 * GET /api/v1/payees/{address}/score を非同期で叩けばよい（同キャッシュ）。
 * degraded / partial な判定はそもそもキャッシュに固定されない
 * （payee-engine の cache.set 条件）ので、この面から出る判定は常に
 * エンジンの確信済みのものだけ——速さのために質を落とさない。
 */
export const maxDuration = 10;

type RouteContext = { params: Promise<{ address: string }> };

// 2026-09-02 監査: 静的化された route handler が prerender から古い判定を返すのを防ぐ（09c1fa0 と同じ欠陥）。
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await authorizeApiRequest(request, 1);
  if (!auth.ok) return auth.error;

  const { address } = await context.params;
  if (!isValidAddress(address)) {
    return NextResponse.json({ error: "invalid_wallet_address" }, { status: 400 });
  }

  try {
    const started = process.hrtime.bigint();
    const cached = peekPayeeScoreCache(address);
    const handlerMicros = Number(process.hrtime.bigint() - started) / 1000;

    if (!cached) {
      return withRateLimitHeaders(
        NextResponse.json(
          {
            status: "cache_cold",
            recommendation: null,
            warmVia: `/api/v1/payees/${address}/score`,
            note: "This surface never computes. Treat cache_cold as not-ALLOW (fail closed) and warm asynchronously.",
            handlerMicros,
          },
          { headers: { "Cache-Control": "no-store" } },
        ),
        auth.ctx.rateLimit,
      );
    }
    return withRateLimitHeaders(
      NextResponse.json(
        {
          status: "hit",
          recommendation: cached.recommendation,
          score: cached.score,
          cacheExpiresAt: cached.cacheExpiresAt,
          handlerMicros,
        },
        { headers: { "Cache-Control": "no-store" } },
      ),
      auth.ctx.rateLimit,
    );
  } catch (error) {
    logServerError("verdict_fast", error);
    return NextResponse.json({ error: "verdict_unavailable" }, { status: 503 });
  }
}
