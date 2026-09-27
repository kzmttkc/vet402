// ============================================================
// /sellers の集計（純関数・DB 無し）。reader.ts が DB から事実を引き、ここで数える。
//
// 1 出品は「最新の購入行」1 つで数える（Base の行と、network の無い行＝支払い前に止まった行）。
// 数字は頁に書かない。毎回ここを通して DB の行から出す。
// ============================================================
import { explorerTxUrl } from "@/lib/observatory/chains";
import { classifyRow, FIX_MODES, NOT_IN_EXPORT_STATUSES, type Bucket, type FixMode, type SellerRowFacts } from "./fix-modes";

export type SummaryBucket = Bucket | "not_bought";

export interface OutcomeCounts {
  delivered: number;
  seller: number;
  vet402: number;
  unsorted: number;
  notBought: number;
}

export interface SellerSummary extends OutcomeCounts {
  host: string;
  listings: number;
  /** その売り手の最新の購入（ISO）。無ければ null。 */
  lastAttemptAt: string | null;
  /** 売り手の最新の行が vet402 の側（payer_unfunded / body_not_sent）＝retest の対象になる形。 */
  retestDue: boolean;
}

export interface FixGroupSeller {
  host: string;
  listings: number;
}

export interface FixGroup extends FixMode {
  /** この種類で最新の購入が終わっている出品の数。 */
  listings: number;
  /** その出品を持つ売り手の数。 */
  hosts: number;
  /** 台帳の status ごとの件数（何から振り分けたかを見せる）。 */
  statuses: Record<string, number>;
  sellers: FixGroupSeller[];
}

export interface SellerBoard {
  /** DB を読んだ時刻（ISO）。頁はこの時刻を出す。 */
  fetchedAt: string;
  sellers: SellerSummary[];
  totals: OutcomeCounts & { sellers: number; listings: number; sellersBought: number };
  groups: FixGroup[];
}

/** DB から来る、Base の出品 1 つの最新の購入行（ホスト名付き）。 */
export interface LatestRow extends SellerRowFacts {
  host: string;
}

export const RETEST_MODE_KEYS: ReadonlySet<string> = new Set(["payer_unfunded", "body_not_sent"]);

function zero(): OutcomeCounts {
  return { delivered: 0, seller: 0, vet402: 0, unsorted: 0, notBought: 0 };
}

const SIDE_ORDER = { seller: 0, vet402: 1, unsorted: 2 } as const;
const MODE_ORDER = new Map(FIX_MODES.map((m, i) => [m.key, i]));

function bucketKey(b: Bucket): keyof OutcomeCounts {
  return b;
}

/** 売り手の一覧の並び: 買った売り手を新しい順、まだの売り手はホスト名順。 */
export function compareSellers(a: SellerSummary, b: SellerSummary): number {
  if (a.lastAttemptAt && b.lastAttemptAt) return b.lastAttemptAt.localeCompare(a.lastAttemptAt) || a.host.localeCompare(b.host);
  if (a.lastAttemptAt) return -1;
  if (b.lastAttemptAt) return 1;
  return a.host.localeCompare(b.host);
}

/**
 * hostListings: Base の出品数（ホストごと・active）。latest: 購入のある出品の最新行（出品ごとに 1 行）。
 * latest にあって hostListings に無いホストは数えない（カタログから外れた・Base でなくなった出品）。
 */
export function buildSellerBoard(
  hostListings: readonly { host: string; listings: number }[],
  latest: readonly LatestRow[],
  fetchedAt: string,
): SellerBoard {
  const byHost = new Map<string, SellerSummary>();
  for (const h of hostListings) {
    byHost.set(h.host, { host: h.host, listings: h.listings, ...zero(), lastAttemptAt: null, retestDue: false });
  }
  const acc = new Map<string, { hosts: Map<string, number>; statuses: Record<string, number>; listings: number }>();
  const newest = new Map<string, LatestRow & { modeKey: string | null }>();
  for (const r of latest) {
    const s = byHost.get(r.host);
    if (!s) continue;
    const c = classifyRow(r);
    s[bucketKey(c.bucket)]++;
    if (!s.lastAttemptAt || r.attemptedAt > s.lastAttemptAt) s.lastAttemptAt = r.attemptedAt;
    const prev = newest.get(r.host);
    if (!prev || r.attemptedAt > prev.attemptedAt) newest.set(r.host, { ...r, modeKey: c.mode?.key ?? null });
    if (c.mode) {
      let a = acc.get(c.mode.key);
      if (!a) acc.set(c.mode.key, (a = { hosts: new Map(), statuses: {}, listings: 0 }));
      a.listings++;
      a.hosts.set(r.host, (a.hosts.get(r.host) ?? 0) + 1);
      a.statuses[r.status] = (a.statuses[r.status] ?? 0) + 1;
    }
  }
  const sellers = [...byHost.values()];
  const totals = { ...zero(), sellers: sellers.length, listings: 0, sellersBought: 0 };
  for (const s of sellers) {
    const bought = s.delivered + s.seller + s.vet402 + s.unsorted;
    s.notBought = Math.max(0, s.listings - bought);
    s.retestDue = RETEST_MODE_KEYS.has(newest.get(s.host)?.modeKey ?? "");
    totals.listings += s.listings;
    totals.delivered += s.delivered;
    totals.seller += s.seller;
    totals.vet402 += s.vet402;
    totals.unsorted += s.unsorted;
    totals.notBought += s.notBought;
    if (s.lastAttemptAt) totals.sellersBought++;
  }
  sellers.sort(compareSellers);

  const groups: FixGroup[] = [...acc.entries()].map(([key, a]) => {
    const mode = FIX_MODES.find((m) => m.key === key)!;
    const groupSellers = [...a.hosts.entries()]
      .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
      .map(([host, listings]) => ({ host, listings }));
    return { ...mode, listings: a.listings, hosts: a.hosts.size, statuses: a.statuses, sellers: groupSellers };
  });
  groups.sort(
    (a, b) =>
      SIDE_ORDER[a.side] - SIDE_ORDER[b.side] ||
      b.hosts - a.hosts ||
      a.effort - b.effort ||
      b.listings - a.listings ||
      (MODE_ORDER.get(a.key) ?? 0) - (MODE_ORDER.get(b.key) ?? 0),
  );
  return { fetchedAt, sellers, totals, groups };
}

