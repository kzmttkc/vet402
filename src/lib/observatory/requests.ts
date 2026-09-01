// ============================================================
// 公開検証リクエストキュー v0（C9・無償枠）。
//
// 誰でも「このエンドポイントを測って」を積める。実測定は日次 L0 cron が
// キューを先に消化する形で行い、行は通常のプローブとして記帳される
// （trigger: "request"）。リクエストが多いことは測定を歪めない——
// 順番が前後するだけで、判定のゲートは常に同一。
//
// 有償優先枠（x402課金＝自社ドッグフード）は self-listing 計画と統合して
// 後日。テーブルは tier/payment_ref を既に持つが、v0 は常に free。
// ============================================================
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { verificationRequests, x402Endpoints, x402L0Probes } from "@/lib/db/schema";
import { mapWithConcurrency } from "@/lib/util/concurrency";
import { createDeadline } from "@/lib/util/deadline";
import { probeEndpoint, type ProbeOptions } from "./l0-probe";
import { UUID_RE } from "@/lib/validation/uuid";

export type EnqueueResult =
  | { ok: true; id: string; deduped: boolean }
  | { ok: false; reason: "invalid_input" | "endpoint_not_found" | "db_unavailable" };

export async function enqueueVerificationRequest(input: {
  endpointId: string;
  requesterIp: string | null;
}): Promise<EnqueueResult> {
  if (!UUID_RE.test(input.endpointId)) return { ok: false, reason: "invalid_input" };
  const db = getDb();
  if (!db) return { ok: false, reason: "db_unavailable" };

  const [ep] = await db
    .select({ id: x402Endpoints.id })
    .from(x402Endpoints)
    .where(eq(x402Endpoints.id, input.endpointId))
    .limit(1);
  if (!ep) return { ok: false, reason: "endpoint_not_found" };

  // 同一エンドポイントの pending は1件に畳む（キューの水増しをさせない）。
  const [pending] = await db
    .select({ id: verificationRequests.id })
    .from(verificationRequests)
    .where(
      and(
        eq(verificationRequests.endpointId, input.endpointId),
        eq(verificationRequests.status, "pending"),
      ),
    )
    .limit(1);
  if (pending) return { ok: true, id: pending.id, deduped: true };

  const [row] = await db
    .insert(verificationRequests)
    .values({ endpointId: input.endpointId, requesterIp: input.requesterIp })
    .returning();
  return { ok: true, id: row.id, deduped: false };
}

/**
 * ドレインの時間予算と件数上限（2026-08-22 監査）。
 *
 * キューは APIキー不要・5回/分で誰でも積める。以前のドレインは選んだ行を
 * 逐次でプローブしており、1件あたり最大 10s（l0-probe の既定タイムアウト）。
 * 50件なら最悪 500s で、呼び出し元 cron の maxDuration=300 を単独で食い潰す
 * ——つまり「公開キューに積むだけで日次L0測定を止められる」状態だった。
 *
 * 数字の根拠: l0-probe cron の 300s のうち、本体 runL0ProbeBatch が
 * 最悪 250s（500件 / 並列20 / 10s）を使う設計（cron/l0-probe/route.ts 冒頭）。
 * 残りは 50s。予算を 45s に置き、並列度は probe-runner と同じ 20 に揃える
 * ので 50件は最悪3波 = 約30s に収まる。予算内に収まらなかった行は pending の
 * まま次回へ回し、何件残したかを summary とログに出す（黙って落とさない）。
 */
const DRAIN_BUDGET_MS = 45_000;
const DRAIN_CONCURRENCY = 20;
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

export type DrainSummary = {
  drained: number;
  probed: number;
  invalid: number;
  /** 予算切れで着手しなかった件数（pending のまま次回のドレインへ）。 */
  deferred: number;
};

