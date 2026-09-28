// ============================================================
// /sellers の集計（純関数・DB 無し）。reader.ts が DB から事実を引き、ここで数える。
//
// 1 出品は「最新の購入行」1 つで数える（Base の行と、network の無い行＝支払い前に止まった行）。
// 数字は頁に書かない。毎回ここを通して DB の行から出す。
// ============================================================
import { chainLabel, explorerTxUrl } from "@/lib/observatory/chains";
import {
  classifyRow,
  FIX_MODES,
  NOT_IN_EXPORT_STATUSES,
  observed402Line,
  rowNote,
  SIGNED_ROW_STATUSES,
  type Bucket,
  type FixMode,
  type SellerRowFacts,
} from "./fix-modes";

export interface OutcomeCounts {
  delivered: number;
  /** 照合待ち（settle_claimed）。失敗にも delivered にも数えない。 */
  pending: number;
  seller: number;
  vet402: number;
  unsorted: number;
  /** 試したが vet402 が署名しなかった（L1 の結果ではない・2026-09-29 第2巡）。 */
  notPaid: number;
  /** まだ試していない出品（購入行が無い）。 */
  notTried: number;
}

export interface SellerSummary extends OutcomeCounts {
  host: string;
  listings: number;
  /** その売り手の最新の購入（ISO）。無ければ null。 */
  lastAttemptAt: string | null;
  /**
   * 買い直しの予定がある: 旗が on で、retest の SQL（RETEST_SELLERS_SQL）がこの売り手を選び、しかも選んだ行
   * （endpoint_id）がこの頁の見ている最新の行と同じで、その行がこちらの側の失敗。1 つでも欠けたら false
   * （頁は Base の掲載中の出品しか見ず、retest は全チェーンの最新行を見るので、食い違う売り手には書かない）。
   */
  rebuyEligible: boolean;
  /** rebuyEligible のとき、retest が買い直す行の出品（endpoint id）。 */
  rebuyEndpointId: string | null;
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
  totals: OutcomeCounts & { sellers: number; listings: number; sellersTried: number };
  groups: FixGroup[];
}

/** DB から来る、Base の出品 1 つの最新の購入行（ホスト名付き）。 */
export interface LatestRow extends SellerRowFacts {
  host: string;
}

/** retest が買い直しの理由にする種類（(a) 残高切れ・(b) 本文・(c) クエリ）。 */
export const RETEST_MODE_KEYS: ReadonlySet<string> = new Set(["payer_unfunded", "body_not_sent", "query_not_sent"]);

/**
 * retest の SQL（RETEST_SELLERS_SQL）の結果: ホスト → その売り手の最新の行の endpoint_id と理由
 * （"unfunded" | "body"。(c) が入れば "query"）。null＝旗が off か読めなかった。
 */
export type RetestPick = { endpointId: string; reason: string };
export type RetestQueue = ReadonlyMap<string, RetestPick>;

/** retest の理由 → この頁の種類。理由と種類が食い違う売り手（retest は全チェーンの最新行を見る）には rebuyEligible と書かない。 */
const RETEST_REASON_MODE: Readonly<Record<string, string>> = { unfunded: "payer_unfunded", body: "body_not_sent", query: "query_not_sent" };

function zero(): OutcomeCounts {
  return { delivered: 0, pending: 0, seller: 0, vet402: 0, unsorted: 0, notPaid: 0, notTried: 0 };
}

const SIDE_ORDER = { seller: 0, vet402: 1, unsorted: 2, not_bought: 3 } as const;
const MODE_ORDER = new Map(FIX_MODES.map((m, i) => [m.key, i]));

