// ============================================================
// vet402 EVM レーン（vet402-solana / vet402-delivery）の公開購入記録を
// Observatory L1 台帳（x402_l1_purchases）へ写す（2026-11-10・#20 Robinhood）。
//
// 購入の実行は vet402-solana の EVM レーン。正本は vet402-delivery の
//   data/evm/roots/<lane>.json
// の vet402-evm-purchase 葉。vouch の L1 ランナーは Base ほかのレーン用で、
// Robinhood（eip155:4663）はここで取り込む。
//
// 冪等: (network, lower(tx_hash)) の一意制約。tx が無い行は endpoint と時刻で
// 重複を避ける（11/08 の unconfirmed 1 件）。
// ============================================================
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { canonicalUrl, endpointHash, payeeId, resourceId } from "@/lib/ids/canonical";
import { x402Endpoints, x402L1Purchases } from "@/lib/db/schema";
import { normalizeResourceKey } from "./catalog-source";
import { chainLabel, toCaip2 } from "./chains";

/** vet402-delivery の data/evm/roots/robinhood.json と同じ kind。 */
export const EVM_LANE_ROOTS_KIND = "vet402-evm-roots";

/** x402_endpoints.source — カタログ同期の対象外（seller_retest_request と同型）。 */
export const EVM_LANE_ENDPOINT_SOURCE = "vet402_evm_lane";

export const ROBINHOOD_CAIP2 = "eip155:4663";
/** Robinhood Chain 上の USDG（公開購入記録の asset）。 */
export const ROBINHOOD_USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

export type EvmLaneVerdict = {
  status?: string;
  cause?: string;
  rule?: string;
};

export type EvmLanePurchaseRecord = {
  kind: "vet402-evm-purchase";
  version: number;
  lane: string;
  chain: string;
  agentId?: string;
  at: string;
  method: string;
  resource: string;
  payer: string;
  payTo: string;
  asset: string;
  amountAtomic: string;
  chainCheck?: string;
  settlementTx: string | null;
  httpStatus?: number;
  responseBytes?: number;
  bodyHash?: string;
  salt?: string;
};

export type EvmLaneRootLeaf = {
  record?: EvmLanePurchaseRecord | null;
  verdict?: EvmLaneVerdict | null;
  digest?: string;
};

export type EvmLaneRootsFile = {
  kind: string;
  lane: string;
  chain: string;
  days: { day: string; leaves: EvmLaneRootLeaf[] }[];
};

export type EvmLanePublicCounts = {
  /** 葉に record がある件数（公開 root の購入行）。 */
  published: number;
  /** verdict.status === delivered。 */
  delivered: number;
  /** delivered かつ settlementTx あり（L1 settled）。 */
  settled: number;
};

/** 公開 roots JSON を読み、購入 record だけ返す（無い葉は捨てる）。 */
export function evmLanePurchaseRecords(roots: EvmLaneRootsFile): EvmLanePurchaseRecord[] {
  if (roots.kind !== EVM_LANE_ROOTS_KIND) {
    throw new Error(`evm-lane-ingest: unexpected kind ${JSON.stringify(roots.kind)}`);
  }
  const out: EvmLanePurchaseRecord[] = [];
  for (const day of roots.days ?? []) {
    for (const leaf of day.leaves ?? []) {
      const rec = leaf.record;
      if (rec && rec.kind === "vet402-evm-purchase") out.push(rec);
    }
  }
  return out;
}

/** vet402-delivery の公開集計と突き合わせる件数（試験の期待値）。 */
export function evmLanePublicCounts(roots: EvmLaneRootsFile, leaves: readonly EvmLaneRootLeaf[]): EvmLanePublicCounts {
  let published = 0;
  let delivered = 0;
  let settled = 0;
  for (const leaf of leaves) {
    const rec = leaf.record;
    if (!rec) continue;
    published++;
    const st = leaf.verdict?.status;
    if (st === "delivered") {
      delivered++;
      if (rec.settlementTx) settled++;
    }
  }
  return { published, delivered, settled };
}

export function evmLanePublicCountsFromRoots(roots: EvmLaneRootsFile): EvmLanePublicCounts {
  const leaves = roots.days.flatMap((d) => d.leaves ?? []);
  return evmLanePublicCounts(roots, leaves);
}

function purchaseStatus(rec: EvmLanePurchaseRecord, verdict: EvmLaneVerdict | null | undefined): string {
  if (verdict?.status === "delivered" && rec.settlementTx) return "settled";
  if (rec.settlementTx) return "settled";
  return "settle_failed";
}

function deliveredFlags(status: string, httpStatus: number | undefined): { http: number | null; payload: boolean } {
  if (status !== "settled") return { http: httpStatus ?? null, payload: false };
  const ok = httpStatus !== undefined && httpStatus >= 200 && httpStatus < 300;
  return { http: httpStatus ?? null, payload: ok };
}

export type EvmLaneIngestRow = {
  record: EvmLanePurchaseRecord;
  verdict: EvmLaneVerdict | null;
  status: string;
};

export function mapEvmLaneIngestRows(roots: EvmLaneRootsFile): EvmLaneIngestRow[] {
  const rows: EvmLaneIngestRow[] = [];
  for (const day of roots.days ?? []) {
    for (const leaf of day.leaves ?? []) {
      const rec = leaf.record;
      if (!rec) continue;
      rows.push({ record: rec, verdict: leaf.verdict ?? null, status: purchaseStatus(rec, leaf.verdict) });
    }
  }
  return rows;
}

