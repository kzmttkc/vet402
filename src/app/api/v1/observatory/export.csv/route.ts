import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit, ipRateLimitHeaders } from "@/lib/api/ip-rate-limit";
import { getDb } from "@/lib/db/client";
import { logServerError } from "@/lib/util/log";

/**
 * GET /api/v1/observatory/export.csv?days=90 — 購入台帳のCSVエクスポート
 * （Phase 4.2 の v0: 監査証跡の持ち出し可能な形）。
 *
 * 中身は各エンドポイントページ・purchases API と同じ事実の別シリアライズ
 * ——新しい主張はこのルートからは生まれない。行は attempted_at 昇順の
 * 全paid-attempt系列（budget_denied / request_error は我々側の都合なので
 * 含めない: 台帳の対外的な意味は「売り手に何が起きたか」）。
 * days は 1..366 に飽和・行数は 50,000 で打ち切り（打ち切り時はヘッダで明示）。
 */

const RL_LIMIT = 6;
const RL_WINDOW_MS = 60_000;
const MAX_ROWS = 50_000;

const CSV_COLUMNS = [
  "attempted_at",
  "resource_key",
  "network",
  "status",
  "amount_units",
  "spent_units",
  "tx_hash",
  "http_status_paid",
  "latency_ms",
  "l2_schema",
] as const;

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// 2026-09-02 監査: 静的化された route handler が prerender から古い判定を返すのを防ぐ（09c1fa0 と同じ欠陥）。
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`observatory-export:${ip}`, RL_LIMIT, RL_WINDOW_MS);
  const perCaller = ipRateLimitHeaders(limited);
  if (!limited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: perCaller });
  }

  const daysParam = request.nextUrl.searchParams.get("days");
  const daysRaw = daysParam === null ? 90 : Number(daysParam);
  if (!Number.isFinite(daysRaw)) {
    return NextResponse.json({ error: "invalid_days" }, { status: 400, headers: perCaller });
  }
  const days = Math.min(Math.max(Math.trunc(daysRaw), 1), 366);

  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "observatory_unavailable" }, { status: 503, headers: perCaller });
  }

  try {
    const raw = await db.execute(sql`
      SELECT to_char(pu.attempted_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS attempted_at,
             e.resource_key, pu.network, pu.status, pu.amount_units, pu.spent_units,
             pu.tx_hash, pu.http_status_paid, pu.latency_ms, pu.l2_schema
      FROM x402_l1_purchases pu
      JOIN x402_endpoints e ON e.id = pu.endpoint_id
      WHERE pu.attempted_at >= now() - make_interval(days => ${days}::int)
        AND pu.status NOT IN ('budget_denied', 'request_error', 'in_flight')
      ORDER BY pu.attempted_at ASC
      LIMIT ${MAX_ROWS + 1}
    `);
    const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Record<
      string,
      unknown
    >[];
    const truncated = rows.length > MAX_ROWS;
    const emit = truncated ? rows.slice(0, MAX_ROWS) : rows;

    const lines = [CSV_COLUMNS.join(",")];
    for (const r of emit) {
      lines.push(CSV_COLUMNS.map((c) => csvCell(r[c])).join(","));
    }
    return new NextResponse(lines.join("\n") + "\n", {
      headers: {
        ...perCaller,
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="vet402-l1-ledger-${days}d.csv"`,
        "x-vet402-truncated": truncated ? "true" : "false",
        // CSVはコメント行を持てないので、ライセンス・取得日・出典は
        // ヘッダで運ぶ。ファイルだけ手元に残った人が出所を失わないための最低限。
        "x-vet402-license": "CC-BY-4.0",
        "x-vet402-retrieved-at": new Date().toISOString(),
        "x-vet402-rows": String(emit.length),
        "x-vet402-window-days": String(days),
        Link:
          '<https://creativecommons.org/licenses/by/4.0/>; rel="license", ' +
          '<https://vet402.com/observatory/methodology>; rel="describedby"',
        "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=7200",
      },
    });
  } catch (error) {
    logServerError("observatory_export", error);
    return NextResponse.json({ error: "observatory_unavailable" }, { status: 503, headers: perCaller });
  }
}
