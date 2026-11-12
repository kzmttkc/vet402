// ============================================================
// 売り手依頼の 1 回きり L1 買い直し（2026-10-30）。
//
// 目録に無い URL 用の x402_endpoints 行（source = seller_retest_request）を用意し、
// 402 を読んで payTo / network / 上限を照合してから既存の purchaseOne へ渡す。
// ============================================================
import { eq, sql } from "drizzle-orm";
import { canonicalUrl, endpointHash, payeeId, resourceId } from "@/lib/ids/canonical";
import { x402Endpoints } from "@/lib/db/schema";
import { utcDayStart } from "@/lib/db/utc-day";
import { normalizeResourceKey } from "./catalog-source";
import {
  SELLER_REQUEST_PRESIGN_PREFIX,
  SELLER_RETEST_MAX_PER_RUN,
  SELLER_RETEST_REQUEST_SOURCE,
  resolveSellerRetestUrl,
  sellerRetestRequestCatalog,
  type SellerRetestRequest,
} from "./seller-retest-requests";
import { BASE_CAIP2, BASE_USDC, CELO_CAIP2, CELO_USDC, MAX_PER_PURCHASE_UNITS, type ParsedChallenge } from "./x402-payer";

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

// 2026-11-02 Goldsky（Elliott）: 支払いの扱いは x-goldsky-x402-funding で読む（settled / credit / pending / unpaid）。売り手の申告なので
// 行の status は変えない。保存するだけ。
const SELLER_RESPONSE_HEADERS = ["x-goldsky-x402-balance", "x-goldsky-x402-funding"] as const;

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
      AND pu.auth_nonce NOT LIKE ${`${SELLER_REQUEST_PRESIGN_PREFIX}%`}
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

/**
 * 予約を取った後に、署名せずに後始末した行（2026-10-30 差し戻し2）。停止スイッチ（halted）、署名前の解放
 * （phase pre_sign）、孤児の掃除（phase sweep）、予約後の例外の確定（phase post_reservation）。402 は取れていて
 * 資格情報は出していないので、その依頼は次の実行でまた買える（その日の「取りに行った」には数えない）。
 */
export function sellerRequestReservationReleasedSql(alias: "pu"): ReturnType<typeof sql> {
  return sql.raw(
    `(${alias}.status = 'halted' OR coalesce(${alias}.raw_response_meta->>'phase', '') IN ('pre_sign', 'sweep', 'post_reservation'))`,
  );
}

/**
 * その UTC 日に 402 を取りに行って、予約の前で止まった依頼（402 が取れない・合わない・上限で断った等。
 * 1 日 1 回の再試行用）。記録は既存の台帳の行（record() が書く sellerRequestId 付きの行）で、
 * 予約の後に後始末した行（sellerRequestReservationReleasedSql）は数えない。進行中の予約（in_flight）は数える
 * （同じ依頼を並行の実行が取りに行かない）。
 */
