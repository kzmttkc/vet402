// ============================================================
// vet402 が日付窓のあいだに特定の Bazaar 出品へ有料試行を 1 件予約するリスト。
// 売り手は支払いや依頼を出せない。並びと台帳の印だけが変わり、上限・署名・受取先の
// 照合は通常の L1 と同じ（塞がれれば買わない）。
// ============================================================
import { sql } from "drizzle-orm";
import { canonicalUrl } from "@/lib/ids/canonical";

export type PinnedPurchase = {
  /** 完全な https URL（canonicalUrl と同じ規則で照合）。 */
  url: string;
  method: "GET" | "POST";
  /** 窓の開始（ISO 8601 UTC・含む）。 */
  from: string;
  /** 窓の終了（ISO 8601 UTC・含む）。 */
  to: string;
  reason: string;
  requestedBy: string;
  approvedAt: string;
  maxPurchases: number;
};

export const PINNED_PURCHASE_SELECTION = "pinned_purchase" as const;

/** 正典リスト（版管理）。FactGate 審査用の最初の予約（2026-11-23 承認）。 */
export const PINNED_PURCHASES: readonly PinnedPurchase[] = [
  {
    url: "https://agent402.tools/api/weather-forecast",
    method: "GET",
    from: "2027-01-10T00:00:00.000Z",
    to: "2027-01-10T23:59:59.999Z",
    reason: "FactGate hackathon judging (starts 2027-01-11 18:00 UTC): delivered evidence for this Bazaar listing the day before judging opens.",
    requestedBy: "hackathon session for FactGate judging (2027-01-11 18:00 UTC to 2027-01-18)",
    // 2026-11-23 07:20 JST 承認（01-11〜01-12）、09:32 JST に 01-10 へ前倒しを承認（金額・回数・経路は同じ）。
    approvedAt: "2026-11-23T00:32:00.000Z",
    maxPurchases: 1,
  },
];

function parseUtcMs(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`pinned purchase: invalid ISO date ${iso}`);
  return ms;
}

export function validatePinnedPurchase(entry: PinnedPurchase, index: number): void {
  const label = `PINNED_PURCHASES[${index}]`;
  const c = canonicalUrl(entry.url);
  if (c === null) throw new Error(`${label}: url must be https`);
  if (entry.method !== "GET" && entry.method !== "POST") throw new Error(`${label}: method must be GET or POST`);
  const fromMs = parseUtcMs(entry.from);
  const toMs = parseUtcMs(entry.to);
  if (!(fromMs < toMs)) throw new Error(`${label}: from must be before to`);
  if (!Number.isInteger(entry.maxPurchases) || entry.maxPurchases < 1) {
    throw new Error(`${label}: maxPurchases must be an integer >= 1`);
  }
  if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
    throw new Error(`${label}: reason is required`);
  }
  if (typeof entry.approvedAt !== "string" || entry.approvedAt.trim() === "") {
    throw new Error(`${label}: approvedAt is required`);
  }
  parseUtcMs(entry.approvedAt);
  if (typeof entry.requestedBy !== "string" || entry.requestedBy.trim() === "") {
    throw new Error(`${label}: requestedBy is required`);
  }
}

export function validatePinnedPurchaseList(list: readonly PinnedPurchase[]): void {
  list.forEach((entry, i) => validatePinnedPurchase(entry, i));
}

validatePinnedPurchaseList(PINNED_PURCHASES);

export function pinnedWindowActive(entry: PinnedPurchase, nowMs: number): boolean {
  const fromMs = parseUtcMs(entry.from);
  const toMs = parseUtcMs(entry.to);
  return nowMs >= fromMs && nowMs <= toMs;
}

/** resource_url / method が予約行と同じ出品か（canonical URL・method の大文字小文字）。 */
export function listingMatchesPinned(entry: PinnedPurchase, resourceUrl: string, method: string | null): boolean {
  const want = canonicalUrl(entry.url);
  const have = canonicalUrl(resourceUrl);
  if (want === null || have === null) return false;
  const m = (method ?? "GET").toUpperCase();
  return want.url === have.url && m === entry.method.toUpperCase();
}