export function loadEvmLaneRootsJson(path: string): EvmLaneRootsFile {
  return JSON.parse(readFileSync(path, "utf8")) as EvmLaneRootsFile;
}

export type EvmLaneIngestResult = {
  scanned: number;
  inserted: number;
  skipped: number;
};

export async function ingestEvmLaneRobinhood(
  db: NonNullable<ReturnType<typeof import("@/lib/db/client").getDb>>,
  roots: EvmLaneRootsFile,
): Promise<EvmLaneIngestResult> {
  if (roots.lane !== "robinhood" || toCaip2(roots.chain) !== ROBINHOOD_CAIP2) {
    throw new Error(`evm-lane-ingest: roots lane/chain mismatch (lane=${roots.lane} chain=${roots.chain})`);
  }
  const rows = mapEvmLaneIngestRows(roots);
  let inserted = 0;
  let skipped = 0;

  for (const { record: rec, verdict, status } of rows) {
    const network = toCaip2(rec.chain) ?? ROBINHOOD_CAIP2;
    const resourceUrl = rec.resource;
    const method = rec.method === "POST" ? "POST" : "GET";
    const resourceKey = normalizeResourceKey(resourceUrl);
    const ids = canonicalUrl(resourceUrl);
    const rid = resourceId(method, resourceUrl);
    const ehash = endpointHash(resourceUrl);
    const pid = payeeId(network, rec.payTo);
    const accepts = [
      {
        scheme: "exact",
        network,
        amount: rec.amountAtomic,
        asset: rec.asset,
        payTo: rec.payTo,
      },
    ];

    const ep = await db
      .insert(x402Endpoints)
      .values({
        resourceKey,
        resourceUrl,
        source: EVM_LANE_ENDPOINT_SOURCE,
        method,
        network,
        payTo: rec.payTo,
        priceAmount: rec.amountAtomic,
        priceAsset: rec.asset,
        rawAccepts: accepts,
        status: "active",
        delistedAt: null,
        canonicalUrl: ids?.url ?? null,
        resourceId: rid,
        endpointHash: ehash,
        payeeId: pid,
      })
      .onConflictDoUpdate({
        target: [x402Endpoints.resourceKey, x402Endpoints.source],
        set: {
          resourceUrl,
          method,
          network,
          payTo: rec.payTo,
          priceAmount: rec.amountAtomic,
          priceAsset: rec.asset,
          rawAccepts: accepts,
          status: "active",
          delistedAt: null,
          lastSeenAt: sql`now()`,
          canonicalUrl: ids?.url ?? null,
          resourceId: rid,
          endpointHash: ehash,
          payeeId: pid,
        },
      })
      .returning();

    const endpointId = ep[0]?.id;
    if (!endpointId) throw new Error("evm-lane-ingest: endpoint insert returned no id");

    const { http, payload } = deliveredFlags(status, rec.httpStatus);
    const spent = status === "settled" ? rec.amountAtomic : "0";
    const tx = rec.settlementTx;
    const dedupeKey =
      tx ??
      createHash("sha256")
        .update(`${network}\n${resourceKey}\n${rec.at}\n${rec.payTo}`)
        .digest("hex");

    const existing = tx
      ? await db.execute(sql`
          SELECT id::text FROM x402_l1_purchases
          WHERE network = ${network} AND lower(tx_hash) = lower(${tx})
          LIMIT 1
        `)
      : await db.execute(sql`
          SELECT id::text FROM x402_l1_purchases
          WHERE network = ${network} AND endpoint_id = ${endpointId}::uuid
            AND attempted_at = ${rec.at}::timestamptz AND tx_hash IS NULL
          LIMIT 1
        `);
    const exists = (Array.isArray(existing) ? existing : (existing as { rows?: unknown[] }).rows ?? []).length > 0;
    if (exists) {
      skipped++;
      continue;
    }

    await db.insert(x402L1Purchases).values({
      endpointId,
      attemptedAt: new Date(rec.at),
      status,
      network,
      asset: rec.asset.toLowerCase(),
      payTo: rec.payTo.toLowerCase(),
      amountUnits: rec.amountAtomic,
      spentUnits: spent,
      payer: rec.payer.toLowerCase(),
      txHash: tx,
      authNonce: rec.salt ?? null,
      httpStatusPaid: http,
      latencyMs: null,
      payloadNonEmpty: payload,
      contentTypeMatch: null,
      l2Schema: "no_declaration",
      rawResponseMeta: {
        evmLane: rec.lane,
        evmLaneIngest: true,
        verdictStatus: verdict?.status ?? null,
        chainCheck: rec.chainCheck ?? null,
        dedupeKey,
      },
      settlementVerified: status === "settled" && rec.chainCheck === "transfer_found" ? true : status === "settled" ? true : null,
      settlementVerifiedAt: status === "settled" ? new Date(rec.at) : null,
      settlementVerifyReason: status === "settled" ? "evm_lane_public_record" : verdict?.rule ?? null,
    });
    inserted++;
  }

  return { scanned: rows.length, inserted, skipped };
}

/** l1.byChain の結合キー（chainLabel → chainIdentity と同じ系列）。 */
export function robinhoodChainLabelForByChain(): string {
  return chainLabel(ROBINHOOD_CAIP2);
}
