// ============================================================
// §7.2 Solana 決済索引の受取人の出どころ（2026-09-15）。
//
// 索引が見る Solana の受取人は、これまで x402_endpoints の network / pay_to（各リソースの
// **先頭の accept** だけ）だった。2 つの取りこぼしがあった（公開データで実測）:
//   - Base が先頭で Solana が 2 番目のリソースは落ちる。Bazaar の Solana 受取人: 先頭だけ 33 / 全 accept 220
//   - PayAI facilitator の公開 discovery を取り込んでいない。PayAI の Solana 受取人 278・Bazaar と重なり 30
//
// ここでは**索引の対象の受取人**だけを増やす。カタログ（公開の総数・L0 の疎通・L1 の購入候補）には
// 入れない——L1 は実資金が動く経路で、候補を増やす判断は別に要る。
// 取り込んだ受取人への決済は、カタログの封筒と照合できなければ attribution=unmatched のまま数える。
// ============================================================
import { sql } from "drizzle-orm";
import { PublicKey } from "@solana/web3.js";
import { getDb } from "@/lib/db/client";
import { isMissingSchemaError } from "@/lib/db/pg-errors";
import { fetchFullCatalog } from "@/lib/observatory/catalog-source";
import { toCaip2 } from "@/lib/observatory/chains";
import { SOLANA_MAINNET_CAIP2 } from "@/lib/observatory/sol402-payer";
import { logServerError } from "@/lib/util/log";

export const PAYAI_DISCOVERY_URL = "https://facilitator.payai.network/discovery/resources";
export const DISCOVERY_PAYEE_SOURCE_PAYAI = "payai_facilitator";
/** 索引の受取人として使う鮮度。discovery から消えた受取人も、この日数は索引を続ける。 */
export const DISCOVERY_PAYEE_FRESH_DAYS = 14;
const UPSERT_CHUNK = 500;

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

function isSolanaPubkey(value: string): boolean {
  if (value.startsWith("0x")) return false;
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

/** discovery の生 items から、全 accept の Solana メインネットの受取人を重複なしで抜く。純関数。 */
export function extractSolanaPayTos(items: readonly unknown[]): string[] {
  const out = new Set<string>();
  for (const item of items) {
    const accepts = asRecord(item)?.accepts;
    if (!Array.isArray(accepts)) continue;
    for (const raw of accepts) {
      const a = asRecord(raw);
      if (!a || toCaip2(a.network) !== SOLANA_MAINNET_CAIP2) continue;
      const payTo = typeof a.payTo === "string" ? a.payTo : typeof a.recipient === "string" ? a.recipient : null;
      if (payTo && isSolanaPubkey(payTo)) out.add(payTo);
    }
  }
  return [...out];
}

export type DiscoveryPayeeRow = { chain: string; payTo: string; source: string };

export type DiscoveryRefreshDeps = {
  source: string;
  fetchRawItems: () => Promise<{ items: readonly unknown[]; complete: boolean; totalCount: number }>;
  upsert: (rows: DiscoveryPayeeRow[]) => Promise<number>;
};

export type DiscoveryRefreshSummary = {
  source: string;
  payees: number;
  complete: boolean;
  totalCount: number;
  skipped?: "table_missing";
  error?: string;
};

/** 取れた分だけ入れる。受取人は消さない（鮮度は last_seen_at で読む側が決める）。 */
export async function refreshDiscoveryPayees(deps: DiscoveryRefreshDeps): Promise<DiscoveryRefreshSummary> {
  const base: DiscoveryRefreshSummary = { source: deps.source, payees: 0, complete: false, totalCount: 0 };
  let fetched: { items: readonly unknown[]; complete: boolean; totalCount: number };
  try {
    fetched = await deps.fetchRawItems();
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }
  const payTos = extractSolanaPayTos(fetched.items);
  const rows = payTos.map((payTo) => ({ chain: SOLANA_MAINNET_CAIP2, payTo, source: deps.source }));
  const n = rows.length > 0 ? await deps.upsert(rows) : 0;
  return { ...base, payees: n, complete: fetched.complete, totalCount: fetched.totalCount };
}

/** 受取人を入れる。既にあれば last_seen_at だけ進める。1 文あたり 500 行（パラメータ上限の内側）。 */
export async function upsertDiscoveryPayees(
  db: NonNullable<ReturnType<typeof getDb>>,
  rows: readonly DiscoveryPayeeRow[],
): Promise<number> {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    const values = sql.join(
      chunk.map((r) => sql`(${r.chain}, ${r.payTo}, ${r.source}, now(), now())`),
      sql`, `,
    );
    await db.execute(sql`
      INSERT INTO x402_discovery_payees (chain, pay_to, source, first_seen_at, last_seen_at)
      VALUES ${values}
      ON CONFLICT (chain, pay_to, source) DO UPDATE SET last_seen_at = now()
    `);
  }
  return rows.length;
}

/** 本番配線: PayAI の公開 discovery → x402_discovery_payees。表が未作成なら何もしない。 */
export async function refreshSolanaDiscoveryPayees(): Promise<DiscoveryRefreshSummary> {
  const db = getDb();
  if (!db) throw new Error("refreshSolanaDiscoveryPayees: DATABASE_URL is not configured");
  try {
    return await refreshDiscoveryPayees({
      source: DISCOVERY_PAYEE_SOURCE_PAYAI,
      async fetchRawItems() {
        // PayAI は 1 ページ 1000 件を返す（2026-09-15 実測: 28,655 件を 29 ページ・約 60 秒）。
        const r = await fetchFullCatalog({ baseUrl: PAYAI_DISCOVERY_URL, pageLimit: 1000, sleepMs: 150 });
        return { items: r.items.map((i) => ({ accepts: i.rawAccepts })), complete: r.complete, totalCount: r.totalCount };
      },
      upsert: (rows) => upsertDiscoveryPayees(db, rows),
    });
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return { source: DISCOVERY_PAYEE_SOURCE_PAYAI, payees: 0, complete: false, totalCount: 0, skipped: "table_missing" };
    }
    logServerError("settlements.discovery-payees", error);
    throw error;
  }
}
