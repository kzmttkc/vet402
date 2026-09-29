// ============================================================
// L0 の公開判定を 1 出品 1 行で持ち出す公開 export（2026-09-29 監査 5 周目・データ記者の立場）。
//
// /observatory/state の L0 の件数（publishedPass・publishedPassActive・publishedFail・チェーン別表）は、元になる
// 「出品ごとの最新の公開判定」が公開の export に無く、数え直せなかった。ここは getObservatoryStats /
// getObservatoryStatsByChain と同じ母集団（運営自身の endpoint を除いた全出品・掲載落ちを含む）を、同じ規則
// （l0-probe.ts の publishedVerdict・chains.ts の chainLabel / isMainnet）で 1 行ずつ出すだけ。新しい判定は作らない。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { chainLabel, isMainnet, isTestnet, toCaip2 } from "./chains";
import { MIN_CONSECUTIVE_FAILS_TO_PUBLISH, publishedVerdict } from "./l0-probe";
import { operatorExclusionPredicate } from "./operator-sql";

export const L0_EXPORT_COLUMNS = [
  "endpoint_id",
  "resource_key",
  "network",
  "chain",
  "network_class",
  "listed",
  "published_verdict",
  "latest_probe_verdict",
  "last_probed_at",
  "latest_probe_older_than_7d",
] as const;

export type L0ExportColumn = (typeof L0_EXPORT_COLUMNS)[number];
export type L0ExportRow = Record<L0ExportColumn, string>;

/** mainnet（state の byChain に入る）/ testnet / unclassified（名前で分からない id・byChainUnclassified）。 */
export function networkClassOf(network: string | null): "mainnet" | "testnet" | "unclassified" {
  const n = toCaip2(network);
  if (isMainnet(n)) return "mainnet";
  if (isTestnet(n)) return "testnet";
  return "unclassified";
}

/** 純関数: DB の 1 行 → CSV の 1 行。verdicts は新しい順（最大 MIN_CONSECUTIVE_FAILS_TO_PUBLISH 件）。 */
export function toL0ExportRow(
  r: {
    endpoint_id: string;
    resource_key: string;
    network: string | null;
    status: string;
    verdicts: readonly string[] | null;
    last_probed_at: string | null;
  },
  now: number,
): L0ExportRow {
  const verdicts = r.verdicts ?? [];
  const last = r.last_probed_at;
  const lastMs = last ? Date.parse(last) : NaN;
  return {
    endpoint_id: r.endpoint_id,
    resource_key: r.resource_key,
    network: r.network ?? "",
    chain: chainLabel(toCaip2(r.network)),
    network_class: networkClassOf(r.network),
    listed: String(r.status === "active"),
    published_verdict: publishedVerdict(verdicts),
    latest_probe_verdict: verdicts[0] ?? "",
    last_probed_at: last ?? "",
    latest_probe_older_than_7d: Number.isFinite(lastMs) ? String(now - lastMs >= 7 * 86_400_000) : "",
  };
}

export async function readL0Export(): Promise<{ fetchedAt: string; rows: L0ExportRow[] } | null> {
  const db = getDb();
  if (!db) return null;
  const fetchedAt = new Date().toISOString();
  const raw = await db.execute(sql`
    SELECT e.id::text AS endpoint_id, e.resource_key, e.network, e.status,
           lp.verdicts,
           to_char(lp.last_probed_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_probed_at
    FROM x402_endpoints e
    LEFT JOIN LATERAL (
      SELECT array_agg(v.verdict ORDER BY v.probed_at DESC) AS verdicts, max(v.probed_at) AS last_probed_at
      FROM (
        SELECT verdict, probed_at FROM x402_l0_probes p
        WHERE p.endpoint_id = e.id
        ORDER BY probed_at DESC
        LIMIT ${MIN_CONSECUTIVE_FAILS_TO_PUBLISH}
      ) v
    ) lp ON true
    WHERE ${operatorExclusionPredicate("e")}
    ORDER BY e.resource_key ASC, e.id ASC
  `);
  const list = (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as {
    endpoint_id: string;
    resource_key: string;
    network: string | null;
    status: string;
    verdicts: string[] | string | null;
    last_probed_at: string | null;
  }[];
  const now = Date.now();
  return {
    fetchedAt,
    rows: list.map((r) => toL0ExportRow({ ...r, verdicts: parsePgArray(r.verdicts) }, now)),
  };
}

/** ドライバが text[] を文字列（`{pass,fail}`）で返す場合に備える。 */
function parsePgArray(v: string[] | string | null): string[] | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v;
  const inner = v.replace(/^\{|\}$/g, "");
  return inner === "" ? [] : inner.split(",").map((x) => x.replace(/^"|"$/g, ""));
}

export const L0_EXPORT_COLUMN_NOTES =
  "One row per endpoint on record (listed or not), excluding endpoints paying vet402's own addresses, the population /api/v1/observatory/state counts. " +
  "published_verdict = pass (latest probe passed) | fail (the newest 2 probes both failed) | unverified (anything else, including no probe); " +
  "counting published_verdict=pass gives publishedPass, adding listed=true gives publishedPassActive, and adding latest_probe_older_than_7d=true gives publishedPassActiveProbeOlderThan7d. " +
  "network_class = mainnet (a network id vet402 knows to be a mainnet: the rows of the state byChain table) | testnet | unclassified (an id vet402 cannot name, listed in byChainUnclassified). " +
  "listed = the catalog still lists it (status active). last_probed_at = the newest L0 probe (UTC). " +
  "Full definitions: https://vet402.com/openapi.yaml";
