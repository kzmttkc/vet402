// ============================================================
// §14 P2「週次カバレッジ報告（listed / L0 実施 / L1 実施 / 実需決済）」。
// /accuracy の週次ブロックとして出す（§12「Accuracy ledger に週次で出す」）。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { rowsOf } from "@/lib/settlements/upsert";

export type CoverageWeekly = {
  window_days: 7;
  listed: number;
  l0_measured: number;
  l0_measured_pct: number | null;
  l1_measured: number;
  l1_measured_pct: number | null;
  real_settlements: number;
  raw_settlements: number;
  definition: string;
};

export async function getCoverageWeekly(): Promise<CoverageWeekly> {
  const db = getDb();
  const empty: CoverageWeekly = {
    window_days: 7,
    listed: 0,
    l0_measured: 0,
    l0_measured_pct: null,
    l1_measured: 0,
    l1_measured_pct: null,
    real_settlements: 0,
    raw_settlements: 0,
    definition:
      "listed = active catalog endpoints seen in the last 30 days; l0_measured = of those, probed (L0) in the last 7 days; l1_measured = of those, purchased (L1 attempt) in the last 7 days; real_settlements / raw_settlements = indexed settlements in the last 7 days with and without wash/test exclusion.",
  };
  if (!db) return empty;
  const r = rowsOf<Record<string, number>>(
    await db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM x402_endpoints e WHERE e.status = 'active' AND e.last_seen_at > now() - interval '30 days') AS listed,
        (SELECT count(*)::int FROM x402_endpoints e WHERE e.status = 'active' AND e.last_seen_at > now() - interval '30 days'
           AND EXISTS (SELECT 1 FROM x402_l0_probes p WHERE p.endpoint_id = e.id AND p.probed_at > now() - interval '7 days')) AS l0,
        (SELECT count(*)::int FROM x402_endpoints e WHERE e.status = 'active' AND e.last_seen_at > now() - interval '30 days'
           AND EXISTS (SELECT 1 FROM x402_l1_purchases pu WHERE pu.endpoint_id = e.id AND pu.attempted_at > now() - interval '7 days')) AS l1,
        (SELECT count(*)::int FROM settlements s WHERE coalesce(s.block_time, s.observed_at) > now() - interval '7 days' AND s.wash_flag = 'none') AS real,
        (SELECT count(*)::int FROM settlements s WHERE coalesce(s.block_time, s.observed_at) > now() - interval '7 days') AS raw
    `),
  )[0] ?? {};
  const listed = Number(r.listed ?? 0);
  const l0 = Number(r.l0 ?? 0);
  const l1 = Number(r.l1 ?? 0);
  const pct = (n: number) => (listed === 0 ? null : Math.round((n / listed) * 1000) / 10);
  return {
    ...empty,
    listed,
    l0_measured: l0,
    l0_measured_pct: pct(l0),
    l1_measured: l1,
    l1_measured_pct: pct(l1),
    real_settlements: Number(r.real ?? 0),
    raw_settlements: Number(r.raw ?? 0),
  };
}
