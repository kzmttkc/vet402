// ============================================================
// 経路 2: POST /payments/x402 で所有証明済み（ownership_verified）かつ
// オンチェーンで USDC の受取が読めた行（§7.2）。
//   resource が宣言されていれば resource_id で Endpoint に落とし、封筒
//   （カタログの payTo / amount / asset / network）と突き合わせて confirmed / probable。
//   宣言が無ければ payee_id から Endpoint を逆引きし、1 件に定まれば probable、
//   複数なら Endpoint 未定の probable、無ければ unmatched。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { resourceId as toResourceId, payeeId as toPartyId } from "@/lib/ids/canonical";
import { toCaip2 } from "@/lib/observatory/chains";
import { BASE_USDC } from "@/lib/observatory/x402-payer";
import { attribute } from "./attribution";
import { loadWashClassifier, type WashClassifier } from "./context";
import { buildRow, rowsOf, upsertSettlement } from "./upsert";
import type { Attribution } from "./types";

type PaymentRow = {
  id: string;
  wallet: string;
  tx_hash: string;
  network: string;
  resource: string | null;
  payee: string | null;
  onchain_amount: string;
  token: string | null;
  block_timestamp: string | null;
};

type EndpointRow = {
  id: string;
  resource_id: string | null;
  pay_to: string | null;
  price_amount: string | null;
  price_asset: string | null;
  network: string | null;
};

export async function resolveEndpointForSettlement(
  db: NonNullable<ReturnType<typeof getDb>>,
  input: { chain: string; payee: string | null; amount: string | null; asset: string | null; blockTime: Date | null; resourceUrl: string | null },
): Promise<{ attribution: Attribution; resourceId: string | null; endpointId: string | null }> {
  if (input.resourceUrl) {
    const rid = toResourceId("GET", input.resourceUrl);
    const byResource = rowsOf<EndpointRow>(
      await db.execute(sql`
        SELECT id::text AS id, resource_id, pay_to, price_amount, price_asset, network
        FROM x402_endpoints WHERE resource_id = ${rid} OR resource_url = ${input.resourceUrl}
        ORDER BY (resource_id = ${rid}) DESC LIMIT 1
      `),
    );
    const e = byResource[0];
    if (e) {
      const a = attribute(
        { payee: input.payee, amount: input.amount, asset: input.asset, chain: input.chain, blockTime: input.blockTime },
        { payTo: e.pay_to, amount: e.price_amount, asset: e.price_asset, network: e.network, observedAt: input.blockTime },
      );
      if (a !== "unmatched") return { attribution: a, resourceId: e.resource_id ?? rid, endpointId: e.id };
    }
  }
  if (!input.payee) return { attribution: "unmatched", resourceId: null, endpointId: null };
  const pid = toPartyId(input.chain, input.payee);
  const byPayee = rowsOf<EndpointRow>(
    await db.execute(sql`
      SELECT id::text AS id, resource_id, pay_to, price_amount, price_asset, network
      FROM x402_endpoints WHERE payee_id = ${pid} AND status = 'active' LIMIT 2
    `),
  );
  if (byPayee.length === 1) {
    const e = byPayee[0];
    const a = attribute(
      { payee: input.payee, amount: input.amount, asset: input.asset, chain: input.chain, blockTime: input.blockTime },
      { payTo: e.pay_to, amount: e.price_amount, asset: e.price_asset, network: e.network, observedAt: input.blockTime },
    );
    return { attribution: a === "unmatched" ? "probable" : a, resourceId: e.resource_id, endpointId: e.id };
  }
  if (byPayee.length > 1) return { attribution: "probable", resourceId: null, endpointId: null };
  return { attribution: "unmatched", resourceId: null, endpointId: null };
}

export async function ingestPayments(options: { limit?: number; sinceDays?: number; classifier?: WashClassifier } = {}) {
  const db = getDb();
  if (!db) throw new Error("ingestPayments: DATABASE_URL is not configured");
  const { limit = 2000, sinceDays = 45 } = options;
  const classifier = options.classifier ?? (await loadWashClassifier());
  const rows = rowsOf<PaymentRow>(
    await db.execute(sql`
      SELECT id::text AS id, wallet, tx_hash, network, resource, payee, onchain_amount, token,
             block_timestamp::text AS block_timestamp
      FROM x402_payments
      WHERE ownership_verified = true AND onchain_amount IS NOT NULL AND payee IS NOT NULL
        AND lower(token) = ${BASE_USDC.toLowerCase()}
        AND coalesce(block_timestamp, created_at) > now() - make_interval(days => ${sinceDays})
      ORDER BY coalesce(block_timestamp, created_at) DESC
      LIMIT ${limit}
    `),
  );
  let inserted = 0;
  let updated = 0;
  const attribution = { confirmed: 0, probable: 0, unmatched: 0 };
  for (const r of rows) {
    const chain = toCaip2(r.network) ?? "eip155:8453";
    const blockTime = r.block_timestamp ? new Date(r.block_timestamp) : null;
    const resolved = await resolveEndpointForSettlement(db, {
      chain,
      payee: r.payee,
      amount: r.onchain_amount,
      asset: r.token,
      blockTime,
      resourceUrl: r.resource,
    });
    attribution[resolved.attribution]++;
    const payerId = toPartyId(chain, r.wallet);
    const payeeId = r.payee ? toPartyId(chain, r.payee) : null;
    const washFlag = await classifier.classify({ payerId, payeeId, blockTime });
    const row = buildRow(
      {
        chain,
        txHash: r.tx_hash,
        asset: r.token,
        amount: r.onchain_amount,
        payer: r.wallet,
        payee: r.payee,
        blockTime,
        source: "payments_api",
        raw: { paymentRowId: r.id, resource: r.resource },
      },
      { attribution: resolved.attribution, washFlag, resourceId: resolved.resourceId, endpointId: resolved.endpointId },
    );
    const outcome = await upsertSettlement(row);
    if (outcome === "inserted") inserted++;
    else updated++;
  }
  return { scanned: rows.length, inserted, updated, attribution };
}