export async function sellerRequestIdsAttemptedToday(
  db: NonNullable<ReturnType<typeof import("@/lib/db/client").getDb>>,
): Promise<Set<string>> {
  const rows = await db.execute(sql`
    SELECT DISTINCT pu.raw_response_meta->>'sellerRequestId' AS id
    FROM x402_l1_purchases pu
    WHERE pu.raw_response_meta->>'sellerRequestId' IS NOT NULL
      -- UTC 日の始まりは utcDayStart の 1 か所（naive timestamp の比較は接続の TimeZone でずれる）。
      AND pu.attempted_at >= ${utcDayStart()}
      AND NOT ${sellerRequestReservationReleasedSql("pu")}
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

export type SellerRequestAuthClaim = { ok: true } | { ok: false; reason: "already_claimed" | "write_failed" };

/**
 * 署名の前に sellerRequestId の auth 枠を 1 行だけ確保する（部分一意索引と併用）。
 * auth_nonce = presign:<rowId> は完了判定に数えない（completedSellerRequestIds）。
 */
export async function claimSellerRequestAuthSlot(
  db: NonNullable<ReturnType<typeof import("@/lib/db/client").getDb>>,
  rowId: string,
  sellerRequestId: string,
): Promise<SellerRequestAuthClaim> {
  const presign = `${SELLER_REQUEST_PRESIGN_PREFIX}${rowId}`;
  try {
    const raw = await db.execute(sql`
      UPDATE x402_l1_purchases pu
      SET auth_nonce = ${presign}
      WHERE pu.id = ${rowId}::uuid
        AND pu.auth_nonce IS NULL
        AND pu.raw_response_meta->>'sellerRequestId' = ${sellerRequestId}
        AND NOT EXISTS (
          SELECT 1 FROM x402_l1_purchases o
          WHERE o.raw_response_meta->>'sellerRequestId' = ${sellerRequestId}
            AND o.auth_nonce IS NOT NULL
            AND o.id <> ${rowId}::uuid
        )
      RETURNING pu.id::text AS id
    `);
    const list = (Array.isArray(raw) ? raw : ((raw as unknown as { rows?: Record<string, unknown>[] }).rows ?? [])) as Record<
      string,
      unknown
    >[];
    if (list[0]?.id === rowId) return { ok: true };
    return { ok: false, reason: "already_claimed" };
  } catch {
    return { ok: false, reason: "write_failed" };
  }
}

export function pendingSellerRetestRequests(
  catalog: readonly SellerRetestRequest[],
  completed: Set<string>,
  todayUtc: string,
  attemptedToday: Set<string> = new Set(),
  limit = SELLER_RETEST_MAX_PER_RUN,
): SellerRetestRequest[] {
  const out: SellerRetestRequest[] = [];
  for (const req of catalog) {
    if (out.length >= limit) break;
    if (completed.has(req.id)) continue;
    if (attemptedToday.has(req.id)) continue;
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
  | { ok: true; amountUnits: bigint; payTo: string; asset?: string }
  | { ok: false; reason: string; detail?: Record<string, unknown> };

/** JSON の値の深い等しさ。オブジェクトはキーの順番を問わない。配列は順番を区別する。数値と文字列は区別する。 */
function jsonValuesEqual(a: unknown, b: unknown): boolean {
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return Object.is(a, b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => jsonValuesEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  if (ak.length !== Object.keys(bo).length) return false;
  return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && jsonValuesEqual(ao[k], bo[k]));
}

/**
 * 依頼の POST 本文と 402 が宣言した本文が同じか（2026-10-31・本番の Goldsky で宣言がキーの順番だけ違った）。
 * 両方が JSON として読めるときは正規化した JSON の等しさ（jsonValuesEqual）、どちらかが読めなければバイト列の一致。
 * 払うときに送る本文はこの判定に関係なく依頼リストの body のまま。
 */
export function sellerRequestBodiesEqual(expected: string, declared: string): boolean {
  let e: unknown;
  let d: unknown;
  try {
    e = JSON.parse(expected);
    d = JSON.parse(declared);
  } catch {
    return expected === declared;
  }
  return jsonValuesEqual(e, d);
}

/**
 * Celo の依頼で払ってよい accept か。network は eip155:42220、資産は Celo の USDC、
 * payTo は依頼と一致（0x は大小を無視）、額は依頼の額そのもの（上限未満では買わない）。
 * 1 件の上限（MAX_PER_PURCHASE_UNITS）を超える額はここでも外す。
 */
function celoSellerAcceptMatches(
  accept: { network: string; amount?: unknown; payTo?: unknown; asset?: unknown },
  gate: SellerRequestGate,
): boolean {
  if (gate.network !== CELO_CAIP2 || accept.network !== CELO_CAIP2) return false;
  if (typeof accept.asset !== "string" || accept.asset.toLowerCase() !== CELO_USDC.toLowerCase()) return false;
  if (typeof accept.payTo !== "string" || normalizedEvmPayTo(accept.payTo) !== normalizedEvmPayTo(gate.expectedPayTo)) return false;
  if (typeof accept.amount !== "string" || accept.amount !== String(gate.maxAmountUnits)) return false;
  let amount: bigint;
  try {
    amount = BigInt(accept.amount);
  } catch {
    return false;
  }
  return amount > 0n && amount === gate.maxAmountUnits && amount <= MAX_PER_PURCHASE_UNITS;
}

/** 署名する accept を依頼の network だけに絞る（Arbitrum 等のレーンが ON でも依頼の network で払う）。 */
export function sellerRequestAccepts<T extends { network: string }>(accepts: readonly T[], gate: SellerRequestGate): T[] {
  // Celo は network だけでなく payTo と額と Celo USDC が一致したものだけを、Celo レーンと同じ selectAccept へ渡す。
  if (gate.network === CELO_CAIP2) return accepts.filter((a) => celoSellerAcceptMatches(a, gate));
  // Base と Celo 以外は署名側へ渡さない（レーンが ON でも依頼レーンでは買わない）。
  if (gate.network !== BASE_CAIP2) return [];
  return accepts.filter((a) => a.network === gate.network);
}

function validateCeloSellerRequest402(challenge: ParsedChallenge, gate: SellerRequestGate): SellerRequest402Verdict {
  const onNetwork = challenge.accepts.filter((a) => a.network === CELO_CAIP2);
  if (onNetwork.length === 0) {
    return { ok: false, reason: "seller_request_network_missing", detail: { network: gate.network } };
  }
  for (const accept of onNetwork) {
    if (!celoSellerAcceptMatches(accept, gate)) continue;
    return { ok: true, amountUnits: BigInt(accept.amount), payTo: accept.payTo, asset: accept.asset };
  }
  const expected = normalizedEvmPayTo(gate.expectedPayTo);
  for (const accept of onNetwork) {
    if (accept.asset.toLowerCase() !== CELO_USDC.toLowerCase()) continue;
    let amount: bigint;
    try {
      amount = BigInt(accept.amount);
    } catch {
      continue;
    }
    if (amount === gate.maxAmountUnits && amount > 0n && amount <= MAX_PER_PURCHASE_UNITS && normalizedEvmPayTo(accept.payTo) !== expected) {
      return {
        ok: false,
        reason: "seller_request_payto_mismatch",
        detail: { expected: gate.expectedPayTo, wall: accept.payTo },
      };
    }
  }
  for (const accept of onNetwork) {
    let amount: bigint;
    try {
      amount = BigInt(accept.amount);
    } catch {
      continue;
    }
    if (amount > gate.maxAmountUnits || amount > MAX_PER_PURCHASE_UNITS) {
      return {
        ok: false,
        reason: "seller_request_over_cap",
        detail: { amount: accept.amount, maxPerPurchase: String(MAX_PER_PURCHASE_UNITS), requestMax: String(gate.maxAmountUnits) },
      };
    }
  }
  return { ok: false, reason: "seller_request_no_eligible_accept" };
}

export function validateSellerRequest402(challenge: ParsedChallenge, gate: SellerRequestGate): SellerRequest402Verdict {
  // Celo の依頼だけ、network・payTo・額・Celo USDC が一致する accept を選ぶ。払う関数は purchaseOne の selectAccept / signX402Payment（Celo レーンと同じ）。
  if (gate.network === CELO_CAIP2) return validateCeloSellerRequest402(challenge, gate);
  // Base 以外の網（Arc、Arbitrum、BNB、Avalanche、Solana など）は依頼レーンでは買わない。
  if (gate.network !== BASE_CAIP2) {
    return { ok: false, reason: "seller_request_network_unsupported", detail: { network: gate.network } };
  }
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
  // Base の依頼は BASE_USDC のまま。Celo の依頼だけ Celo の USDC を書く。
  const asset = req.network === CELO_CAIP2 ? CELO_USDC : BASE_USDC;
  const ids = canonicalUrl(resourceUrl);
  const rid = resourceId(method, resourceUrl);
  const ehash = endpointHash(resourceUrl);
  const pid = payeeId(req.network, req.payTo);
  const accepts = [
    {
      scheme: "exact",
      network: req.network,
      amount,
      asset,
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
      priceAsset: asset,
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
        priceAsset: asset,
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
