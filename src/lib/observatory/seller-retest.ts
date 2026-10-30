// ============================================================
// 売り手依頼の 1 回きり L1 買い直し（2026-10-30）。
//
// 目録に無い URL 用の x402_endpoints 行（source = seller_retest_request）を用意し、
// 402 を読んで payTo / network / 上限を照合してから既存の purchaseOne へ渡す。
// ============================================================
import { eq, sql } from "drizzle-orm";
import { canonicalUrl, endpointHash, payeeId, resourceId } from "@/lib/ids/canonical";
import { x402Endpoints } from "@/lib/db/schema";
import { normalizeResourceKey } from "./catalog-source";
import {
  SELLER_RETEST_MAX_PER_RUN,
  SELLER_RETEST_REQUEST_SOURCE,
  resolveSellerRetestUrl,
  sellerRetestRequestCatalog,
  type SellerRetestRequest,
} from "./seller-retest-requests";
import { BASE_USDC, MAX_PER_PURCHASE_UNITS, type ParsedChallenge } from "./x402-payer";

export { SELLER_RETEST_REQUEST_SOURCE, SELLER_RETEST_MAX_PER_RUN };

export type SellerRequestGate = {
  id: string;
  expectedPayTo: string;
  network: string;
  maxAmountUnits: bigint;
};

export type SellerRequestUnpaid = {
  url: string;
  body?: string;
};

/** raw_response_meta.selection = "seller_request" */
export const SELLER_REQUEST_SELECTION = "seller_request" as const;

const SELLER_RESPONSE_HEADERS = ["x-goldsky-x402-balance"] as const;

export function sellerResponseHeadersOf(headers: Headers): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const name of SELLER_RESPONSE_HEADERS) {
    const v = headers.get(name);
    if (v !== null && v.length > 0) out[name] = v.slice(0, 200);
  }
  return Object.keys(out).length > 0 ? out : null;
}

function normalizedEvmPayTo(payTo: string): string {
  return payTo.startsWith("0x") ? payTo.toLowerCase() : payTo;
}

