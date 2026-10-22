// The front page's one purchase and the decision facts beside it.
//
// The purchase is the settled row with the latest attempted_at in the same window as
// GET /api/v1/observatory/export.csv?days=1 (src/app/api/v1/observatory/export.csv/route.ts):
// the last day, the same excluded statuses, then status settled with a tx and a resource key.
// Ties keep the smaller purchase id, which is what the export's ascending (attempted_at, id)
// order yields when the reader keeps the first row of the latest time.
//
// The decision facts come from loadSellerFacts() on the purchase row's endpoint id, the same
// function the decision route uses, without recording a lookup and without an HTTP call back
// to this process. Resolving the URL again would pick another listing when one URL has two.
// A missing database, an empty window, or a row that cannot be formatted returns null.
// The page then draws no purchase. It does not print a zero or a stand-in.
// A thrown read is not cached. The caller turns that throw into null.
import { unstable_cache } from "next/cache";
import { sql } from "drizzle-orm";
import { settlementAssetOf } from "@/components/site/HomeLedger";
import { getDb } from "@/lib/db/client";
import { l1BasisOf } from "@/lib/decision/rules";
import { loadSellerFacts } from "@/lib/decision/seller-facts";
import { explorerTxUrl, paymentChainLabel } from "@/lib/observatory/chains";
import { heldReasonSql, isDelivered, judgedSettledCount } from "@/lib/observatory/delivery";
import { confirmedUnitsSql } from "@/lib/observatory/export-columns";
import { l2ReadingColumnsSql, l2ReadingOf } from "@/lib/observatory/l2-check";
import { PUBLIC_READ_REVALIDATE } from "@/lib/observatory/public-read-revalidate";
import { settlementSourceSql } from "@/lib/observatory/settlement-source";
import { rowsOf } from "@/lib/settlements/upsert";
import { logServerErrorSafe } from "@/lib/util/log-safe";

/** Statuses the public export leaves out. The route writes the same list. */
export const PUBLIC_EXPORT_EXCLUDED_STATUSES = ["budget_denied", "halted", "request_error", "in_flight"] as const;

export type HomeReceipt = {
  attemptedAt: string;
  date: string;
  time: string;
  host: string;
  path: string;
  url: string;
  network: string;
  chain: string;
  asset: string;
  amount: string;
  httpStatus: number | null;
  /** delivery.ts isDelivered: settled, 2xx except 202, body not recorded empty. */
  delivered: boolean;
  /** heldReasonSql returned a reason (a settled 4xx is settled_4xx). Not a failed delivery. */
  held: boolean;
  endpointId: string;
  l2: string;
  settlementSource: string;
  tx: string;
  txShort: string;
  txUrl: string | null;
  purchaseId: string;
  windowRows: number;
  windowSettled: number;
  windowFrom: string;
  windowTo: string;
};

export type HomeDecision = {
  method: string;
  observatoryId: string;
  l0: { status: string; observedAt: string | null };
  l1: { attempts: number; settled: number; delivered: number; windowDays: number };
  l2: string;
};

export type HomeExample = {
  receipt: HomeReceipt;
  decision: HomeDecision | null;
};

export const fmt = (n: number) => n.toLocaleString("en-US");

/**
 * Lowest delivered share among chains with at least `minSettled` settled purchases.
 * The denominator is judgedSettledCount, the same one as deliveryRatePct. A chain
 * with nothing left to judge is left out. Empty when no chain qualifies.
 */
export function lowestChainShareLine(
  chains: readonly { label: string; settled: number; delivered: number; inconclusiveSettled: number }[],
  minSettled = 100,
): string {
  const eligible = chains.filter((c) => c.settled >= minSettled && judgedSettledCount(c.settled, c.inconclusiveSettled) > 0);
  if (eligible.length === 0) return "";
  const picked = eligible.reduce((a, b) => {
    const aShare = a.delivered / judgedSettledCount(a.settled, a.inconclusiveSettled);
    const bShare = b.delivered / judgedSettledCount(b.settled, b.inconclusiveSettled);
    return bShare < aShare ? b : a;
  });
  const judged = judgedSettledCount(picked.settled, picked.inconclusiveSettled);
  return ` Lowest share among chains with ${minSettled} or more settled, over settled purchases that are not held: ${picked.label}, ${fmt(picked.delivered)} of ${fmt(judged)}.`;
}

/** Ledger units are 6-digit USD base units (spent_units / confirmed_units). */
export function unitsToAmount(units: string): string | null {
  if (!/^\d+$/.test(units)) return null;
  const s = units.padStart(7, "0");
  const whole = s.slice(0, -6).replace(/^0+(?=\d)/, "");
  const frac = s.slice(-6).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export function shortHash(tx: string): string {
  return tx.length > 14 ? `${tx.slice(0, 6)}…${tx.slice(-4)}` : tx;
}

function stamp(iso: string): { date: string; time: string } | null {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)/.exec(iso);
  return m ? { date: m[1], time: m[2] } : null;
}

