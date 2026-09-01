import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit, ipRateLimitHeaders } from "@/lib/api/ip-rate-limit";
import { getDb } from "@/lib/db/client";
import { waitlistEntries } from "@/lib/db/schema";
import { logServerError } from "@/lib/util/log";

/**
 * POST /api/v1/waitlist — 有償面の意思表明の受け皿（C11）。
 * 保存するだけ。確認メールも営業メールも送らない（外部送信は承認事項で、
 * 課金の開始は docs/economic-capture-design.md §5 の関門を通ってから）。
 * ここにあるのは「需要が実在するか」を数える器で、それ以上ではない。
 */

const RL_LIMIT = 5;
const RL_WINDOW_MS = 60_000;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const INTERESTS = new Set(["premium_data", "design_partner", "other"]);

// 2026-09-02 監査: 静的化された route handler が prerender から古い判定を返すのを防ぐ（09c1fa0 と同じ欠陥）。
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`waitlist:${ip}`, RL_LIMIT, RL_WINDOW_MS);
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
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const interest = typeof body.interest === "string" ? body.interest : "";
  const note = typeof body.note === "string" ? body.note.slice(0, 500) : null;
  if (!EMAIL_RE.test(email) || !INTERESTS.has(interest)) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400, headers: perCaller });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "waitlist_unavailable" }, { status: 503, headers: perCaller });
  }
  try {
    await db
      .insert(waitlistEntries)
      .values({ email, interest, note })
      .onConflictDoNothing();
    return NextResponse.json(
      { ok: true, note: "Recorded. No emails are sent from this list until you hear from a human." },
      { status: 201, headers: perCaller },
    );
  } catch (error) {
    logServerError("waitlist", error);
    return NextResponse.json({ error: "waitlist_unavailable" }, { status: 503, headers: perCaller });
  }
}