export function utcDateString(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function isSellerRetestRequestActive(req: SellerRetestRequest, todayUtc: string): boolean {
  return todayUtc <= req.expiresOn;
}

export async function completedSellerRequestIds(db: NonNullable<ReturnType<typeof import("@/lib/db/client").getDb>>): Promise<Set<string>> {
  const rows = await db.execute(sql`
    SELECT DISTINCT pu.raw_response_meta->>'sellerRequestId' AS id
    FROM x402_l1_purchases pu
    WHERE pu.raw_response_meta->>'sellerRequestId' IS NOT NULL
      AND pu.auth_nonce IS NOT NULL
  `);
  const list = (Array.isArray(rows) ? rows : ((rows as unknown as { rows?: Record<string, unknown>[] }).rows ?? [])) as Record<
    string,
    unknown
  >[];
  return new Set(
    list
      .map((r) => r.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
}

export function pendingSellerRetestRequests(
  catalog: readonly SellerRetestRequest[],
  completed: Set<string>,
  todayUtc: string,
  limit = SELLER_RETEST_MAX_PER_RUN,
): SellerRetestRequest[] {
  const out: SellerRetestRequest[] = [];
  for (const req of catalog) {
    if (out.length >= limit) break;
    if (completed.has(req.id)) continue;
    if (!isSellerRetestRequestActive(req, todayUtc)) continue;
    out.push(req);
  }
  return out;
}

export function sellerRequestGateOf(req: SellerRetestRequest): SellerRequestGate {
  const amountRaw = req.amountUnits ?? "5000";
  let maxAmountUnits = 5000n;
  try {
    maxAmountUnits = BigInt(amountRaw);
  } catch {
    maxAmountUnits = 5000n;
  }
  return {
    id: req.id,
    expectedPayTo: req.payTo,
    network: req.network,
    maxAmountUnits,
  };
}

export function sellerRequestUnpaidOf(req: SellerRetestRequest, payerAddress: string): SellerRequestUnpaid {
  return {
    url: resolveSellerRetestUrl(req.url, payerAddress),
    ...(req.method === "POST" && req.body ? { body: req.body } : {}),
  };
}

export type SellerRequest402Verdict =
  | { ok: true; amountUnits: bigint; payTo: string }
  | { ok: false; reason: string; detail?: Record<string, unknown> };

export function validateSellerRequest402(challenge: ParsedChallenge, gate: SellerRequestGate): SellerRequest402Verdict {
  const expected = normalizedEvmPayTo(gate.expectedPayTo);
  const accepts = challenge.accepts.filter((a) => a.network === gate.network);
  if (accepts.length === 0) {
    return { ok: false, reason: "seller_request_network_missing", detail: { network: gate.network } };
  }
  for (const accept of accepts) {
    let amount: bigint;
    try {
      amount = BigInt(accept.amount);
    } catch {
      continue;
    }
    if (amount <= 0n) continue;
    if (amount > gate.maxAmountUnits || amount > MAX_PER_PURCHASE_UNITS) {
      return {
        ok: false,
        reason: "seller_request_over_cap",
        detail: { amount: accept.amount, maxPerPurchase: String(MAX_PER_PURCHASE_UNITS), requestMax: String(gate.maxAmountUnits) },
      };
    }
    if (normalizedEvmPayTo(accept.payTo) !== expected) {
      return {
        ok: false,
        reason: "seller_request_payto_mismatch",
        detail: { expected: gate.expectedPayTo, wall: accept.payTo },
      };
    }
    return { ok: true, amountUnits: amount, payTo: accept.payTo };
  }
  return { ok: false, reason: "seller_request_no_eligible_accept" };
}

export async function ensureSellerRetestEndpoint(
  db: NonNullable<ReturnType<typeof import("@/lib/db/client").getDb>>,
  req: SellerRetestRequest,
  payerAddress: string,
): Promise<string> {
  const resourceUrl = resolveSellerRetestUrl(req.url, payerAddress);
  const resourceKey = normalizeResourceKey(resourceUrl);
  const method = req.method;
  const amount = req.amountUnits ?? "5000";
  const ids = canonicalUrl(resourceUrl);
  const rid = resourceId(method, resourceUrl);
  const ehash = endpointHash(resourceUrl);
  const pid = payeeId(req.network, req.payTo);
  const accepts = [
    {
      scheme: "exact",
      network: req.network,
      amount,
      asset: BASE_USDC,
      payTo: req.payTo,
    },
  ];
  const inserted = await db
    .insert(x402Endpoints)
    .values({
      resourceKey,
      resourceUrl,
      source: SELLER_RETEST_REQUEST_SOURCE,
      method,
      network: req.network,
      payTo: req.payTo,
      priceAmount: amount,
      priceAsset: BASE_USDC,
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
        network: req.network,
        payTo: req.payTo,
        priceAmount: amount,
        priceAsset: BASE_USDC,
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
  const row = inserted[0];
  if (!row) throw new Error("ensureSellerRetestEndpoint: no row returned");
  return row.id;
}

export type SellerRetestCandidateExtras = {
  selection: typeof SELLER_REQUEST_SELECTION;
  sellerRequest: SellerRequestGate;
  sellerRequestUnpaid: SellerRequestUnpaid;
};

export async function buildSellerRetestCandidate(
  db: NonNullable<ReturnType<typeof import("@/lib/db/client").getDb>>,
  req: SellerRetestRequest,
  payerAddress: string,
): Promise<{ id: string; extras: SellerRetestCandidateExtras }> {
  const id = await ensureSellerRetestEndpoint(db, req, payerAddress);
  return {
    id,
    extras: {
      selection: SELLER_REQUEST_SELECTION,
      sellerRequest: sellerRequestGateOf(req),
      sellerRequestUnpaid: sellerRequestUnpaidOf(req, payerAddress),
    },
  };
}

export function sellerRetestCatalogForBatch(): readonly SellerRetestRequest[] {
  return sellerRetestRequestCatalog();
}
