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
