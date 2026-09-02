// ============================================================
// vet402 Observatory L0 — rolling probe runner (design §4).
//
// Hobby crons fire once a day, and 15k probes don't fit one invocation —
// so each run takes the N endpoints whose last probe is OLDEST (never-probed
// first) and the fleet cycles through the catalog over a few days. Daily
// delisting detection doesn't depend on this: catalog-sync covers presence
// every day; the probe answers "does the payment wall actually stand".
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { isMissingSchemaError } from "@/lib/db/pg-errors";
import { x402L0Probes } from "@/lib/db/schema";
import { probeEndpoint, type ProbeResult } from "./l0-probe";
import { invalidateDecisionCache } from "@/lib/decision/cache";
import { l0TierWhere } from "./coverage";

export type ProbeBatchSummary = {
  probed: number;
  pass: number;
  fail: number;
  unverified: number;
};

type Candidate = {
  id: string;
  resourceUrl: string;
  method: string | null;
  payTo: string | null;
  network: string | null;
  priceAmount: string | null;
  priceAsset: string | null;
};

export async function runL0ProbeBatch(
  options: {
    limit?: number;
    concurrency?: number;
    fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
    timeoutMs?: number;
    /**
     * §7.4 カバレッジ階層（2026-09-02）。c1 = 30 日以内に listed/決済のある active、
     * c2 = 決済帰属あり ∨ 問い合わせ多（6 時間周期・5 時間以内に測った行は飛ばす）。
     * all = 従来どおり active 全件（テスト・手動用）。
     */
    tier?: "c1" | "c2" | "all";
  } = {},
): Promise<ProbeBatchSummary> {
  const { limit = 500, concurrency = 20, fetchImpl, timeoutMs, tier = "all" } = options;
  const where = tier === "all" ? sql`e.status = 'active'` : l0TierWhere(tier);
  const freshness = tier === "c2" ? sql`AND (lp.last_probed_at IS NULL OR lp.last_probed_at < now() - interval '5 hours')` : sql``;
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL is not configured");

  // Oldest-probed-first (never-probed before that) across ACTIVE endpoints.
  let candidates: Candidate[];
  try {
    const rows = await db.execute(sql`
      SELECT e.id, e.resource_url, e.method, e.pay_to, e.network,
             e.price_amount, e.price_asset
      FROM x402_endpoints e
      LEFT JOIN LATERAL (
        SELECT max(probed_at) AS last_probed_at
        FROM x402_l0_probes p WHERE p.endpoint_id = e.id
      ) lp ON true
      WHERE ${where}
      ${freshness}
      ORDER BY lp.last_probed_at ASC NULLS FIRST, e.first_seen_at ASC
      LIMIT ${limit}
    `);
    const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
    candidates = (list as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      resourceUrl: String(r.resource_url),
      method: (r.method as string | null) ?? null,
      payTo: (r.pay_to as string | null) ?? null,
      network: (r.network as string | null) ?? null,
      priceAmount: (r.price_amount as string | null) ?? null,
      priceAsset: (r.price_asset as string | null) ?? null,
    }));
  } catch (error) {
    if (isMissingSchemaError(error)) return { probed: 0, pass: 0, fail: 0, unverified: 0 };
    throw error;
  }

  const summary: ProbeBatchSummary = { probed: 0, pass: 0, fail: 0, unverified: 0 };
  let cursor = 0;

  // Small worker pool — polite to targets, bounded for the function's clock.
  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= candidates.length) return;
      const c = candidates[index];
      const result: ProbeResult = await probeEndpoint(
        {
          resourceUrl: c.resourceUrl,
          method: c.method,
          payTo: c.payTo,
          network: c.network,
          priceAmount: c.priceAmount,
          priceAsset: c.priceAsset,
        },
        { fetchImpl, timeoutMs },
      );
      await db!.insert(x402L0Probes).values({
        endpointId: c.id,
        method: result.method,
        verdict: result.verdict,
        dialect: result.dialect,
        httpStatus: result.httpStatus,
        has402Challenge: result.has402Challenge,
        acceptsValid: result.acceptsValid,
        priceConsistent: result.priceConsistent,
        metadataConsistent: result.metadataConsistent,
        latencyMs: result.latencyMs,
        failReason: result.failReason,
        rawResponseMeta: result.rawResponseMeta,
      });
      invalidateDecisionCache(c.id); // L0 判定は判定材料（このインスタンスのみ・cache.ts 参照）
      summary.probed++;
      summary[result.verdict]++;
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(candidates.length, 1)) }, worker),
  );
  return summary;
}
