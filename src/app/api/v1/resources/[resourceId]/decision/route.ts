import { NextRequest, NextResponse } from "next/server";
import { authorizeApiRequest, refundRateLimitUnits, withRateLimitHeaders } from "@/lib/api/guard";
import { lookupManualList } from "@/lib/db/customer-lists";
import { decide } from "@/lib/decision/decide";
import { SHA256_HEX_RE, parsePartyId, payeeId as toPartyId } from "@/lib/ids/canonical";
import { getResource } from "@/lib/resolve/lookup";
import { SOLANA_MAINNET_CAIP2 } from "@/lib/observatory/sol402-payer";
import { logServerError } from "@/lib/util/log";

// §9.1: GET /api/v1/resources/{resource_id}/decision?role=payer|payee&caller_dialect=v1|v2
//   role=payer  「このURLは今、宣言どおり届くか」→ 売り手事実 + 判定
//   role=payee  「この支払元を通してよいか」→ payer 必須。買い手事実 + 判定
// facts と recommendation は同じ応答に同居する。facts を省く経路は無い。
// Idempotency-Key（§9.3）: 同一 (キー, resource, role, payer, key) の再試行は
// 10 分間、レート単位を二重に消費しない。
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type RouteContext = { params: Promise<{ resourceId: string }> };

const IDEMPOTENCY_TTL_MS = 10 * 60_000;
const idempotency = new Map<string, number>();

function normalizePayer(raw: string): string | null {
  const v = raw.trim();
  if (parsePartyId(v)) return v.startsWith("eip155:") ? v.toLowerCase() : v;
  if (/^0x[0-9a-fA-F]{40}$/.test(v)) return toPartyId("eip155:8453", v);
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) return toPartyId(SOLANA_MAINNET_CAIP2, v);
  return null;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await authorizeApiRequest(request, 1);
  if (!auth.ok) return auth.error;

  const { resourceId } = await context.params;
  if (!SHA256_HEX_RE.test(resourceId)) {
    void refundRateLimitUnits(auth.ctx, 1);
    return NextResponse.json({ error: "invalid_resource_id" }, { status: 400 });
  }
  const params = request.nextUrl.searchParams;
  const roleRaw = params.get("role") ?? "payer";
  if (roleRaw !== "payer" && roleRaw !== "payee") {
    void refundRateLimitUnits(auth.ctx, 1);
    return NextResponse.json({ error: "invalid_role" }, { status: 400 });
  }
  const dialectRaw = params.get("caller_dialect");
  if (dialectRaw !== null && dialectRaw !== "v1" && dialectRaw !== "v2") {
    void refundRateLimitUnits(auth.ctx, 1);
    return NextResponse.json({ error: "invalid_caller_dialect" }, { status: 400 });
  }
  let payerId: string | null = null;
  if (roleRaw === "payee") {
    const p = params.get("payer");
    payerId = p ? normalizePayer(p) : null;
    if (!payerId) {
      void refundRateLimitUnits(auth.ctx, 1);
      return NextResponse.json({ error: "payer_required" }, { status: 400 });
    }
  }
  const allowWithoutL1 = params.get("allow_without_l1") === "true";

  const idemKey = request.headers.get("idempotency-key");
  if (idemKey) {
    const k = `${auth.ctx.apiKeyId}|${resourceId}|${roleRaw}|${payerId ?? "-"}|${idemKey.slice(0, 128)}`;
    const seen = idempotency.get(k);
    if (seen && seen > Date.now()) void refundRateLimitUnits(auth.ctx, 1);
    else idempotency.set(k, Date.now() + IDEMPOTENCY_TTL_MS);
    if (idempotency.size > 10_000) {
      const now = Date.now();
      for (const [key, exp] of idempotency) if (exp <= now) idempotency.delete(key);
    }
  }

  try {
    const ref = await getResource(resourceId);
    if (!ref) {
      void refundRateLimitUnits(auth.ctx, 1);
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    // 顧客の WL/BL は私的ポリシー（§13）。判定に効かせるが facts には混ぜない。
    const listSubject = roleRaw === "payer" ? ref.payee_id ? parsePartyId(ref.payee_id)?.address ?? null : null : parsePartyId(payerId!)?.address ?? null;
    const list = await lookupManualList(auth.ctx.apiKeyId, listSubject && listSubject.startsWith("0x") ? listSubject : null);
    const operatorBlacklist = list === "blacklist";

    const result =
      roleRaw === "payer"
        ? await decide({ role: "payer", observatoryId: ref.observatory_id, callerDialect: dialectRaw ?? undefined, allowWithoutL1, operatorBlacklist })
        : await decide({ role: "payee", observatoryId: ref.observatory_id, payerId: payerId!, operatorBlacklist });
    if (!result) {
      void refundRateLimitUnits(auth.ctx, 1);
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return withRateLimitHeaders(NextResponse.json(result), auth.ctx.rateLimit);
  } catch (error) {
    logServerError("decision", error);
    void refundRateLimitUnits(auth.ctx, 1);
    return NextResponse.json({ error: "decision_unavailable" }, { status: 503 });
  }
}
