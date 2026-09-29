// ============================================================
// 面の間のずれを見る計器の標本（毎日・決定的）。
//
// 公開の export（/sellers の区分・L1 台帳・L0）だけから、型ごとの候補の列を作る。判定の区分
// （ALLOW/WARN/BLOCK）は /decision を引くまで分からないので、呼び手は型を巡回しながら引き、
// 足りない区分があれば、その区分を出しやすい型から足す（ALLOW ← delivered、BLOCK ← l0_fail/unprobed、WARN ← l1_failure）。
// 同じ日に回せば同じ標本になる（seed = UTC の日付）。
// ============================================================

export const SAMPLE_TYPES = [
  "l1_failure",
  "l2_mismatch",
  "l2_not_checked",
  "unprobed",
  "path_template",
  "delivered",
  "l0_fail",
  "not_bought",
  "pending",
] as const;
export type SampleType = (typeof SAMPLE_TYPES)[number];

export type Candidate = {
  observatoryId: string;
  resourceKey: string;
  network: string;
  host: string;
  types: SampleType[];
};

/** パステンプレート（{id}・:id）を含む URL の形。L0 は叩けない（unverified(path_template)）。 */
export const PATH_TEMPLATE_RE = /\{[^}/]+\}|\/:[A-Za-z_][A-Za-z0-9_]*/;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedFor(date: string): number {
  let h = 2166136261;
  for (const ch of date) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

function shuffle<T>(xs: T[], rnd: () => number): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/**
 * 型ごとの候補の列。掲載中（l0 export の listed=true）の出品だけ。同じ resource_key と network を
 * 2 つの endpoint が持つもの（台帳の行をどちらに付けるか決まらない）は外す。
 */
export function buildPools(args: {
  sellers: Record<string, string>[];
  l0: Record<string, string>[];
  ledger: Record<string, string>[];
  now: number;
  seed: number;
}): Map<SampleType, Candidate[]> {
  const rnd = mulberry32(args.seed);
  const keyCount = new Map<string, number>();
  for (const r of args.l0) keyCount.set(`${r.resource_key}|${r.network}`, (keyCount.get(`${r.resource_key}|${r.network}`) ?? 0) + 1);
  const byId = new Map<string, Candidate>();
  const byKey = new Map<string, Candidate>();
  for (const r of args.l0) {
    if (r.listed !== "true") continue;
    if (keyCount.get(`${r.resource_key}|${r.network}`) !== 1) continue;
    const c: Candidate = { observatoryId: r.endpoint_id, resourceKey: r.resource_key, network: r.network, host: r.resource_key.split("/")[0]!, types: [] };
    byId.set(c.observatoryId, c);
    byKey.set(`${r.resource_key}|${r.network}`, c);
    if (r.latest_probe_verdict === "") c.types.push("unprobed");
    if (r.published_verdict === "fail") c.types.push("l0_fail");
    if (PATH_TEMPLATE_RE.test(r.resource_key)) c.types.push("path_template");
  }
  for (const r of args.sellers) {
    const c = byId.get(r.endpoint_id);
    if (!c) continue;
    if (r.outcome === "vet402" || r.outcome === "unsorted" || r.outcome === "seller") c.types.push("l1_failure");
    if (r.outcome === "delivered") c.types.push("delivered");
    if (r.outcome === "not_bought") c.types.push("not_bought");
    if (r.outcome === "pending") c.types.push("pending");
  }
  const cutoff = args.now - 30 * 86_400_000;
  for (const r of args.ledger) {
    if (Date.parse(r.attempted_at) < cutoff) continue;
    const c = byKey.get(`${r.resource_key}|${r.network}`);
    if (!c) continue;
    if (r.l2_schema === "mismatch" && !c.types.includes("l2_mismatch")) c.types.push("l2_mismatch");
    if (r.l2_schema === "not_checked" && !c.types.includes("l2_not_checked")) c.types.push("l2_not_checked");
  }
  const pools = new Map<SampleType, Candidate[]>();
  const all = [...byId.values()].sort((a, b) => a.observatoryId.localeCompare(b.observatoryId));
  for (const ty of SAMPLE_TYPES) pools.set(ty, shuffle(all.filter((c) => c.types.includes(ty)), rnd));
  return pools;
}

/** 型を巡回して次の候補を返す（同じ出品は 2 度返さない）。 */
export class PoolCursor {
  private readonly used = new Set<string>();
  private readonly pos = new Map<SampleType, number>();
  constructor(private readonly pools: Map<SampleType, Candidate[]>) {}
  next(type: SampleType): Candidate | null {
    const pool = this.pools.get(type) ?? [];
    let i = this.pos.get(type) ?? 0;
    while (i < pool.length && this.used.has(pool[i]!.observatoryId)) i++;
    this.pos.set(type, i + 1);
    const c = pool[i];
    if (!c) return null;
    this.used.add(c.observatoryId);
    return c;
  }
  size(type: SampleType): number {
    return this.pools.get(type)?.length ?? 0;
  }
}

/** 足りない判定の区分を出しやすい型 */
export const TYPES_FOR_VERDICT: Record<string, SampleType[]> = {
  ALLOW: ["delivered"],
  BLOCK: ["l0_fail", "unprobed", "l2_mismatch"],
  WARN: ["l1_failure", "not_bought", "pending"],
};
