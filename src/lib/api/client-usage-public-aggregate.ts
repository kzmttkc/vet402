import { SELF_MONITOR_CLIENT } from "@/lib/api/client-usage";

export type PublicApiUsageDay = {
  day: string;
  /** GET /api/v1/resources/{id}/decision の鍵なしの 200。 */
  decision: number;
  /** GET /api/v1/check（MCP の check_x402_seller と同じ判定の REST 版）。decision とは別の入口なので別に数える。 */
  check: number;
  resolve: number;
  mcp: number;
  sdk: number;
  otherRoutes: number;
};

export function isExcludedPublicClient(client: string): boolean {
  if (client === SELF_MONITOR_CLIENT) return true;
  if (client.startsWith("vet402-observatory-")) return true;
  if (client.startsWith("kizuna-")) return true;
  return false;
}

const MCP_CLIENT_PREFIX = "vet402-mcp/";
const SDK_CLIENT_PREFIX = "vet402-sdk/";

export function routeBucket(
  route: string,
): keyof Pick<PublicApiUsageDay, "decision" | "check" | "resolve" | "mcp" | "otherRoutes"> {
  if (route === "decision") return "decision";
  if (route === "rest:check") return "check";
  if (route === "resolve") return "resolve";
  if (route.startsWith("mcp:")) return "mcp";
  return "otherRoutes";
}

export function emptyPublicUsageDay(day: string): PublicApiUsageDay {
  return { day, decision: 0, check: 0, resolve: 0, mcp: 0, sdk: 0, otherRoutes: 0 };
}

/** 1 行を日次スロットへ足す。MCP は vet402-mcp/<版> の client 行だけ。 */
export function addPublicClientUsageRow(
  slot: PublicApiUsageDay,
  client: string,
  route: string,
  count: number,
): PublicApiUsageDay {
  if (isExcludedPublicClient(client)) return slot;
  const n = Number(count) || 0;
  if (n <= 0) return slot;
  const next = { ...slot };
  if (client.startsWith(SDK_CLIENT_PREFIX)) {
    next.sdk += n;
    return next;
  }
  if (client.startsWith(MCP_CLIENT_PREFIX)) {
    next.mcp += n;
    return next;
  }
  const bucket = routeBucket(route);
  if (bucket === "mcp") {
    next.otherRoutes += n;
    return next;
  }
  next[bucket] += n;
  return next;
}

/**
 * 週ごとの外からの呼び出し（2026-11-27・申請文の基準を公開の口で再現できるように）。
 * 数えないもの: vet402 自身の監視と観測所（isExcludedPublicClient）、自サイト（client=site）、
 * crawler（client=crawler か、client に bot・crawl・spider・slurp を含む）、道具を呼ばない MCP の接続（route=mcp:initialize）。
 * 週は UTC の月曜始まり。
 */
export type PublicApiUsageWeek = { weekStart: string; externalCalls: number };

const CRAWLER_RE = /bot|crawl|spider|slurp/i;

export function isExternalUsageRow(client: string, route: string): boolean {
  if (isExcludedPublicClient(client)) return false;
  if (client === "site" || client === "crawler" || CRAWLER_RE.test(client)) return false;
  if (route === "mcp:initialize") return false;
  return true;
}

export function utcWeekStart(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * 86_400_000).toISOString().slice(0, 10);
}

/**
 * 行から週ごとの外からの呼び出しを足し上げる。windowStart より前に始まる週は途中からの合計になるので出さない。
 */
export function weeklyExternalFromRows(
  rows: readonly { day: string; client: string; route: string; count: number }[],
  windowStart: string,
): PublicApiUsageWeek[] {
  const byWeek = new Map<string, number>();
  for (const r of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.day)) continue;
    if (!isExternalUsageRow(r.client, r.route)) continue;
    const w = utcWeekStart(r.day);
    if (w < windowStart) continue;
    byWeek.set(w, (byWeek.get(w) ?? 0) + (Number(r.count) || 0));
  }
  return [...byWeek.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([weekStart, externalCalls]) => ({ weekStart, externalCalls }));
}
