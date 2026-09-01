import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit, ipRateLimitHeaders } from "@/lib/api/ip-rate-limit";
import { secureCompare } from "@/lib/util/secure-compare";
import { runDeepHealthChecks } from "@/lib/health/deep-checks";
import { runScoringProbe } from "@/lib/health/scoring-probe";
import { runPayeeProbe, worstStatus } from "@/lib/scoring/payee-probe";
import { evaluateLiveness, HEALTH_RATE_LIMIT, HEALTH_RATE_WINDOW_MS } from "@/lib/health/liveness";
import { recordHealthSnapshotIfDue } from "@/lib/health/snapshot";

function authorizeAdmin(request: NextRequest): boolean {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return false;

  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return false;

  const token = auth.slice("Bearer ".length).trim();
  return secureCompare(token, secret);
}

// 2026-09-02 監査: 静的化された route handler が prerender から古い判定を返すのを防ぐ（09c1fa0 と同じ欠陥）。
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const deep = request.nextUrl.searchParams.get("deep") === "1";

  // 2026-08-15 security audit: key-less path with real upstream cost. Runs
  // FIRST — before the probes and before the admin branch — because the whole
  // point is to refuse spending a Base RPC / Blockscout call on an anonymous
  // flood. See HEALTH_RATE_LIMIT in ./liveness for the ceiling's rationale.
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(
    `health:${ip}`,
    HEALTH_RATE_LIMIT,
    HEALTH_RATE_WINDOW_MS,
  );
  if (!limited.allowed) {
    // Same one-bit-of-information rule as the liveness body below: a throttled
    // caller learns it was throttled, not anything about the service.
    return NextResponse.json(
      { status: "rate_limited" },
      { status: 429, headers: ipRateLimitHeaders(limited) },
    );
  }

  // 2026-08-06 security (self-audit item 4): the unauthenticated liveness
  // probe returns ONLY a status. It previously leaked version (0.1.0), chain,
  // and the erc8004 flag — fingerprinting material, and a "0.1.0" visible to a
  // prospect reads as pre-production. Detailed service metadata stays behind
  // the admin gate below.
  //
  // 2026-08-12: that status used to be the STRING LITERAL "ok" — it could not
  // report anything else, because it checked nothing. It answered 200/ok
  // throughout a total scoring outage, while the docs were telling customers
  // to point their uptime monitor here. A monitor that is green while the
  // product is down is worse than no monitor: it converts an outage into a
  // silent one. The status now comes from an actual probe of the scoring path.
  //
  // Still exactly one bit of information to an anonymous caller — up or not —
  // so nothing new is leaked. Which upstream is unhappy stays admin-only.
  //
  // 2026-08-13: that probe covered the SELLER side only — scoreAgentById, the
  // "should I accept payment from this agent?" engine. Measured the same day,
  // nine seconds apart on the same deploy:
  //
  //   09:50:08Z  GET /api/health         → 200 {"status":"ok"}
  //   09:50:17Z  GET /payee/0xd8dA…6045  → "Not verifiable right now"
  //
  // The buyer-side engine — the one the SDK's SpendGuard consults before
  // releasing funds — was failing, and nothing here looked at it. Same class
  // of mistake as the hard-coded "ok" and as the block-number deep check
  // before it: measuring the thing NEXT TO the thing that broke. Both sides
  // are probed now, concurrently (so the endpoint costs the slower probe, not
  // the sum), and the endpoint reports the worse of the two.
  //
  // 2026-08-13 (later, hackathon persona R2): and one layer under THAT, the
  // same hole again — `degraded` returned HTTP 200 while the docs promised
  // uptime pollers "200/503". A monitor reads the code, not the body, so a
  // half-down product still looked green. The status→code mapping and the
  // two-probe composition now live in ./liveness, pinned by tests.
  if (!deep) {
    const { status, httpStatus } = await evaluateLiveness({
      scoring: runScoringProbe,
      payee: runPayeeProbe,
    });
    void recordHealthSnapshotIfDue(status).catch(() => {});
    return NextResponse.json({ status }, { status: httpStatus });
  }

  // Always require admin for deep health — never gate on APP_ENV alone.
  if (!authorizeAdmin(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Authenticated callers get the full picture, including the service
  // metadata that used to be public.
  const payload: Record<string, unknown> = {
    status: "ok",
    service: "vouch-trust-api",
    version: "0.1.0",
    chain: "base",
    erc8004: true,
  };

  const [deepResult, payee] = await Promise.all([runDeepHealthChecks(), runPayeeProbe()]);
  payload.status = deepResult.status;
  payload.checks = deepResult.checks;
  if (deepResult.env) payload.env = deepResult.env;
  if (deepResult.indexer) payload.indexer = deepResult.indexer;
  // Admin-only, so this is the one place the failing input may be NAMED. The
  // public body above still says only up/degraded/down.
  payload.payee = payee;
  if (payee.status !== "ok") {
    payload.status = worstStatus([deepResult.status, payee.status]);
  }

  const statusCode = deepResult.criticalFailure || payee.status === "error" ? 503 : 200;
  const snapshotStatus =
    payload.status === "ok" || payload.status === "degraded" || payload.status === "error"
      ? payload.status
      : "error";
  void recordHealthSnapshotIfDue(snapshotStatus).catch(() => {});
  return NextResponse.json(payload, { status: statusCode });
}
