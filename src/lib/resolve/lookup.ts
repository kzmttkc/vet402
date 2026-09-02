// ============================================================
// §7.3 逆引き（DB）。必須の4本:
//   payee → endpoints[]   endpoint → payees[]   domain → endpoints[]   tx → settlement + resource?
// 公開 ID は §5 の sha / chain:address。既存の uuid（/observatory/e/{uuid}）も受ける。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { canonicalUrl, payeeId as toPartyId, resourceId as toResourceId, SHA256_HEX_RE } from "@/lib/ids/canonical";
import { SOLANA_MAINNET_CAIP2 } from "@/lib/observatory/sol402-payer";
import { rowsOf } from "@/lib/settlements/upsert";
import { escapeLike } from "@/lib/util/like";
import { classifyQuery, type QueryKind } from "./classify";
import { UUID_RE } from "@/lib/validation/uuid";

export type EndpointRef = {
  endpoint_id: string;
  resource_id: string | null;
  observatory_id: string;
  canonical_url: string;
  method: string;
  payee_id: string | null;
  catalog_status: "listed" | "delisted" | "unknown";
  first_seen: string | null;
  last_seen: string | null;
};

export type SettlementRef = {
  purchase_id: string;
  chain: string;
  tx_hash: string;
  payer_id: string | null;
  payee_id: string | null;
  amount: string | null;
  asset: string | null;
  block_time: string | null;
  attribution: string;
  wash_flag: string;
  resource_id: string | null;
  endpoint_id: string | null;
};

export type ResolveResult = {
  query: { kind: QueryKind; value: string };
  resource?: EndpointRef;
  endpoints?: EndpointRef[];
  payees?: { payee_id: string; endpoints: number }[];
  settlement?: SettlementRef;
  disclaimer: string;
};

const DISCLAIMER =
  "Scores are opinions; L0–L2 are measurement records. This is not credit assessment, KYC, sanctions screening, or certification.";

const ENDPOINT_SELECT = sql`
  SELECT id::text AS observatory_id, endpoint_hash, resource_id, coalesce(canonical_url, resource_url) AS canonical_url,
         coalesce(method, 'GET') AS method, payee_id, status, first_seen_at::text AS first_seen, last_seen_at::text AS last_seen
  FROM x402_endpoints`;

type EndpointRow = {
  observatory_id: string;
  endpoint_hash: string | null;
  resource_id: string | null;
  canonical_url: string;
  method: string;
  payee_id: string | null;
  status: string;
  first_seen: string | null;
  last_seen: string | null;
};

function toRef(r: EndpointRow): EndpointRef {
  return {
    endpoint_id: r.endpoint_hash ?? r.observatory_id,
    resource_id: r.resource_id,
    observatory_id: r.observatory_id,
    canonical_url: r.canonical_url,
    method: r.method,
    payee_id: r.payee_id,
    catalog_status: r.status === "active" ? "listed" : r.status === "delisted" ? "delisted" : "unknown",
    first_seen: r.first_seen,
    last_seen: r.last_seen,
  };
}

/** endpoint_hash（64hex）または uuid のどちらでも引ける。 */
function endpointWhere(ref: string) {
  if (UUID_RE.test(ref)) return sql`id = ${ref}::uuid`;
  if (SHA256_HEX_RE.test(ref)) return sql`endpoint_hash = ${ref}`;
  return null;
}

export async function getEndpoint(ref: string): Promise<EndpointRef | null> {
  const db = getDb();
  if (!db) return null;
  const where = endpointWhere(ref);
  if (!where) return null;
  const rows = rowsOf<EndpointRow>(await db.execute(sql`${ENDPOINT_SELECT} WHERE ${where} ORDER BY status = 'active' DESC, last_seen_at DESC NULLS LAST LIMIT 1`));
  return rows[0] ? toRef(rows[0]) : null;
}

export async function getResource(resourceIdHex: string): Promise<EndpointRef | null> {
  const db = getDb();
  if (!db || !SHA256_HEX_RE.test(resourceIdHex)) return null;
  const rows = rowsOf<EndpointRow>(await db.execute(sql`${ENDPOINT_SELECT} WHERE resource_id = ${resourceIdHex} ORDER BY status = 'active' DESC LIMIT 1`));
  return rows[0] ? toRef(rows[0]) : null;
}

export async function endpointsByPayee(payeeIdStr: string, limit = 200): Promise<EndpointRef[]> {
  const db = getDb();
  if (!db) return [];
  const rows = rowsOf<EndpointRow>(
    await db.execute(sql`${ENDPOINT_SELECT} WHERE payee_id = ${payeeIdStr} ORDER BY status = 'active' DESC, last_seen_at DESC NULLS LAST LIMIT ${Math.min(Math.max(limit, 1), 500)}`),
  );
  return rows.map(toRef);
}