/** "2026-10-22 00:02:27" from an ISO or Postgres timestamp. */
export function utc(iso: string | null | undefined, withSeconds = true): string {
  if (!iso) return "";
  const s = stamp(iso);
  if (!s) return iso;
  return `${s.date} ${withSeconds ? s.time : s.time.slice(0, 5)}`;
}

type ExportRow = {
  attempted_at?: string;
  resource_key?: string;
  network?: string;
  spent_units?: string;
  confirmed_units?: string;
  tx_hash?: string;
  http_status_paid?: string | null;
  payload_non_empty?: boolean | null;
  held_reason?: string | null;
  endpoint_id?: string | null;
  l2_schema?: string | null;
  l2_reading?: string | null;
  settlement_source?: string | null;
  id?: string;
};

/** Ledger column l2_schema, and the decision words mapped onto that column. */
const L2_LEDGER = new Set(["match", "mismatch", "no_declaration", "not_checked"]);

export function ledgerL2Word(status: string | null | undefined): string {
  if (status === "conform") return "match";
  if (status === "undeclared") return "no_declaration";
  if (status && L2_LEDGER.has(status)) return status;
  return "not_checked";
}

function payloadFlag(v: unknown): boolean | null {
  if (v === true || v === false) return v;
  if (v === "true" || v === "t") return true;
  if (v === "false" || v === "f") return false;
  return null;
}

export function formatSettledReceipt(
  row: ExportRow,
  window: { rows: number; settled: number; from: string; to: string },
): HomeReceipt | null {
  const at = typeof row.attempted_at === "string" ? stamp(row.attempted_at) : null;
  const key = typeof row.resource_key === "string" ? row.resource_key : "";
  const tx = typeof row.tx_hash === "string" ? row.tx_hash : "";
  const id = typeof row.id === "string" ? row.id : "";
  const amount = unitsToAmount(String(row.confirmed_units || row.spent_units || ""));
  if (!at || !key || !tx || !id || !amount) return null;
  const slash = key.indexOf("/");
  const host = slash === -1 ? key : key.slice(0, slash);
  const path = slash === -1 ? "/" : key.slice(slash);
  const network = typeof row.network === "string" ? row.network : "";
  const chain = paymentChainLabel(network);
  const httpRaw = row.http_status_paid == null ? "" : String(row.http_status_paid);
  const http = /^\d+$/.test(httpRaw) ? Number(httpRaw) : NaN;
  const httpStatus = Number.isInteger(http) && http > 0 ? http : null;
  const reading = typeof row.l2_reading === "string" && row.l2_reading !== "" ? row.l2_reading : "";
  const schema = typeof row.l2_schema === "string" && row.l2_schema !== "" ? row.l2_schema : "";
  const heldReason = typeof row.held_reason === "string" ? row.held_reason.trim() : "";
  const held = heldReason !== "";
  const delivered =
    !held &&
    isDelivered({ status: "settled", httpStatusPaid: httpStatus, payloadNonEmpty: payloadFlag(row.payload_non_empty) });
  return {
    attemptedAt: row.attempted_at as string,
    date: at.date,
    time: at.time,
    host,
    path,
    url: `https://${key}`,
    network,
    chain,
    asset: settlementAssetOf(chain),
    amount,
    httpStatus,
    delivered,
    held,
    endpointId: typeof row.endpoint_id === "string" ? row.endpoint_id : "",
    l2: ledgerL2Word(reading || schema),
    settlementSource: typeof row.settlement_source === "string" ? row.settlement_source : "",
    tx,
    txShort: shortHash(tx),
    txUrl: explorerTxUrl(network, tx),
    purchaseId: id,
    windowRows: window.rows,
    windowSettled: window.settled,
    windowFrom: window.from,
    windowTo: window.to,
  };
}

const EXCLUDED_SQL = PUBLIC_EXPORT_EXCLUDED_STATUSES.map((s) => `'${s}'`).join(", ");

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

