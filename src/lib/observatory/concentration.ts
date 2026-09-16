// ============================================================
// 集中度の集計（次波③・SPEC20-A7の facts-only 形）。
//
// 「sybil」という評価語も、個別の名指しも、公開面には出さない。
// 出すのは分母付きの構造事実だけ:
//   - 1ホストに複数の受取ウォレットがぶら下がる度合い
//   - 1ウォレットが複数ホストで受け取る度合い
//   - 「2回以上失敗し1度も決済されない」ウォレットの数（history-flagsと同述語）
// 解釈（運用の分散か・名義の分散か）は読者とキー付き面（graph/flags）の仕事。
// ============================================================
import { sql } from "drizzle-orm";
import { inconclusivePredicate } from "@/lib/observatory/delivery";
import { getDb } from "@/lib/db/client";

export const CONCENTRATION_DEFINITION =
  "Structural aggregates over the active catalog, denominators included, no entities named: hostsWithMultiplePayTos (active hosts receiving to >=2 distinct payTo), payTosOnMultipleHosts (payTo receiving on >=2 hosts), repeatFailNoSuccessPayTos (payTo whose endpoints have >=2 settle_failed and 0 settled in vet402's own ledger, not counting settle_failed rows held as inconclusive — same predicate as the keyed history-flags surface). Interpretation is deliberately left out.";

export type Concentration = {
  activeHosts: number;
  distinctPayTos: number;
  hostsWithMultiplePayTos: number;
  maxPayTosOnOneHost: number;
  payTosOnMultipleHosts: number;
  maxHostsForOnePayTo: number;
  repeatFailNoSuccessPayTos: number;
  definition: string;
};

export async function computeConcentration(): Promise<Concentration | null> {
  const db = getDb();
  if (!db) return null;
  const raw = await db.execute(sql`
    WITH act AS (
      SELECT split_part(resource_key, '/', 1) AS host, pay_to, id
      FROM x402_endpoints WHERE status = 'active' AND pay_to IS NOT NULL
    ), by_host AS (
      SELECT host, count(DISTINCT pay_to) AS n FROM act GROUP BY host
    ), by_payto AS (
      SELECT pay_to, count(DISTINCT host) AS n FROM act GROUP BY pay_to
    ), fails AS (
      SELECT act.pay_to,
             count(*) FILTER (WHERE pu.status = 'settle_failed' AND NOT (${sql.raw(inconclusivePredicate("pu"))})) AS failed,
             count(*) FILTER (WHERE pu.status = 'settled') AS settled
      FROM x402_l1_purchases pu JOIN act ON act.id = pu.endpoint_id
      GROUP BY act.pay_to
    )
    SELECT
      (SELECT count(*)::int FROM by_host) AS active_hosts,
      (SELECT count(*)::int FROM by_payto) AS distinct_paytos,
      (SELECT count(*)::int FROM by_host WHERE n >= 2) AS multi_payto_hosts,
      coalesce((SELECT max(n)::int FROM by_host), 0) AS max_paytos_one_host,
      (SELECT count(*)::int FROM by_payto WHERE n >= 2) AS multi_host_paytos,
      coalesce((SELECT max(n)::int FROM by_payto), 0) AS max_hosts_one_payto,
      (SELECT count(*)::int FROM fails WHERE failed >= 2 AND settled = 0) AS repeat_fail_paytos
  `);
  const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Record<string, unknown>[];
  const r = rows[0] ?? {};
  return {
    activeHosts: Number(r.active_hosts ?? 0),
    distinctPayTos: Number(r.distinct_paytos ?? 0),
    hostsWithMultiplePayTos: Number(r.multi_payto_hosts ?? 0),
    maxPayTosOnOneHost: Number(r.max_paytos_one_host ?? 0),
    payTosOnMultipleHosts: Number(r.multi_host_paytos ?? 0),
    maxHostsForOnePayTo: Number(r.max_hosts_one_payto ?? 0),
    repeatFailNoSuccessPayTos: Number(r.repeat_fail_paytos ?? 0),
    definition: CONCENTRATION_DEFINITION,
  };
}
