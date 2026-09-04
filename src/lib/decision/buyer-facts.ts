// ============================================================
// §8.2 買い手事実（Payer / Agent）。主材料は実決済の多様性・異常リトライ・シビル信号。
// 自己申告のバッジではない。ERC-8004 identity は加点材料に留める（判定側で weight 0.05 相当）。
//
//   settled_count_30d / unique_payees_30d  settlements（wash 'none'）から
//   retry_burst_rate                        同一 resource への 60 秒以内の再署名率
//   sybil.shared_funder                     funder_wallets で他の payer と funder を共有
//   sybil.multi_agent_owner                 8004 owner が 3 体以上を保有
//   erc8004.feedback_with_payment_proof_ratio  同 payer の feedback のうち settlements に tx がある比率
// 読めなかった入力は sybil.unavailable に名指しで残す（判定は fail-closed）。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { parsePartyId, agentId8004 } from "@/lib/ids/canonical";
import { RAW_RETENTION_DAYS, SETTLEMENT_DAY, UTC_TODAY } from "@/lib/settlements/rollup";
import { rowsOf } from "@/lib/settlements/upsert";
import type { BuyerFacts } from "./types";

export const RETRY_BURST_WINDOW_MS = 60_000;
export const MULTI_AGENT_OWNER_MIN = 3;

/** 純関数: (resource_id, 時刻) の列から 60 秒以内の再署名率を出す。列 < 2 なら null。 */
export function retryBurstRate(events: readonly { resourceId: string | null; at: Date }[]): number | null {
  const byResource = new Map<string, number[]>();
  for (const e of events) {
    const key = e.resourceId ?? "";
    if (!key) continue;
    const list = byResource.get(key) ?? [];
    list.push(e.at.getTime());
    byResource.set(key, list);
  }
  let total = 0;
  let bursts = 0;
  for (const times of byResource.values()) {
    times.sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) {
      total++;
      if (times[i] - times[i - 1] <= RETRY_BURST_WINDOW_MS) bursts++;
    }
  }
  return total === 0 ? null : bursts / total;
}

