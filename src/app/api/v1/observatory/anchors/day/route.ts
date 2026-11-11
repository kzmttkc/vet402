import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit, ipRateLimitHeaders } from "@/lib/api/ip-rate-limit";
import { readDayVerificationInputs } from "@/lib/observatory/anchors";
import { verifyPublishedDayTriple } from "@/lib/observatory/ledger-day-verify";
import { getDb } from "@/lib/db/client";
import { logServerErrorSafe } from "@/lib/util/log-safe";

/**
 * GET /api/v1/observatory/anchors/day?day=YYYY-MM-DD — その日の公開ファイル（2026-11-10 公平審査 3.8 の 6c-1）。
 *
 * 本文は anchorDay が root を計算したのと同じ正規化 JSON（canonicalDayPayload）を、1 バイトも変えずに返す。
 * 鍵なしで検算できる: sha256((prevRoot ?? "genesis") + "\n" + 本文) が、/anchors のその日の rootHash と、
 * 次に封印した日の prevRoot の両方に一致すれば、その日の中身は封印したときのままである。
 * 封印の後に行が変わった日（決済の後追いの確定など）は一致しない。その理由は /observatory/corrections に残る。
 * ヘッドが無い日は 404 no_head_for_day を返し、後から root を作らない。
 */

const RL_LIMIT = 10;
const RL_WINDOW_MS = 60_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`observatory-anchors-day:${ip}`, RL_LIMIT, RL_WINDOW_MS);
  const headers = ipRateLimitHeaders(limited);
  if (!limited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers });
  }
  const day = request.nextUrl.searchParams.get("day") ?? "";
  if (!DAY_RE.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
    return NextResponse.json({ error: "invalid_day", message: "day is required. Use YYYY-MM-DD." }, { status: 400, headers });
  }
  const db = getDb();
  if (!db) return NextResponse.json({ error: "observatory_unavailable" }, { status: 503, headers });
  try {
    const inputs = await readDayVerificationInputs(db, day);
    if (!inputs.head) {
      return NextResponse.json(
        { day, status: "no_head_for_day", error: "no_head_for_day" },
        { status: 404, headers: { ...headers, "Cache-Control": "no-store" } },
      );
    }
    const verification = verifyPublishedDayTriple({
      day,
      payloadBytes: inputs.payload,
      publishedHead: inputs.head,
      chainRoot: inputs.chainRoot,
    });
    const body = Buffer.from(inputs.payload, "utf8");
    return new Response(body, {
      status: 200,
      headers: {
        ...headers,
        "content-type": "application/json; charset=utf-8",
        "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=7200",
        "x-vet402-day": day,
        "x-vet402-prev-root": inputs.head.prevRoot ?? "genesis",
        "x-vet402-day-root": inputs.head.rootHash,
        "x-vet402-chain-root": inputs.chainRoot ?? "",
        "x-vet402-chain-root-day": inputs.chainRootDay ?? "",
        "x-vet402-payload-sha256": createHash("sha256").update(body).digest("hex"),
        "x-vet402-day-verification": verification.ok ? "ok" : (verification.code ?? "failed"),
        "x-vet402-license": "CC-BY-4.0",
      },
    });
  } catch (error) {
    logServerErrorSafe("observatory_anchors_day", error);
    return NextResponse.json({ error: "observatory_unavailable" }, { status: 503, headers });
  }
}
