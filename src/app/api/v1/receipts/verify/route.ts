import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit, ipRateLimitHeaders } from "@/lib/api/ip-rate-limit";
import { verifyVerdictReceipt } from "@/lib/receipts/verdict-receipt";

/**
 * POST /api/v1/receipts/verify
 * 判定レシートの EIP-191 署名を、鍵なしで確かめる。
 * 署名の検査は disputes と同じ verifyMessage（matchSignatureForm）で、
 * 復元に失敗した署名は invalid_signature に倒す。
 */

const RL_LIMIT = 30;
const RL_WINDOW_MS = 60_000;

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`receipts-verify:${ip}`, RL_LIMIT, RL_WINDOW_MS);
  const perCaller = ipRateLimitHeaders(limited);
  if (!limited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: perCaller });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: perCaller });
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400, headers: perCaller });
  }
  const record = body as Record<string, unknown>;
  const result = await verifyVerdictReceipt({
    input_sha256: record.input_sha256,
    verdict: record.verdict,
    as_of: record.as_of,
    signer: record.signer,
    signature: record.signature,
  });
  if (!result.ok && result.error === "invalid_input") {
    return NextResponse.json({ error: "invalid_input" }, { status: 400, headers: perCaller });
  }
  return NextResponse.json(result, { status: 200, headers: perCaller });
}