/**
 * resource_key（host+path、小文字）に対する LIKE パターン: 同ホスト配下のパス・
 * サブドメイン配下のパス・サブドメインそのもの。host 内の `_` `%` `\` はリテラル
 * （2026-09-02 監査: 未エスケープで `a_b.example` が `axb.example` に一致していた）。
 */
export function domainLikePatterns(domain: string): [string, string, string] {
  const host = escapeLike(domain.toLowerCase());
  return [`${host}/%`, `%.${host}/%`, `%.${host}`];
}

export async function endpointsByDomain(domain: string, limit = 200): Promise<EndpointRef[]> {
  const db = getDb();
  if (!db) return [];
  const host = domain.toLowerCase();
  const [underHost, underSub, subOnly] = domainLikePatterns(domain);
  const rows = rowsOf<EndpointRow>(
    await db.execute(sql`${ENDPOINT_SELECT} WHERE resource_key = ${host} OR resource_key LIKE ${underHost} OR resource_key LIKE ${underSub} OR resource_key LIKE ${subOnly}
      ORDER BY status = 'active' DESC, last_seen_at DESC NULLS LAST LIMIT ${Math.min(Math.max(limit, 1), 500)}`),
  );
  return rows.map(toRef);
}

/** endpoint（sha か uuid）に紐づく payee。同じ endpoint_hash 配下の全 resource の payee_id を集める。 */
export async function payeesByEndpoint(ref: string): Promise<{ payee_id: string; endpoints: number }[]> {
  const db = getDb();
  if (!db) return [];
  const where = endpointWhere(ref);
  if (!where) return [];
  const rows = rowsOf<{ payee_id: string; n: number }>(
    await db.execute(sql`
      SELECT payee_id, count(*)::int AS n FROM x402_endpoints
      WHERE payee_id IS NOT NULL AND (
        ${where} OR endpoint_hash = (SELECT endpoint_hash FROM x402_endpoints WHERE ${where} LIMIT 1)
      )
      GROUP BY payee_id ORDER BY n DESC LIMIT 100
    `),
  );
  return rows.map((r) => ({ payee_id: r.payee_id, endpoints: Number(r.n) }));
}

export async function settlementByTx(txHash: string): Promise<SettlementRef | null> {
  const db = getDb();
  if (!db) return null;
  const rows = rowsOf<SettlementRef & { endpoint_id: string | null }>(
    await db.execute(sql`
      SELECT purchase_id, chain, tx_hash, payer_id, payee_id, amount, asset, block_time::text AS block_time,
             attribution, wash_flag, resource_id, endpoint_id::text AS endpoint_id
      FROM settlements WHERE tx_hash = ${txHash} OR lower(tx_hash) = ${txHash.toLowerCase()} LIMIT 1
    `),
  );
  return rows[0] ?? null;
}

export async function resolve(q: string): Promise<ResolveResult> {
  const query = classifyQuery(q);
  const out: ResolveResult = { query, disclaimer: DISCLAIMER };
  switch (query.kind) {
    case "url": {
      const c = canonicalUrl(query.value);
      if (!c) return out;
      // method は不明なので GET → POST の順に引く（§6.1 の既定に合わせる）
      const byGet = await getResource(toResourceId("GET", c.url));
      const hit = byGet ?? (await getResource(toResourceId("POST", c.url)));
      if (hit) out.resource = hit;
      const host = new URL(c.url).hostname;
      out.endpoints = await endpointsByDomain(host, 50);
      return out;
    }
    case "domain": {
      out.endpoints = await endpointsByDomain(query.value);
      return out;
    }
    case "address": {
      const ids = query.value.startsWith("0x")
        ? [toPartyId("eip155:8453", query.value), toPartyId("eip155:137", query.value)]
        : [toPartyId(SOLANA_MAINNET_CAIP2, query.value)];
      const lists = await Promise.all(ids.map((id) => endpointsByPayee(id)));
      out.endpoints = lists.flat();
      out.payees = ids.map((id, i) => ({ payee_id: id, endpoints: lists[i].length })).filter((p) => p.endpoints > 0);
      return out;
    }
    case "payee_id": {
      out.endpoints = await endpointsByPayee(query.value);
      out.payees = [{ payee_id: query.value, endpoints: out.endpoints.length }];
      return out;
    }
    case "tx": {
      const s = await settlementByTx(query.value);
      if (s) {
        out.settlement = s;
        if (s.endpoint_id) out.resource = (await getEndpoint(s.endpoint_id)) ?? undefined;
      }
      return out;
    }
    default:
      return out;
  }
}
