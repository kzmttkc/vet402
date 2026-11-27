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
  /**
   * 払う network（CAIP-2・省略可・2026-11-27）。省略した行は従来どおり主ネットワーク（カタログの accepts[0]）で買う。
   * 書けるのは PINNED_NETWORK_LANES の network だけ。その行はそのレーンの候補として扱う（レーンの accept を先に選ぶ）。
   * 受取先の照合・上限・別枠・残高の関門はレーンの通常の購入と同じ。カタログにその network の accept が無ければ買わない。
   */
  network?: string;
};

/** 予約に書ける network と、その候補を載せるレーン。Celo だけ（Prezenti M3・売り手ごとの Celo の証拠）。 */
export const PINNED_NETWORK_LANES = { "eip155:42220": "celo" } as const;
export type PinnedNetworkLane = (typeof PINNED_NETWORK_LANES)[keyof typeof PINNED_NETWORK_LANES];

/** 予約行のレーン（network を書いた行だけ）。 */
export function pinnedLaneChainOf(entry: PinnedPurchase): PinnedNetworkLane | null {
  if (entry.network === undefined) return null;
  return (PINNED_NETWORK_LANES as Record<string, PinnedNetworkLane>)[entry.network] ?? null;
}

import { PAYSH_PINNED_PURCHASES } from "./pay-skills-pinned-data";

export const PINNED_PURCHASE_SELECTION = "pinned_purchase" as const;

const FACTGATE_PINNED_PURCHASES: readonly PinnedPurchase[] = [
  {
    url: "https://agent402.tools/api/weather-forecast",
    method: "GET",
    from: "2027-01-10T00:00:00.000Z",
    to: "2027-01-11T12:30:00.000Z",
    reason: "FactGate hackathon judging (starts 2027-01-11 18:00 UTC): delivered evidence for this Bazaar listing before judging opens; the 2027-01-11 12:00 UTC run retries once if 2027-01-10 did not buy.",
    requestedBy: "hackathon session for FactGate judging (2027-01-11 18:00 UTC to 2027-01-18)",
    // 2026-11-23 07:20 JST 承認（01-11〜01-12）、09:32 JST に 01-10 へ前倒しを承認（金額・回数・経路は同じ）。
    // 2026-11-23 17:22 JST: 終わりを 01-11 12:30 UTC へ（12:00 UTC の購入 cron が1回失敗しても審査前にもう1回だけ試す。maxPurchases 1 のまま・承認済みの 01-11〜01-12 の内側）。
    approvedAt: "2026-11-23T00:32:00.000Z",
    maxPurchases: 1,
  },
];

// 2026-11-27: Prezenti M3（試した Celo の売り手）の証拠。x402atlas.xyz は 11/27 に Bazaar で Celo の accept
// （payTo 0x2632a66e…・USDC 0xcebA9300…）を 7 口に出した。$0.005 以下の 4 口を Celo で 1 件ずつ（上限の合計 0.009 USDC）。
// POST の chat/completions は目録が本文の例を宣言している。erc20 / erc721 は必須の引数に例が無いので、決済まで届かない
// ことがある（その場合も 1 口 1 件のまま）。:address の口はパスの値を知らないので買わない。$0.02 の 2 口（images・q-verdict）は外した。
const PREZENTI_M3_CELO_PINNED_PURCHASES: readonly PinnedPurchase[] = [
  "https://x402atlas.xyz/api/chain/block-number",
  "https://x402atlas.xyz/v1/chat/completions",
  "https://x402atlas.xyz/api/chain/erc20-balance",
  "https://x402atlas.xyz/api/chain/erc721-tokens",
].map((url) => ({
  url,
  method: url.endsWith("/v1/chat/completions") ? ("POST" as const) : ("GET" as const),
  network: "eip155:42220",
  from: "2026-11-27T00:00:00.000Z",
  to: "2026-11-29T23:59:59.999Z",
  reason: "prezenti-m3-celo-x402atlas",
  requestedBy: "grants session (Prezenti M3)",
  // 2026-11-27 10:46 JST、グラントの会話の依頼（合計 0.02 USDC 以内・1 口 1 件）。
  approvedAt: "2026-11-27T01:46:00.000Z",
  maxPurchases: 1,
}));

// 2026-11-25: Prezenti M2 usebuy の 4 予約は目的が無くなったので外した（オーナー 14:58「現時点では外部開発者を巻き込まない。M2 の直接の打診は行わない」）。出品は operator の通常の巡回で測る。

