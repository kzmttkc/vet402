// 自社購入（L1 プローブ）とは別系列として、鍵なし API と SDK と MCP の呼び出し件数を日付付きで公開する。
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import {
  addPublicClientUsageRow,
  emptyPublicUsageDay,
  isExcludedPublicClient,
  type PublicApiUsageDay,
} from "@/lib/api/client-usage-public-aggregate";

export type { PublicApiUsageDay } from "@/lib/api/client-usage-public-aggregate";
export { isExcludedPublicClient, addPublicClientUsageRow, routeBucket, emptyPublicUsageDay } from "@/lib/api/client-usage-public-aggregate";

export type PublicApiUsage = {
  retrievedAt: string;
  byDay: PublicApiUsageDay[];
  note: string;
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const PUBLIC_API_USAGE_NOTE =
  "Call counts per UTC day from client_usage_daily, for calls made without an API key. Rows from vet402's own monitors and observatory clients are left out. decision counts GET /api/v1/resources/{id}/decision. check counts GET /api/v1/check, a separate entry point, so it is not part of decision. sdk counts every route called by a client that names itself vet402-sdk/<semver>, and those calls are not counted again under decision or check. mcp counts rows whose client is vet402-mcp/<semver>. mcp:* routes from any other client are counted in otherRoutes. Current SDK and MCP releases may not send that User-Agent and then appear as other. These counts are not added to l1.attempts.";

export async function readPublicClientUsage(now: Date = new Date()): Promise<PublicApiUsage> {
  const retrievedAt = now.toISOString();
  const note = PUBLIC_API_USAGE_NOTE;
  const db = getDb();
  if (!db) {
    return { retrievedAt, byDay: [], note };
  }

  const windowStart = new Date(now.getTime() - 90 * 86_400_000).toISOString().slice(0, 10);
  const raw = await db.execute(sql`
    SELECT day::text AS day, client, route, count::int AS count
    FROM client_usage_daily
    WHERE day >= ${windowStart}::date
    ORDER BY day ASC, route ASC, client ASC
  `);
  const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as {
    day: string;
    client: string;
    route: string;
    count: number;
  }[];

  const byDay = new Map<string, PublicApiUsageDay>();
  for (const row of rows) {
    const day = String(row.day);
    if (!DAY_RE.test(day)) continue;
    const client = String(row.client);
    if (isExcludedPublicClient(client)) continue;
    const slot = byDay.get(day) ?? emptyPublicUsageDay(day);
    byDay.set(day, addPublicClientUsageRow(slot, client, String(row.route), Number(row.count) || 0));
  }

  return {
    retrievedAt,
    byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    note,
  };
}
