import { NextRequest, NextResponse } from "next/server";
import { consumeIpRateLimit, getClientIp, ipRateLimitHeaders } from "@/lib/api/ip-rate-limit";
import { isMissingSchemaError } from "@/lib/db/pg-errors";
import { readSpendingHaltState, setSpendingHalt } from "@/lib/observatory/kill-switch";
import { logServerError } from "@/lib/util/log";
import { secureCompare } from "@/lib/util/secure-compare";

/**
 * /api/admin/spending-halt — L1 実購入の**実行時**停止スイッチ（2026-09-05 監査 P0）。
 *
 *   GET   現在値（runtime_flags.l1_spending_halt の行そのまま）
 *   POST  {enabled, reason, by?} で停止 / 再開。1 文の upsert（読んでから書かない）。
 *
 * これ以前、支出を止める手段は Vercel env `OBSERVATORY_L1_ENABLED` の変更＋
 * 再デプロイしかなかった。起動点は 4 つあり、再デプロイが終わるまでどれもが
 * 署名できる。ここは 1 リクエストで即時に効く（効き始めは次の署名から）。
 * 手順は docs/INCIDENT_RUNBOOK.md。
 *
 * 意図的に置かなかったもの / 外したもの:
 *  - assertProductionConfig()。兄弟の admin ルートは環境の取り違えを罠で落とすが、
 *    それは「レポートが誤った環境で計算される」のを防ぐためのもの。
 *    **止めるボタンが環境設定を理由に拒否されるのは、止められないのと同じ。**
 *  - 停止（enabled=true）への IP レート制限。読み取りと再開だけ絞る。
 */
export const dynamic = "force-dynamic";

function authorized(request: NextRequest): boolean {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return false;
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  return token.length > 0 && secureCompare(token, secret);
}

/** 429 を返すべきときだけ Response を返す。停止の経路からは呼ばない。 */
async function throttled(request: NextRequest): Promise<NextResponse | null> {
  const ip = getClientIp(request);
  const limit = await consumeIpRateLimit(`admin-spending-halt:${ip}`, 60, 60_000);
  if (limit.allowed) return null;
  return NextResponse.json(
    { error: "rate_limit_exceeded", retryAfter: limit.retryAfter },
    { status: 429, headers: ipRateLimitHeaders(limit) },
  );
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const limited = await throttled(request);
  if (limited) return limited;
  try {
    return NextResponse.json(await readSpendingHaltState());
  } catch (error) {
    logServerError("admin.spending_halt.read", error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const enabled = (body as { enabled?: unknown })?.enabled;
  // 文字列 "true" を通さない。止めたつもりで止まっていない、が一番悪い。
  if (typeof enabled !== "boolean") {
    return NextResponse.json(
      { error: "invalid_enabled", detail: "body.enabled must be a boolean" },
      { status: 400 },
    );
  }

  const rawReason = (body as { reason?: unknown })?.reason;
  // 理由は必須。この行がそのまま履歴（updated_at / updated_by / reason）になる。
  if (typeof rawReason !== "string" || rawReason.trim().length === 0) {
    return NextResponse.json(
      { error: "reason_required", detail: "body.reason must say why" },
      { status: 400 },
    );
  }

  const rawBy = (body as { by?: unknown })?.by;
  const updatedBy = typeof rawBy === "string" && rawBy.trim() ? rawBy.trim().slice(0, 100) : "admin";

  // 止める操作だけはレート制限を通さない（冒頭のコメント参照）。
  if (enabled === false) {
    const limited = await throttled(request);
    if (limited) return limited;
  }

  try {
    const state = await setSpendingHalt({
      enabled,
      reason: rawReason.trim().slice(0, 500),
      updatedBy,
    });
    return NextResponse.json({ ok: true, ...state });
  } catch (error) {
    if (isMissingSchemaError(error)) {
      // 表がまだ無い＝止められない。黙って 200 を返さず、次の 1 手を書いて返す。
      logServerError("admin.spending_halt.schema_missing", error);
      return NextResponse.json(
        {
          error: "flag_table_absent",
          detail: "apply scripts/sql/2026-09-05-runtime-flags.sql, then retry",
        },
        { status: 503 },
      );
    }
    logServerError("admin.spending_halt.write", error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