/** 検索: ホスト名の完全一致を先頭に、部分一致を続ける（最大 limit 件）。 */
export function searchSellers(sellers: readonly SellerSummary[], q: string, limit = 50): { exact: SellerSummary | null; matches: SellerSummary[] } {
  const needle = q.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/:[0-9]+$/, "");
  if (!needle) return { exact: null, matches: [] };
  const exact = sellers.find((s) => s.host === needle) ?? null;
  const matches = sellers.filter((s) => s.host !== needle && s.host.includes(needle)).slice(0, limit);
  return { exact, matches };
}

// ------------------------------------------------------------
// 1 売り手の頁
// ------------------------------------------------------------

export interface SellerEndpointFacts {
  endpointId: string;
  resourceKey: string;
  resourceUrl: string;
  method: string | null;
  priceAmount: string | null;
}

export interface ShownRow {
  facts: SellerRowFacts;
  bucket: Bucket;
  mode: FixMode | null;
  held: string | null;
  txUrl: string | null;
  /** export.csv にこの行が載るか（vet402 の側の状態は載らない）。 */
  inExport: boolean;
}

export interface SellerListing extends SellerEndpointFacts {
  latest: ShownRow | null;
  /** 最新より前の行（新しい順・最大 EARLIER_ROWS_SHOWN 件）。 */
  earlier: ShownRow[];
  /** 最新の行が届いていて、その前に届かなかった行がある（「直った」とは書かない。事実だけを出す）。 */
  deliveredAfterFailure: boolean;
}

export interface SellerDetail {
  fetchedAt: string;
  host: string;
  summary: SellerSummary;
  listings: SellerListing[];
  /** 表示した行の中で census / retest で選ばれた行の数。 */
  selectedBy: { census: number; retest: number };
}

export const EARLIER_ROWS_SHOWN = 4;

export function showRow(r: SellerRowFacts): ShownRow {
  const c = classifyRow(r);
  return {
    facts: r,
    bucket: c.bucket,
    mode: c.mode,
    held: c.held,
    txUrl: explorerTxUrl(r.network, r.txHash),
    inExport: !NOT_IN_EXPORT_STATUSES.has(r.status),
  };
}

/** 出品の並び: 購入のある出品を新しい順、まだの出品は resource_key 順。 */
function compareListings(a: SellerListing, b: SellerListing): number {
  const at = a.latest?.facts.attemptedAt ?? null;
  const bt = b.latest?.facts.attemptedAt ?? null;
  if (at && bt) return bt.localeCompare(at) || a.resourceKey.localeCompare(b.resourceKey);
  if (at) return -1;
  if (bt) return 1;
  return a.resourceKey.localeCompare(b.resourceKey);
}

/**
 * endpoints: その売り手の Base の出品（active）。rows: それらの購入行（新しい順でなくてよい）。
 */
export function buildSellerDetail(
  host: string,
  endpoints: readonly SellerEndpointFacts[],
  rows: readonly SellerRowFacts[],
  fetchedAt: string,
): SellerDetail {
  const byEndpoint = new Map<string, SellerRowFacts[]>();
  for (const r of rows) {
    const list = byEndpoint.get(r.endpointId) ?? [];
    list.push(r);
    byEndpoint.set(r.endpointId, list);
  }
  const selectedBy = { census: 0, retest: 0 };
  const listings: SellerListing[] = endpoints.map((e) => {
    const own = (byEndpoint.get(e.endpointId) ?? []).slice().sort((a, b) => b.attemptedAt.localeCompare(a.attemptedAt));
    const shown = own.slice(0, 1 + EARLIER_ROWS_SHOWN).map(showRow);
    for (const s of shown) {
      if (s.facts.selection === "census") selectedBy.census++;
      if (s.facts.selection === "retest") selectedBy.retest++;
    }
    const latest = shown[0] ?? null;
    const earlier = shown.slice(1);
    const deliveredAfterFailure = latest?.bucket === "delivered" && own.slice(1).some((r) => classifyRow(r).bucket !== "delivered");
    return { ...e, latest, earlier, deliveredAfterFailure };
  });
  listings.sort(compareListings);
  const latestRows: LatestRow[] = listings.filter((l) => l.latest).map((l) => ({ ...l.latest!.facts, host }));
  const board = buildSellerBoard([{ host, listings: endpoints.length }], latestRows, fetchedAt);
  const summary = board.sellers[0] ?? { host, listings: 0, ...zero(), lastAttemptAt: null, retestDue: false };
  return { fetchedAt, host, summary, listings, selectedBy };
}

/** export.csv の ?days= で、その行が窓に入る最小の日数（1..366）。366 を超えるなら null。 */
export function exportDaysFor(attemptedAt: string, now: number): number | null {
  const ageMs = now - Date.parse(attemptedAt);
  if (!Number.isFinite(ageMs)) return null;
  const days = Math.max(1, Math.ceil(ageMs / 86_400_000) + 1);
  return days > 366 ? null : days;
}
