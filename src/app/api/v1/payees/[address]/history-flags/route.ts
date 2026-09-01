import { NextRequest, NextResponse } from "next/server";
import { authorizeApiRequest, withRateLimitHeaders } from "@/lib/api/guard";
import { computeHistoryFlags } from "@/lib/scoring/history-flags";
import { logServerError } from "@/lib/util/log";

/**
 * GET /api/v1/payees/{address}/history-flags — 履歴フラグ v0（キー付き）。
 * 台帳からの決定的述語の要約。観測所の公開面には出さない
 * （src/lib/scoring/history-flags.ts 冒頭の分離方針）。
 * address は 0x（EVM）と base58（Solana payTo）どちらも受ける——
 * このテーブルの主キーはカタログの payTo 文字列。
 */
export const maxDuration = 15;

type RouteContext = { params: Promise<{ address: string }> };

const ADDR_RE = /^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;

// 2026-09-02 監査: 静的化された route handler が prerender から古い判定を返すのを防ぐ（09c1fa0 と同じ欠陥）。
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await authorizeApiRequest(request, 1);
  if (!auth.ok) return auth.error;
  const { address } = await context.params;
  if (!ADDR_RE.test(address)) {
    return NextResponse.json({ error: "invalid_wallet_address" }, { status: 400 });
  }
  try {
    const flags = await computeHistoryFlags(address);
    if (!flags) return NextResponse.json({ error: "flags_unavailable" }, { status: 503 });
    return withRateLimitHeaders(NextResponse.json(flags), auth.ctx.rateLimit);
  } catch (error) {
    logServerError("history_flags", error);
    return NextResponse.json({ error: "flags_unavailable" }, { status: 503 });
  }
}