export type DrainOptions = ProbeOptions & {
  /** ドレイン全体の実時間予算。既定は DRAIN_BUDGET_MS。 */
  budgetMs?: number;
  /** 同時実行数。既定は probe-runner と同じ 20。 */
  concurrency?: number;
};

/**
 * 日次 L0 cron の冒頭で呼ぶ。pending を古い順に limit 件、実プローブして
 * 記帳し、probed へ落とす。エンドポイントが消えていた行は invalid。
 *
 * 予算を跨ぐ行には**着手しない**（開始してから短いタイムアウトで打ち切る、
 * ということはしない）。中途半端に急かしたプローブは売り手の fail として
 * 台帳に残ってしまい、それは測定ではなくこちらの都合だから。
 */
export async function drainVerificationRequests(
  limit: number,
  options: DrainOptions = {},
): Promise<DrainSummary> {
  const summary: DrainSummary = { drained: 0, probed: 0, invalid: 0, deferred: 0 };
  const db = getDb();
  if (!db) return summary;

  const { budgetMs = DRAIN_BUDGET_MS, concurrency = DRAIN_CONCURRENCY, ...probeOptions } = options;
  const deadline = createDeadline(budgetMs);
  const probeTimeoutMs = probeOptions.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  const raw = await db.execute(sql`
    SELECT vr.id, vr.endpoint_id, e.resource_url, e.method, e.pay_to, e.network,
           e.price_amount, e.price_asset, (e.id IS NULL) AS missing
    FROM verification_requests vr
    LEFT JOIN x402_endpoints e ON e.id = vr.endpoint_id
    WHERE vr.status = 'pending'
    ORDER BY vr.created_at ASC
    LIMIT ${Math.min(Math.max(limit, 1), 200)}
  `);
  const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Record<
    string,
    unknown
  >[];
  summary.drained = rows.length;

  await mapWithConcurrency(rows, concurrency, async (r) => {
    const id = String(r.id);
    if (r.missing === true || !r.resource_url) {
      // 台帳の掃除は外向きHTTPを伴わないので予算判定の前でよい。
      await db
        .update(verificationRequests)
        .set({ status: "invalid" })
        .where(eq(verificationRequests.id, id));
      summary.invalid++;
      return;
    }
    // まるまる1本ぶんの時間が残っていなければ着手しない（上の注記の理由）。
    if (deadline.remaining() < probeTimeoutMs) {
      summary.deferred++;
      return;
    }
    try {
      const probe = await probeEndpoint(
        {
          resourceUrl: String(r.resource_url),
          method: (r.method as string | null) ?? null,
          payTo: (r.pay_to as string | null) ?? null,
          network: (r.network as string | null) ?? null,
          priceAmount: (r.price_amount as string | null) ?? null,
          priceAsset: (r.price_asset as string | null) ?? null,
        },
        probeOptions,
      );
      await db.insert(x402L0Probes).values({
        endpointId: String(r.endpoint_id),
        method: probe.method,
        verdict: probe.verdict,
        dialect: probe.dialect,
        httpStatus: probe.httpStatus,
        acceptsValid: probe.acceptsValid,
        priceConsistent: probe.priceConsistent,
        metadataConsistent: probe.metadataConsistent,
        latencyMs: probe.latencyMs,
        failReason: probe.failReason,
        rawResponseMeta: { ...probe.rawResponseMeta, trigger: "request", requestId: id },
      });
      await db
        .update(verificationRequests)
        .set({ status: "probed", probedAt: new Date() })
        .where(eq(verificationRequests.id, id));
      summary.probed++;
    } catch {
      // 次回の drain で再試行される（pending のまま）。
    }
  });

  if (summary.deferred > 0) {
    // 予算超過は運用事実。黙って落とすとキューが伸び続けても誰も気づかない。
    console.warn(
      `[vouch] verification_request_drain_deferred: ${summary.deferred}/${summary.drained} left pending (budget ${budgetMs}ms)`,
    );
  }
  return summary;
}