export type PinnedPurchaseMeta = {
  selection: typeof PINNED_PURCHASE_SELECTION;
  pinnedPurchaseReason: string;
  pinnedPurchaseApprovedAt: string;
};

export function pinnedPurchaseMetaOf(entry: PinnedPurchase): PinnedPurchaseMeta {
  return {
    selection: PINNED_PURCHASE_SELECTION,
    pinnedPurchaseReason: entry.reason,
    pinnedPurchaseApprovedAt: entry.approvedAt,
  };
}

export function pinnedPurchasesActiveAt(nowMs: number, list: readonly PinnedPurchase[] = PINNED_PURCHASES): PinnedPurchase[] {
  return list.filter((e) => pinnedWindowActive(e, nowMs));
}

type DbLike = NonNullable<ReturnType<typeof import("@/lib/db/client").getDb>>;

function rowsOf(raw: unknown): Record<string, unknown>[] {
  return (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Record<string, unknown>[];
}

/** `from` 以降の status=settled の件数（予約の maxPurchases 判定）。 */
export async function countSettledSincePinFrom(
  db: DbLike,
  endpointId: string,
  fromIso: string,
): Promise<number> {
  const raw = await db.execute(sql`
    SELECT count(*)::int AS n
    FROM x402_l1_purchases pu
    WHERE pu.endpoint_id = ${endpointId}::uuid
      AND pu.status = 'settled'
      AND pu.attempted_at >= ${fromIso}::timestamptz
  `);
  const row = rowsOf(raw)[0];
  return typeof row?.n === "number" ? row.n : Number(row?.n ?? 0);
}

export type ActivePinnedTarget = {
  entry: PinnedPurchase;
  endpointId: string;
  settledCount: number;
};

/**
 * 窓の内でまだ maxPurchases に届いていない予約。カタログに行が無ければ含めない。
 */
export async function loadActivePinnedPurchaseTargets(
  db: DbLike,
  nowMs: number,
  list: readonly PinnedPurchase[] = PINNED_PURCHASES,
): Promise<ActivePinnedTarget[]> {
  const active = pinnedPurchasesActiveAt(nowMs, list);
  if (active.length === 0) return [];
  const out: ActivePinnedTarget[] = [];
  for (const entry of active) {
    const raw = await db.execute(sql`
      SELECT e.id, e.resource_url, e.method
      FROM x402_endpoints e
      WHERE e.status = 'active'
        AND upper(coalesce(e.method, 'GET')) = ${entry.method.toUpperCase()}
    `);
    const match = rowsOf(raw).find((r) =>
      typeof r.resource_url === "string" && listingMatchesPinned(entry, r.resource_url, typeof r.method === "string" ? r.method : null),
    );
    if (!match || typeof match.id !== "string") continue;
    const settledCount = await countSettledSincePinFrom(db, match.id, entry.from);
    if (settledCount >= entry.maxPurchases) continue;
    out.push({ entry, endpointId: match.id, settledCount });
  }
  return out;
}

/** テスト用: 候補の並びで予約出品を先頭へ（ caps は変えない）。 */
export function promotePinnedPurchaseCandidates<
  T extends { id: string; resourceUrl: string; method: string | null; selection?: string | null },
>(
  candidates: readonly T[],
  targets: readonly ActivePinnedTarget[],
  patch: (c: T, target: ActivePinnedTarget) => T,
): T[] {
  if (targets.length === 0) return [...candidates];
  const pinOrder = targets.map((t) => t.endpointId);
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const head: T[] = [];
  for (const t of targets) {
    const c = byId.get(t.endpointId);
    if (c) head.push(patch(c, t));
  }
  const pinnedIds = new Set(pinOrder);
  const tail = candidates.filter((c) => !pinnedIds.has(c.id)).map((c) => ({ ...c }));
  return [...head, ...tail];
}

/** 方法論・テストが参照するチェックイン場所。 */
export const PINNED_PURCHASES_SOURCE = "src/lib/observatory/pinned-purchases.ts";