export async function loadBuyerFacts(payerId: string): Promise<BuyerFacts> {
  const db = getDb();
  const parsed = parsePartyId(payerId);
  const empty: BuyerFacts = {
    settled_count_30d: 0,
    unique_payees_30d: 0,
    retry_burst_rate: null,
    sybil: { multi_agent_owner: false, shared_funder: false, cluster_id: null, unavailable: [] },
    erc8004: { agent_id: null, feedback_with_payment_proof_ratio: null },
    first_seen: null,
    last_seen: null,
  };
  if (!db || !parsed) return { ...empty, sybil: { ...empty.sybil, unavailable: ["settlements"] } };
  const unavailable: string[] = [];

  // 2026-09-04 W15: 生行は直近 RAW_RETENTION_DAYS 日しか残らない（rollup.ts）。
  // 30 日の実績を生行だけで数えると、保存の都合で「30 日」が静かに「7 日」に
  // すり替わる。日次集約と足して数える——集約は payee_id を鍵に持つので
  // 件数も取引先数も正確に出る。畳んだ日の時刻は日単位まで（個票は残らない）。
  const agg = rowsOf<{ n: number; payees: number; first_seen: string | null; last_seen: string | null }>(
    await db.execute(sql`
      WITH u AS (
        SELECT payee_id, coalesce(block_time, observed_at) AS at, 1::bigint AS n
        FROM settlements
        WHERE payer_id = ${payerId} AND wash_flag = 'none' AND ${SETTLEMENT_DAY} > ${UTC_TODAY} - 30
        UNION ALL
        SELECT payee_id, (day::timestamp AT TIME ZONE 'UTC') AS at, n::bigint
        FROM settlement_daily
        WHERE payer_id = ${payerId} AND wash_flag = 'none' AND day > ${UTC_TODAY} - 30
      )
      SELECT coalesce(sum(n), 0)::int AS n, count(DISTINCT payee_id)::int AS payees,
             min(at)::text AS first_seen, max(at)::text AS last_seen
      FROM u
    `),
  )[0];
  // 生涯の初回観測。集約の保持期間（DAILY_RETENTION_DAYS）より古い活動は
  // 残っていないので、実際には「保持している範囲での初回」に縮む。null には
  // せず最も古い保持データを返す——/decision の「新規（7 日未満）」判定は
  // 保守側（WARN が出やすい方）へ振れるだけで、fail-open にはならない。
  const lifetime = rowsOf<{ first_seen: string | null }>(
    await db.execute(sql`
      SELECT least(
        (SELECT min(coalesce(block_time, observed_at)) FROM settlements WHERE payer_id = ${payerId}),
        (SELECT (min(day)::timestamp AT TIME ZONE 'UTC') FROM settlement_daily WHERE payer_id = ${payerId})
      )::text AS first_seen
    `),
  )[0];

  // retry_burst_rate は「60 秒以内の再署名」なので個票の時刻が要る。畳んだ日の
  // 時刻は残らないため、これだけは生行の窓（RAW_RETENTION_DAYS 日）で測る。
  // 30 日ぶんを日次集約から復元することはできない（丸めた値を出すよりも、
  // 短い窓の正しい値を出す）。
  const events = rowsOf<{ resource_id: string | null; at: string }>(
    await db.execute(sql`
      SELECT resource_id, coalesce(block_time, observed_at)::text AS at FROM settlements
      WHERE payer_id = ${payerId} AND ${SETTLEMENT_DAY} > ${UTC_TODAY} - ${RAW_RETENTION_DAYS}::int
      ORDER BY at ASC LIMIT 2000
    `),
  ).map((r) => ({ resourceId: r.resource_id, at: new Date(r.at) }));

  let sharedFunder = false;
  let clusterId: string | null = null;
  let multiAgentOwner = false;
  let agentId: string | null = null;
  let proofRatio: number | null = null;

  if (parsed.chain.startsWith("eip155:")) {
    const addr = parsed.address.toLowerCase();
    try {
      const f = rowsOf<{ funder: string; siblings: number }>(
        await db.execute(sql`
          SELECT f.funder, (SELECT count(*)::int FROM funder_wallets g WHERE lower(g.funder) = lower(f.funder) AND lower(g.wallet) <> ${addr}) AS siblings
          FROM funder_wallets f WHERE lower(f.wallet) = ${addr} LIMIT 1
        `),
      )[0];
      if (f) {
        clusterId = f.funder.toLowerCase();
        sharedFunder = Number(f.siblings) > 0;
      }
    } catch {
      unavailable.push("funder_index");
    }
    try {
      const { resolveAgentIdByWallet } = await import("@/lib/chain/agent-resolver");
      const id = await resolveAgentIdByWallet(addr as `0x${string}`);
      if (id !== null) {
        agentId = agentId8004(8453, id);
        const owner = rowsOf<{ owner: string; n: number }>(
          await db.execute(sql`
            SELECT o.owner, (SELECT count(*)::int FROM owner_agents p WHERE lower(p.owner) = lower(o.owner)) AS n
            FROM owner_agents o WHERE o.agent_id = ${id.toString()}::bigint LIMIT 1
          `),
        )[0];
        if (owner) multiAgentOwner = Number(owner.n) >= MULTI_AGENT_OWNER_MIN;
        const fb = rowsOf<{ total: number; proved: number }>(
          await db.execute(sql`
            SELECT count(*)::int AS total,
                   count(*) FILTER (WHERE EXISTS (SELECT 1 FROM settlements s WHERE lower(s.tx_hash) = lower(fe.tx_hash)))::int AS proved
            FROM feedback_events fe WHERE lower(fe.client_address) = ${addr}
          `),
        )[0];
        if (fb && Number(fb.total) > 0) proofRatio = Number(fb.proved) / Number(fb.total);
      }
    } catch {
      unavailable.push("erc8004");
    }
  }

  return {
    settled_count_30d: Number(agg?.n ?? 0),
    unique_payees_30d: Number(agg?.payees ?? 0),
    retry_burst_rate: retryBurstRate(events),
    sybil: { multi_agent_owner: multiAgentOwner, shared_funder: sharedFunder, cluster_id: clusterId, unavailable },
    erc8004: { agent_id: agentId, feedback_with_payment_proof_ratio: proofRatio },
    first_seen: lifetime?.first_seen ?? agg?.first_seen ?? null,
    last_seen: agg?.last_seen ?? null,
  };
}
