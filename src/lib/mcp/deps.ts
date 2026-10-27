// ============================================================
// MCP の route が使う読み手（2026-10-28）。
//
// ① は decide の既存の 5 分の LRU（src/lib/decision/cache.ts）のまま。
// ③ は /sellers/[host] と同じ cached の読み手（unstable_cache・PUBLIC_READ_REVALIDATE = 300 秒）と、
//   ホストの出品・購入を同じ窓でキャッシュした読み手。返す as_of は DB を読んだ時刻（fetchedAt）。
// unstable_cache は tsx のテストの中で動かないので、pg テストは reads.ts と sellers/reader.ts を直接渡す。
// ============================================================
import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db/client";
import { decide } from "@/lib/decision/decide";
import { resolve } from "@/lib/resolve/lookup";
import { PUBLIC_READ_REVALIDATE } from "@/lib/observatory/public-read-revalidate";
import {
  getPurchasedHostsCached,
  getSellerBoardCached,
  getSellerDetailCached,
  getSellerOtherChainsCached,
} from "@/lib/sellers/cached";
import { readFindSellers, readHostExtras, readL1Purchases, type HostExtras } from "./reads";
import type { McpDeps } from "./tools";

class McpDbUnavailable extends Error {}

function db() {
  const d = getDb();
  if (!d) throw new McpDbUnavailable("database not configured");
  return d;
}

const getHostExtrasCached: (host: string) => Promise<HostExtras> = unstable_cache(
  async (host: string) => readHostExtras(db(), host),
  ["mcp:host-extras:v1"],
  { revalidate: PUBLIC_READ_REVALIDATE, tags: ["observatory"] },
);

export function productionMcpDeps(): McpDeps {
  return {
    // DB が無いときに「カタログに無い」と答えない（resolve は DB が無いと空を返す）。読めないなら 503 にする。
    resolve: (q, opts) => {
      db();
      return resolve(q, opts);
    },
    decide,
    l1Purchases: (id) => readL1Purchases(db(), id),
    sellerPage: {
      board: getSellerBoardCached,
      detail: getSellerDetailCached,
      purchasedHosts: getPurchasedHostsCached,
      otherChains: getSellerOtherChainsCached,
    },
    hostExtras: getHostExtrasCached,
    findSellers: (like, limit) => readFindSellers(db(), like, limit),
  };
}

/** テスト用の差し替え口（pg テストが reader を直接渡す）。null で本番の読み手に戻る。 */
let override: McpDeps | null = null;
export function setMcpDepsForTest(deps: McpDeps | null): void {
  override = deps;
}

/** route が要求ごとに読む。 */
export function mcpDeps(): McpDeps {
  return override ?? productionMcpDeps();
}
