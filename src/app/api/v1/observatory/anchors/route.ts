import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import {
  consumeIpRateLimit,
  ipRateLimitHeaders,
  sharedCacheRateLimitHeaders,
} from "@/lib/api/ip-rate-limit";
import { chainContinuity, getAnchors, readDayVerificationInputs } from "@/lib/observatory/anchors";
import { evaluateHeadFreshness, missingHeadDays } from "@/lib/observatory/ledger-head-freshness";
import { verifyPublishedDayTriple, type DayTripleResult } from "@/lib/observatory/ledger-day-verify";
import { utcDayString } from "@/lib/observatory/metrics-rollup";
import { getDb } from "@/lib/db/client";
import { logServerErrorSafe } from "@/lib/util/log-safe";

/**
 * GET /api/v1/observatory/anchors?days=30 — 台帳ハッシュチェーン、データとして。
 *
 * 各 UTC 日の root は「前日root + その日の全L1行の正規化JSON」の sha256。
 * 再計算手順はコード（src/lib/observatory/anchors.ts）が正典で、この
 * リポは公開されている——第三者は export.csv と合わせて末尾から検算できる。
 * anchoredTx が入った root はオンチェーンにも存在する（刻印は段階導入）。
 */

const RL_LIMIT = 30;
const RL_WINDOW_MS = 60_000;

// 2026-09-02 監査: 静的化された route handler が prerender から古い判定を返すのを防ぐ（09c1fa0 と同じ欠陥）。
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`observatory-anchors:${ip}`, RL_LIMIT, RL_WINDOW_MS);
  const perCaller = ipRateLimitHeaders(limited);
  const shared = sharedCacheRateLimitHeaders(limited);
  if (!limited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: perCaller });
  }
  const daysParam = request.nextUrl.searchParams.get("days");
  const days = daysParam === null ? 30 : Number(daysParam);
  if (!Number.isFinite(days)) {
    return NextResponse.json({ error: "invalid_days" }, { status: 400, headers: perCaller });
  }
  try {
    const anchors = await getAnchors(days);
    const continuity = chainContinuity(anchors);
    const headDay = anchors[0]?.day ?? null;
    const publishedUtcDay = utcDayString();
    const headFreshness = evaluateHeadFreshness(publishedUtcDay, headDay);
    // 2026-11-10 公平審査 3.8 の 6c-2: 鎖の途中の穴に加え、ヘッドの翌日から公開日の前日まで。
    const noHeadDays = missingHeadDays(publishedUtcDay, anchors);
    // 3.8 の 6c-1: 鎖が次の日の prevRoot として持っている最新の日を、3 つの値で検算する。
    // 公開ファイル（その日の行から作ったバイト列）、公開ヘッド（この応答の行）、鎖の値を別々に読む。
    let dayVerification: DayTripleResult | null = null;
    const db = getDb();
    const linkedDay = anchors[1]?.day ?? null;
    if (db && linkedDay) {
      const inputs = await readDayVerificationInputs(db, linkedDay);
      const published = anchors.find((a) => a.day === linkedDay) ?? null;
      dayVerification = verifyPublishedDayTriple({
        day: linkedDay,
        payloadBytes: inputs.payload,
        publishedHead: published ? { day: published.day, rootHash: published.rootHash, prevRoot: published.prevRoot } : null,
        chainRoot: inputs.chainRoot,
      });
    }
    const retrievedAt = new Date().toISOString();
    const cite = `KIZUNA Creation. vet402 observatory ledger anchors, retrieved ${retrievedAt}. https://vet402.com/api/v1/observatory/anchors`;
    // 遅れたヘッドを 200 の成功として返さない。本文は同じ形で返し、遅れの理由を headFreshness に書く。
    const ok = headFreshness.ok;
    return NextResponse.json(
      {
        ...(ok ? {} : { error: "anchors_head_stale" }),
        anchors,
        chainContinuity: continuity,
        headFreshness,
        missingHeadDays: noHeadDays,
        dayVerification,
        recompute:
          "root = sha256((prevRoot ?? 'genesis') + '\\n' + canonical day JSON of all L1 rows, pk-ascending). The day JSON is served byte for byte at /api/v1/observatory/anchors/day?day=YYYY-MM-DD. Projection: src/lib/observatory/anchors.ts (open source). A day verifies when the root recomputed from that file equals the published root and equals the prevRoot of the next sealed day. A day with no sealed root is listed in missingHeadDays and is never filled later.",
        humanReadable: "https://vet402.com/observatory/state",
        license: "CC-BY-4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        retrievedAt,
        cite,
      },
      {
        status: ok ? 200 : 503,
        headers: ok
          ? { ...shared, "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=7200" }
          : { ...shared, "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    logServerErrorSafe("observatory_anchors", error);
    return NextResponse.json({ error: "observatory_unavailable" }, { status: 503, headers: perCaller });
  }
}