function bucketKey(b: Bucket): keyof OutcomeCounts {
  return b === "not_bought" ? "notPaid" : b;
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
  retest: RetestQueue | null = null,
): SellerBoard {
  const byHost = new Map<string, SellerSummary>();
  for (const h of hostListings) {
    byHost.set(h.host, { host: h.host, listings: h.listings, ...zero(), lastAttemptAt: null, rebuyEligible: false, rebuyEndpointId: null });
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
  const totals = { ...zero(), sellers: sellers.length, listings: 0, sellersTried: 0 };
  for (const s of sellers) {
    const tried = s.delivered + s.pending + s.seller + s.vet402 + s.unsorted + s.notPaid;
    s.notTried = Math.max(0, s.listings - tried);
    const last = newest.get(s.host);
    const pick = retest?.get(s.host);
    s.rebuyEligible =
      !!last &&
      pick !== undefined &&
      pick.endpointId === last.endpointId &&
      RETEST_MODE_KEYS.has(last.modeKey ?? "") &&
      RETEST_REASON_MODE[pick.reason] === last.modeKey;
    s.rebuyEndpointId = s.rebuyEligible ? pick!.endpointId : null;
    totals.listings += s.listings;
    totals.delivered += s.delivered;
    totals.seller += s.seller;
    totals.vet402 += s.vet402;
    totals.unsorted += s.unsorted;
    totals.pending += s.pending;
    totals.notPaid += s.notPaid;
    totals.notTried += s.notTried;
    if (s.lastAttemptAt) totals.sellersTried++;
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

/**
 * 一覧の「いつの結果か」（2026-09-29 第2巡: /sellers と fix-first の表題に日付を入れる）。
 * 最新の試行（どの売り手でも）の UTC の日付。試行が無ければ null。
 */
export function boardAsOfDay(board: Pick<SellerBoard, "sellers">): string | null {
  let latest: string | null = null;
  for (const s of board.sellers) if (s.lastAttemptAt && (!latest || s.lastAttemptAt > latest)) latest = s.lastAttemptAt;
  return latest && /^\d{4}-\d{2}-\d{2}/.test(latest) ? latest.slice(0, 10) : null;
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
  /** 行ごとの注記（fix-modes.ts の rowNote）。 */
  note: string | null;
  /** vet402 が署名した行か（L1 の支払い付き購入か）。署名していない行を「L1 paid purchase」と書かない。 */
  signed: boolean;
  /** そのとき vet402 が見た 402 の要点（記録済みの範囲・fix-modes.ts の observed402Line）。 */
  seen402: string | null;
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
    note: rowNote(r, c.mode?.key ?? null),
    signed: SIGNED_ROW_STATUSES.has(r.status),
    seen402: observed402Line(r),
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
  const summary = board.sellers[0] ?? { host, listings: 0, ...zero(), lastAttemptAt: null, rebuyEligible: false, rebuyEndpointId: null };
  return { fetchedAt, host, summary, listings, selectedBy };
}

/**
 * 1 売り手の頁に、一覧（board）が持つ retest の判定を移す。board と頁の読み取りは別の時刻なので、
 * 頁の最新の行が board の選んだ行と同じで、なおかつこちらの側の失敗であるときだけ rebuyEligible にする。
 */
export function markRebuyEligible(d: SellerDetail, fromBoard: SellerSummary | undefined): SellerDetail {
  const newest = d.listings[0]?.latest ? d.listings[0] : undefined;
  const rebuyEligible =
    !!fromBoard?.rebuyEligible &&
    !!newest &&
    fromBoard.rebuyEndpointId === newest.endpointId &&
    RETEST_MODE_KEYS.has(newest.latest?.mode?.key ?? "");
  return { ...d, summary: { ...d.summary, rebuyEligible, rebuyEndpointId: rebuyEligible ? newest!.endpointId : null } };
}

/** export.csv の ?days= で、その行が窓に入る最小の日数（1..366）。366 を超えるなら null。 */
export function exportDaysFor(attemptedAt: string, now: number): number | null {
  const ageMs = now - Date.parse(attemptedAt);
  if (!Number.isFinite(ageMs)) return null;
  const days = Math.max(1, Math.ceil(ageMs / 86_400_000) + 1);
  return days > 366 ? null : days;
}

// ------------------------------------------------------------
// Base の出品が無い売り手（2026-09-29 監査 第2巡）。
//
// /sellers/[host] は Base の出品（active）がある host だけを扱っていたので、Arc や Solana で
// 買った実績がある host（例: edge.goldsky.com）は 404 だった。売り手が自分のドメインで
// 探して何も無いのは「測っていない」と読まれる。Base の頁と同じ数え方はせず（Base の一覧と
// 重複・行の少ない頁になるので noindex）、出品ごとの記録頁へ案内するだけの簡易版を出す。
// ------------------------------------------------------------

export interface OtherChainListing {
  endpointId: string;
  resourceKey: string;
  /** 最新の購入行の network（支払い前に止まった行は無いので、カタログの代表 network）の表示名。 */
  chain: string;
  latest: ShownRow;
}

export interface SellerOtherChains {
  fetchedAt: string;
  host: string;
  listings: OtherChainListing[];
}

/**
 * rows: その host の出品ごとの最新の購入行（1 出品 1 行）。catalogNetwork はカタログ上の代表 network。
 * 行が無ければ null（＝頁は従来どおり 404）。並びは最新の購入が新しい順。
 */
export function buildSellerOtherChains(
  host: string,
  rows: ReadonlyArray<{ resourceKey: string; catalogNetwork: string | null; facts: SellerRowFacts }>,
  fetchedAt: string,
): SellerOtherChains | null {
  if (rows.length === 0) return null;
  const listings = rows
    .map((r) => ({
      endpointId: r.facts.endpointId,
      resourceKey: r.resourceKey,
      chain: chainLabel(r.facts.network ?? r.catalogNetwork),
      latest: showRow(r.facts),
    }))
    .sort(
      (a, b) =>
        b.latest.facts.attemptedAt.localeCompare(a.latest.facts.attemptedAt) || a.resourceKey.localeCompare(b.resourceKey),
    );
  return { fetchedAt, host, listings };
}

export type SellerPageData =
  | { kind: "base"; detail: SellerDetail }
  | { kind: "other_chains"; other: SellerOtherChains }
  | { kind: "none" };

/**
 * /sellers/[host] が何を出すか（頁から DB を外した判定・tests/sellers-other-chains.test.ts が 3 通りを固定）。
 *   1. 一覧（Base の出品がある host）に居る → Base の頁
 *   2. 居ないが、購入行のある host の集合に居る → 他チェーンの簡易頁
 *   3. どちらでもない → 404
 * 2 の集合はキャッシュ済みの 1 本（cached.ts）なので、でたらめな host は従来どおり host ごとの問い合わせを走らせない。
 */
export async function resolveSellerPage(
  host: string,
  load: {
    board: () => Promise<SellerBoard>;
    detail: (host: string) => Promise<SellerDetail | null>;
    purchasedHosts: () => Promise<readonly string[]>;
    otherChains: (host: string) => Promise<SellerOtherChains | null>;
  },
): Promise<SellerPageData> {
  const board = await load.board();
  const fromBoard = board.sellers.find((s) => s.host === host);
  if (fromBoard) {
    const read = await load.detail(host);
    return read ? { kind: "base", detail: markRebuyEligible(read, fromBoard) } : { kind: "none" };
  }
  if (!(await load.purchasedHosts()).includes(host)) return { kind: "none" };
  const other = await load.otherChains(host);
  return other ? { kind: "other_chains", other } : { kind: "none" };
}
