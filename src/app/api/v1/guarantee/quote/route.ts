import { NextRequest, NextResponse } from "next/server";
import {
  applyRateLimit,
  authenticateApiRequest,
  withRateLimitHeaders,
} from "@/lib/api/guard";
import { isGuaranteeUnderwritingEnabled } from "@/lib/config/env";
import { computeAccuracyReport } from "@/lib/scoring/accuracy";
import { fetchAccuracyRows } from "@/lib/db/outcome-reader";
import { underwrite } from "@/lib/guarantee/underwriting";
import { logServerError } from "@/lib/util/log";

// ============================================================
// N-20 guarantee underwriting — the API RECEPTACLE, OFF by default.
//
// This is the wiring, not the launch. It connects the already-tested pure
// function underwrite() to the same external AccuracyReport the public
// /accuracy page is built from, so that the day the business + legal decision
// lands (approval-queue AQ-016) go-live is `GUARANTEE_UNDERWRITING_ENABLED=true`
// and nothing else. Until then this endpoint 404s exactly as if it did not
// exist — a dormant financial product must not be discoverable, quotable, or
// implied to anyone.
//
// It underwrites off the SAME numbers we publish (fetchAccuracyRows excludes
// the operator-benchmark self-seed at the SQL layer), so a quote can never be
// priced off internal numbers rosier than the public ones. The pure function
// fails closed below 200 resolved verdicts — today it returns canOffer:false
// with machine-readable blockers, which is the honest current answer.
// ============================================================

/**
 * 2026-09-01 監査: このルートは GET しか輸出しておらず、他メソッドは Next.js の
 * 既定 405 を返していた。405 は「このパスにルートは在るが、そのメソッドは不可」
 * の意味なので、**フラグが OFF でも実在が判る**——上のコメントが宣言している
 * 「存在しないかのように 404」が、GET でしか成立していなかった。
 *
 * 実測（2026-09-01 本番）:
 *   GET  /api/v1/guarantee/quote → 404
 *   POST /api/v1/guarantee/quote → 405   ← 実在が漏れる
 *   実在しないパス（/api/[...unmatched]）→ 全メソッド 404
 *
 * OFF のときは**どのメソッドでも 404**にして、実在しないパスと区別がつかない
 * 状態に揃える。ON のときは従来どおり GET だけが通り、他は 405（機能が公開
 * された後なら、メソッド違いを 405 で正直に言うのが正しい）。
 */
function disabled404(): NextResponse {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

/** OFF なら 404、ON なら 405。ON 時のメソッド不一致は隠す理由がない。 */
function methodNotAllowedOrHidden(): NextResponse {
  if (!isGuaranteeUnderwritingEnabled()) return disabled404();
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
}

export const POST = methodNotAllowedOrHidden;
export const PUT = methodNotAllowedOrHidden;
export const PATCH = methodNotAllowedOrHidden;
export const DELETE = methodNotAllowedOrHidden;
export const HEAD = methodNotAllowedOrHidden;
export const OPTIONS = methodNotAllowedOrHidden;

// 2026-09-02 監査: 静的化された route handler が prerender から古い判定を返すのを防ぐ（09c1fa0 と同じ欠陥）。
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  // Gate FIRST, before auth even runs: a disabled feature reveals nothing,
  // not even whether a valid key would have worked.
  if (!isGuaranteeUnderwritingEnabled()) {
    return disabled404();
  }

  const auth = await authenticateApiRequest(request);
  if (!auth.ok) return auth.error;

  const limited = await applyRateLimit(auth.ctx, 1);
  if (!limited.ok) return limited.error;

  try {
    const report = computeAccuracyReport(await fetchAccuracyRows(90));
    const quote = underwrite(report);
    return withRateLimitHeaders(
      NextResponse.json({
        ...quote,
        // Echo the disclaimer posture — a quote is not a bound policy.
        disclaimer:
          "Indicative underwriting quote from measured accuracy only. Not a bound guarantee, insurance policy, or offer of coverage; subject to separate terms.",
        generatedAt: new Date().toISOString(),
      }),
      limited.rateLimit,
    );
  } catch (error) {
    logServerError("guarantee_quote", error);
    return NextResponse.json({ error: "guarantee_unavailable" }, { status: 503 });
  }
}