async function loadLatestReceipt(): Promise<HomeReceipt | null> {
  const db = getDb();
  if (!db) return null;
  const windowWhere = () => sql`
    pu.attempted_at >= now() - make_interval(days => 1)
    AND pu.status NOT IN (${sql.raw(EXCLUDED_SQL)})
  `;
  const counts = rowsOf<{ window_rows: number; window_settled: number; window_from: string | null; window_to: string | null }>(
    await db.execute(sql`
      SELECT count(*)::int AS window_rows,
             count(*) FILTER (
               WHERE pu.status = 'settled'
                 AND pu.tx_hash IS NOT NULL AND pu.tx_hash <> ''
                 AND e.resource_key IS NOT NULL AND e.resource_key <> ''
             )::int AS window_settled,
             to_char(min(pu.attempted_at) AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS window_from,
             to_char(max(pu.attempted_at) AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS window_to
      FROM x402_l1_purchases pu
      JOIN x402_endpoints e ON e.id = pu.endpoint_id
      WHERE ${windowWhere()}
    `),
  );
  const count = counts[0];
  if (!count || Number(count.window_settled) < 1) return null;
  const latest = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      SELECT pu.id::text AS id,
             to_char(pu.attempted_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS attempted_at,
             e.resource_key,
             pu.network,
             pu.spent_units::text AS spent_units,
             pu.tx_hash,
             pu.endpoint_id::text AS endpoint_id,
             pu.http_status_paid::text AS http_status_paid,
             pu.payload_non_empty,
             (${sql.raw(heldReasonSql("pu"))}) AS held_reason,
             pu.l2_schema,
             (${sql.raw(settlementSourceSql("pu"))}) AS settlement_source,
             (${sql.raw(confirmedUnitsSql("pu"))}) AS confirmed_units,
             ${sql.raw(l2ReadingColumnsSql("pu"))},
             CASE WHEN pu.l2_schema = 'mismatch' THEN e.declared_schema END AS l2_declared_schema
      FROM x402_l1_purchases pu
      JOIN x402_endpoints e ON e.id = pu.endpoint_id
      WHERE ${windowWhere()}
        AND pu.status = 'settled'
        AND pu.tx_hash IS NOT NULL AND pu.tx_hash <> ''
        AND e.resource_key IS NOT NULL AND e.resource_key <> ''
      ORDER BY pu.attempted_at DESC, pu.id ASC
      LIMIT 1
    `),
  );
  const row = latest[0];
  if (!row) return null;
  const l2Schema = typeof row.l2_schema === "string" ? row.l2_schema : null;
  const l2Reading =
    l2Schema === null
      ? null
      : l2ReadingOf(
          {
            l2Schema,
            l2Detail: row.l2_detail,
            bodyHead: typeof row.l2_body_head === "string" ? row.l2_body_head : null,
            contentType: typeof row.l2_content_type === "string" ? row.l2_content_type : null,
          },
          row.l2_declared_schema ?? null,
        );
  return formatSettledReceipt(
    {
      attempted_at: str(row.attempted_at),
      resource_key: str(row.resource_key),
      network: str(row.network),
      spent_units: str(row.spent_units),
      confirmed_units: str(row.confirmed_units),
      tx_hash: str(row.tx_hash),
      http_status_paid: row.http_status_paid == null ? null : str(row.http_status_paid),
      payload_non_empty: payloadFlag(row.payload_non_empty),
      held_reason: row.held_reason == null ? null : str(row.held_reason),
      endpoint_id: str(row.endpoint_id),
      l2_schema: l2Schema,
      l2_reading: l2Reading,
      settlement_source: row.settlement_source == null ? null : str(row.settlement_source),
      id: str(row.id),
    },
    {
      rows: Number(count.window_rows),
      settled: Number(count.window_settled),
      from: str(count.window_from),
      to: str(count.window_to),
    },
  );
}

async function loadDecision(endpointId: string): Promise<HomeDecision | null> {
  if (!endpointId) return null;
  const loaded = await loadSellerFacts(endpointId);
  if (!loaded) return null;
  const l1 = loaded.facts.l1;
  if (![l1.n_attempts, l1.n_settled, l1.n_delivered].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const basis = l1BasisOf(loaded.facts, { l1Timeline: loaded.l1Timeline, l1NotCounted: loaded.l1NotCounted });
  return {
    method: loaded.endpoint.method ?? "",
    observatoryId: loaded.endpoint.id,
    l0: { status: loaded.facts.l0.status, observedAt: loaded.facts.l0.observed_at },
    l1: {
      attempts: l1.n_attempts,
      settled: l1.n_settled,
      delivered: l1.n_delivered,
      windowDays: basis.window_days,
    },
    l2: ledgerL2Word(loaded.facts.l2.status),
  };
}

/** Uncached read. A thrown decision read propagates, so the cache below does not store it. */
export async function readHomeExample(): Promise<HomeExample | null> {
  const receipt = await loadLatestReceipt();
  if (!receipt) return null;
  const decision = await loadDecision(receipt.endpointId);
  return { receipt, decision };
}

const readHomeExampleCached = unstable_cache(readHomeExample, ["home:example:v2"], {
  revalidate: PUBLIC_READ_REVALIDATE,
  tags: ["observatory"],
});

/** Same window as the other public HTML reads. A thrown read is not cached. This catch turns it into null. */
export async function getHomeExampleCached(): Promise<HomeExample | null> {
  try {
    return await readHomeExampleCached();
  } catch (error) {
    logServerErrorSafe("home_example_decision", error);
    return null;
  }
}