/** 正典リスト（版管理）。FactGate → Prezenti M3 の Celo → pay.sh delivery（presign-gate-2611）の予約。 */
export const PINNED_PURCHASES: readonly PinnedPurchase[] = [
  ...FACTGATE_PINNED_PURCHASES,
  ...PREZENTI_M3_CELO_PINNED_PURCHASES,
  ...PAYSH_PINNED_PURCHASES,
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
  if (entry.network !== undefined && pinnedLaneChainOf(entry) === null) {
    throw new Error(`${label}: network must be one of ${Object.keys(PINNED_NETWORK_LANES).join(", ")}`);
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

/**
 * `from` 以降で、払った可能性のある購入の件数（予約の maxPurchases 判定）。
 * settled だけでなく、受領証の再読み待ち（settle_claimed・settle_claimed_unverifiable）と
 * 受領証なしで届いた行（delivered_no_receipt）も数える。窓が2回の cron をまたぐので、
 * 1回目が未確定のまま2回目が二重に払わないようにする（2026-11-23）。
 */
export async function countSettledSincePinFrom(
  db: DbLike,
  endpointId: string,
  fromIso: string,
): Promise<number> {
  const raw = await db.execute(sql`
    SELECT count(*)::int AS n
    FROM x402_l1_purchases pu
    WHERE pu.endpoint_id = ${endpointId}::uuid
      AND pu.status IN ('settled', 'settle_claimed', 'settle_claimed_unverifiable', 'delivered_no_receipt')
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
  // 出品の表は 1 回だけ読む（2026-11-27: 予約 349 件で 1 件ずつ全件を読み直し、準備が 231 秒かかって
  // 11/26 の L1 が 1 件も買えなかった）。照合は従来と同じ listingMatchesPinned・最初に当たった行。
  const raw = await db.execute(sql`
    SELECT e.id, e.resource_url, e.method
    FROM x402_endpoints e
    WHERE e.status = 'active'
  `);
  const byKey = new Map<string, string>();
  for (const r of rowsOf(raw)) {
    if (typeof r.id !== "string" || typeof r.resource_url !== "string") continue;
    const c = canonicalUrl(r.resource_url);
    if (c === null) continue;
    const key = `${(typeof r.method === "string" ? r.method : "GET").toUpperCase()} ${c.url}`;
    if (!byKey.has(key)) byKey.set(key, r.id);
  }
  const matched: { entry: PinnedPurchase; endpointId: string }[] = [];
  for (const entry of active) {
    const c = canonicalUrl(entry.url);
    if (c === null) continue;
    const id = byKey.get(`${entry.method.toUpperCase()} ${c.url}`);
    if (id) matched.push({ entry, endpointId: id });
  }
  // 件数も窓の開始ごとに 1 回で数える（数え方は countSettledSincePinFrom と同じ）。
  const counts = new Map<string, number>();
  const byFrom = new Map<string, string[]>();
  for (const m of matched) byFrom.set(m.entry.from, [...(byFrom.get(m.entry.from) ?? []), m.endpointId]);
  for (const [fromIso, ids] of byFrom) {
    const n = await countSettledSincePinFromMany(db, [...new Set(ids)], fromIso);
    for (const [id, v] of n) counts.set(`${fromIso} ${id}`, v);
  }
  const out: ActivePinnedTarget[] = [];
  for (const m of matched) {
    const settledCount = counts.get(`${m.entry.from} ${m.endpointId}`) ?? 0;
    if (settledCount >= m.entry.maxPurchases) continue;
    out.push({ entry: m.entry, endpointId: m.endpointId, settledCount });
  }
  return out;
}

/** countSettledSincePinFrom を複数の出品で 1 回に（同じ status・同じ attempted_at の線）。 */
export async function countSettledSincePinFromMany(
  db: DbLike,
  endpointIds: readonly string[],
  fromIso: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (endpointIds.length === 0) return out;
  const raw = await db.execute(sql`
    SELECT pu.endpoint_id::text AS id, count(*)::int AS n
    FROM x402_l1_purchases pu
    WHERE pu.endpoint_id IN (${sql.join(endpointIds.map((id) => sql`${id}::uuid`), sql`, `)})
      AND pu.status IN ('settled', 'settle_claimed', 'settle_claimed_unverifiable', 'delivered_no_receipt')
      AND pu.attempted_at >= ${fromIso}::timestamptz
    GROUP BY pu.endpoint_id
  `);
  for (const r of rowsOf(raw)) {
    if (typeof r.id === "string") out.set(r.id, typeof r.n === "number" ? r.n : Number(r.n ?? 0));
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
/** 主候補に無い予約購入を 1 バッチで足す上限（2026-11-27・予約 349 件で準備が持ち時間を食い、11/26 は 0 件）。 */
export const PINNED_FETCHES_PER_BATCH = 40;
/** そのための個別の問い合わせの回数の上限（候補にならない予約で回数を使い切らないように）。 */
export const PINNED_QUERIES_PER_BATCH = 120;

/**
 * 主候補に無い予約を 1 件ずつ引く（fetchOne が 1 回の問い合わせ）。足すのは PINNED_FETCHES_PER_BATCH まで、
 * 問い合わせは PINNED_QUERIES_PER_BATCH まで。引き始めは UTC の日ごとに PINNED_FETCHES_PER_BATCH ずつずらす。
 * 予約が何件あっても、問い合わせの回数は上限で止まる（tests/pinned-purchases.test.ts が 349 件と 1,000 件で確かめる）。
 */
export async function fetchPinnedCandidateRows<R>(
  pinTargets: readonly ActivePinnedTarget[],
  existingIds: ReadonlySet<string>,
  nowMs: number,
  fetchOne: (t: ActivePinnedTarget) => Promise<R | null | undefined>,
): Promise<{ rows: R[]; queries: number }> {
  const rows: R[] = [];
  let queries = 0;
  if (pinTargets.length === 0) return { rows, queries };
  const seen = new Set(existingIds);
  // network を書いた予約（数件）は日ごとのずらしの外で先に引く。ずらしの 40 件に入らない日に、窓のあいだ一度も候補に
  // ならないのを防ぐ（2026-11-27・Celo）。件数と回数の上限は同じものを使う。
  const laned = pinTargets.filter((t) => pinnedLaneChainOf(t.entry) !== null);
  const rest = pinTargets.filter((t) => pinnedLaneChainOf(t.entry) === null);
  const start = rest.length === 0 ? 0 : (Math.floor(nowMs / 86_400_000) * PINNED_FETCHES_PER_BATCH) % rest.length;
  const order = [...laned, ...rest.slice(start), ...rest.slice(0, start)];
  for (const t of order) {
    if (seen.has(t.endpointId)) continue;
    if (rows.length >= PINNED_FETCHES_PER_BATCH || queries >= PINNED_QUERIES_PER_BATCH) break;
    queries++;
    const row = await fetchOne(t);
    if (row) {
      rows.push(row);
      seen.add(t.endpointId);
    }
  }
  return { rows, queries };
}

/**
 * network を書いた予約の窓のあいだ、同じホストのそのレーンの候補は予約の行だけにする（2026-11-27）。
 * レーン枠（laneFloorCandidates）は 1 ホスト 2 件まで同点の並びで選ぶので、予約と同じ売り手の高い口（x402atlas の
 * $0.02 の口）を同じバッチで足しうる。予約は窓の全体で効かせる（maxPurchases に届いた後も）。主候補・census など
 * レーン以外の候補と、ほかのホストの候補は変えない。
 */
export function dropLaneCandidatesShadowedByNetworkPins<
  T extends { id: string; resourceUrl: string; laneChain: string | null },
>(candidates: readonly T[], nowMs: number, pinnedIds: ReadonlySet<string>, list: readonly PinnedPurchase[] = PINNED_PURCHASES): T[] {
  const shadow = new Set<string>();
  for (const e of pinnedPurchasesActiveAt(nowMs, list)) {
    const lane = pinnedLaneChainOf(e);
    if (lane === null) continue;
    const c = canonicalUrl(e.url);
    if (c === null) continue;
    shadow.add(`${lane} ${new URL(c.url).hostname.toLowerCase()}`);
  }
  if (shadow.size === 0) return [...candidates];
  return candidates.filter((c) => {
    if (c.laneChain === null || pinnedIds.has(c.id)) return true;
    let host: string;
    try {
      host = new URL(c.resourceUrl).hostname.toLowerCase();
    } catch {
      return true;
    }
    return !shadow.has(`${c.laneChain} ${host}`);
  });
}
