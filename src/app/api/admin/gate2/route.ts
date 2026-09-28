import { NextRequest, NextResponse } from "next/server";
import { assertProductionConfig } from "@/lib/config/env";
import { secureCompare } from "@/lib/util/secure-compare";
import { consumeIpRateLimit, getClientIp } from "@/lib/api/ip-rate-limit";
import { buildGate2Report, Gate2NotConfiguredError, Gate2SchemaMissingError } from "@/lib/gate2/report";
import { logServerErrorSafe } from "@/lib/util/log-safe";

/**
 * Admin-only Gate2 PMF report, computed inside the running production
 * function where process.env.DATABASE_URL is populated by Vercel at
 * runtime — even though the value is a "Sensitive" env var and therefore
 * unreadable via `vercel env pull` / dashboard / API on this machine.
 * See src/lib/gate2/report.ts for the full rationale.
 *
 * Added 2026-07-26 to unblock weekly Gate2 measurement (state/gate2-ledger.json
 * had been empty since inception because the CLI script requires a local
 * DATABASE_URL that cannot be retrieved).
 */
function authorizeAdmin(request: NextRequest): boolean {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return false;

  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return false;

  const token = auth.slice("Bearer ".length).trim();
  return secureCompare(token, secret);
}

export async function GET(request: NextRequest) {
  // 2026-08-22 audit: the sibling admin route (global-lists) opens its gate
  // with this same production-config trap; this one didn't. It catches a
  // mislabeled deploy (NODE_ENV=production with APP_ENV=development) before
  // an admin report is computed against it.
  assertProductionConfig();

  // 2026-08-15 audit: the sibling admin route (global-lists) rate-limits
  // every verb BEFORE the bearer check; this one didn't. ADMIN_SECRET's
  // length/entropy floor already makes brute force impractical, so this is
  // defense-in-depth parity, not a response to a demonstrated exploit.
  const ip = getClientIp(request);
  const limited = await consumeIpRateLimit(`admin:${ip}`, 30, 60_000);
  if (!limited.allowed) {
    return NextResponse.json(
      { error: "rate_limit_exceeded", retryAfter: limited.retryAfter },
      { status: 429 },
    );
  }

  if (!authorizeAdmin(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const report = await buildGate2Report();
    return NextResponse.json(report);
  } catch (error) {
    if (error instanceof Gate2NotConfiguredError) {
      return NextResponse.json({ error: "database_not_configured" }, { status: 503 });
    }
    if (error instanceof Gate2SchemaMissingError) {
      return NextResponse.json({ error: "schema_not_ready" }, { status: 503 });
    }
    // 2026-08-22 audit: this used to hand console.error the whole error
    // object. A pg error carries the failing query and connection details on
    // its own fields, so a stack-printed object can put fragments of the
    // connection string into logs. logServerError prints the message only —
    // the same discipline every sibling route already follows.
    logServerErrorSafe("gate2_admin", error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
